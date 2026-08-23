import { createServer, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import { createMailboxProbeServerFactory } from '../src/mailbox-probe-server.js';
import { MAILBOX_PROBE_RESOURCE_URI, MCP_APP_RESOURCE_MIME_TYPE } from '../src/mailbox-probe-widget-resource.js';

const bearer = 'mailbox-probe-bearer-token-that-is-long-enough';
const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'chatgpt-user' };
const authInfo: AuthInfo = { token: 'opaque', clientId: 'chatgpt-user', scopes: [], extra: { principal, externalPrincipal: { issuer: principal.issuer, subject: principal.subject } } };

const runnerClient = {
  async call() {
    return { ok: true as const, message: 'Stub runner result', data: { workspaces: [] }, truncated: false };
  }
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


function field(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

async function inMemoryClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const factory = createMailboxProbeServerFactory(runnerClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = factory({ era: 'modern', authInfo });
  const client = new Client({ name: 'mailbox-probe-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function openProbe(client: Client): Promise<{ sessionId: string; capability: string; firstRequestId: string }> {
  const opened = await client.callTool({ name: 'mailbox_probe_open', arguments: {} });
  const meta = opened._meta;
  const sessionId = text(field(meta, 'mailboxProbeSessionId'));
  const capability = text(field(meta, 'mailboxProbeCapability'));
  expect(sessionId).toMatch(/^mbp_/);
  expect(capability.length).toBeGreaterThan(40);
  expect(JSON.stringify(opened.structuredContent)).not.toContain(capability);
  expect(JSON.stringify(opened.content)).not.toContain(capability);

  const rejected = await client.callTool({ name: 'mailbox_probe_receive', arguments: { sessionId, capability: 'wrong-capability-that-is-long-enough', waitMs: 0 } });
  expect(rejected.isError).toBe(true);

  const received = await client.callTool({ name: 'mailbox_probe_receive', arguments: { sessionId, capability, waitMs: 500 } });
  expect(field(received.structuredContent, 'received')).toBe(true);
  const request = field(received.structuredContent, 'request');
  const firstRequestId = text(field(request, 'id'));
  expect(firstRequestId).toMatch(/^mpr_/);
  return { sessionId, capability, firstRequestId };
}

const validSubmit = (requestId: string) => ({
  version: 1,
  requestId,
  status: 'completed',
  message: { role: 'assistant', content: [{ type: 'output_text', text: 'probe ok' }] },
  finishReason: 'stop',
  data: null,
  error: null
});

let runtime: ApiRuntime | undefined;
let httpServer: Server | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (httpServer) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  httpServer = undefined;
});

describe('mailbox probe MCP profile', () => {
  it('exposes only probe tools plus the read-only allowlisted tool', async () => {
    const { client, close } = await inMemoryClient();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['agent_probe_submit', 'mailbox_probe_open', 'mailbox_probe_receive', 'workspace_list']);
      expect(listed.tools.find((tool) => tool.name === 'mailbox_probe_receive')?._meta).toMatchObject({ 'openai/widgetAccessible': true, 'openai/visibility': 'private' });
      expect(listed.tools.map((tool) => tool.name)).not.toContain('exec_run');
      await expect(client.callTool({ name: 'exec_run', arguments: {} })).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('serves an MCP App resource that contains the ChatGPT autonomy probe hooks', async () => {
    const { client, close } = await inMemoryClient();
    try {
      await client.callTool({ name: 'mailbox_probe_open', arguments: {} });
      const resources = await client.listResources();
      expect(resources.resources.find((resource) => resource.uri === MAILBOX_PROBE_RESOURCE_URI)?.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
      const resource = await client.readResource({ uri: MAILBOX_PROBE_RESOURCE_URI });
      expect(resource.contents[0]).toMatchObject({ uri: MAILBOX_PROBE_RESOURCE_URI, mimeType: MCP_APP_RESOURCE_MIME_TYPE });
      expect(field(resource.contents[0], '_meta')).toMatchObject({ ui: { prefersBorder: true } });
      const html = text(field(resource.contents[0], 'text'));
      expect(html).toContain("callTool('mailbox_probe_receive'");
      expect(html).toContain('sendFollowUpMessage');
      expect(html).toContain('requestDisplayMode');
    } finally {
      await close();
    }
  });

  it('keeps the widget capability out of model-visible result fields and enforces strict submit', async () => {
    const { client, close } = await inMemoryClient();
    try {
      const opened = await openProbe(client);
      const invalidSubmit = await client.callTool({ name: 'agent_probe_submit', arguments: { ...validSubmit(opened.firstRequestId), extra: 'rejected' } });
      expect(invalidSubmit.isError).toBe(true);
      expect(JSON.stringify(invalidSubmit.content)).toContain('Unrecognized key');
      const accepted = await client.callTool({ name: 'agent_probe_submit', arguments: validSubmit(opened.firstRequestId) });
      expect(field(accepted.structuredContent, 'accepted')).toBe(true);
      const second = await client.callTool({ name: 'mailbox_probe_receive', arguments: { sessionId: opened.sessionId, capability: opened.capability, waitMs: 500 } });
      const secondRequest = field(second.structuredContent, 'request');
      const secondRequestId = text(field(secondRequest, 'id'));
      expect(secondRequestId).toMatch(/^mpr_/);
      expect(secondRequestId).not.toBe(opened.firstRequestId);
      const secondAccepted = await client.callTool({ name: 'agent_probe_submit', arguments: validSubmit(secondRequestId) });
      expect(field(secondAccepted.structuredContent, 'accepted')).toBe(true);
    } finally {
      await close();
    }
  });

  it('keeps the draft HTTP endpoint unmounted while explicitly disabled', async () => {
    const config: ApiConfig = {
      host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: bearer,
      runnerUrl: 'http://127.0.0.1:9', runnerToken: 'runner-token-that-is-longer-than-32-characters',
      publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
      apiKeyAuthEnabled: false, mailboxProbeEnabled: false
    };
    runtime = createApiApp(config);
    httpServer = createServer(runtime.app);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp-mailbox-probe`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  });

  it('mounts the draft HTTP endpoint when the feature gate is enabled', async () => {
    const config: ApiConfig = {
      host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: bearer,
      runnerUrl: 'http://127.0.0.1:9', runnerToken: 'runner-token-that-is-longer-than-32-characters',
      publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
      apiKeyAuthEnabled: false, mailboxProbeEnabled: true
    };
    runtime = createApiApp(config);
    httpServer = createServer(runtime.app);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp-mailbox-probe`);
    const client = new Client({ name: 'mailbox-probe-http-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['agent_probe_submit', 'mailbox_probe_open', 'mailbox_probe_receive', 'workspace_list']);
    const opened = await openProbe(client);
    const accepted = await client.callTool({ name: 'agent_probe_submit', arguments: validSubmit(opened.firstRequestId) });
    expect(field(accepted.structuredContent, 'accepted')).toBe(true);
    await client.close();
  });
});
