import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOOL_SPECS,
  WORKSPACE_EXPLORER_READ_TOOLS,
  WORKSPACE_EXPLORER_RESOURCE_URI,
  WORKSPACE_EXPLORER_TOOL_NAME,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { createCloudHarnessServer, createCloudHarnessServerFactory } from '../src/mcp-server.js';
import type { OperationBackend } from '../src/operation-backend.js';
import type { RunnerClient } from '../src/runner-client.js';

const WORKSPACE = 'ws_AAAAAAAAAAAAAAAAAAAAAAAA';
const MCP_APP_MIME = 'text/html;profile=mcp-app';
const activeRecord = { workspaceId: WORKSPACE, status: 'ACTIVE', leaseState: 'ACTIVE', ref: 'main', remainingLeaseMs: 3_600_000 };
const ok = (data: unknown): RunnerResponse => ({ ok: true, message: 'ok', data, truncated: false });
const fail = (code: 'NOT_FOUND' | 'EXPIRED', message: string): RunnerResponse => ({ ok: false, message, error: { code, message, retryable: false }, truncated: false });

type Call = { operation: string; input: Record<string, unknown>; principal?: RunnerPrincipalSelector };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-apps-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

function backend(respond: (call: Call) => RunnerResponse = () => ok(activeRecord)) {
  const calls: Call[] = [];
  const value: OperationBackend = {
    call: async (operation, input) => {
      calls.push({ operation, input });
      return respond({ operation, input });
    }
  };
  return { backend: value, calls };
}

function authInfo(subject: string): AuthInfo {
  return { token: 'opaque', clientId: 'client', scopes: ['mcp'], extra: { principal: { kind: 'owner', ownerId: subject } } };
}

describe('MCP Apps workspace explorer', () => {
  it('lists one render tool bound to the versioned view and leaves every native tool without UI metadata', async () => {
    const client = await connect(createCloudHarnessServer(backend().backend));
    const { tools } = await client.listTools();
    const explorer = tools.find((tool) => tool.name === WORKSPACE_EXPLORER_TOOL_NAME);
    expect(explorer?._meta).toMatchObject({
      ui: { resourceUri: WORKSPACE_EXPLORER_RESOURCE_URI },
      'ui/resourceUri': WORKSPACE_EXPLORER_RESOURCE_URI,
      'openai/outputTemplate': WORKSPACE_EXPLORER_RESOURCE_URI
    });
    expect(explorer?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const native = tools.filter((tool) => tool.name !== WORKSPACE_EXPLORER_TOOL_NAME);
    expect(native.map((tool) => tool.name)).toEqual(TOOL_SPECS.map((spec) => spec.name));
    for (const tool of native) expect(tool._meta, tool.name).toBeUndefined();
  });

  it('serves a self-contained view with the MCP Apps MIME type and no network origins', async () => {
    const client = await connect(createCloudHarnessServer(backend().backend));
    const listed = (await client.listResources()).resources;
    expect(listed).toEqual([expect.objectContaining({ uri: WORKSPACE_EXPLORER_RESOURCE_URI, mimeType: MCP_APP_MIME })]);
    const { contents } = await client.readResource({ uri: WORKSPACE_EXPLORER_RESOURCE_URI });
    expect(contents).toHaveLength(1);
    const [content] = contents;
    expect(content).toMatchObject({ uri: WORKSPACE_EXPLORER_RESOURCE_URI, mimeType: MCP_APP_MIME, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
    const html = 'text' in content ? content.text : '';
    expect(html).toMatch(/^<!doctype html>/u);
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).not.toMatch(/<link[^>]+href=/iu);
    expect(html.match(/<\/script/giu)).toHaveLength(1);
  });

  it('serves the same view to every principal, so it can carry no credential or per-user data', async () => {
    const runner = { call: async () => ok(activeRecord) } as unknown as RunnerClient;
    const factory = createCloudHarnessServerFactory(runner);
    const read = async (subject: string) => {
      const client = await connect(factory({ era: 'modern', authInfo: authInfo(subject) }));
      const [content] = (await client.readResource({ uri: WORKSPACE_EXPLORER_RESOURCE_URI })).contents;
      return 'text' in content ? content.text : '';
    };
    const [first, second] = [await read('owner-a'), await read('owner-b')];
    expect(first).toBe(second);
    expect(first).not.toMatch(/owner-a|opaque|bearer /iu);
  });

  it('reads only workspace_status for the caller and returns the record with the requested view', async () => {
    const { backend: fake, calls } = backend();
    const client = await connect(createCloudHarnessServer(fake));
    const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL_NAME, arguments: { workspaceId: WORKSPACE, view: 'git', repositoryId: 'api' } });
    expect(calls).toEqual([{ operation: 'workspace_status', input: { workspaceId: WORKSPACE } }]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true, data: { view: 'git', repositoryId: 'api', workspace: activeRecord } });
    expect(result.content).toEqual([expect.objectContaining({ type: 'text' })]);
  });

  it('defaults to the files view and the active workspace', async () => {
    const { backend: fake, calls } = backend();
    const client = await connect(createCloudHarnessServer(fake));
    const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL_NAME, arguments: {} });
    expect(calls).toEqual([{ operation: 'workspace_status', input: {} }]);
    expect(result.structuredContent).toMatchObject({ ok: true, data: { view: 'files' } });
  });

  it('passes authorization and lifecycle failures through unchanged as tool errors', async () => {
    for (const failure of [fail('NOT_FOUND', 'workspace not found'), fail('EXPIRED', 'workspace lease expired')]) {
      const client = await connect(createCloudHarnessServer(backend(() => failure).backend));
      const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL_NAME, arguments: { workspaceId: WORKSPACE } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(failure);
    }
  });

  it('rejects malformed input before reaching the backend', async () => {
    const { backend: fake, calls } = backend();
    const client = await connect(createCloudHarnessServer(fake));
    for (const args of [{ workspaceId: '../ws' }, { view: 'terminal' }, { repositoryId: 'Bad Alias' }]) {
      const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL_NAME, arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('runs as the authenticated principal and fails closed without one', async () => {
    const seen: Array<RunnerPrincipalSelector | undefined> = [];
    const runner = { call: async (_operation: string, _input: unknown, principal: RunnerPrincipalSelector) => { seen.push(principal); return ok(activeRecord); } } as unknown as RunnerClient;
    const factory = createCloudHarnessServerFactory(runner);
    const owner = await connect(factory({ era: 'modern', authInfo: authInfo('owner-a') }));
    await owner.callTool({ name: WORKSPACE_EXPLORER_TOOL_NAME, arguments: { workspaceId: WORKSPACE } });
    expect(seen).toEqual([{ kind: 'owner', ownerId: 'owner-a' }]);

    const anonymous = await connect(factory({ era: 'modern' }));
    const result = await anonymous.callTool({ name: WORKSPACE_EXPLORER_TOOL_NAME, arguments: { workspaceId: WORKSPACE } });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'AUTHENTICATION_FAILED' } });
    expect(seen).toHaveLength(1);
  });
});

describe('workspace explorer view source', () => {
  const source = readFile(new URL('../mcp-apps/workspace-explorer/main.js', import.meta.url), 'utf8');

  it('calls only the read-only native tools named by the contract', async () => {
    const declared = /const READ_TOOLS = new Set\((\[[^\]]*\])\)/u.exec(await source)?.[1];
    expect(JSON.parse((declared ?? '[]').replaceAll("'", '"'))).toEqual([...WORKSPACE_EXPLORER_READ_TOOLS]);
    for (const name of WORKSPACE_EXPLORER_READ_TOOLS) {
      const spec = TOOL_SPECS.find((candidate) => candidate.name === name);
      expect(spec?.readOnly, name).toBe(true);
      expect(spec?.destructive, name).toBe(false);
    }
  });

  it('renders workspace content as text, never as markup or code', async () => {
    const text = await source;
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'fetch(', 'localStorage', 'sessionStorage']) {
      expect(text, sink).not.toContain(sink);
    }
  });
});
