import { readFileSync } from 'node:fs';
import { Client, ProtocolError } from '@modelcontextprotocol/client';
import { InMemoryTransport, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { EXTENSION_ID, RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
  TOOL_SPECS,
  WORKSPACE_EXPLORER_READ_TOOLS,
  WORKSPACE_EXPLORER_TOOL,
  WORKSPACE_EXPLORER_UI_URI,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { createCloudHarnessServer } from '../src/mcp-server.js';
import { buildWorkspaceExplorerHtml } from '../src/mcp-apps.js';
import type { OperationBackend } from '../src/operation-backend.js';
import * as view from '../mcp-apps/workspace-explorer/explorer.js';

const workspaceId = 'ws_abcdefghijklmnopqrstuv';
const otherWorkspaceId = 'ws_zyxwvutsrqponmlkjihgfe';
const ok = (data: unknown, extra: Partial<RunnerResponse> = {}): RunnerResponse => ({ ok: true, message: 'ok', data, truncated: false, ...extra });
const fail = (code: 'EXPIRED' | 'FORBIDDEN' | 'NOT_FOUND', message: string): RunnerResponse =>
  ({ ok: false, message, error: { code, message, retryable: false }, truncated: false });

type Call = { operation: string; input: Record<string, unknown> };

function backend(respond: (call: Call) => RunnerResponse = defaultRespond, skills = false) {
  const calls: Call[] = [];
  const value: OperationBackend = {
    call: async (operation, input) => {
      const call = { operation, input };
      calls.push(call);
      return respond(call);
    },
    ...(skills ? { callSkillsExtension: async () => ok({ contents: [{ uri: 'skill://cloud-harness/owner/demo/SKILL.md', mimeType: 'text/markdown', text: '# demo' }] }) } : {})
  };
  return { backend: value, calls };
}

function defaultRespond(call: Call): RunnerResponse {
  if (call.input.workspaceId !== workspaceId) return fail('NOT_FOUND', 'Workspace not found');
  switch (call.operation) {
    case 'workspace_status': return ok({ workspaceId, status: 'ACTIVE', leaseState: 'ACTIVE', repositoryUrl: 'https://github.com/example/repo.git', ref: 'main' });
    case 'files_list': return ok({ path: '.', entries: [{ name: 'README.md', type: 'file' }] });
    default: return ok({});
  }
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(server: ReturnType<typeof createCloudHarnessServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'apps-host', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('MCP Apps contract constants', () => {
  it('match the official ext-apps SDK', () => {
    expect(MCP_APPS_EXTENSION_ID).toBe(EXTENSION_ID);
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
    expect(RESOURCE_URI_META_KEY).toBe('ui/resourceUri');
    expect(WORKSPACE_EXPLORER_UI_URI).toMatch(/^ui:\/\/cloud-harness\/workspace-explorer-v\d+\.html$/u);
  });

  it('lets the explorer call only read-only, non-destructive, closed-world native tools', () => {
    expect([...view.READ_TOOLS]).toEqual([...WORKSPACE_EXPLORER_READ_TOOLS]);
    for (const name of WORKSPACE_EXPLORER_READ_TOOLS) {
      const spec = TOOL_SPECS.find((entry) => entry.name === name);
      expect(spec, name).toBeDefined();
      expect(spec).toMatchObject({ readOnly: true, destructive: false, openWorld: false });
    }
    for (const forbidden of ['exec_run', 'bash', 'git_push', 'files_delete', 'files_write', 'workspace_close', 'tasks_run', 'shell_open']) {
      expect(view.READ_TOOLS).not.toContain(forbidden);
    }
  });
});

describe('workspace explorer tool', () => {
  it('is listed with its UI link while native tools keep their definitions', async () => {
    const client = await connect(createCloudHarnessServer(backend().backend));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_SPECS.map((spec) => spec.name), WORKSPACE_EXPLORER_TOOL]);
    const explorer = tools.find((tool) => tool.name === WORKSPACE_EXPLORER_TOOL)!;
    expect(explorer._meta).toEqual({ ui: { resourceUri: WORKSPACE_EXPLORER_UI_URI, visibility: ['model', 'app'] }, [RESOURCE_URI_META_KEY]: WORKSPACE_EXPLORER_UI_URI });
    expect(explorer.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(explorer.inputSchema.required).toEqual(['workspaceId']);
    for (const tool of tools.filter((entry) => entry.name !== WORKSPACE_EXPLORER_TOOL)) expect(tool._meta, tool.name).toBeUndefined();
  });

  it('answers exactly like workspace_status, with a text fallback, for only the requested workspace', async () => {
    const { backend: value, calls } = backend();
    const client = await connect(createCloudHarnessServer(value));
    const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL, arguments: { workspaceId } });
    expect(calls).toEqual([{ operation: 'workspace_status', input: { workspaceId } }]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true, data: { workspaceId, leaseState: 'ACTIVE' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain(workspaceId);
  });

  it('reports runner denials and expiry as tool errors without reaching other operations', async () => {
    const { backend: value, calls } = backend(() => fail('EXPIRED', 'Workspace lease expired'));
    const client = await connect(createCloudHarnessServer(value));
    const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL, arguments: { workspaceId } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'EXPIRED' } });
    expect(calls.map((call) => call.operation)).toEqual(['workspace_status']);
  });

  it('rejects malformed workspace IDs and extra arguments before reaching the runner', async () => {
    const { backend: value, calls } = backend();
    const client = await connect(createCloudHarnessServer(value));
    for (const args of [{ workspaceId: '../ws' }, { workspaceId, repositoryId: 'repo_x', command: 'rm -rf /' }, {}]) {
      const result = await client.callTool({ name: WORKSPACE_EXPLORER_TOOL, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe('workspace explorer resource', () => {
  const html = buildWorkspaceExplorerHtml();

  it('is a self-contained page with no remote origins or inline handlers', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('__CH_');
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).not.toMatch(/<link[^>]+href=/iu);
    expect(html).not.toMatch(/https?:\/\/(?!github\.com\/example)/iu);
    expect(html).not.toMatch(/\son[a-z]+=/iu);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u);
    expect(html).not.toMatch(/ui\/update-model-context|ui\/message|ui\/open-link/u);
    expect(html.match(/<script type="module">/gu)).toHaveLength(1);
    // Notices, badges, and the repository picker rely on `hidden`; a component display rule must not override it.
    expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/u);
  });

  it('is listed and served with the MCP Apps MIME type and an empty origin allowlist', async () => {
    const client = await connect(createCloudHarnessServer(backend().backend));
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();
    const { resources } = await client.listResources();
    expect(resources).toEqual([expect.objectContaining({ uri: WORKSPACE_EXPLORER_UI_URI, mimeType: MCP_APP_RESOURCE_MIME_TYPE })]);
    const read = await client.readResource({ uri: WORKSPACE_EXPLORER_UI_URI });
    expect(read.contents).toEqual([{
      uri: WORKSPACE_EXPLORER_UI_URI,
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true } }
    }]);
  });

  it('shares the resources handlers with the Skills extension without shadowing skill reads', async () => {
    const client = await connect(createCloudHarnessServer(backend(defaultRespond, true).backend));
    expect((await client.readResource({ uri: WORKSPACE_EXPLORER_UI_URI })).contents[0]).toMatchObject({ mimeType: MCP_APP_RESOURCE_MIME_TYPE });
    expect((await client.readResource({ uri: 'skill://cloud-harness/owner/demo/SKILL.md' })).contents[0]).toMatchObject({ text: '# demo' });
  });

  it('rejects unknown URIs on backends without skills', async () => {
    const client = await connect(createCloudHarnessServer(backend().backend));
    await expect(client.readResource({ uri: 'ui://cloud-harness/other.html' })).rejects.toBeInstanceOf(ProtocolError);
    await expect(client.request({ method: 'skills/list', params: {} }, z.unknown())).rejects.toBeInstanceOf(ProtocolError);
  });

  it('ships the inlined script and stylesheet byte for byte', () => {
    const script = readFileSync(new URL('../mcp-apps/workspace-explorer/explorer.js', import.meta.url), 'utf8');
    const style = readFileSync(new URL('../mcp-apps/workspace-explorer/explorer.css', import.meta.url), 'utf8');
    expect(html).toContain(script);
    expect(html).toContain(style);
  });
});

describe('explorer view model', () => {
  it('makes bidirectional overrides and control characters visible', () => {
    expect(view.visibleText('a‮b\u0007c\nd\te')).toBe('a⟦U+202E⟧b⟦U+0007⟧c\nd\te');
    expect(view.truncateMessage('x'.repeat(500)).length).toBe(300);
  });

  it('parses git status with renames, quoting, and the branch line', () => {
    expect(view.parseGitStatus('## main...origin/main [ahead 1]\nM  src/a.ts\n?? new.txt\nR  old.ts -> renamed.ts\n M "with space.ts"\n')).toEqual({
      branch: 'main...origin/main [ahead 1]',
      entries: [
        { code: 'M ', path: 'src/a.ts', staged: true, unstaged: false },
        { code: '??', path: 'new.txt', staged: false, unstaged: true },
        { code: 'R ', path: 'renamed.ts', staged: true, unstaged: false },
        { code: ' M', path: 'with space.ts', staged: false, unstaged: true }
      ]
    });
  });

  it('classifies diff lines and bounds how many are rendered', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+<script>alert(1)</script>\n same\n';
    expect(view.classifyDiffLines(diff).lines.map((line: { kind: string }) => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
    const big = view.classifyDiffLines('+x\n'.repeat(10_000));
    expect(big.lines).toHaveLength(view.LIMITS.renderedDiffLines);
    expect(big.omitted).toBe(10_000 - view.LIMITS.renderedDiffLines);
  });

  it('maps failures to states without echoing internals beyond the bounded message', () => {
    expect(view.describeFailure(fail('EXPIRED', 'lease gone'))).toMatchObject({ kind: 'expired' });
    expect(view.describeFailure(fail('FORBIDDEN', 'no'))).toMatchObject({ kind: 'forbidden' });
    expect(view.describeFailure({ ok: false })).toMatchObject({ kind: 'error', code: 'INTERNAL_ERROR' });
    expect(view.leaseTone({ status: 'ACTIVE', leaseState: 'EXPIRED_RECOVERABLE' })).toMatchObject({ expired: true });
    expect(view.leaseTone({ status: 'CLOSED' })).toMatchObject({ expired: true });
    expect(view.leaseTone({ status: 'ACTIVE', leaseState: 'WARNING' })).toMatchObject({ expired: false, tone: 'warn' });
  });

  it('treats only settled runner task states as terminal', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'blocked']) expect(view.isTerminalTask(status)).toBe(true);
    for (const status of ['queued', 'running', undefined]) expect(view.isTerminalTask(status)).toBe(false);
    expect(view.dependenciesByTask({ edges: [{ from: 'a', to: 'b' }, { from: 'c', to: 'b' }, { bogus: true }] }).get('b')).toEqual(['a', 'c']);
  });
});

/** Pairs the view-side bridge with a host transport, as two windows exchanging postMessage. */
function linkView(): { hostTransport: Transport; viewBridge: ReturnType<typeof view.createBridge>; viewSent: JSONRPCMessage[] } {
  const viewSent: JSONRPCMessage[] = [];
  let deliverToView: (data: unknown) => void = () => undefined;
  const hostTransport: Transport = {
    start: async () => undefined,
    close: async () => { hostTransport.onclose?.(); },
    send: async (message) => { const copy = structuredClone(message); queueMicrotask(() => deliverToView(copy)); }
  };
  const viewBridge = view.createBridge({
    target: { postMessage: (message: JSONRPCMessage) => { viewSent.push(message); const copy = structuredClone(message); queueMicrotask(() => hostTransport.onmessage?.(copy)); } },
    listen: (deliver: (data: unknown) => void) => { deliverToView = deliver; },
    timeoutMs: 2_000
  });
  return { hostTransport, viewBridge, viewSent };
}

describe('explorer bridge against the official MCP Apps host bridge', () => {
  async function host(respond: (call: Call) => RunnerResponse = defaultRespond) {
    const { backend: value, calls } = backend(respond);
    const client = await connect(createCloudHarnessServer(value));
    const bridge = new AppBridge(client, { name: 'test-host', version: '1.0.0' }, { serverTools: {}, serverResources: {} });
    const { hostTransport, viewBridge, viewSent } = linkView();
    const initialized = new Promise<void>((resolve) => { bridge.oninitialized = () => resolve(); });
    await bridge.connect(hostTransport);
    closers.push(async () => { await bridge.close(); });
    return { bridge, viewBridge, viewSent, calls, initialized };
  }

  it('completes the ui/initialize handshake and receives tool input and result notifications', async () => {
    const { bridge, viewBridge, initialized } = await host();
    const input = new Promise((resolve) => viewBridge.on('ui/notifications/tool-input', resolve));
    const result = new Promise((resolve) => viewBridge.on('ui/notifications/tool-result', resolve));
    const init = await viewBridge.request('ui/initialize', { appInfo: view.APP_INFO, appCapabilities: {}, protocolVersion: view.PROTOCOL_VERSION }) as { protocolVersion: string; hostInfo: { name: string } };
    expect(init.hostInfo.name).toBe('test-host');
    expect(init.protocolVersion).toBe(view.PROTOCOL_VERSION);
    viewBridge.notify('ui/notifications/initialized', {});
    await initialized;
    await bridge.sendToolInput({ arguments: { workspaceId } });
    await bridge.sendToolResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true, message: 'ok', data: { workspaceId }, truncated: false } });
    expect(await input).toEqual({ arguments: { workspaceId } });
    expect(view.toolResultOf(await result)).toMatchObject({ ok: true, data: { workspaceId } });
  });

  it('reads through the host to the server, always for the bound workspace', async () => {
    const { viewBridge, calls, initialized } = await host();
    await viewBridge.request('ui/initialize', { appInfo: view.APP_INFO, appCapabilities: {}, protocolVersion: view.PROTOCOL_VERSION });
    viewBridge.notify('ui/notifications/initialized', {});
    await initialized;
    const read = view.createReader(viewBridge, () => workspaceId);
    const listed = await read('files_list', { path: '.', limit: 10, workspaceId: otherWorkspaceId });
    expect(listed).toMatchObject({ ok: true, data: { entries: [{ name: 'README.md', type: 'file' }] } });
    expect(calls).toEqual([{ operation: 'files_list', input: expect.objectContaining({ workspaceId, path: '.', limit: 10 }) }]);
    await expect(read('exec_run', { command: 'id' })).rejects.toThrow(/not available/u);
    await expect(read('git_push', {})).rejects.toThrow(/not available/u);
    expect(calls).toHaveLength(1);
  });

  it('surfaces server-side denials as failed results', async () => {
    const { viewBridge, initialized } = await host(() => fail('FORBIDDEN', 'Workspace belongs to another principal'));
    await viewBridge.request('ui/initialize', { appInfo: view.APP_INFO, appCapabilities: {}, protocolVersion: view.PROTOCOL_VERSION });
    viewBridge.notify('ui/notifications/initialized', {});
    await initialized;
    const result = await view.createReader(viewBridge, () => workspaceId)('git_diff', { limit: 10 });
    expect(view.describeFailure(result)).toMatchObject({ kind: 'forbidden' });
  });

  it('answers host teardown and rejects host requests it does not implement', async () => {
    const { bridge, viewBridge, viewSent, initialized } = await host();
    viewBridge.onRequest('ui/resource-teardown', () => ({}));
    await viewBridge.request('ui/initialize', { appInfo: view.APP_INFO, appCapabilities: {}, protocolVersion: view.PROTOCOL_VERSION });
    viewBridge.notify('ui/notifications/initialized', {});
    await initialized;
    await expect(bridge.teardownResource({})).resolves.toEqual({});
    await expect(bridge.request({ method: 'tools/list', params: {} }, z.unknown())).rejects.toThrow();
    expect(viewSent.some((message) => 'error' in message && (message.error as { code: number }).code === -32601)).toBe(true);
  });

  it('times out when the host never answers', async () => {
    const silent = view.createBridge({ target: { postMessage: () => undefined }, listen: () => undefined, timeoutMs: 20 });
    await expect(silent.request('ui/initialize', {})).rejects.toThrow(/in time/u);
  });
});
