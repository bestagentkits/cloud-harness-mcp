import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { sanitizeDeweePageContext, serializeDeweePageContext } from '../src/dashboard-dewee-page-context.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';
import type * as DeweeServer from 'dewee-webchat/server';
import { apiLogger } from '../src/logging.js';
import { startDeweeGatewayStub } from './dewee-gateway-stub.js';

// Lets a test hold visitor-token verification open, i.e. keep a request mid-validation.
const verifyGate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock('dewee-webchat/server', async (importOriginal) => {
  const actual = await importOriginal<typeof DeweeServer>();
  return {
    ...actual,
    verifyVisitorToken: async (...args: Parameters<typeof actual.verifyVisitorToken>) => {
      await verifyGate.hold;
      return actual.verifyVisitorToken(...args);
    }
  };
});

// The Dashboard webchat BFF proxies the dewee-webchat HTTP contract to a Dewee gateway. These
// tests drive it end to end against an in-process gateway stub and check that the gateway
// token and webchat secret never reach a response or a log line.

const GATEWAY_TOKEN = 'dewee-gateway-token-0123456789abcdef';
const WEBCHAT_SECRET = 'dewee-webchat-secret-0123456789abcdef-xyz';
const operator: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const otherOperator: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'someone-else' };
const baseConfig: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: false, runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false,
  deweeAgentId: 'cloud-harness-operator', deweeChatTimeoutMs: 180_000
};

type Reply = { status: number; headers: Record<string, unknown>; text: string; json: any };

let stub: Awaited<ReturnType<typeof startDeweeGatewayStub>>;
let httpServer: Server;
let port: number;
let current: RunnerPrincipalSelector | undefined;
let transcript: string[];
let logged: string[];

async function listen(config: ApiConfig): Promise<void> {
  const ok = async (): Promise<RunnerResponse> => ({ ok: true, message: 'ok', truncated: false, data: {} });
  const runner: DashboardRunnerClient = { call: vi.fn(ok), callInternal: vi.fn(ok) };
  const app = express();
  app.use((request: any, _response, next) => {
    if (current) request.auth = { token: 'cloudflare-access', clientId: current.kind === 'external' ? current.subject : 'owner', scopes: [], extra: { principal: current } };
    next();
  });
  app.use('/dashboard', createDashboardRouter(config, runner));
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
}

beforeEach(async () => {
  verifyGate.hold = undefined;
  current = operator;
  transcript = [];
  logged = [];
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    vi.spyOn(apiLogger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);
  }
  stub = await startDeweeGatewayStub(GATEWAY_TOKEN);
  await listen({ ...baseConfig, deweeGatewayUrl: stub.url, deweeGatewayToken: GATEWAY_TOKEN, deweeWebchatSecret: WEBCHAT_SECRET });
});

afterEach(async () => {
  // Nothing the BFF answered or logged may carry the gateway token or the webchat secret.
  for (const text of [...transcript, ...logged]) {
    expect(text).not.toContain(GATEWAY_TOKEN);
    expect(text).not.toContain(WEBCHAT_SECRET);
  }
  vi.restoreAllMocks();
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await stub.close();
});

function open(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): { request: ClientRequest; reply: Promise<Reply> } {
  let request!: ClientRequest;
  const reply = new Promise<Reply>((resolve, reject) => {
    request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers: { host: 'dashboard.example', ...options.headers, ...(options.body ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        transcript.push(JSON.stringify(response.headers), text);
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(options.body);
  });
  return { request, reply };
}

const send = (path: string, options: Parameters<typeof open>[1] = {}) => open(path, options).reply;

async function csrfHeaders(): Promise<Record<string, string>> {
  const session = await send('/api/v1/session');
  const cookie = String((session.headers['set-cookie'] as string[])[0]).split(';', 1)[0]!;
  return { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
}

async function visitorSession(headers: Record<string, string>): Promise<{ visitorId: string; token: string; expiresAt: number }> {
  const reply = await send('/api/v1/dewee/session', { method: 'POST', headers, body: '{}' });
  expect(reply.status).toBe(200);
  return reply.json;
}

async function chatHeaders(): Promise<Record<string, string>> {
  const headers = await csrfHeaders();
  const { token } = await visitorSession(headers);
  return { ...headers, authorization: `Bearer ${token}` };
}

const frames = (text: string) => text.split('\n\n').filter((block) => block.startsWith('data: ')).map((block) => JSON.parse(block.slice(6)));

async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Dashboard webchat BFF: access', () => {
  it('requires a dashboard principal', async () => {
    current = undefined;
    expect((await send('/api/v1/dewee/config')).status).toBe(401);
  });

  it('requires the CSRF header on POST', async () => {
    const { 'x-csrf-token': _csrf, ...headers } = await csrfHeaders();
    void _csrf;
    const reply = await send('/api/v1/dewee/session', { method: 'POST', headers, body: '{}' });
    expect(reply.status).toBe(403);
    expect(reply.json).toEqual({ error: 'csrf_failed' });
  });

  it('serves the fixed agent and no credentials from config', async () => {
    const reply = await send('/api/v1/dewee/config');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      agents: [{ id: 'cloud-harness-operator' }], defaultAgent: 'cloud-harness-operator', allowAgentSwitch: false,
      allowClientCredentials: false, maxMessageLength: 4_000, version: '0.3.0'
    });
  });

  it('derives a stable per-operator visitor and refuses another operator\'s token', async () => {
    const headers = await csrfHeaders();
    const first = await visitorSession(headers);
    const second = await visitorSession(headers);
    expect(first.visitorId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.visitorId).toBe(first.visitorId);
    expect(first.expiresAt).toBeGreaterThan(Date.now());

    current = otherOperator;
    const otherHeaders = await csrfHeaders();
    const other = await visitorSession(otherHeaders);
    expect(other.visitorId).not.toBe(first.visitorId);
    const borrowed = await send('/api/v1/dewee/chat', { method: 'POST', headers: { ...otherHeaders, authorization: `Bearer ${first.token}` }, body: JSON.stringify({ message: 'hi' }) });
    expect(borrowed.status).toBe(401);
    expect(borrowed.json).toEqual({ error: { message: 'Missing or expired visitor session.', code: 'unauthorized' } });
    const missing = await send('/api/v1/dewee/history?conversationId=conv-123', { headers: otherHeaders });
    expect(missing.status).toBe(401);
    expect(stub.requests).toEqual([]);
  });
});

describe('Dashboard webchat BFF: visitor session', () => {
  it('issues a token that outlives the widget\'s 24h reuse threshold', async () => {
    const before = Date.now();
    const { expiresAt } = await visitorSession(await csrfHeaders());
    expect(expiresAt - before).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1_000 - 1_000);
    expect(expiresAt - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1_000);
  });
});

describe('Dashboard webchat BFF: chat', () => {
  it('streams the gateway reply as SSE and prepends a sanitized page block', async () => {
    const headers = await chatHeaders();
    const actions = [{ name: 'navigate', description: 'Open a page', sensitivity: 'navigate', parameters: { type: 'object', properties: { route: { type: 'string' } } } }];
    const pageContext = { route: '/workspaces', apiKey: 'chm_key_abcdefghijkl', note: 'Bearer abcdefghijklmnop', count: 3 };
    const reply = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: '  hello  ', conversationId: 'conv-123', actions, pageContext }) });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const events = frames(reply.text);
    expect(events[0]).toMatchObject({ type: 'start', conversationId: 'conv-123', agent: 'cloud-harness-operator', actionsHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(events.slice(1)).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'tool_call', id: 't1', name: 'workspace_list', arguments: {} },
      { type: 'tool_result', id: 't1', name: 'workspace_list', isError: false, result: '{"workspaces":[]}' },
      { type: 'done', content: 'Hello', usage: { input_tokens: 3 } }
    ]);

    const [connect, chat] = stub.requests;
    const visitorId = (await visitorSession(await csrfHeaders())).visitorId;
    expect(connect).toEqual({ method: 'connect', params: { token: GATEWAY_TOKEN, user_id: `webchat-${visitorId}` } });
    expect(chat!.method).toBe('chat.send');
    expect(chat!.params).toMatchObject({ agentId: 'cloud-harness-operator', sessionKey: `agent:cloud-harness-operator:ws:direct:webchat-${visitorId}-conv-123`, stream: true });
    const message = String(chat!.params.message);
    expect(message.startsWith('[[dewee-page v1]]\n')).toBe(true);
    expect(message.endsWith('[[/dewee-page]]\n\nhello')).toBe(true);
    expect(message).toContain('"name":"navigate"');
    expect(message).toContain('Page context: {"route":"/workspaces","apiKey":"[redacted]","note":"[redacted]","count":3}');
    expect(message).not.toContain('chm_key_abcdefghijkl');
    expect(reply.text).not.toContain('LEAK');
    expect(reply.text).not.toContain('UNKEYED');
  });

  it('redacts secret-shaped content in action-result blocks but leaves the visitor\'s words as typed', async () => {
    const headers = await chatHeaders();
    const result = { id: 'call-1', name: 'prepare_project_create', status: 'error', error: 'upstream said: sk-SENTINELabcdefghijklmnop', result: { token: 'plain', id: `prj_${'a'.repeat(32)}` } };
    const message = `\`\`\`dewee-action-result\n${JSON.stringify(result)}\n\`\`\`\n\n\`\`\`dewee-action-result\nnot json Bearer abcdefghijklmnop\n\`\`\`\nmy words`;
    const reply = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message }) });
    expect(reply.status).toBe(200);
    const forwarded = String(stub.requests.find((entry) => entry.method === 'chat.send')!.params.message);
    expect(forwarded).not.toContain('sk-SENTINEL');
    expect(forwarded).not.toContain('"token":"plain"');
    expect(forwarded).not.toContain('Bearer abcdefghijklmnop');
    expect(forwarded).toContain('"error":"upstream said: [redacted]"');
    expect(forwarded).toContain(`"id":"prj_${'a'.repeat(32)}"`);
    expect(forwarded.endsWith('```\nmy words')).toBe(true);
  });

  it.each([['an empty', ''], ['a null', null]])('treats %s agent as the configured default', async (_label, agent) => {
    const headers = await chatHeaders();
    const reply = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi', agent }) });
    expect(reply.status).toBe(200);
    expect(stub.requests.find((entry) => entry.method === 'chat.send')!.params.agentId).toBe('cloud-harness-operator');
  });

  it('forwards an event that names this turn only by its run session key', async () => {
    const headers = await chatHeaders();
    stub.setMode('run_key_only');
    const events = frames((await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).text);
    expect(events.slice(1)).toEqual([{ type: 'delta', text: 'via run key' }, { type: 'done', content: 'via run key' }]);
  });

  it('clips oversized tool call arguments', async () => {
    const headers = await chatHeaders();
    stub.setMode('big_arguments');
    const events = frames((await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).text);
    const call = events.find((event) => event.type === 'tool_call');
    expect(typeof call.arguments).toBe('string');
    expect(call.arguments.length).toBe(4_001);
    expect(call.arguments.endsWith('…')).toBe(true);
  });

  it('sends the manifest once and only a reference when the client already has its hash', async () => {
    const headers = await chatHeaders();
    const actions = [{ name: 'navigate', description: 'Open a page', sensitivity: 'navigate' }];
    const first = frames((await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'a', actions }) })).text);
    const actionsHash = first[0].actionsHash as string;
    await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'b', actions, actionsHash }) });
    const messages = stub.requests.filter((entry) => entry.method === 'chat.send').map((entry) => String(entry.params.message));
    expect(messages[0]).toContain('Actions: ');
    expect(messages[1]).not.toContain('Actions: ');
    expect(messages[1]).toContain(`Page actions unchanged (manifest ${actionsHash})`);
  });

  it.each([
    ['a non-array manifest', { actions: { name: 'x' } }, 400, 'invalid_actions'],
    ['an invalid action name', { actions: [{ name: 'Bad Name', sensitivity: 'read' }] }, 400, 'invalid_actions'],
    ['too many actions', { actions: Array.from({ length: 33 }, (_, index) => ({ name: `a${index}`, sensitivity: 'read' })) }, 413, 'actions_too_large'],
    ['oversized parameters', { actions: [{ name: 'big', sensitivity: 'read', parameters: { type: 'object', description: 'x'.repeat(5_000) } }] }, 413, 'actions_too_large'],
    ['an oversized page context', { pageContext: { blob: 'x'.repeat(5_000) } }, 413, 'context_too_large'],
    ['an empty message', { message: '   ' }, 400, 'bad_request'],
    ['a too long message', { message: 'x'.repeat(4_001) }, 413, 'too_long'],
    ['another agent', { agent: 'someone-else' }, 403, 'agent_not_allowed']
  ])('refuses %s before streaming', async (_label, extra, status, code) => {
    const headers = await chatHeaders();
    const reply = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi', ...extra }) });
    expect(reply.status).toBe(status);
    expect(reply.json.error.code).toBe(code);
    expect(stub.requests).toEqual([]);
  });

  it('replaces gateway and run error text with fixed messages', async () => {
    const headers = await chatHeaders();
    stub.setMode('fail');
    const failed = frames((await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).text);
    expect(failed.at(-1)).toEqual({ type: 'error', message: 'The Dewee gateway request failed.', code: 'gateway_error' });
    stub.setMode('run_failed');
    const runFailed = frames((await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).text);
    expect(runFailed.at(-1)).toEqual({ type: 'error', message: 'The agent run failed.', code: 'run_failed' });
    expect(logged.some((line) => line.includes('dewee.chat') && line.includes('"code":"INTERNAL"'))).toBe(true);
    for (const line of logged) expect(line).not.toContain('"hi"');
  });

  it('reports an unreachable gateway as a typed stream error', async () => {
    const headers = await chatHeaders();
    await stub.close();
    const events = frames((await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).text);
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    expect(events[1]).toEqual({ type: 'error', message: 'The Dewee gateway request failed.', code: 'gateway_error' });
  });

  it('aborts the gateway run when the browser disconnects', async () => {
    const headers = await chatHeaders();
    stub.setMode('hang');
    const { request, reply } = open('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi', conversationId: 'conv-abort' }) });
    reply.catch(() => undefined);
    await eventually(() => stub.requests.some((entry) => entry.method === 'chat.send'));
    expect(stub.openSockets()).toBe(1);
    request.destroy();
    await eventually(() => stub.requests.some((entry) => entry.method === 'chat.abort'));
    expect(stub.requests.find((entry) => entry.method === 'chat.abort')!.params).toEqual({ sessionKey: expect.stringContaining('-conv-abort') });
    await eventually(() => stub.openSockets() === 0);
  });

  it('releases the stream slot when the browser leaves before the stream opens', async () => {
    const headers = await chatHeaders();
    stub.setMode('hang');
    for (let index = 0; index < 3; index += 1) {
      let proceed!: () => void;
      verifyGate.hold = new Promise<void>((resolve) => { proceed = resolve; });
      const { request, reply } = open('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: `early ${index}` }) });
      reply.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      proceed();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    verifyGate.hold = undefined;
    // No gateway run was started for the abandoned requests, and both slots are still free.
    expect(stub.requests.filter((entry) => entry.method === 'chat.send')).toEqual([]);
    stub.setMode('reply');
    const reply = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'after' }) });
    expect(reply.status).toBe(200);
    expect(frames(reply.text).at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('Dashboard webchat BFF: rate limit', () => {
  it('limits visitor sessions per operator', async () => {
    const headers = await csrfHeaders();
    for (let index = 0; index < 10; index += 1) await visitorSession(headers);
    const limited = await send('/api/v1/dewee/session', { method: 'POST', headers, body: '{}' });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: { message: 'Too many webchat requests, please wait a moment.', code: 'rate_limited' } });
    current = otherOperator;
    await visitorSession(await csrfHeaders());
  });

  it('allows at most two concurrent streams per operator', async () => {
    const headers = await chatHeaders();
    stub.setMode('hang');
    const streams = [open('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'one' }) }), open('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'two' }) })];
    for (const stream of streams) stream.reply.catch(() => undefined);
    await eventually(() => stub.requests.filter((entry) => entry.method === 'chat.send').length === 2);
    const third = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'three' }) });
    expect(third.status).toBe(429);
    streams[0]!.request.destroy();
    await eventually(() => stub.requests.filter((entry) => entry.method === 'chat.abort').length === 1);
    stub.setMode('reply');
    const fourth = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'four' }) });
    expect(fourth.status).toBe(200);
    streams[1]!.request.destroy();
  });
});

describe('Dashboard webchat BFF: history', () => {
  it('returns the operator\'s own transcript with the page block stripped', async () => {
    const headers = await chatHeaders();
    stub.setHistory([
      { role: 'user', content: '[[dewee-page v1]]\nPage context: {"route":"/"}\n[[/dewee-page]]\n\nhello' },
      { role: 'assistant', content: 'Hi there' }
    ]);
    const reply = await send('/api/v1/dewee/history?agent=cloud-harness-operator&conversationId=conv-123', { headers });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi there' }] });
    const visitorId = (await visitorSession(headers)).visitorId;
    expect(stub.requests.find((entry) => entry.method === 'chat.history')!.params).toEqual({ agentId: 'cloud-harness-operator', sessionKey: `agent:cloud-harness-operator:ws:direct:webchat-${visitorId}-conv-123` });
  });

  it('validates the conversation and agent', async () => {
    const headers = await chatHeaders();
    expect((await send('/api/v1/dewee/history?conversationId=../x', { headers })).status).toBe(400);
    expect((await send('/api/v1/dewee/history?conversationId=conv-123&agent=other', { headers })).status).toBe(403);
    expect(stub.requests).toEqual([]);
  });
});

describe('Dashboard webchat BFF: disabled', () => {
  it('answers every webchat route with a typed 503 when unconfigured', async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await listen(baseConfig);
    const config = await send('/api/v1/dewee/config');
    expect(config.status).toBe(503);
    expect(config.json).toEqual({ error: { message: 'The Dashboard webchat is not configured.', code: 'dewee_disabled' } });
    const headers = await csrfHeaders();
    const chat = await send('/api/v1/dewee/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) });
    expect(chat.status).toBe(503);
    expect(stub.requests).toEqual([]);
  });
});

describe('Dashboard webchat page context sanitizer', () => {
  it('redacts secret-named fields and secret-shaped values at any depth', () => {
    expect(sanitizeDeweePageContext({
      route: '/settings',
      nested: { password: 'p', items: [{ github: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }, 'https://user:pass@example.com/repo'] },
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2lnbmF0dXJlLXZhbHVl',
      openai: 'sk-abcdefghijklmnopqrstuv',
      pem: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
      count: 2
    })).toEqual({
      route: '/settings',
      nested: { password: '[redacted]', items: [{ github: '[redacted]' }, 'https://[redacted]@example.com/repo'] },
      jwt: '[redacted]',
      openai: '[redacted]',
      pem: '[redacted]',
      count: 2
    });
  });

  it('redacts generic secret keys and long random strings but keeps ordinary values', () => {
    const hex64 = 'a3f1'.repeat(16);
    const base64 = 'Zk9xR2b7Tq1LmN4pWv8Yc3Hs6Ju0Ke5Dg2Fa9Xo';
    expect(sanitizeDeweePageContext({
      key: 'k', value: 'v', pwd: 'p', accessKey: 'a', signature: 's',
      digest: `sha256:${hex64}`, blob: `token=${base64}`,
      commit: '0123456789abcdef0123456789abcdef01234567',
      route: '/workspaces/ws_abc/terminal-sessions', slug: 'cloud-harness-operator-dashboard-webchat-session'
    })).toEqual({
      key: '[redacted]', value: '[redacted]', pwd: '[redacted]', accessKey: '[redacted]', signature: '[redacted]',
      digest: 'sha256:[redacted]', blob: 'token=[redacted]',
      commit: '0123456789abcdef0123456789abcdef01234567',
      route: '/workspaces/ws_abc/terminal-sessions', slug: 'cloud-harness-operator-dashboard-webchat-session'
    });
  });

  it('keeps public resource ids in ids and routes', () => {
    for (let index = 0; index < 200; index += 1) {
      const workspaceId = `ws_${randomBytes(24).toString('base64url')}`;
      const agentId = `agent_${randomBytes(24).toString('base64url')}`;
      const context = { route: `/dashboard/workspaces/${workspaceId}/files`, workspaceId, note: `agent ${agentId} on ${workspaceId}` };
      expect(sanitizeDeweePageContext(context)).toEqual(context);
    }
  });

  it('still redacts random tokens beside ids and credential-bearing prefixes', () => {
    const workspaceId = `ws_${randomBytes(24).toString('base64url')}`;
    const token = 'Zk9xR2b7Tq1LmN4pWv8Yc3Hs6Ju0Ke5Dg2Fa9Xo';
    const lease = 'lease_Qm3xT8vLk2Rz7Wn4Yp9Hc6Js1Fd5Gb0A';
    expect(sanitizeDeweePageContext({ route: `/dashboard/workspaces/${workspaceId}/${token}`, bare: token, lease, accessKey: 'a', value: 'v' })).toEqual({
      route: `/dashboard/workspaces/${workspaceId}/[redacted]`, bare: '[redacted]', lease: '[redacted]', accessKey: '[redacted]', value: '[redacted]'
    });
  });

  it('keeps a real id of every generator shape, including hex ids it does not list', () => {
    const base64url = (bytes: number) => randomBytes(bytes).toString('base64url');
    const hex = (bytes: number) => randomBytes(bytes).toString('hex');
    for (let index = 0; index < 50; index += 1) {
      const ids = [
        ...['ws', 'agent', 'task', 'sess', 'term', 'art', 'env', 'prj', 'mcps', 'mcpg', 'msp', 'prn'].map((prefix) => `${prefix}_${base64url(24)}`),
        ...['rc', 'mem', 'dlv'].map((prefix) => `${prefix}_${base64url(16)}`),
        `mcpt_${base64url(32).slice(0, 24)}`,
        ...['sk', 'skrev', 'skset', 'skjob', 'cred'].map((prefix) => `${prefix}_${hex(16)}`),
        `kn_${hex(12)}`, `knl_${hex(12)}`, `icr_${randomUUID().replaceAll('-', '')}`, `evt_${hex(16)}`
      ];
      const context = { ids, route: `/dashboard/${ids.join('/')}` };
      expect(sanitizeDeweePageContext(context)).toEqual(context);
    }
  });

  it('gives no id pass to look-alike keys or over-long ids', () => {
    const random = 'Zk9xR2b7Tq1LmN4pWv8Yc3Hs6Ju0Ke5Dg2Fa9Xo';
    expect(sanitizeDeweePageContext({
      live: `sk_live_${random}`, test: `sk_test_${random}`, long: `ws_${random}${random.slice(0, 24)}`
    })).toEqual({ live: '[redacted]', test: '[redacted]', long: '[redacted]' });
  });

  it('is not confused by private-use characters in the input', () => {
    const workspaceId = `ws_${randomBytes(24).toString('base64url')}`;
    const note = `\uE0000\uE001 ${workspaceId} \uE0001\uE001 \uE0009\uE001`;
    expect(sanitizeDeweePageContext({ note })).toEqual({ note });
  });

  it('measures the context before and after sanitizing', () => {
    expect(serializeDeweePageContext(undefined)).toBeUndefined();
    expect(serializeDeweePageContext({ a: 1 })).toBe('{"a":1}');
    expect(() => serializeDeweePageContext({ blob: 'x'.repeat(4_097) })).toThrow(expect.objectContaining({ code: 'context_too_large', status: 413 }));
    const manyShortSecrets = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`csrf${index}`, 1]));
    expect(() => serializeDeweePageContext(manyShortSecrets)).toThrow(expect.objectContaining({ code: 'context_too_large' }));
  });
});
