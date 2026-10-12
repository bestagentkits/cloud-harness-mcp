import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { SKILLS_EXTENSION_ID, type ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';

const token = 'integration-bearer-token-longer-than-32-characters';
const workspaceA = 'ws_AAAAAAAAAAAAAAAAAAAAAAAA';
const workspaceB = 'ws_BBBBBBBBBBBBBBBBBBBBBBBB';
const skillUri = 'skill://cloud-harness/owner/demo/SKILL.md';
const skillBody = '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n';

type RunnerCall = { operation: string; input: Record<string, unknown>; principal: unknown };
const runnerCalls: RunnerCall[] = [];
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let base: string;

const ok = (data: unknown) => ({ ok: true, message: 'ok', data, truncated: false });
const notFound = (message: string) => ({ ok: false, message, error: { code: 'NOT_FOUND', message, retryable: false }, truncated: false });
/** Each skill names the workspace the runner was asked about, so a crossed binding is visible in the response. */
const skillFor = (workspaceId: unknown) => ({
  uri: 'skill://cloud-harness/built-in/other/SKILL.md',
  frontmatter: { name: 'other', description: typeof workspaceId === 'string' ? workspaceId : 'unbound' },
  resources: 'dynamic'
});

beforeAll(async () => {
  const runnerApp = express();
  runnerApp.use(express.json());
  runnerApp.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  runnerApp.post(['/v1/operations', '/v1/internal/dashboard-operations'], async (request, response) => {
    const { operation, input, principal } = request.body as RunnerCall;
    runnerCalls.push({ operation, input, principal });
    if (request.path === '/v1/operations') {
      response.json({ ok: true, message: 'Stub runner result', data: { operation }, truncated: false });
      return;
    }
    // Delay workspace A so concurrent requests for A and B interleave inside the API.
    await new Promise((resolve) => setTimeout(resolve, input.workspaceId === workspaceA ? 20 : 1));
    if (input.workspaceId === 'ws_CCCCCCCCCCCCCCCCCCCCCCCC') { response.json(notFound('Workspace not available')); return; }
    if (operation === 'skills_ext_list') { response.json(ok({ skills: [skillFor(input.workspaceId)] })); return; }
    if (operation === 'skills_ext_get') { response.json(ok({ skill: skillFor(input.workspaceId) })); return; }
    if (operation === 'skills_ext_read') { response.json(ok({ contents: [{ uri: skillUri, mimeType: 'text/markdown', text: skillBody }] })); return; }
    response.status(400).json({ ok: false, message: 'unexpected', error: { code: 'INVALID_INPUT', message: 'unexpected', retryable: false }, truncated: false });
  });
  runner = createServer(runnerApp);
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  const runnerAddress = runner.address();
  if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('runner failed');
  const config: ApiConfig = {
    host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: token,
    runnerUrl: `http://127.0.0.1:${runnerAddress.port}`, runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 5_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
  };
  runtime = createApiApp(config);
  api = createServer(runtime.app);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('api failed');
  base = `http://127.0.0.1:${apiAddress.port}`;
});

afterAll(async () => {
  await runtime.close();
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => runner.close(() => resolve()))
  ]);
});

function recordingFetch(bodies: unknown[]): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.clone().text();
    const payloads = /^(event|data|id):/m.test(text)
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
      : (text ? [text] : []);
    for (const payload of payloads) {
      try { bodies.push(JSON.parse(payload)); } catch { /* non-JSON transport noise */ }
    }
    return response;
  };
}

async function connect(path: string, bodies: unknown[] = []): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(path, base), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: recordingFetch(bodies)
  });
  const client = new Client({ name: 'skills-bound-http-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  return client;
}

const SkillSchema = z.object({ uri: z.string(), frontmatter: z.record(z.string(), z.unknown()), resources: z.unknown() });
const ListResult = z.looseObject({ skills: z.array(SkillSchema) });
const GetResult = z.looseObject({ skill: SkillSchema });
const skillCalls = () => runnerCalls.filter((call) => call.operation.startsWith('skills_ext_'));

async function rawPost(path: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }, body = '{}'): Promise<Response> {
  return await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body
  });
}

describe('workspace-bound Skills over MCP endpoint', () => {
  it('advertises the extension in server/discover and serves the same tools as /mcp', async () => {
    const bodies: unknown[] = [];
    const bound = await connect(`/mcp/workspaces/${workspaceA}`, bodies);
    const discover = bodies.map((body) => (body as { result?: Record<string, unknown> }).result).find((result) => result && 'capabilities' in result);
    expect((discover?.capabilities as Record<string, unknown> | undefined)?.extensions).toEqual({ [SKILLS_EXTENSION_ID]: {} });
    const unbound = await connect('/mcp');
    expect((await bound.listTools()).tools).toEqual((await unbound.listTools()).tools);
    await Promise.all([bound.close(), unbound.close()]);
  });

  it('passes the bound workspace on every extension call and none on /mcp', async () => {
    runnerCalls.length = 0;
    const bound = await connect(`/mcp/workspaces/${workspaceA}`);
    expect((await bound.request({ method: 'skills/list', params: {} }, ListResult)).skills[0]!.frontmatter.description).toBe(workspaceA);
    await bound.request({ method: 'skills/get', params: { uri: skillUri } }, GetResult);
    await bound.readResource({ uri: skillUri });
    expect(skillCalls().map((call) => [call.operation, call.input.workspaceId])).toEqual([
      ['skills_ext_list', workspaceA], ['skills_ext_get', workspaceA], ['skills_ext_read', workspaceA]
    ]);
    for (const call of skillCalls()) expect(call.principal).toEqual({ kind: 'owner', ownerId: 'owner' });

    runnerCalls.length = 0;
    const unbound = await connect('/mcp');
    expect((await unbound.request({ method: 'skills/list', params: {} }, ListResult)).skills[0]!.frontmatter.description).toBe('unbound');
    await unbound.readResource({ uri: skillUri });
    expect(skillCalls()).toHaveLength(2);
    for (const call of skillCalls()) expect(call.input).not.toHaveProperty('workspaceId');
    await Promise.all([bound.close(), unbound.close()]);
  });

  it('does not let a client override the binding through request params', async () => {
    runnerCalls.length = 0;
    const bound = await connect(`/mcp/workspaces/${workspaceA}`);
    await bound.request({ method: 'skills/list', params: { workspaceId: workspaceB } }, ListResult);
    await bound.request({ method: 'skills/get', params: { uri: skillUri, workspaceId: workspaceB } }, GetResult);
    await bound.request({ method: 'resources/read', params: { uri: skillUri, workspaceId: workspaceB } }, z.unknown());
    expect(skillCalls().map((call) => call.input.workspaceId)).toEqual([workspaceA, workspaceA, workspaceA]);
    await bound.close();
  });

  it('never crosses bindings between concurrent requests to different workspaces', async () => {
    const [first, second] = await Promise.all([connect(`/mcp/workspaces/${workspaceA}`), connect(`/mcp/workspaces/${workspaceB}`)]);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? first : second)
      .request({ method: 'skills/list', params: {} }, ListResult)));
    results.forEach((result, index) => expect(result.skills[0]!.frontmatter.description).toBe(index % 2 === 0 ? workspaceA : workspaceB));
    await Promise.all([first.close(), second.close()]);
  });

  it('maps an unavailable workspace to invalid params', async () => {
    const bound = await connect('/mcp/workspaces/ws_CCCCCCCCCCCCCCCCCCCCCCCC');
    const error = await bound.request({ method: 'skills/list', params: {} }, ListResult).then(() => undefined, (caught: unknown) => caught);
    expect((error as { code?: number }).code).toBe(-32602);
    await bound.close();
  });

  it('rejects malformed workspace ids before reaching the runner', async () => {
    runnerCalls.length = 0;
    for (const path of [
      '/mcp/workspaces/not-a-workspace',
      '/mcp/workspaces/ws_short',
      `/mcp/workspaces/op_${'A'.repeat(24)}`,
      `/mcp/workspaces/ws_${'A'.repeat(81)}`,
      `/mcp/workspaces/ws_${'A'.repeat(12)}%2F${'A'.repeat(12)}`,
      `/mcp/workspaces/ws_${'A'.repeat(12)}%00${'A'.repeat(12)}`
    ]) {
      const response = await rawPost(path);
      expect(response.status, path).toBe(404);
    }
    expect((await rawPost(`/mcp/workspaces/${workspaceA}/extra`)).status).toBe(404);
    expect(runnerCalls).toEqual([]);
  });

  it('rejects unauthenticated and non-JSON requests before reaching the runner', async () => {
    runnerCalls.length = 0;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skills/list', params: {} });
    expect((await rawPost(`/mcp/workspaces/${workspaceA}`, {}, body)).status).toBe(401);
    expect((await rawPost(`/mcp/workspaces/${workspaceA}`, { authorization: 'Bearer wrong-token-wrong-token-wrong-token' }, body)).status).toBe(401);
    expect((await rawPost('/mcp/workspaces/not-a-workspace', {}, body)).status).toBe(401);
    const nonJson = await fetch(new URL(`/mcp/workspaces/${workspaceA}`, base), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body
    });
    expect(nonJson.status).toBe(415);
    expect(runnerCalls).toEqual([]);
  });

  it('applies the /mcp host checks to the bound endpoint and leaves /mcp-gateway separate', async () => {
    const forbidden = await rawPost(`/mcp/workspaces/${workspaceA}`, { authorization: `Bearer ${token}`, origin: 'https://evil.example' });
    expect(forbidden.status).toBe(403);
    expect((await rawPost(`/mcp-gateway/workspaces/${workspaceA}`)).status).toBe(404);
  });
});
