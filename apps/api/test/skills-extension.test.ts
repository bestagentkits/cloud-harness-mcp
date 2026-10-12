import { createHash } from 'node:crypto';
import { Client, ProtocolError } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_EXTENSION_MAX_BYTES,
  TOOL_SPECS,
  WorkspaceIdSchema,
  type RunnerPrincipalSelector,
  type RunnerResponse,
  type WorkspaceId
} from '@cloud-harness/contracts';
import { bindWorkspace, createCloudHarnessServer, createCloudHarnessServerFactory, createWorkspaceBoundServerFactory } from '../src/mcp-server.js';
import type { OperationBackend } from '../src/operation-backend.js';
import type { RunnerClient } from '../src/runner-client.js';

const skillBody = '---\nname: demo\ndescription: Demo skill\n---\n# Demo\nRun `rm -rf /` never.\n';
const scriptBytes = Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0x00, 0xff]);
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const skillUri = 'skill://cloud-harness/owner/demo/SKILL.md';
const scriptUri = 'skill://cloud-harness/owner/demo/scripts/run.sh';
const demoSkill = {
  uri: skillUri,
  frontmatter: { name: 'demo', description: 'Demo skill' },
  resources: [
    { uri: skillUri, digest: sha(skillBody), size: Buffer.byteLength(skillBody) },
    { uri: scriptUri, digest: sha(scriptBytes), size: scriptBytes.length }
  ]
};
const builtinSkill = { uri: 'skill://cloud-harness/built-in/other/SKILL.md', frontmatter: { name: 'other', description: 'Built-in skill' }, resources: 'dynamic' as const };

type Call = { operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector };
type Responder = (call: Call, signal?: AbortSignal) => Promise<RunnerResponse> | RunnerResponse;

const ok = (data: unknown, cursor?: string): RunnerResponse => ({ ok: true, message: 'ok', data, truncated: false, ...(cursor ? { cursor } : {}) });
const fail = (code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE' | 'TIMEOUT' | 'INTERNAL_ERROR', message = 'runner says no'): RunnerResponse =>
  ({ ok: false, message, error: { code, message, retryable: false }, truncated: false });

function defaultResponder(call: Call): RunnerResponse {
  if (call.operation === 'skills_ext_list') {
    return call.input.cursor === 'page-2' ? ok({ skills: [builtinSkill] }) : ok({ skills: [demoSkill] }, 'page-2');
  }
  if (call.operation === 'skills_ext_get') return call.input.uri === skillUri ? ok({ skill: demoSkill }) : fail('NOT_FOUND', 'Skill not found');
  if (call.operation === 'skills_ext_read') {
    if (call.input.uri === skillUri) return ok({ contents: [{ uri: skillUri, mimeType: 'text/markdown', text: skillBody }] });
    if (call.input.uri === scriptUri) return ok({ contents: [{ uri: scriptUri, mimeType: 'application/octet-stream', blob: scriptBytes.toString('base64') }] });
    return fail('NOT_FOUND', 'Resource not found');
  }
  return fail('INTERNAL_ERROR');
}

function fakeRunner(responder: Responder = defaultResponder) {
  const internalCalls: Call[] = [];
  const toolCalls: Call[] = [];
  const client = {
    async call(operation: string, input: Record<string, unknown>, principal: RunnerPrincipalSelector) {
      toolCalls.push({ operation, input, principal });
      return ok({});
    },
    async callInternal(operation: string, input: Record<string, unknown>, principal: RunnerPrincipalSelector, signal?: AbortSignal) {
      const call = { operation, input, principal };
      internalCalls.push(call);
      return await responder(call, signal);
    }
  } as unknown as RunnerClient;
  return { client, internalCalls, toolCalls };
}

const authInfo = (subject: string): AuthInfo => {
  const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject };
  return { token: 'opaque', clientId: subject, scopes: [], extra: { principal, externalPrincipal: { issuer: principal.issuer, subject } } };
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(runnerClient: RunnerClient, subject = 'owner-subject'): Promise<Client> {
  const server = createCloudHarnessServerFactory(runnerClient)({ era: 'modern', authInfo: authInfo(subject) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skills-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

const ResourceSchema = z.object({ uri: z.string(), digest: z.string(), size: z.number() });
const SkillSchema = z.object({ uri: z.string(), frontmatter: z.record(z.string(), z.unknown()), resources: z.union([z.array(ResourceSchema), z.literal('dynamic')]) });
const ListResult = z.looseObject({ skills: z.array(SkillSchema), nextCursor: z.string().optional(), ttlMs: z.number(), cacheScope: z.string() });
const GetResult = z.looseObject({ skill: SkillSchema, ttlMs: z.number(), cacheScope: z.string() });

async function expectProtocolError(promise: Promise<unknown>, code: number): Promise<ProtocolError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProtocolError);
  expect((error as ProtocolError).code).toBe(code);
  return error as ProtocolError;
}

describe('Skills over MCP extension', () => {
  it('advertises the extension and resources capability without directory reads', async () => {
    const { client: runner } = fakeRunner();
    const client = await connect(runner);
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
    expect(capabilities?.resources).toBeDefined();
    expect(JSON.stringify(capabilities)).not.toContain('directoryRead');
    await expectProtocolError(client.request({ method: 'resources/directory/read', params: { uri: skillUri } } as never, z.unknown()), -32601);
  });

  it('keeps the tool surface identical', async () => {
    const { client: runner } = fakeRunner();
    const client = await connect(runner);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_SPECS.map((spec) => spec.name));
    expect(tools.some((tool) => tool.name.startsWith('skills/'))).toBe(false);
  });

  it('round-trips list, get, and read with verifiable digests', async () => {
    const { client: runner, internalCalls, toolCalls } = fakeRunner();
    const client = await connect(runner);

    const firstPage = await client.request({ method: 'skills/list', params: {} }, ListResult);
    expect(firstPage.skills).toEqual([demoSkill]);
    expect(firstPage.nextCursor).toBe('page-2');
    expect(firstPage).toMatchObject({ ttlMs: 30_000, cacheScope: 'private' });
    const secondPage = await client.request({ method: 'skills/list', params: { cursor: 'page-2' } }, ListResult);
    expect(secondPage.skills).toEqual([builtinSkill]);
    expect(secondPage.nextCursor).toBeUndefined();

    const got = await client.request({ method: 'skills/get', params: { uri: skillUri } }, GetResult);
    expect(got.skill).toEqual(demoSkill);
    const manifest = got.skill.resources;
    if (manifest === 'dynamic') throw new Error('expected static manifest');
    for (const entry of manifest) {
      const read = await client.readResource({ uri: entry.uri });
      expect(read.contents).toHaveLength(1);
      const content = read.contents[0]!;
      const bytes = 'text' in content && typeof content.text === 'string'
        ? Buffer.from(content.text, 'utf8')
        : Buffer.from((content as { blob: string }).blob, 'base64');
      expect(sha(bytes)).toBe(entry.digest);
      expect(bytes.length).toBe(entry.size);
    }

    // Reading only reaches the three read-only extension operations; nothing executes.
    expect(toolCalls).toEqual([]);
    expect(internalCalls.map((call) => call.operation)).toEqual([
      'skills_ext_list', 'skills_ext_list', 'skills_ext_get', 'skills_ext_read', 'skills_ext_read'
    ]);
    expect(internalCalls[0]!.input).toEqual({ limit: 100 });
    expect(internalCalls[1]!.input).toEqual({ limit: 100, cursor: 'page-2' });
  });

  it('never forwards a client-supplied digest pin to the runner', async () => {
    const { client: runner, internalCalls } = fakeRunner();
    const client = await connect(runner);
    const pin = `sha256:${'0'.repeat(64)}`;
    await client.request({ method: 'resources/read', params: { uri: skillUri, expectedDigest: pin } } as never, z.unknown());
    expect(internalCalls.map((call) => call.input)).toEqual([{ uri: skillUri }]);
  });

  it('maps unknown or invalid URIs and malformed params to invalid params', async () => {
    const { client: runner, internalCalls } = fakeRunner();
    const client = await connect(runner);
    await expectProtocolError(client.request({ method: 'skills/get', params: { uri: 'skill://cloud-harness/owner/missing/SKILL.md' } }, GetResult), -32602);
    await expectProtocolError(client.readResource({ uri: 'skill://cloud-harness/owner/missing/file.txt' }), -32602);
    const callsBeforeMalformed = internalCalls.length;
    await expectProtocolError(client.request({ method: 'skills/get', params: {} }, GetResult), -32602);
    await expectProtocolError(client.request({ method: 'skills/get', params: { uri: 42 } } as never, GetResult), -32602);
    await expectProtocolError(client.request({ method: 'skills/list', params: { cursor: 'x'.repeat(300) } }, ListResult), -32602);
    await expectProtocolError(client.request({ method: 'skills/get', params: { uri: 'skill://has space' } }, GetResult), -32602);
    expect(internalCalls).toHaveLength(callsBeforeMalformed);
  });

  it('maps runner failures and malformed runner data to internal errors without leaking detail', async () => {
    for (const responder of [
      () => fail('UNAVAILABLE', 'runner at http://10.0.0.5 down'),
      () => fail('TIMEOUT'),
      () => { throw new Error('schema rejected operation'); },
      () => ok({ skills: [{ uri: skillUri }] }),
      () => ok({ skills: [{ ...demoSkill, resources: [{ uri: skillUri, digest: 'md5:abc', size: 1 }] }] })
    ] satisfies Responder[]) {
      const { client: runner } = fakeRunner(responder);
      const client = await connect(runner);
      const error = await expectProtocolError(client.request({ method: 'skills/list', params: {} }, ListResult), -32603);
      expect(error.message).not.toContain('10.0.0.5');
    }
  });

  it('answers resources/list and resources/templates/list empty without calling the runner', async () => {
    const { client: runner, internalCalls, toolCalls } = fakeRunner();
    const client = await connect(runner);
    const resources = await client.request({ method: 'resources/list', params: {} }, z.looseObject({ resources: z.array(z.unknown()), ttlMs: z.number(), cacheScope: z.string() }));
    expect(resources).toMatchObject({ resources: [], ttlMs: 30_000, cacheScope: 'private' });
    expect(resources.nextCursor).toBeUndefined();
    const templates = await client.request({ method: 'resources/templates/list', params: {} }, z.looseObject({ resourceTemplates: z.array(z.unknown()), ttlMs: z.number(), cacheScope: z.string() }));
    expect(templates).toMatchObject({ resourceTemplates: [], ttlMs: 30_000, cacheScope: 'private' });
    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect(internalCalls).toEqual([]);
    expect(toolCalls).toEqual([]);
  });

  it('rejects oversized runner payloads', async () => {
    const huge = 'a'.repeat(21 * 1024 * 1024);
    const { client: runner } = fakeRunner(() => ok({ contents: [{ uri: skillUri, text: huge }] }));
    const client = await connect(runner);
    await expectProtocolError(client.readResource({ uri: skillUri }), -32603);
  });

  it('serves a binary file at the per-skill size limit despite base64 expansion, and rejects one byte more', async () => {
    const limit = SKILLS_EXTENSION_MAX_BYTES;
    const atLimit = Buffer.alloc(limit, 0xff);
    const { client: runner } = fakeRunner(() => ok({ contents: [{ uri: scriptUri, mimeType: 'application/octet-stream', blob: atLimit.toString('base64') }] }));
    const client = await connect(runner);
    const read = await client.readResource({ uri: scriptUri });
    const blob = (read.contents[0] as { blob: string }).blob;
    expect(blob.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(Buffer.from(blob, 'base64').equals(atLimit)).toBe(true);

    const overLimit = Buffer.alloc(limit + 1, 0xff).toString('base64');
    const { client: overRunner } = fakeRunner(() => ok({ contents: [{ uri: scriptUri, mimeType: 'application/octet-stream', blob: overLimit }] }));
    const overClient = await connect(overRunner);
    await expectProtocolError(overClient.readResource({ uri: scriptUri }), -32603);
  });

  it('treats a missing principal as an internal error without calling the runner', async () => {
    const { client: runner, internalCalls } = fakeRunner();
    const server = createCloudHarnessServerFactory(runner)({ era: 'modern' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'anonymous', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => { await client.close(); await server.close(); });
    await expectProtocolError(client.request({ method: 'skills/list', params: {} }, ListResult), -32603);
    expect(internalCalls).toEqual([]);
  });

  it('scopes every call to the requesting principal', async () => {
    const { client: runner, internalCalls } = fakeRunner();
    const first = await connect(runner, 'first');
    const second = await connect(runner, 'second');
    await first.request({ method: 'skills/list', params: {} }, ListResult);
    await second.request({ method: 'skills/list', params: {} }, ListResult);
    await first.readResource({ uri: skillUri });
    await second.readResource({ uri: skillUri });
    const subjects = internalCalls.map((call) => call.principal.kind === 'external' ? call.principal.subject : call.principal.ownerId);
    expect(subjects).toEqual(['first', 'second', 'first', 'second']);
  });

  it('propagates client cancellation to the runner call', async () => {
    let runnerSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { client: runner } = fakeRunner(async (_call, signal) => {
      runnerSignal = signal;
      entered();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return fail('UNAVAILABLE');
    });
    const client = await connect(runner);
    const controller = new AbortController();
    const pending = client.request({ method: 'skills/list', params: {} }, ListResult, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(() => runnerSignal?.aborted).toBe(true);
  });

  it('never sends a workspace on the unbound endpoint, even when a client supplies one', async () => {
    const { client: runner, internalCalls } = fakeRunner();
    const client = await connect(runner);
    await client.request({ method: 'skills/list', params: { workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaaaa' } }, ListResult);
    await client.request({ method: 'skills/get', params: { uri: skillUri, workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaaaa' } }, GetResult);
    await client.request({ method: 'resources/read', params: { uri: skillUri, workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaaaa' } }, z.unknown());
    expect(internalCalls).toHaveLength(3);
    for (const call of internalCalls) expect(call.input).not.toHaveProperty('workspaceId');
  });

  it('is not advertised by backends without skills support', async () => {
    const backend: OperationBackend = { call: async () => ok({}) };
    const server = createCloudHarnessServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'local', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => { await client.close(); await server.close(); });
    expect(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID]).toBeUndefined();
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await expectProtocolError(client.request({ method: 'skills/list', params: {} }, ListResult), -32601);
    await expectProtocolError(client.request({ method: 'resources/list', params: {} }, z.unknown()), -32601);
  });
});

describe('workspace-bound Skills over MCP extension', () => {
  const workspaceA = WorkspaceIdSchema.parse('ws_AAAAAAAAAAAAAAAAAAAAAAAA');
  const workspaceB = WorkspaceIdSchema.parse('ws_BBBBBBBBBBBBBBBBBBBBBBBB');

  async function connectBound(runnerClient: RunnerClient, workspaceId: WorkspaceId, subject = 'owner-subject'): Promise<Client> {
    const server = createWorkspaceBoundServerFactory(runnerClient)({ era: 'modern', authInfo: bindWorkspace(authInfo(subject), workspaceId) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'skills-bound-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => { await client.close(); await server.close(); });
    return client;
  }

  it('advertises the extension and keeps the tool surface identical to the unbound endpoint', async () => {
    const { client: runner } = fakeRunner();
    const bound = await connectBound(runner, workspaceA);
    const unbound = await connect(runner);
    expect(bound.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
    expect((await bound.listTools()).tools).toEqual((await unbound.listTools()).tools);
  });

  it('sends the bound workspace on every extension call', async () => {
    const { client: runner, internalCalls, toolCalls } = fakeRunner();
    const client = await connectBound(runner, workspaceA);
    await client.request({ method: 'skills/list', params: {} }, ListResult);
    await client.request({ method: 'skills/list', params: { cursor: 'page-2' } }, ListResult);
    await client.request({ method: 'skills/get', params: { uri: skillUri } }, GetResult);
    await client.readResource({ uri: skillUri });
    expect(toolCalls).toEqual([]);
    expect(internalCalls.map((call) => call.input)).toEqual([
      { limit: 100, workspaceId: workspaceA },
      { limit: 100, cursor: 'page-2', workspaceId: workspaceA },
      { uri: skillUri, workspaceId: workspaceA },
      { uri: skillUri, workspaceId: workspaceA }
    ]);
  });

  it('does not let request params override the bound workspace', async () => {
    const { client: runner, internalCalls } = fakeRunner();
    const client = await connectBound(runner, workspaceA);
    await client.request({ method: 'skills/list', params: { workspaceId: workspaceB } }, ListResult);
    await client.request({ method: 'skills/get', params: { uri: skillUri, workspaceId: workspaceB } }, GetResult);
    await client.request({ method: 'resources/read', params: { uri: skillUri, workspaceId: workspaceB } }, z.unknown());
    expect(internalCalls.map((call) => call.input.workspaceId)).toEqual([workspaceA, workspaceA, workspaceA]);
  });

  it('keeps concurrent requests bound to their own workspaces', async () => {
    const { client: runner, internalCalls } = fakeRunner(async (call) => {
      // Interleave the two workspaces' calls so a shared binding would surface as a crossed result.
      await new Promise((resolve) => setTimeout(resolve, call.input.workspaceId === workspaceA ? 15 : 1));
      return ok({ skills: [{ ...builtinSkill, frontmatter: { name: 'other', description: String(call.input.workspaceId) } }] });
    });
    const first = await connectBound(runner, workspaceA, 'first');
    const second = await connectBound(runner, workspaceB, 'second');
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? first : second)
      .request({ method: 'skills/list', params: {} }, ListResult)));
    results.forEach((result, index) => expect(result.skills[0]!.frontmatter.description).toBe(index % 2 === 0 ? workspaceA : workspaceB));
    for (const call of internalCalls) {
      const subject = call.principal.kind === 'external' ? call.principal.subject : undefined;
      expect(call.input.workspaceId).toBe(subject === 'first' ? workspaceA : workspaceB);
    }
  });

  it('maps an unavailable workspace to invalid params', async () => {
    const { client: runner } = fakeRunner(() => fail('NOT_FOUND', 'Workspace not available'));
    const client = await connectBound(runner, workspaceA);
    const error = await expectProtocolError(client.request({ method: 'skills/list', params: {} }, ListResult), -32602);
    expect(error.message).toContain('Workspace not available');
  });

  it('maps a skill that changed under a read to a refresh hint without echoing runner detail', async () => {
    const { client: runner } = fakeRunner(() => fail('CONFLICT', 'skill://cloud-harness/workspace/x changed at /srv/jobs/abc'));
    const client = await connectBound(runner, workspaceA);
    const error = await expectProtocolError(client.readResource({ uri: skillUri }), -32603);
    expect(error.message).toContain('Skill changed; refresh it with skills/get');
    expect(error.message).not.toContain('/srv/jobs');
  });

  it('fails closed when the binding is missing or malformed', () => {
    const { client: runner } = fakeRunner();
    const factory = createWorkspaceBoundServerFactory(runner);
    expect(() => factory({ era: 'modern', authInfo: authInfo('owner-subject') })).toThrow();
    const malformed = authInfo('owner-subject');
    malformed.extra = { ...malformed.extra, cloudHarnessSkillsWorkspace: 'ws_short' };
    expect(() => factory({ era: 'modern', authInfo: malformed })).toThrow();
  });
});
