import { describe, expect, it, vi } from 'vitest';
import type {
  McpGatewayResolvedCredentials,
  McpGatewayServerView,
  McpGatewayToolView,
  RunnerPrincipalSelector,
  RunnerResponse
} from '@cloud-harness/contracts';
import type { Client } from '@modelcontextprotocol/client';
import type { RunnerClient } from '../src/runner-client.js';
import { McpGatewayService } from '../src/mcp-gateway/service.js';
import type { GatewayConnectionManager, GatewayConnectionHealth } from '../src/mcp-gateway/connection-manager.js';
import type { GatewayCatalogFilter } from '../src/mcp-gateway/types.js';

const principal: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'owner' };
const otherPrincipal: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'other' };

function serverView(overrides: Partial<McpGatewayServerView> = {}): McpGatewayServerView {
  return {
    id: `mcps_${'a'.repeat(24)}`,
    principalId: 'owner',
    name: 'github',
    description: null,
    transport: 'streamable-http',
    endpoint: 'https://upstream.test/mcp',
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

function toolView(server: McpGatewayServerView, overrides: Partial<McpGatewayToolView> = {}): McpGatewayToolView {
  return {
    id: `mcpt_${'b'.repeat(24)}`,
    principalId: server.principalId,
    serverId: server.id,
    serverName: server.name,
    qualifiedName: `${server.name}.issue_create`,
    upstreamName: 'issue_create',
    description: 'Create a GitHub issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    annotations: { readOnlyHint: false },
    availability: 'available',
    permission: 'allow',
    discoveredAt: 1,
    ...overrides
  };
}

const github = serverView();
const posthog = serverView({ id: `mcps_${'c'.repeat(24)}`, name: 'posthog', endpoint: 'https://posthog.test/mcp' });
const legacy = serverView({ id: `mcps_${'d'.repeat(24)}`, name: 'legacy', enabled: false });
const issueCreate = toolView(github);
const traffic = toolView(posthog, {
  id: `mcpt_${'e'.repeat(24)}`,
  qualifiedName: 'posthog.traffic_report',
  upstreamName: 'traffic_report',
  description: 'Website analytics traffic report',
  permission: 'allow'
});
const deniedSecret = toolView(posthog, {
  id: `mcpt_${'f'.repeat(24)}`,
  qualifiedName: 'posthog.delete_project',
  upstreamName: 'delete_project',
  description: 'Delete a project',
  permission: 'deny'
});
const disabledTool = toolView(legacy, {
  id: `mcpt_${'g'.repeat(24)}`,
  qualifiedName: 'legacy.old_thing',
  upstreamName: 'old_thing',
  description: 'A tool on a disabled server',
  permission: 'allow'
});

const CATALOG: { servers: McpGatewayServerView[]; tools: McpGatewayToolView[] } = {
  servers: [github, posthog, legacy],
  tools: [issueCreate, traffic, deniedSecret, disabledTool]
};

type RecordedCall = { operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector };

type FakeRunnerOptions = {
  credentials?: McpGatewayResolvedCredentials | RunnerResponse;
  catalogError?: boolean;
};

function okResponse(message: string, data: unknown): RunnerResponse {
  return { ok: true, message, data, truncated: false };
}

function createFakeRunner(options: FakeRunnerOptions = {}) {
  const calls: RecordedCall[] = [];
  const traces: Record<string, unknown>[] = [];
  const runner = {
    async callInternal(
      operation: string,
      input: Record<string, unknown>,
      callPrincipal: RunnerPrincipalSelector
    ): Promise<RunnerResponse> {
      calls.push({ operation, input, principal: callPrincipal });
      if (operation === 'mcp_gateway_catalog') {
        if (options.catalogError) {
          return {
            ok: false,
            message: 'catalog unavailable',
            error: { code: 'UNAVAILABLE', message: 'catalog unavailable', retryable: true },
            truncated: false
          };
        }
        const filter = input as GatewayCatalogFilter;
        const servers = filter.serverId
          ? CATALOG.servers.filter((server) => server.id === filter.serverId)
          : CATALOG.servers;
        const tools = filter.qualifiedName
          ? CATALOG.tools.filter((tool) => tool.qualifiedName === filter.qualifiedName)
          : filter.serverId
            ? CATALOG.tools.filter((tool) => tool.serverId === filter.serverId)
            : CATALOG.tools;
        return okResponse('MCP gateway catalog', { servers, tools });
      }
      if (operation === 'mcp_server_get_credentials') {
        const resolved = options.credentials ?? {
          allowed: true,
          transport: 'streamable-http',
          endpoint: 'https://upstream.test/mcp',
          headers: { Authorization: 'Bearer fake-secret-value' }
        };
        if ('ok' in resolved) return resolved;
        return okResponse('MCP credentials resolved', resolved);
      }
      if (operation === 'mcp_gateway_trace_append') {
        traces.push(input);
        return okResponse('MCP trace recorded', { trace: { id: input.serverId ?? 'mcpg_traceid' } });
      }
      if (operation === 'mcp_server_replace_tools') {
        return okResponse('MCP tools replaced', { server: github, tools: [] });
      }
      if (operation === 'mcp_server_connection_result') {
        return okResponse('MCP connection result recorded', { server: github });
      }
      return okResponse('ok', {});
    }
  } as unknown as RunnerClient;
  return { runner, calls, traces };
}

type FakeConnectionOptions = {
  listTools?: () => Promise<{ tools: unknown[] }>;
  callTool?: (name: string, args: Record<string, unknown>, client: Client) => Promise<unknown>;
  failure?: unknown;
  health?: GatewayConnectionHealth;
};

function createFakeConnections(options: FakeConnectionOptions = {}) {
  const health = options.health ?? 'unknown';
  const withConnection = vi.fn(
    async (
      _server: McpGatewayServerView,
      _headers: Record<string, string>,
      fn: (client: Client) => Promise<unknown>,
    ): Promise<unknown> => {
      if (options.failure) throw options.failure;
      const client = {
        listTools: options.listTools ?? (async () => ({ tools: [] })),
        callTool: async (params: { name: string; arguments: Record<string, unknown> }) =>
          options.callTool
            ? await options.callTool(params.name, params.arguments, client as unknown as Client)
            : { content: [{ type: 'text', text: 'ok' }], isError: false }
      } as unknown as Client;
      return await fn(client);
    }
  );
  const manager = {
    withConnection,
    health: vi.fn(() => health),
    invalidate: vi.fn(),
    closeAll: vi.fn(async () => undefined)
  } as unknown as GatewayConnectionManager;
  return { manager, withConnection };
}

function serviceFor(
  runner: RunnerClient,
  connections: GatewayConnectionManager,
  overrides: Partial<ConstructorParameters<typeof McpGatewayService>[2]> = {}
): McpGatewayService {
  return new McpGatewayService(runner, connections, {
    timeoutMs: 2_000,
    maxResponseBytes: 262_144,
    maxToolsPerServer: 500,
    maxSchemaBytes: 65_536,
    maxCatalogBytes: 2_097_152,
    ...overrides
  });
}

describe('McpGatewayService: catalog loading and cache', () => {
  it('filters inspect and execute catalog reads to the single tool', async () => {
    const { runner, calls } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    await service.inspect(principal, { tool: 'posthog.traffic_report' });
    await service.execute(principal, { tool: 'posthog.traffic_report', arguments: {} });

    const catalogCalls = calls.filter((call) => call.operation === 'mcp_gateway_catalog');
    expect(catalogCalls.length).toBeGreaterThanOrEqual(1);
    // The first read is cached and reused; no read may ever omit the filter, which
    // would transfer the whole fleet on a single-tool operation.
    expect(catalogCalls[0]!.input).toEqual({ qualifiedName: 'posthog.traffic_report' });
    for (const call of catalogCalls) {
      expect(call.input).toEqual({ qualifiedName: 'posthog.traffic_report' });
    }
  });

  it('caches one catalog view per principal and filter and invalidates per principal', async () => {
    const { runner, calls } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager, { catalogTtlMs: 60_000 });

    for (let index = 0; index < 3; index += 1) {
      await service.search(principal, { query: 'issue', limit: 5 });
    }
    let catalogCalls = calls.filter((call) => call.operation === 'mcp_gateway_catalog');
    expect(catalogCalls).toHaveLength(1);

    await service.search(otherPrincipal, { query: 'issue', limit: 5 });
    catalogCalls = calls.filter((call) => call.operation === 'mcp_gateway_catalog');
    expect(catalogCalls).toHaveLength(2);

    service.invalidateCatalog(principal);
    await service.search(principal, { query: 'issue', limit: 5 });
    catalogCalls = calls.filter((call) => call.operation === 'mcp_gateway_catalog');
    expect(catalogCalls).toHaveLength(3);
    expect(catalogCalls[2]!.input).toEqual({});
  });

  it('re-reads an expired catalog view', async () => {
    let now = 1_000;
    const { runner, calls } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager, { catalogTtlMs: 100, now: () => now });

    await service.search(principal, { query: 'issue', limit: 5 });
    now += 500;
    await service.search(principal, { query: 'issue', limit: 5 });
    expect(calls.filter((call) => call.operation === 'mcp_gateway_catalog')).toHaveLength(2);
  });

  it('surfaces a failed catalog read as an error result with the upstream code', async () => {
    const { runner } = createFakeRunner({ catalogError: true });
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.search(principal, { query: 'issue', limit: 5 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });
});

describe('McpGatewayService: search', () => {
  it('ranks a matching tool and excludes a disabled server and denied tools', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.search(principal, { query: 'website analytics traffic', limit: 5 });
    expect(result.ok).toBe(true);
    const data = result.data as { results: Array<{ tool: string; server: string; score: number }> };
    expect(data.results.map((entry) => entry.tool)).toEqual(['posthog.traffic_report']);
    expect(data.results[0]!.server).toBe('posthog');
    expect(data.results[0]!.score).toBeGreaterThan(0);
  });

  it('returns an empty result for an unknown server filter and clamps the limit', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const unknown = await service.search(principal, { query: 'issue', server: 'nope', limit: 5 });
    expect(unknown.ok).toBe(true);
    expect((unknown.data as { results: unknown[] }).results).toEqual([]);

    const clamped = await service.search(principal, { query: 'issue', limit: 100 });
    expect((clamped.data as { results: unknown[] }).results.length).toBeLessThanOrEqual(25);
  });

  it('records a trace for a search without arguments', async () => {
    const { runner, traces } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    await service.search(principal, { query: 'issue', limit: 5 }, { clientId: 'client-1' });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ operation: 'search', status: 'success', clientId: 'client-1', serverId: null });
    expect(traces[0]).not.toHaveProperty('arguments');
    expect(traces[0]!.maxRows).toBe(20_000);
  });
});

describe('McpGatewayService: inspect', () => {
  it('returns the upstream schema verbatim plus permission and availability', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.inspect(principal, { tool: 'github.issue_create' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      name: 'github.issue_create',
      server: 'github',
      permission: 'allow',
      availability: 'available'
    });
    expect((result.data as { inputSchema: Record<string, unknown> }).inputSchema).toEqual(issueCreate.inputSchema);
    expect((result.data as { inputSchema: Record<string, unknown> }).inputSchema).toMatchObject({
      required: ['title']
    });
  });

  it('returns the same 404 for unknown and forbidden tools so existence is not leaked', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const unknown = await service.inspect(principal, { tool: 'github.nope' });
    const denied = await service.inspect(principal, { tool: 'posthog.delete_project' });
    expect(unknown.ok).toBe(false);
    expect(denied.ok).toBe(false);
    expect(unknown.error?.code).toBe('NOT_FOUND');
    expect(denied.error?.code).toBe('NOT_FOUND');
    expect(unknown.error?.message).toBe('unknown or inaccessible MCP tool');
    expect(denied.error?.message).toBe(unknown.error?.message);
  });

  it('rejects a malformed qualified name before reading the catalog', async () => {
    const { runner, calls } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.inspect(principal, { tool: 'not-qualified' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(calls.filter((call) => call.operation === 'mcp_gateway_catalog')).toHaveLength(0);
  });
});

describe('McpGatewayService: execute', () => {
  it('resolves execute credentials, calls the tool once, and returns the normalized envelope', async () => {
    const { runner, calls } = createFakeRunner();
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'created' }],
      structuredContent: { number: 7 },
      isError: false
    }));
    const { manager } = createFakeConnections({ callTool });
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: { title: 'hello' } });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      content: [{ type: 'text', text: 'created' }],
      structuredContent: { number: 7 },
      isError: false
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe('issue_create');
    expect(callTool.mock.calls[0]![1]).toEqual({ title: 'hello' });

    const credentialCall = calls.find((call) => call.operation === 'mcp_server_get_credentials');
    expect(credentialCall?.input).toEqual({ serverId: github.id, toolName: 'issue_create', purpose: 'execute' });
  });

  it('returns a denied envelope, never calls downstream, and records a denied trace', async () => {
    const { runner, traces } = createFakeRunner({
      credentials: { allowed: false, reason: 'tool_denied' }
    });
    const callTool = vi.fn();
    const { manager, withConnection } = createFakeConnections({ callTool });
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: { title: 'hello' } });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      tool: 'github.issue_create',
      server: 'github',
      allowed: false,
      reason: 'tool_denied'
    });
    expect(withConnection).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ operation: 'execute', status: 'denied', errorCode: 'FORBIDDEN' });
    // No header material may ride the trace input.
    expect(traces[0]).not.toHaveProperty('headers');
  });

  it('refuses a tool on a disabled server before resolving credentials', async () => {
    const { runner, calls } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'legacy.old_thing', arguments: {} });
    expect(result.ok).toBe(false);
    // A disabled server is indistinguishable from an inaccessible tool, so execution
    // never leaks that the server exists.
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(calls.filter((call) => call.operation === 'mcp_server_get_credentials')).toHaveLength(0);
  });

  it('refuses an unavailable tool without contacting downstream', async () => {
    const { runner } = createFakeRunner();
    const { manager, withConnection } = createFakeConnections();
    const unavailable = toolView(github, { availability: 'unavailable' });
    const original = CATALOG.tools[0]!;
    CATALOG.tools[0] = unavailable;
    try {
      const service = serviceFor(runner, manager);
      const result = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toBe('tool is unavailable');
      expect(withConnection).not.toHaveBeenCalled();
    } finally {
      CATALOG.tools[0] = original;
    }
  });

  it('never retries a failed downstream call and records an error trace', async () => {
    const { runner, traces } = createFakeRunner();
    const withConnection = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const manager = {
      withConnection,
      health: vi.fn(() => 'unknown' as const),
      invalidate: vi.fn(),
      closeAll: vi.fn(async () => undefined)
    } as unknown as GatewayConnectionManager;
    const service = serviceFor(runner, manager);

    const first = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
    expect(first.ok).toBe(false);
    expect(withConnection).toHaveBeenCalledTimes(1);
    expect(traces.filter((trace) => trace.operation === 'execute')).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'error' });
  });

  it('normalizes a downstream isError result and keeps the structured content', async () => {
    const { runner, traces } = createFakeRunner();
    const { manager } = createFakeConnections({
      callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true })
    });
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
    expect(result.ok).toBe(true);
    expect((result.data as { isError: boolean }).isError).toBe(true);
    expect(traces[0]).toMatchObject({ status: 'error', errorCode: 'EXECUTION_FAILED' });
  });

  it('scrubs a credential value out of a thrown downstream failure and its trace', async () => {
    const secret = 'hunter2-super-secret-token';
    const { runner, traces } = createFakeRunner({
      credentials: {
        allowed: true,
        transport: 'streamable-http',
        endpoint: 'https://upstream.test/mcp',
        headers: { Authorization: `Bearer ${secret}` }
      }
    });
    const withConnection = vi.fn(async () => {
      throw new Error(`upstream rejected Authorization: Bearer ${secret}`);
    });
    const manager = {
      withConnection,
      health: vi.fn(() => 'unknown' as const),
      invalidate: vi.fn(),
      closeAll: vi.fn(async () => undefined)
    } as unknown as GatewayConnectionManager;
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(traces)).not.toContain(secret);
  });

  it('scrubs a credential value from a returning downstream result without changing its shape', async () => {
    const secret = 'ghp_returned_payload_secret_7d2a';
    const { runner } = createFakeRunner({
      credentials: {
        allowed: true,
        transport: 'streamable-http',
        endpoint: 'https://upstream.test/mcp',
        headers: { 'x-api-key': secret }
      }
    });
    const { manager } = createFakeConnections({
      callTool: async () => ({
        content: [
          { type: 'text', text: `upstream echoed ${secret}` },
          { type: 'resource', resource: { uri: 'file:///tmp/report', text: `nested ${secret}` } }
        ],
        structuredContent: {
          token: secret,
          keep: 'kept',
          count: 3,
          list: [secret, 'kept'],
          nested: { echo: secret, ok: true }
        },
        isError: false
      })
    });
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);

    const data = result.data as {
      content: Array<{ type: string; text?: string; resource?: { uri: string; text: string } }>;
      structuredContent: Record<string, unknown>;
      isError: boolean;
    };
    // Structure is preserved and only the credential leaves are replaced.
    expect(data.content).toHaveLength(2);
    expect(data.content[0]).toEqual({ type: 'text', text: 'upstream echoed [REDACTED_SECRET]' });
    expect(data.content[1]).toEqual({
      type: 'resource',
      resource: { uri: 'file:///tmp/report', text: 'nested [REDACTED_SECRET]' }
    });
    expect(data.structuredContent).toEqual({
      token: '[REDACTED_SECRET]',
      keep: 'kept',
      count: 3,
      list: ['[REDACTED_SECRET]', 'kept'],
      nested: { echo: '[REDACTED_SECRET]', ok: true }
    });
    expect(data.isError).toBe(false);
  });

  it('normalizes a connection-manager timeout into a TIMEOUT result', async () => {
    const { HarnessError } = await import('@cloud-harness/contracts');
    const { runner, traces } = createFakeRunner();
    const { manager } = createFakeConnections({ failure: new HarnessError('TIMEOUT', 'the downstream MCP call timed out', 504, true) });
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
    expect(traces[0]).toMatchObject({ status: 'error', errorCode: 'TIMEOUT' });
  });

  it('swallows a failed trace write', async () => {
    const runner = {
      async callInternal(operation: string): Promise<RunnerResponse> {
        if (operation === 'mcp_gateway_trace_append') throw new Error('audit sink down');
        if (operation === 'mcp_gateway_catalog') return okResponse('catalog', { servers: [github], tools: [issueCreate] });
        if (operation === 'mcp_server_get_credentials') {
          return okResponse('credentials', { allowed: true, headers: { Authorization: 'Bearer x' } });
        }
        return okResponse('ok', {});
      }
    } as unknown as RunnerClient;
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.execute(principal, { tool: 'github.issue_create', arguments: {} });
    expect(result.ok).toBe(true);
  });
});

describe('McpGatewayService: permissions', () => {
  it('resolves one tool, one server, and the server list', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const tool = await service.permissions(principal, { tool: 'posthog.delete_project' });
    expect(tool.data).toEqual({ tool: 'posthog.delete_project', allowed: false, reason: 'tool_denied' });

    const allowedTool = await service.permissions(principal, { tool: 'github.issue_create' });
    expect(allowedTool.data).toEqual({ tool: 'github.issue_create', allowed: true });

    // A tool on a disabled server is reported as inaccessible, matching execute/inspect.
    const disabledToolResult = await service.permissions(principal, { tool: 'legacy.old_thing' });
    expect(disabledToolResult.data).toEqual({ tool: 'legacy.old_thing', allowed: false, reason: 'server_disabled' });

    const unknownTool = await service.permissions(principal, { tool: 'github.nope' });
    expect(unknownTool.data).toEqual({ tool: 'github.nope', allowed: false, reason: 'tool_unknown' });

    const server = await service.permissions(principal, { server: 'posthog' });
    expect(server.data).toMatchObject({ server: 'posthog', permissionDefault: 'allow' });
    expect((server.data as { tools: Array<{ name: string; permission: string }> }).tools).toEqual([
      { name: 'posthog.traffic_report', permission: 'allow' },
      { name: 'posthog.delete_project', permission: 'deny' }
    ]);

    const all = await service.permissions(principal, {});
    expect((all.data as { servers: Array<{ name: string }> }).servers.map((entry) => entry.name)).toEqual([
      'github',
      'posthog',
      'legacy'
    ]);
  });

  it('reports an unknown server as NOT_FOUND', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.permissions(principal, { server: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

describe('McpGatewayService: status', () => {
  it('reconciles persisted status with live connection health and tolerates a broken server', async () => {
    const broken = serverView({
      id: `mcps_${'h'.repeat(24)}`,
      name: 'broken',
      status: 'error',
      lastError: 'downstream refused the connection',
      lastConnectedAt: 5,
      lastCheckedAt: 6
    });
    const { runner } = createFakeRunner({
      credentials: { allowed: true, headers: {} }
    });
    CATALOG.servers.push(broken);
    try {
      const { manager } = createFakeConnections({ health: 'connected' });
      const service = serviceFor(runner, manager);

      const result = await service.status(principal);
      expect(result.ok).toBe(true);
      const servers = (result.data as { servers: Array<Record<string, unknown>> }).servers;
      const brokenStatus = servers.find((entry) => entry.server === 'broken');
      expect(brokenStatus).toMatchObject({
        enabled: true,
        connection: 'connected',
        error: 'downstream refused the connection',
        lastConnectedAt: 5,
        lastCheckedAt: 6
      });
      expect(servers.find((entry) => entry.server === 'legacy')?.connection).toBe('disabled');
      expect(servers.find((entry) => entry.server === 'github')?.toolCount).toBe(1);
    } finally {
      CATALOG.servers.pop();
    }
  });
});

describe('McpGatewayService: refresh and test use the connect purpose', () => {
  it('refreshes with connect credentials and replaces normalized tools', async () => {
    const { runner, calls } = createFakeRunner({ credentials: { allowed: true, headers: { Authorization: 'Bearer c' } } });
    const listTools = vi.fn(async () => ({
      tools: [
        { name: 'issue_create', description: 'Create an issue', inputSchema: { type: 'object' } },
        { name: 'not a valid name!', description: 'dropped', inputSchema: { type: 'object' } }
      ]
    }));
    const { manager } = createFakeConnections({ listTools });
    const service = serviceFor(runner, manager);

    const result = await service.refreshServer(principal, github.id);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ server: 'github', status: 'connected', toolCount: 1, error: null });

    const credentialCall = calls.find((call) => call.operation === 'mcp_server_get_credentials');
    expect(credentialCall?.input).toEqual({ serverId: github.id, purpose: 'connect' });
    expect(credentialCall?.input).not.toHaveProperty('toolName');

    const replace = calls.find((call) => call.operation === 'mcp_server_replace_tools');
    expect(replace?.input).toMatchObject({ serverId: github.id, status: 'connected', cap: 500 });
    const tools = replace?.input.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ upstreamName: 'issue_create', availability: 'available' });
    expect(typeof tools[0]!.schemaBytes).toBe('number');
  });

  it('works for a deny-by-default server and records the connection result', async () => {
    const { runner, calls } = createFakeRunner({ credentials: { allowed: true, headers: {} } });
    const denyByDefault = serverView({
      id: `mcps_${'i'.repeat(24)}`,
      name: 'deny-all',
      permissionDefault: 'deny'
    });
    CATALOG.servers.push(denyByDefault);
    try {
      const { manager } = createFakeConnections({ listTools: async () => ({ tools: [] }) });
      const service = serviceFor(runner, manager);
      const result = await service.testServer(principal, denyByDefault.id);
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ server: 'deny-all', status: 'connected', toolCount: 0, error: null });
      const credentialCall = calls.find((call) => call.operation === 'mcp_server_get_credentials');
      expect(credentialCall?.input).toEqual({ serverId: denyByDefault.id, purpose: 'connect' });
      const connectionResult = calls.find((call) => call.operation === 'mcp_server_connection_result');
      expect(connectionResult).toBeUndefined();
    } finally {
      CATALOG.servers.pop();
    }
  });

  it('records an error connection result with a sanitized message when discovery fails', async () => {
    const secret = 'refresh-secret-value';
    const { runner, calls } = createFakeRunner({
      credentials: { allowed: true, headers: { Authorization: `Bearer ${secret}` } }
    });
    const { manager } = createFakeConnections({ failure: new Error(`connect failed for Bearer ${secret}`) });
    const service = serviceFor(runner, manager);

    const result = await service.refreshServer(principal, github.id);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status: 'error', toolCount: 0 });
    expect(JSON.stringify(result)).not.toContain(secret);
    const connectionResult = calls.find((call) => call.operation === 'mcp_server_connection_result');
    expect(connectionResult?.input).toMatchObject({ serverId: github.id, status: 'error' });
    expect(JSON.stringify(connectionResult?.input)).not.toContain(secret);
  });

  it('reports NOT_FOUND for an unknown server and closes the connection pool', async () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    const result = await service.refreshServer(principal, `mcps_${'z'.repeat(24)}`);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');

    await service.close();
    expect(manager.closeAll).toHaveBeenCalledTimes(1);
  });

  it('evicts one server connection on demand so Phase 4 can invalidate after a mutation', () => {
    const { runner } = createFakeRunner();
    const { manager } = createFakeConnections();
    const service = serviceFor(runner, manager);

    service.invalidateConnection(github.id);
    expect(manager.invalidate).toHaveBeenCalledWith(github.id);
  });
});
