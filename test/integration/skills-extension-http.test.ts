import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client, ProtocolError, SdkHttpError, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { SKILLS_EXTENSION_ID, TOOL_SPECS, type ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';

const token = 'integration-bearer-token-longer-than-32-characters';
const skillBody = '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n';
const assetBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const skillUri = 'skill://cloud-harness/owner/demo/SKILL.md';
const assetUri = 'skill://cloud-harness/owner/demo/assets/logo.png';
const demoSkill = {
  uri: skillUri,
  frontmatter: { name: 'demo', description: 'Demo skill', 'allowed-tools': 'Bash' },
  resources: [
    { uri: skillUri, digest: sha(skillBody), size: Buffer.byteLength(skillBody) },
    { uri: assetUri, digest: sha(assetBytes), size: assetBytes.length }
  ]
};
const builtinSkill = { uri: 'skill://cloud-harness/built-in/other/SKILL.md', frontmatter: { name: 'other', description: 'Built-in' }, resources: 'dynamic' };

type RunnerCall = { path: string; operation: string; input: Record<string, unknown>; principal: unknown };
const runnerCalls: RunnerCall[] = [];
let runnerMode: 'normal' | 'unavailable' = 'normal';
let slowRequestClosed: () => void = () => undefined;
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let endpoint: URL;

const ok = (data: unknown, cursor?: string) => ({ ok: true, message: 'ok', data, truncated: false, ...(cursor ? { cursor } : {}) });
const notFound = { ok: false, message: 'Skill not found', error: { code: 'NOT_FOUND', message: 'Skill not found', retryable: false }, truncated: false };
const unavailable = { ok: false, message: 'Runner is unavailable', error: { code: 'UNAVAILABLE', message: 'Runner is unavailable', retryable: true }, truncated: false };

beforeAll(async () => {
  const runnerApp = express();
  runnerApp.use(express.json());
  runnerApp.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  runnerApp.post(['/v1/operations', '/v1/internal/dashboard-operations'], (request, response) => {
    const { operation, input, principal } = request.body as { operation: string; input: Record<string, unknown>; principal: unknown };
    runnerCalls.push({ path: request.path, operation, input, principal });
    if (request.path === '/v1/operations') {
      response.json({ ok: true, message: 'Stub runner result', data: { operation }, truncated: false });
      return;
    }
    if (runnerMode === 'unavailable') { response.json(unavailable); return; }
    if (operation === 'skills_ext_list') {
      if (input.cursor === 'slow') {
        response.on('close', () => slowRequestClosed());
        return;
      }
      response.json(input.cursor === 'page-2' ? ok({ skills: [builtinSkill] }) : ok({ skills: [demoSkill] }, 'page-2'));
      return;
    }
    if (operation === 'skills_ext_get') { response.json(input.uri === skillUri ? ok({ skill: demoSkill }) : notFound); return; }
    if (operation === 'skills_ext_read') {
      if (input.uri === skillUri) { response.json(ok({ contents: [{ uri: skillUri, mimeType: 'text/markdown', text: skillBody }] })); return; }
      if (input.uri === assetUri) { response.json(ok({ contents: [{ uri: assetUri, mimeType: 'image/png', blob: assetBytes.toString('base64') }] })); return; }
      response.json(notFound);
      return;
    }
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
  endpoint = new URL(`http://127.0.0.1:${apiAddress.port}/mcp`);
});

afterAll(async () => {
  await runtime.close();
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => runner.close(() => resolve()))
  ]);
});

/** Records every raw JSON-RPC response body so wire-level fields can be asserted. */
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

async function connect(mode: 'modern' | 'legacy' = 'modern', bodies: unknown[] = []): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: recordingFetch(bodies)
  });
  const client = new Client(
    { name: 'skills-http-test', version: '1.0.0' },
    { versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' } }
  );
  await client.connect(transport);
  return client;
}

const SkillSchema = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })), z.literal('dynamic')])
});
const ListResult = z.looseObject({ skills: z.array(SkillSchema), nextCursor: z.string().optional() });
const GetResult = z.looseObject({ skill: SkillSchema });

/** JSON-RPC error code, whether surfaced in-band or (for unknown methods) as an HTTP 404 body. */
async function protocolErrorCode(promise: Promise<unknown>): Promise<number | undefined> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  if (error instanceof ProtocolError) return error.code;
  expect(error).toBeInstanceOf(SdkHttpError);
  const text = ((error as SdkHttpError).data as { text?: string } | undefined)?.text ?? '';
  return (JSON.parse(text) as { error?: { code?: number } }).error?.code;
}

function wireResult(bodies: unknown[], predicate: (result: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  for (const body of bodies) {
    const result = (body as { result?: Record<string, unknown> }).result;
    if (result && predicate(result)) return result;
  }
  return undefined;
}

describe('Skills over MCP extension over streamable HTTP', () => {
  it('advertises the extension in server/discover without directory reads and keeps tools unchanged', async () => {
    const bodies: unknown[] = [];
    const client = await connect('modern', bodies);
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
    expect(capabilities?.resources).toBeDefined();
    const discover = wireResult(bodies, (result) => 'capabilities' in result);
    expect(discover).toBeDefined();
    expect((discover!.capabilities as Record<string, unknown>).extensions).toEqual({ [SKILLS_EXTENSION_ID]: {} });
    expect(JSON.stringify(discover)).not.toContain('directoryRead');

    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_SPECS.map((spec) => spec.name));
    expect(await protocolErrorCode(client.request({ method: 'resources/directory/read', params: { uri: skillUri } } as never, z.unknown()))).toBe(-32601);
    await client.close();
  });

  it('round-trips list, get, and read with client-verified digests and cache fields', async () => {
    runnerCalls.length = 0;
    const bodies: unknown[] = [];
    const client = await connect('modern', bodies);

    const firstPage = await client.request({ method: 'skills/list', params: {} }, ListResult);
    expect(firstPage.skills).toEqual([demoSkill]);
    expect(firstPage.nextCursor).toBe('page-2');
    const listWire = wireResult(bodies, (result) => Array.isArray(result.skills));
    expect(listWire).toMatchObject({ resultType: 'complete', ttlMs: 30_000, cacheScope: 'private', nextCursor: 'page-2' });
    const secondPage = await client.request({ method: 'skills/list', params: { cursor: 'page-2' } }, ListResult);
    expect(secondPage.skills).toEqual([builtinSkill]);
    expect(secondPage.nextCursor).toBeUndefined();

    const got = await client.request({ method: 'skills/get', params: { uri: skillUri } }, GetResult);
    expect(got.skill).toEqual(demoSkill);
    expect(wireResult(bodies, (result) => 'skill' in result)).toMatchObject({ resultType: 'complete', ttlMs: 30_000, cacheScope: 'private' });
    const manifest = got.skill.resources;
    if (manifest === 'dynamic') throw new Error('expected static manifest');
    for (const entry of manifest) {
      const read = await client.readResource({ uri: entry.uri });
      const content = read.contents[0]!;
      expect(content.uri).toBe(entry.uri);
      const bytes = 'text' in content && typeof content.text === 'string'
        ? Buffer.from(content.text, 'utf8')
        : Buffer.from((content as { blob: string }).blob, 'base64');
      expect(sha(bytes)).toBe(entry.digest);
      expect(bytes.length).toBe(entry.size);
    }
    expect(wireResult(bodies, (result) => Array.isArray(result.contents))).toMatchObject({ ttlMs: 30_000, cacheScope: 'private' });

    // Reading only reaches the read-only extension operations, scoped to the authenticated owner.
    const skillCalls = runnerCalls.filter((call) => call.operation.startsWith('skills_ext_'));
    expect(runnerCalls.filter((call) => !call.operation.startsWith('skills_ext_'))).toEqual([]);
    expect(skillCalls.map((call) => call.operation)).toEqual(['skills_ext_list', 'skills_ext_list', 'skills_ext_get', 'skills_ext_read', 'skills_ext_read']);
    expect(new Set(skillCalls.map((call) => call.path))).toEqual(new Set(['/v1/internal/dashboard-operations']));
    for (const call of skillCalls) expect(call.principal).toEqual({ kind: 'owner', ownerId: 'owner' });
    expect(skillCalls[1]!.input).toEqual({ limit: 100, cursor: 'page-2' });
    await client.close();
  });

  it('maps unknown URIs and malformed params to -32602 and runner outages to -32603', async () => {
    const client = await connect();
    expect(await protocolErrorCode(client.request({ method: 'skills/get', params: { uri: 'skill://cloud-harness/owner/missing/SKILL.md' } }, GetResult))).toBe(-32602);
    expect(await protocolErrorCode(client.readResource({ uri: 'skill://cloud-harness/owner/demo/missing.txt' }))).toBe(-32602);
    expect(await protocolErrorCode(client.request({ method: 'skills/get', params: {} }, GetResult))).toBe(-32602);
    expect(await protocolErrorCode(client.request({ method: 'skills/get', params: { uri: 'x'.repeat(2_000) } }, GetResult))).toBe(-32602);
    runnerMode = 'unavailable';
    try {
      expect(await protocolErrorCode(client.request({ method: 'skills/list', params: {} }, ListResult))).toBe(-32603);
    } finally {
      runnerMode = 'normal';
    }
    await client.close();
  });

  it('aborts the runner call when the client cancels', async () => {
    const closed = new Promise<void>((resolve) => { slowRequestClosed = resolve; });
    const client = await connect();
    const controller = new AbortController();
    const pending = client.request({ method: 'skills/list', params: { cursor: 'slow' } }, ListResult, { signal: controller.signal });
    await expect.poll(() => runnerCalls.some((call) => call.input.cursor === 'slow')).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await closed;
    await client.close();
  });

  it('keeps legacy clients working', async () => {
    const legacy = await connect('legacy');
    expect((await legacy.listTools()).tools).toHaveLength(TOOL_SPECS.length);
    const result = await legacy.callTool({ name: 'workspace_list', arguments: {} });
    expect(result.isError).toBe(false);
    await legacy.close();
  });

  it('rejects unauthenticated extension requests before they reach the runner', async () => {
    runnerCalls.length = 0;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skills/list', params: {} })
    });
    expect(response.status).toBe(401);
    expect(runnerCalls).toEqual([]);
  });
});
