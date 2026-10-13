import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { terminalWaitCapMs } from '../src/dashboard-terminal-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const terminalId = `term_${'t'.repeat(24)}`;
const base = `/api/v1/workspaces/${workspaceId}/terminals`;
const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const baseConfig: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'api-key-audience',
  apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 60_000, maxBodyBytes: 1_048_576,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

const view = {
  terminalId, workspaceId, status: 'running', cwd: '.', cols: 80, rows: 24,
  createdAt: '2026-10-13T00:00:00.000Z', lastActivityAt: '2026-10-13T00:00:01.000Z',
  idleExpiresAt: '2026-10-13T00:30:00.000Z', hardExpiresAt: '2026-10-13T08:00:00.000Z',
  // Runner-internal fields that must never reach the browser.
  pid: 4242, containerName: 'executor-secret', ownerId: 'internal-owner', ptyPath: '/host/jobs/private/pty'
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };
type Call = { operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector; signal?: AbortSignal };
type Handler = (call: Call) => Promise<RunnerResponse>;

let server: Server | undefined;
let port = 0;
let calls: Call[] = [];

const ok = (data: Record<string, unknown>): RunnerResponse => ({ ok: true, message: 'ok', truncated: false, data });
const defaultHandler: Handler = async ({ operation, input }) => {
  if (operation === 'terminal_list') return ok({ terminals: [view], ownerId: 'internal-owner' });
  if (operation === 'terminal_read') return ok({ terminal: view, data: 'aGk=', cursor: String(input.cursor), nextCursor: '2', missedBytes: 0, more: false, hostPath: '/host' });
  if (operation === 'terminal_close') return ok({ ...view, status: 'closed', endedAt: '2026-10-13T00:05:00.000Z', endReason: 'closed by operator' });
  return ok({ ...view, cols: Number(input.cols ?? view.cols), rows: Number(input.rows ?? view.rows) });
};

async function start(options: { handler?: Handler; config?: Partial<ApiConfig>; internal?: boolean } = {}): Promise<void> {
  calls = [];
  const handler = options.handler ?? defaultHandler;
  const runner: DashboardRunnerClient = {
    call: vi.fn(async () => ok({})),
    ...(options.internal === false ? {} : {
      callInternal: vi.fn(async (operation, input, selected, signal) => {
        const call = { operation, input, principal: selected, signal };
        calls.push(call);
        return await handler(call);
      })
    })
  };
  const app = express();
  app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
  app.use('/dashboard', createDashboardRouter({ ...baseConfig, ...options.config }, runner));
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
}

async function stop(): Promise<void> {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => { current.closeAllConnections(); current.close(() => resolve()); });
}

afterEach(stop);

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers: { host: 'dashboard.example', ...options.headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { if (text) json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers as Reply['headers'], text, json });
      });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

async function csrfHeaders(): Promise<Record<string, string>> {
  const session = await send('/api/v1/session');
  const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
  return { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
}

async function post(path: string, payload: unknown, headers?: Record<string, string>): Promise<Reply> {
  return await send(path, { method: 'POST', headers: headers ?? await csrfHeaders(), body: JSON.stringify(payload) });
}

describe('dashboard terminal routes', () => {
  it('dispatches every route to its terminal operation with the session principal and path identity', async () => {
    await start();
    const headers = await csrfHeaders();
    const cases: Array<[string, string, unknown, string, Record<string, unknown>]> = [
      ['POST', base, { cols: 120, rows: 40 }, 'terminal_open', { workspaceId, cwd: '.', cols: 120, rows: 40 }],
      ['POST', `${base}/${terminalId}/input`, { data: 'bHMK' }, 'terminal_input', { workspaceId, terminalId, data: 'bHMK' }],
      ['POST', `${base}/${terminalId}/resize`, { cols: 100, rows: 30 }, 'terminal_resize', { workspaceId, terminalId, cols: 100, rows: 30 }],
      ['POST', `${base}/${terminalId}/close`, {}, 'terminal_close', { workspaceId, terminalId }],
      ['GET', base, undefined, 'terminal_list', { workspaceId }],
      ['GET', '/api/v1/terminals', undefined, 'terminal_list', {}],
      ['GET', `${base}/${terminalId}/output?cursor=7&waitMs=1000`, undefined, 'terminal_read', { workspaceId, terminalId, cursor: '7', waitMs: 1_000 }]
    ];
    for (const [method, path, payload, operation, input] of cases) {
      const response = method === 'GET' ? await send(path) : await post(path, payload, headers);
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.headers['cache-control'], path).toContain('no-store');
      expect(calls.at(-1)?.operation, path).toBe(operation);
      expect(calls.at(-1)?.input, path).toEqual(input);
      expect(calls.at(-1)?.principal, path).toEqual(principal);
    }
  });

  it('refuses a body that names a principal, workspace, or terminal instead of merging it', async () => {
    await start();
    const headers = await csrfHeaders();
    const attempts: Array<[string, Record<string, unknown>]> = [
      [base, { principal: { kind: 'owner' } }],
      [base, { workspaceId: `ws_${'z'.repeat(24)}` }],
      [`${base}/${terminalId}/input`, { data: 'aA==', terminalId: `term_${'z'.repeat(24)}` }],
      [`${base}/${terminalId}/resize`, { cols: 80, rows: 24, owner: 'someone' }],
      [`${base}/${terminalId}/close`, { workspaceId }]
    ];
    for (const [path, payload] of attempts) {
      const response = await post(path, payload, headers);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(response.json.error).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });

  it('validates identifiers, geometry, cwd, and input encoding before reaching the runner', async () => {
    await start();
    const headers = await csrfHeaders();
    const invalid: Array<[string, unknown]> = [
      [`${base}/term_short/input`, { data: 'aA==' }],
      [`/api/v1/workspaces/not-a-workspace/terminals`, {}],
      [base, { cols: 1 }],
      [base, { cols: 501 }],
      [base, { rows: 201 }],
      [base, { cols: 80.5 }],
      [base, { cwd: '../outside' }],
      [base, { cwd: '/etc' }],
      [`${base}/${terminalId}/resize`, { cols: 80 }],
      [`${base}/${terminalId}/resize`, { cols: 600, rows: 24 }],
      [`${base}/${terminalId}/input`, { data: 'not base64!' }],
      [`${base}/${terminalId}/input`, {}]
    ];
    for (const [path, payload] of invalid) {
      const response = await post(path, payload, headers);
      expect(response.status, `${path} ${JSON.stringify(payload)}`).toBe(400);
    }
    expect((await send(`/api/v1/workspaces/${workspaceId}/terminals/bad/output`)).status).toBe(400);
    expect((await send(`${base}/${terminalId}/output?cursor=-1`)).status).toBe(400);
    expect((await send(`${base}/${terminalId}/output?waitMs=-5`)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects input larger than the contract allows', async () => {
    await start();
    // One base64 character over the contract's 64 KiB decoded bound, still well under the JSON body limit.
    const oversized = 'A'.repeat(Math.ceil(65_536 / 3) * 4 + 4);
    const response = await post(`${base}/${terminalId}/input`, { data: oversized });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
    // A body beyond the dashboard JSON limit is refused by the parser before validation.
    const huge = await post(`${base}/${terminalId}/input`, { data: 'A'.repeat(1_100_000) });
    expect(huge.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('enforces origin and CSRF on every terminal mutation', async () => {
    await start();
    const good = await csrfHeaders();
    const paths = [base, `${base}/${terminalId}/input`, `${base}/${terminalId}/resize`, `${base}/${terminalId}/close`];
    for (const path of paths) {
      const noOrigin = await post(path, {}, { ...good, origin: '' });
      expect(noOrigin.status, path).toBe(403);
      const foreign = await post(path, {}, { ...good, origin: 'https://evil.example' });
      expect(foreign.status, path).toBe(403);
      const noToken = await post(path, {}, { ...good, 'x-csrf-token': 'forged' });
      expect(noToken.status, path).toBe(403);
    }
    // Reads are still origin-checked when the browser sends a foreign origin.
    expect((await send(`${base}/${terminalId}/output`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('passes NOT_FOUND through as a 404 with the terminal message', async () => {
    await start({
      handler: async () => ({ ok: false, message: 'missing', truncated: false, error: { code: 'NOT_FOUND', message: 'Terminal term_x was not found for owner internal-owner.', retryable: false } })
    });
    const headers = await csrfHeaders();
    for (const response of [
      await send(`${base}/${terminalId}/output?cursor=0`),
      await post(`${base}/${terminalId}/input`, { data: 'aA==' }, headers),
      await post(`${base}/${terminalId}/resize`, { cols: 80, rows: 24 }, headers),
      await post(`${base}/${terminalId}/close`, {}, headers)
    ]) {
      expect(response.status).toBe(404);
      expect(response.json.message).toBe('This terminal is no longer available.');
      expect(response.text).not.toContain('internal-owner');
    }
  });

  it('maps a runner limit to 429 so the browser can back off', async () => {
    await start({
      handler: async () => ({ ok: false, message: 'busy', truncated: false, error: { code: 'LIMIT_EXCEEDED', message: 'Too many terminal inputs; slow down.', retryable: true } })
    });
    const response = await post(`${base}/${terminalId}/input`, { data: 'aA==' });
    expect(response.status).toBe(429);
  });

  it('caps the long-poll below both the contract maximum and the runner request timeout', async () => {
    expect(terminalWaitCapMs(60_000)).toBe(25_000);
    expect(terminalWaitCapMs(20_000)).toBe(15_000);
    expect(terminalWaitCapMs(2_000)).toBe(0);
    await start();
    await send(`${base}/${terminalId}/output?waitMs=999999`);
    expect(calls.at(-1)?.input.waitMs).toBe(25_000);
    await send(`${base}/${terminalId}/output`);
    expect(calls.at(-1)?.input).toEqual({ workspaceId, terminalId, cursor: '0', waitMs: 0 });
    await stop();
    await start({ config: { requestTimeoutMs: 12_000 } });
    await send(`${base}/${terminalId}/output?waitMs=25000`);
    expect(calls.at(-1)?.input.waitMs).toBe(7_000);
  });

  it('aborts the runner read when the browser disconnects', async () => {
    let observed: AbortSignal | undefined;
    let release: () => void = () => {};
    await start({
      handler: async ({ signal }) => {
        observed = signal;
        await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
        return ok({ terminal: view, data: '', cursor: '0', nextCursor: '0', missedBytes: 0, more: false });
      }
    });
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${base}/${terminalId}/output?waitMs=20000`, headers: { host: 'dashboard.example' } });
    request.on('error', () => undefined);
    request.end();
    await vi.waitFor(() => expect(observed).toBeDefined());
    expect(observed?.aborted).toBe(false);
    request.destroy();
    await vi.waitFor(() => expect(observed?.aborted).toBe(true));
    release();
  });

  it('projects terminal views to the public allow-list', async () => {
    await start();
    const list = await send('/api/v1/terminals');
    expect(list.json.data.terminals[0]).toEqual({
      terminalId, workspaceId, status: 'running', cwd: '.', cols: 80, rows: 24,
      createdAt: view.createdAt, lastActivityAt: view.lastActivityAt, idleExpiresAt: view.idleExpiresAt, hardExpiresAt: view.hardExpiresAt
    });
    const read = await send(`${base}/${terminalId}/output?cursor=0`);
    expect(Object.keys(read.json.data).sort()).toEqual(['cursor', 'data', 'missedBytes', 'more', 'nextCursor', 'terminal']);
    expect(read.json.data.data).toBe('aGk=');
    const closed = await post(`${base}/${terminalId}/close`, {});
    expect(closed.json.data.terminal).toMatchObject({ status: 'closed', endReason: 'closed by operator' });
    for (const text of [list.text, read.text, closed.text]) {
      for (const secret of ['containerName', 'executor-secret', 'internal-owner', 'ptyPath', '/host', 'pid']) expect(text).not.toContain(secret);
    }
  });

  it('answers 503 when the runner client has no internal channel', async () => {
    await start({ internal: false });
    const response = await send(base);
    expect(response.status).toBe(503);
    expect(response.json.error).toBe('terminal_unavailable');
  });
});
