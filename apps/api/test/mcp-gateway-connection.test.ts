import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { Client, StreamableHTTPClientTransport, type jsonSchemaValidator } from '@modelcontextprotocol/client';
import type { McpGatewayServerView } from '@cloud-harness/contracts';
import {
  GatewayConnectionManager,
  REDIRECT_ERROR_MESSAGE,
  permissiveJsonSchemaValidator
} from '../src/mcp-gateway/connection-manager.js';
import { guardedFetchOptions } from '../src/mcp-gateway/redaction.js';

// The resolver is mocked so the rebinding case is deterministic and offline; every
// other test in this file uses an IP-literal endpoint and never reaches DNS.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

type FakeTool = { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown };

type FakeServerOptions = {
  tools?: FakeTool[];
  toolResult?: unknown;
  failInitialize?: boolean;
  failToolCallTimes?: number;
  redirect?: boolean;
  sessionId?: string | null;
};

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | null;
  redirect: string | null;
  dispatcher: unknown;
};

type JsonRpcBody = { id?: unknown; method?: string; params?: Record<string, unknown> };

function createFakeServer(options: FakeServerOptions = {}) {
  const state = {
    initializeCount: 0,
    listCount: 0,
    callCount: 0,
    deleteCount: 0,
    toolCallFailuresRemaining: options.failToolCallTimes ?? 0,
    requests: [] as RecordedRequest[]
  };
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    state.requests.push({
      method,
      url: url.toString(),
      authorization: headers.get('authorization'),
      redirect: (init as { redirect?: string } | undefined)?.redirect ?? null,
      dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher
    });
    if (method === 'GET') return new Response('', { status: 405 });
    if (method === 'DELETE') {
      state.deleteCount += 1;
      return new Response('', { status: 200 });
    }
    if (options.redirect) return new Response('', { status: 301, headers: { location: 'https://example.com/mcp' } });
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonRpcBody;
    const id = body.id ?? null;
    const json = (payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...extraHeaders }
      });
    if (body.method === 'server/discover') {
      return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
    if (body.method === 'initialize') {
      if (options.failInitialize) return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
      state.initializeCount += 1;
      const requested = body.params?.protocolVersion;
      const protocolVersion = typeof requested === 'string' ? requested : '2025-06-18';
      const extraHeaders = options.sessionId ? { 'mcp-session-id': options.sessionId } : {};
      return json(
        {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
        },
        200,
        extraHeaders
      );
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/list') {
      state.listCount += 1;
      return json({ jsonrpc: '2.0', id, result: { tools: options.tools ?? [] } });
    }
    if (body.method === 'tools/call') {
      if (state.toolCallFailuresRemaining > 0) {
        state.toolCallFailuresRemaining -= 1;
        throw new Error('socket hang up');
      }
      state.callCount += 1;
      return json({
        jsonrpc: '2.0',
        id,
        result: options.toolResult ?? { content: [{ type: 'text', text: 'ok' }], isError: false }
      });
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  };
  return { fetchImpl, state };
}

const ENDPOINT = 'http://127.0.0.1:4123/mcp';

function serverView(overrides: Partial<McpGatewayServerView> = {}): McpGatewayServerView {
  return {
    id: `mcps_${'a'.repeat(24)}`,
    principalId: 'owner',
    name: 'github',
    description: null,
    transport: 'streamable-http',
    endpoint: ENDPOINT,
    headers: [],
    enabled: true,
    status: 'unknown',
    toolCount: 0,
    lastConnectedAt: null,
    lastError: null,
    lastCheckedAt: null,
    permissionDefault: 'allow',
    generation: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function managerFor(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof GatewayConnectionManager>[0]> = {}
): GatewayConnectionManager {
  return new GatewayConnectionManager({
    timeoutMs: 2_000,
    maxResponseBytes: 262_144,
    maxConnections: 4,
    allowInsecureHttp: true,
    allowPrivateEndpoints: true,
    fetchImpl,
    ...overrides
  });
}

const TOOLS: FakeTool[] = [
  { name: 'issue_create', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }
];

describe('GatewayConnectionManager: connect and reuse', () => {
  it('connects, lists tools, and pins the transport', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const result = await manager.withConnection(serverView(), { Authorization: 'Bearer secret' }, (client) => client.listTools());
    expect(result.tools.map((tool) => tool.name)).toEqual(['issue_create']);
    expect(state.initializeCount).toBe(1);
    const initialize = state.requests.find((request) => request.method === 'POST' && request.authorization !== null);
    expect(initialize).toBeDefined();
    expect(initialize!.redirect).toBe('error');
    expect(initialize!.dispatcher).toBeInstanceOf(Agent);
    await manager.closeAll();
  });

  it('reuses the cached client and opens exactly one connection for concurrent callers', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    const headers = { Authorization: 'Bearer secret' };
    const [first, second] = await Promise.all([
      manager.withConnection(server, headers, (client) => client.listTools()),
      manager.withConnection(server, headers, (client) => client.listTools())
    ]);
    expect(first.tools).toHaveLength(1);
    expect(second.tools).toHaveLength(1);
    await manager.withConnection(server, headers, (client) => client.listTools());
    expect(state.initializeCount).toBe(1);
    expect(manager.size()).toBe(1);
    expect(manager.health(server.id)).toBe('connected');
    await manager.closeAll();
  });

  it('never evicts an in-flight client when a concurrent caller presents a different credential', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEnteredFn!: () => void;
    const firstInFn = new Promise<void>((resolve) => {
      firstEnteredFn = resolve;
    });

    const first = manager.withConnection(server, { Authorization: 'Bearer first' }, async (client) => {
      events.push('first:enter');
      firstEnteredFn();
      await firstHeld;
      const result = await client.listTools();
      events.push('first:exit');
      return result;
    });
    await firstInFn;

    const second = manager.withConnection(server, { Authorization: 'Bearer second' }, async (client) => {
      events.push('second:enter');
      const result = await client.listTools();
      events.push('second:exit');
      return result;
    });
    // Give the second caller time to reach the slot gate while the first is parked.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(['first:enter']);

    releaseFirst();
    const outcomes = await Promise.allSettled([first, second]);
    const rejectionMessages = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      // The reproduced defect rejected the parked caller with the SDK's `Not connected` error.
      .map((outcome) => (outcome.reason as Error)?.message ?? String(outcome.reason));
    expect(rejectionMessages).toEqual([]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((outcomes[0] as PromiseFulfilledResult<{ tools: unknown[] }>).value.tools).toHaveLength(1);
    expect((outcomes[1] as PromiseFulfilledResult<{ tools: unknown[] }>).value.tools).toHaveLength(1);
    // Option A serialization: the credential-scoped second connect happens only after
    // the first caller's `fn` has settled, so no live client is ever closed underneath it.
    expect(events).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit']);
    expect(state.initializeCount).toBe(2);
    expect(manager.size()).toBe(1);
    expect(manager.health(server.id)).toBe('connected');
    await manager.closeAll();
  });

  it('still opens exactly one connection for concurrent identical-credential callers', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    const headers = { Authorization: 'Bearer secret' };
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEnteredFn!: () => void;
    const firstInFn = new Promise<void>((resolve) => {
      firstEnteredFn = resolve;
    });

    const first = manager.withConnection(server, headers, async (client) => {
      events.push('first:enter');
      firstEnteredFn();
      await firstHeld;
      const result = await client.listTools();
      events.push('first:exit');
      return result;
    });
    await firstInFn;
    const second = manager.withConnection(server, headers, async (client) => {
      events.push('second:enter');
      const result = await client.listTools();
      events.push('second:exit');
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(['first:enter']);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.tools).toHaveLength(1);
    expect(secondResult.tools).toHaveLength(1);
    expect(events).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit']);
    expect(state.initializeCount).toBe(1);
    expect(manager.size()).toBe(1);
    await manager.closeAll();
  });

  it('attaches the credential to the configured endpoint and not to another path on the same origin', async () => {
    const endpoint = new URL(ENDPOINT);
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const guarded = guardedFetchOptions(endpoint, { Authorization: 'Bearer secret' }, async (input, init) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await guarded(`${ENDPOINT}`, { method: 'POST' });
    await guarded('http://127.0.0.1:4123/.well-known/oauth-protected-resource', { method: 'GET' });
    expect(seen[0]!.authorization).toBe('Bearer secret');
    expect(seen[1]!.authorization).toBeNull();

    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    await manager.withConnection(serverView(), { Authorization: 'Bearer secret' }, (client) => client.listTools());
    expect(state.requests.every((request) => request.url.endsWith('/mcp'))).toBe(true);
    expect(state.requests.some((request) => request.authorization === 'Bearer secret')).toBe(true);
    await manager.closeAll();
  });
});

describe('GatewayConnectionManager: failure isolation and invalidation', () => {
  it('keeps a healthy server cached when another server fails', async () => {
    const healthy = createFakeServer({ tools: TOOLS });
    const broken = createFakeServer({ failInitialize: true });
    const healthyServer = serverView();
    const brokenServer = serverView({
      id: `mcps_${'b'.repeat(24)}`,
      name: 'broken',
      endpoint: 'http://127.0.0.1:4999/mcp'
    });
    const manager = managerFor(async (input, init) => {
      return new URL(String(input)).port === '4999'
        ? broken.fetchImpl(input, init)
        : healthy.fetchImpl(input, init);
    });
    await manager.withConnection(healthyServer, {}, (client) => client.listTools());
    await expect(manager.withConnection(brokenServer, {}, (client) => client.listTools())).rejects.toBeTruthy();
    expect(manager.health(healthyServer.id)).toBe('connected');
    expect(manager.size()).toBe(1);
    await manager.withConnection(healthyServer, {}, (client) => client.listTools());
    expect(healthy.state.initializeCount).toBe(1);
    await manager.closeAll();
  });

  it('forces a reconnect after invalidate', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    await manager.withConnection(server, {}, (client) => client.listTools());
    manager.invalidate(server.id);
    expect(manager.size()).toBe(0);
    expect(manager.health(server.id)).toBe('disconnected');
    await manager.withConnection(server, {}, (client) => client.listTools());
    expect(state.initializeCount).toBe(2);
    await manager.closeAll();
  });
});

describe('GatewayConnectionManager: deadline, cancellation, and reconnect', () => {
  it('makes zero outbound requests when the resolver rebinds after validation', async () => {
    let lookups = 0;
    dns.lookup.mockImplementation(async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    });
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl, { allowInsecureHttp: false, allowPrivateEndpoints: false });
    const server = serverView({ endpoint: 'https://rebind.example.com/mcp' });
    await expect(
      manager.withConnection(server, { Authorization: 'Bearer secret' }, (client) => client.listTools())
    ).rejects.toBeTruthy();
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(state.requests).toHaveLength(0);
    dns.lookup.mockReset();
    await manager.closeAll();
  });

  it('starts the per-call deadline only after the caller owns the server slot', async () => {
    const manager = managerFor(() => new Promise<Response>(() => undefined), { timeoutMs: 200 });
    const server = serverView();
    const started = Date.now();
    let firstRejectedAt = 0;
    let secondRejectedAt = 0;
    const first = manager.withConnection(server, {}, (client) => client.listTools()).catch((error: unknown) => {
      firstRejectedAt = Date.now() - started;
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = manager.withConnection(server, {}, (client) => client.listTools()).catch((error: unknown) => {
      secondRejectedAt = Date.now() - started;
      throw error;
    });
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]!.status).toBe('rejected');
    expect(outcomes[1]!.status).toBe('rejected');
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'TIMEOUT' });
    // If the queued caller's deadline had started while it waited, it would have failed
    // at the same moment as the holder instead of running its own full deadline.
    expect(secondRejectedAt).toBeGreaterThan(firstRejectedAt + 100);
    await manager.closeAll();
  });

  it('fails a hung connection with TIMEOUT within roughly timeoutMs', async () => {
    const manager = managerFor(() => new Promise<Response>(() => undefined), { timeoutMs: 150 });
    const started = Date.now();
    await expect(manager.withConnection(serverView(), {}, (client) => client.listTools())).rejects.toMatchObject({
      code: 'TIMEOUT'
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    await manager.closeAll();
  });

  it('treats a caller abort as CANCELLED without evicting the shared entry', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    const headers = { Authorization: 'Bearer secret' };
    await manager.withConnection(server, headers, (client) => client.listTools());
    const controller = new AbortController();
    const pending = manager.withConnection(server, headers, () => new Promise<never>(() => undefined), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(manager.size()).toBe(1);
    expect(manager.health(server.id)).toBe('connected');
    await manager.withConnection(server, headers, (client) => client.listTools());
    expect(state.initializeCount).toBe(1);
    await manager.closeAll();
  });

  it('evicts on a transport failure and reconnects exactly once', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS, failToolCallTimes: 1 });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    const headers = { Authorization: 'Bearer secret' };
    await manager.withConnection(server, headers, (client) => client.listTools());
    await expect(
      manager.withConnection(server, headers, (client) => client.callTool({ name: 'issue_create', arguments: {} }))
    ).rejects.toBeTruthy();
    expect(manager.size()).toBe(0);
    expect(manager.health(server.id)).toBe('disconnected');
    await manager.withConnection(server, headers, (client) => client.listTools());
    expect(state.initializeCount).toBe(2);
    await manager.closeAll();
  });

  it('re-asserts that a caller abort keeps the entry while a transport failure evicts it', async () => {
    const { fetchImpl, state } = createFakeServer({ tools: TOOLS, failToolCallTimes: 1 });
    const manager = managerFor(fetchImpl);
    const server = serverView();
    const headers = { Authorization: 'Bearer secret' };
    await manager.withConnection(server, headers, (client) => client.listTools());
    expect(state.initializeCount).toBe(1);

    const controller = new AbortController();
    const aborted = manager.withConnection(server, headers, () => new Promise<never>(() => undefined), controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(manager.size()).toBe(1);
    expect(manager.health(server.id)).toBe('connected');
    await manager.withConnection(server, headers, (client) => client.listTools());
    expect(state.initializeCount).toBe(1);

    await expect(
      manager.withConnection(server, headers, (client) => client.callTool({ name: 'issue_create', arguments: {} }))
    ).rejects.toBeTruthy();
    expect(manager.size()).toBe(0);
    expect(manager.health(server.id)).toBe('disconnected');

    await manager.withConnection(server, headers, (client) => client.listTools());
    expect(state.initializeCount).toBe(2);
    await manager.closeAll();
  });

  it('names redirects instead of surfacing a bare UNAVAILABLE', async () => {
    const { fetchImpl, state } = createFakeServer({ redirect: true });
    const manager = managerFor(fetchImpl);
    let caught: unknown;
    try {
      await manager.withConnection(serverView(), { Authorization: 'Bearer secret' }, (client) => client.listTools());
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/redirect/i);
    expect((caught as Error).message).toBe(REDIRECT_ERROR_MESSAGE);
    expect((caught as { code?: string }).code).toBe('UNAVAILABLE');
    expect(state.requests[0]!.redirect).toBe('error');
    await manager.closeAll();
  });
});

describe('GatewayConnectionManager: cache bounds and shutdown', () => {
  it('evicts the least-recently-used connection and closes it', async () => {
    const { fetchImpl } = createFakeServer({ tools: TOOLS, sessionId: 'session-1' });
    const manager = managerFor(fetchImpl, { maxConnections: 2 });
    const first = serverView({ id: `mcps_${'1'.repeat(24)}`, name: 'one' });
    const second = serverView({ id: `mcps_${'2'.repeat(24)}`, name: 'two' });
    const third = serverView({ id: `mcps_${'3'.repeat(24)}`, name: 'three' });
    const closeSpy = vi.spyOn(Client.prototype, 'close');
    await manager.withConnection(first, {}, (client) => client.listTools());
    await manager.withConnection(second, {}, (client) => client.listTools());
    await manager.withConnection(third, {}, (client) => client.listTools());
    expect(manager.size()).toBe(2);
    expect(manager.health(first.id)).toBe('disconnected');
    expect(manager.health(second.id)).toBe('connected');
    expect(manager.health(third.id)).toBe('connected');
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    closeSpy.mockRestore();
    await manager.closeAll();
  });

  it('closeAll closes every client and rejects a pending waiter with UNAVAILABLE', async () => {
    const healthy = createFakeServer({ tools: TOOLS });
    const routingFetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === '/slow') return new Promise<Response>(() => undefined);
      return healthy.fetchImpl(input, init);
    };
    const manager = managerFor(routingFetch, { timeoutMs: 60_000 });
    const healthyServer = serverView();
    const slowServer = serverView({
      id: `mcps_${'c'.repeat(24)}`,
      name: 'slow',
      endpoint: 'http://127.0.0.1:4123/slow'
    });
    await manager.withConnection(healthyServer, {}, (client) => client.listTools());
    const closeSpy = vi.spyOn(Client.prototype, 'close');
    const holder = manager.withConnection(slowServer, {}, (client) => client.listTools());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiter = manager.withConnection(slowServer, {}, (client) => client.listTools());
    await manager.closeAll();
    await expect(waiter).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(holder).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(manager.size()).toBe(0);
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
    await expect(manager.withConnection(healthyServer, {}, (client) => client.listTools())).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    });
  });

  it('discards and closes a connection that resolves after closeAll', async () => {
    const { fetchImpl } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl, { timeoutMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Hold the connect open so closeAll wins the race, then let the entry resolve
    // after the manager has already shut down.
    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockImplementation(async () => { await gate; });
    const closeSpy = vi.spyOn(Client.prototype, 'close');
    const agentCloseSpy = vi.spyOn(Agent.prototype, 'close');
    try {
      const pending = manager.withConnection(serverView(), {}, (client) => client.listTools());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await manager.closeAll();
      release();
      await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalled();
        expect(agentCloseSpy).toHaveBeenCalled();
      });
      expect(manager.size()).toBe(0);
    } finally {
      connectSpy.mockRestore();
      closeSpy.mockRestore();
      agentCloseSpy.mockRestore();
    }
  });
});

describe('GatewayConnectionManager: transport credential invariants', () => {
  type TransportInternals = { _requestInit?: unknown; _authProvider?: unknown };

  function internals(transport: unknown): TransportInternals {
    return transport as TransportInternals;
  }

  it('never constructs a transport that carries requestInit or authProvider', async () => {
    const { fetchImpl } = createFakeServer({ tools: TOOLS });
    const manager = managerFor(fetchImpl);
    const connectSpy = vi.spyOn(Client.prototype, 'connect');
    try {
      await manager.withConnection(serverView(), { Authorization: 'Bearer secret' }, (client) => client.listTools());
      expect(connectSpy).toHaveBeenCalled();
      const streamable = internals(connectSpy.mock.calls.at(-1)![0]);
      // Anchors the assertion to the transport the SDK actually built.
      expect('_requestInit' in streamable).toBe(true);
      expect('_authProvider' in streamable).toBe(true);
      expect(streamable._requestInit).toBeUndefined();
      expect(streamable._authProvider).toBeUndefined();
    } finally {
      connectSpy.mockRestore();
      await manager.closeAll();
    }

    const sse = createFakeServer({ tools: TOOLS });
    const sseManager = managerFor(sse.fetchImpl, { timeoutMs: 500 });
    const sseSpy = vi.spyOn(Client.prototype, 'connect');
    try {
      // The fake server answers the SSE GET with 405; the transport is still built,
      // so the assertion holds whether or not the connect handshake completes.
      await sseManager
        .withConnection(serverView({ transport: 'sse' }), { Authorization: 'Bearer secret' }, (client) => client.listTools())
        .catch(() => undefined);
      expect(sseSpy).toHaveBeenCalled();
      const transport = internals(sseSpy.mock.calls.at(-1)![0]);
      expect('_requestInit' in transport).toBe(true);
      expect('_authProvider' in transport).toBe(true);
      expect(transport._requestInit).toBeUndefined();
      expect(transport._authProvider).toBeUndefined();
    } finally {
      sseSpy.mockRestore();
      await sseManager.closeAll();
    }
  });
});

describe('GatewayConnectionManager: output-schema validation', () => {
  const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
  const mismatched = { count: 'not-a-number' };
  const toolResult = { content: [{ type: 'text', text: 'ok' }], structuredContent: mismatched, isError: false };

  it('returns structuredContent that violates the declared outputSchema', async () => {
    const { fetchImpl } = createFakeServer({
      tools: [{ name: 'stats', inputSchema: { type: 'object' }, outputSchema: schema }],
      toolResult
    });
    const manager = managerFor(fetchImpl);
    const result = (await manager.withConnection(serverView(), {}, async (client) => {
      await client.listTools();
      return client.callTool({ name: 'stats', arguments: {} });
    })) as { structuredContent?: unknown };
    expect(result.structuredContent).toEqual(mismatched);
    await manager.closeAll();
  });

  it('the permissive provider validates anything and a strict provider still rejects', async () => {
    expect(permissiveJsonSchemaValidator.getValidator(schema)(mismatched)).toEqual({
      valid: true,
      data: mismatched,
      errorMessage: undefined
    });
    const strict: jsonSchemaValidator = {
      getValidator: () => (input: unknown) => ({ valid: false, data: undefined, errorMessage: `rejected ${String(input)}` })
    };
    const { fetchImpl } = createFakeServer({
      tools: [{ name: 'stats', inputSchema: { type: 'object' }, outputSchema: schema }],
      toolResult
    });
    const control = new Client(
      { name: 'control', version: '1.0.0' },
      { jsonSchemaValidator: strict, defaultCacheTtlMs: 60_000 }
    );
    await control.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: fetchImpl as unknown as typeof fetch })
    );
    await control.listTools();
    await expect(control.callTool({ name: 'stats', arguments: {} })).rejects.toThrow(/output schema|structured content/i);
    await control.close();
  });
});
