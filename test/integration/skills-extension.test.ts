import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  SKILLS_EXTENSION_ID,
  SkillProtocolRequestSchema,
  TOOL_SPECS,
  type ApiConfig,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { getProtocolSkill, listProtocolSkills, readProtocolSkillFile, type SkillRoots } from '../../apps/runner/src/skill-protocol-reader.js';

const token = 'integration-bearer-token-longer-than-32-characters';
const WORKSPACE = 'ws_aaaaaaaaaaaaaaaaaaaa';
const OTHER_WORKSPACE = 'ws_bbbbbbbbbbbbbbbbbbbb';
const sha = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const document = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody\n`;

let base: string;
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let endpoint: URL;
const runnerCalls: string[] = [];

function writeSkill(root: string, name: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, name, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Mirrors the runner contract: owner skills need a workspace owned by the caller; built-in skills do not. */
async function stubRunner(request: unknown): Promise<RunnerResponse> {
  const parsed = SkillProtocolRequestSchema.parse(request);
  const roots: SkillRoots = { 'built-in': join(base, 'builtin') };
  if (parsed.input.workspaceId) {
    if (parsed.input.workspaceId !== WORKSPACE) return { ok: false, message: 'workspace not found', error: { code: 'NOT_FOUND', message: 'workspace not found', retryable: false }, truncated: false };
    roots.owner = join(base, 'owner');
  }
  try {
    if (parsed.operation === 'skills_protocol_list') {
      return { ok: true, message: 'Skills listed', data: { skills: (await listProtocolSkills(roots)).map((skill) => skill.entry) }, truncated: false };
    }
    if (parsed.operation === 'skills_protocol_get') {
      return { ok: true, message: 'Skill', data: { skill: (await getProtocolSkill(roots, parsed.input.uri)).skill.entry }, truncated: false };
    }
    return { ok: true, message: 'Skill file', data: { content: await readProtocolSkillFile(roots, parsed.input.uri) }, truncated: false };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR';
    return { ok: false, message: 'failed', error: { code: code as 'NOT_FOUND', message: 'failed', retryable: false }, truncated: false };
  }
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'skills-ext-'));
  mkdirSync(join(base, 'builtin'));
  mkdirSync(join(base, 'owner'));
  writeSkill(join(base, 'builtin'), 'demo', {
    'SKILL.md': document('demo', 'license: MIT\nx-custom: kept\n'),
    'references/guide.md': '# Guide\n',
    'scripts/run.sh': '#!/bin/sh\necho ran\n'
  });
  writeSkill(join(base, 'owner'), 'mine', { 'SKILL.md': document('mine'), 'references/notes.md': 'notes' });

  const runnerApp = express();
  runnerApp.use(express.json());
  runnerApp.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  runnerApp.post('/v1/operations', (request, response) => response.json({ ok: true, message: 'Stub', data: { operation: request.body.operation }, truncated: false }));
  runnerApp.post('/v1/internal/dashboard-operations', async (request, response) => {
    runnerCalls.push(`${request.body.operation}:${request.body.principal?.kind}`);
    response.json(await stubRunner(request.body));
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
  rmSync(base, { recursive: true, force: true });
});

const wireBodies: string[] = [];
const capturingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  wireBodies.push(await response.clone().text());
  return response;
};

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'skills-ext-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: capturingFetch, requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } } }));
  return client;
}

const Skill = z.looseObject({ uri: z.string(), frontmatter: z.record(z.string(), z.unknown()), resources: z.array(z.looseObject({ uri: z.string(), digest: z.string(), size: z.number() })) });
const ListResult = z.looseObject({ skills: z.array(Skill), ttlMs: z.number().optional(), cacheScope: z.string().optional() });
const GetResult = z.looseObject({ skill: Skill, ttlMs: z.number().optional(), cacheScope: z.string().optional() });

const list = (client: Client) => client.request({ method: 'skills/list', params: {} } as never, ListResult as never) as Promise<z.infer<typeof ListResult>>;
const get = (client: Client, uri: string) => client.request({ method: 'skills/get', params: { uri } } as never, GetResult as never) as Promise<z.infer<typeof GetResult>>;
const read = (client: Client, uri: string) => client.readResource({ uri });

describe('Skills over MCP (SEP-2640)', () => {
  it('advertises the extension and the resources capability at discovery', async () => {
    const client = await connect();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
    expect(capabilities?.resources).toBeDefined();
    await client.close();
  });

  it('completes list → get → read and the client can verify every digest', async () => {
    const client = await connect();
    wireBodies.length = 0;
    const listed = await list(client);
    const wire = wireBodies.find((body) => body.includes('"skills"')) ?? '';
    expect(wire).toContain('"resultType":"complete"');
    expect(wire).toMatch(/"ttlMs":\d+/);
    expect(wire).toContain('"cacheScope":"private"');
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills.map((skill) => skill.uri)).toEqual(['skill://built-in/demo/SKILL.md']);

    const { skill } = await get(client, 'skill://built-in/demo/SKILL.md');
    expect(skill.frontmatter).toMatchObject({ name: 'demo', description: 'Does demo', license: 'MIT', 'x-custom': 'kept' });
    expect(skill.resources.map((resource) => resource.uri)).toContain('skill://built-in/demo/references/guide.md');
    expect(skill.resources.map((resource) => resource.uri)).toContain('skill://built-in/demo/scripts/run.sh');

    for (const resource of skill.resources) {
      const { contents } = await read(client, resource.uri);
      const entry = contents[0]!;
      const bytes = 'text' in entry ? Buffer.from(entry.text, 'utf8') : Buffer.from(entry.blob, 'base64');
      expect(bytes.length).toBe(resource.size);
      expect(sha(bytes)).toBe(resource.digest);
    }
    const skillMd = await read(client, 'skill://built-in/demo/SKILL.md');
    expect(skillMd.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    await client.close();
  });

  it('serves skills/get for a URI never listed in a prior call, and rejects unknown ones with -32602', async () => {
    const client = await connect();
    await expect(get(client, 'skill://built-in/demo/SKILL.md')).resolves.toBeDefined();
    await expect(get(client, 'skill://built-in/missing/SKILL.md')).rejects.toMatchObject({ code: -32602 });
    await expect(get(client, 'not-a-uri')).rejects.toMatchObject({ code: -32602 });
    await expect(read(client, 'skill://built-in/demo/../../etc/passwd')).rejects.toMatchObject({ code: -32602 });
    await expect(read(client, 'skill://built-in/demo/nope.md')).rejects.toMatchObject({ code: -32602 });
    await client.close();
  });

  it('does not enable directory reads', async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID]).not.toHaveProperty('directoryRead');
    await expect(client.request({ method: 'resources/directory/read', params: { uri: 'skill://built-in/demo' } } as never, z.looseObject({}) as never)).rejects.toBeDefined();
    await client.close();
  });

  it('exposes owner skills only through an explicit, authorized workspace binding', async () => {
    const unbound = await connect();
    expect((await list(unbound)).skills.map((skill) => skill.uri)).not.toContain('skill://owner/mine/SKILL.md');
    await expect(get(unbound, 'skill://owner/mine/SKILL.md')).rejects.toMatchObject({ code: -32602 });
    await unbound.close();

    const bound = await connect({ 'x-cloud-harness-workspace-id': WORKSPACE });
    expect((await list(bound)).skills.map((skill) => skill.uri).sort()).toEqual(['skill://built-in/demo/SKILL.md', 'skill://owner/mine/SKILL.md']);
    const { contents } = await read(bound, 'skill://owner/mine/references/notes.md');
    expect(contents[0]).toMatchObject({ text: 'notes' });
    await bound.close();

    const foreign = await connect({ 'x-cloud-harness-workspace-id': OTHER_WORKSPACE });
    await expect(list(foreign)).rejects.toMatchObject({ code: -32602 });
    await expect(get(foreign, 'skill://owner/mine/SKILL.md')).rejects.toMatchObject({ code: -32602 });
    await foreign.close();

    const malformed = await connect({ 'x-cloud-harness-workspace-id': 'not a workspace' });
    await expect(list(malformed)).rejects.toMatchObject({ code: -32602 });
    await malformed.close();
  });

  it('never executes anything while serving skills, and leaves the legacy tool surface unchanged', async () => {
    runnerCalls.length = 0;
    const client = await connect();
    await get(client, 'skill://built-in/demo/scripts/../SKILL.md').catch(() => undefined);
    await read(client, 'skill://built-in/demo/scripts/run.sh');
    expect(runnerCalls.every((call) => call.startsWith('skills_protocol_'))).toBe(true);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(TOOL_SPECS.length);
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['skills_list', 'skills_read', 'skills_run']));
    expect(tools.tools.some((tool) => tool.name.startsWith('skills/'))).toBe(false);
    await client.close();
  });

  it('rejects unauthenticated skill requests', async () => {
    const client = new Client({ name: 'anon', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await expect(client.connect(new StreamableHTTPClientTransport(endpoint))).rejects.toBeDefined();
  });
});
