import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  TOOL_SPECS,
  type ApiConfig,
  type McpGatewayResolvedCredentials,
  type McpGatewayServerView,
  type McpGatewayToolView,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import type { RunnerClient } from '../src/runner-client.js';
import type { GatewayFetchLike } from '../src/mcp-gateway/redaction.js';

// The resolver is mocked so the rebinding case is deterministic and offline. Every
// other test uses an IP-literal endpoint or a hostname the mock resolves to a public
// address, and the SDK test client talks to the app over 127.0.0.1, which never
// reaches this module.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];
const SECRET = 'ghp_endpoint_boundary_secret_9f3a';
const TOKEN = 'endpoint-bearer-token-longer-than-32-characters';
const ENDPOINT = 'https://upstream.example.com/mcp';
const CALLER_ARGUMENTS = { title: 'Boundary probe', labels: ['a', 'b'], nested: { keep: true } };
const TRAFFIC_SCHEMA = {
  type: 'object',
  properties: {
    site: { type: 'string' },
    period: { type: 'string', enum: ['day', 'week'] }
  },
  required: ['site'],
  additionalProperties: false
};

type JsonRpcBody = { id?: unknown; method?: string; params?: Record<string, unknown> };
type RecordedRequest = {
  method: string;
  path: string;
  url: string;
  authorization: string | null;
  body: JsonRpcBody;
  toolArguments: Record<string, unknown> | null;
};

type FakeDownstreamOptions = {
  /** Returns the tool result for the Nth `tools/call` (0-based); a hung call never resolves. */
  toolResult?: (callIndex: number) => unknown | Promise<unknown>;
  tools?: unknown[];
};

function createFakeDownstream(options: FakeDownstreamOptions = {}) {
  const state = { initialize: 0, list: 0, call: 0, requests: [] as RecordedRequest[] };
  const fetchImpl: GatewayFetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const body = method === 'POST' ? (JSON.parse(rawBody) as JsonRpcBody) : {};
    const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    state.requests.push({
      method,
      path: url.pathname,
      url: url.toString(),
      authorization: headers.get('authorization'),
      body,
      toolArguments: params?.arguments ?? null
    });
    if (method !== 'POST') return new Response('', { status: 405 });
    const id = body.id ?? null;
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    // Without the credential the endpoint challenges for OAuth, which makes the SDK
    // probe `.well-known/oauth-protected-resource`. That probe must never carry the
    // resolved credential, so the fake must actually offer the challenge.
    if (headers.get('authorization') === null) {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` }
      });
    }
    if (body.method === 'server/discover') {
      return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
    if (body.method === 'initialize') {
      state.initialize += 1;
      const requested = body.params?.protocolVersion;
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-downstream', version: '1.0.0' }
        }
      });
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/list') {
      state.list += 1;
      return json({ jsonrpc: '2.0', id, result: { tools: options.tools ?? [] } });
    }
    if (body.method === 'tools/call') {
      const index = state.call;
      state.call += 1;
      const result = options.toolResult
        ? await options.toolResult(index)
        : { content: [{ type: 'text', text: 'ok' }], isError: false };
      return json({ jsonrpc: '2.0', id, result });
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  };
  return { fetchImpl, state };
}

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
    annotations: null,
    availability: 'available',
    permission: 'allow',
    discoveredAt: 1,
    ...overrides
  };
}

const github = serverView();
const posthog = serverView({ id: `mcps_${'c'.repeat(24)}`, name: 'posthog', endpoint: 'https://posthog.example.com/mcp', toolCount: 2 });
const issueCreate = toolView(github);
const traffic = toolView(posthog, {
  id: `mcpt_${'d'.repeat(24)}`,
  qualifiedName: 'posthog.traffic_report',
  upstreamName: 'traffic_report',
  description: 'Website analytics traffic report for a site',
  inputSchema: TRAFFIC_SCHEMA
});
const sessionDetail = toolView(posthog, {
  id: `mcpt_${'e'.repeat(24)}`,
  qualifiedName: 'posthog.session_detail',
  upstreamName: 'session_detail',
  description: 'Inspect one recorded analytics session',
  inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } }
});

// The runner is the sole permission authority, so its catalog already excludes the
// disabled server and the denied tool. The API must never re-admit them.
const ACCESSIBLE_CATALOG = { servers: [github, posthog], tools: [issueCreate, traffic, sessionDetail] };

type FakeRunnerState = {
  credentials: McpGatewayResolvedCredentials;
  catalog: { servers: McpGatewayServerView[]; tools: McpGatewayToolView[] };
  calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;
  traces: Array<Record<string, unknown>>;
  replaceTools: Array<Record<string, unknown>>;
  connectionResults: Array<Record<string, unknown>>;
  failTraceWrites: boolean;
};

function createFakeRunner(overrides: Partial<FakeRunnerState> = {}) {
  const state: FakeRunnerState = {
    credentials: {
      allowed: true,
      transport: 'streamable-http',
      endpoint: ENDPOINT,
      headers: { Authorization: `Bearer ${SECRET}` }
    },
    catalog: { servers: [...ACCESSIBLE_CATALOG.servers], tools: [...ACCESSIBLE_CATALOG.tools] },
    calls: [],
    traces: [],
    replaceTools: [],
    connectionResults: [],
    failTraceWrites: false,
    ...overrides
  };
  const runner = {
    async callInternal(
      operation: string,
      input: Record<string, unknown>,
      principal: RunnerPrincipalSelector
    ): Promise<RunnerResponse> {
      state.calls.push({ operation, input, principal });
      const ok = (message: string, data: unknown): RunnerResponse => ({ ok: true, message, data, truncated: false });
      if (operation === 'mcp_gateway_catalog') {
        const filter = input as { serverId?: string; qualifiedName?: string };
        const servers = filter.serverId
          ? state.catalog.servers.filter((server) => server.id === filter.serverId)
          : state.catalog.servers;
        const tools = filter.qualifiedName
          ? state.catalog.tools.filter((tool) => tool.qualifiedName === filter.qualifiedName)
          : filter.serverId
            ? state.catalog.tools.filter((tool) => tool.serverId === filter.serverId)
            : state.catalog.tools;
        return ok('MCP gateway catalog', { servers, tools });
      }
      if (operation === 'mcp_server_get_credentials') {
        return ok('MCP credentials resolved', state.credentials);
      }
      if (operation === 'mcp_gateway_trace_append') {
        if (state.failTraceWrites) throw new Error('audit sink down');
        state.traces.push(input);
        return ok('MCP trace recorded', { trace: { id: 'mcpg_trace' } });
      }
      if (operation === 'mcp_server_replace_tools') {
        state.replaceTools.push(input);
        return ok('MCP tools replaced', { server: github, tools: [] });
      }
      if (operation === 'mcp_server_connection_result') {
        state.connectionResults.push(input);
        return ok('MCP connection result recorded', { server: github });
      }
      return ok('ok', {});
    },
    async ready(): Promise<boolean> {
      return true;
    }
  } as unknown as RunnerClient;
  return { runner, state };
}

type Harness = {
  config: ApiConfig;
  client: Client;
  runtime: ApiRuntime;
  close: () => Promise<void>;
};

let nextPort = 4200;

function baseConfig(): ApiConfig {
  nextPort += 1;
  return {
    host: '127.0.0.1',
    port: 0,
    ownerId: 'owner',
    bearerToken: TOKEN,
    runnerUrl: `http://127.0.0.1:${nextPort}`,
    runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['127.0.0.1'],
    allowedOrigins: [],
    requestTimeoutMs: 5_000,
    maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 1_000,
    mcpGatewayMaxResponseBytes: 262_144,
    mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536,
    mcpGatewayMaxCatalogBytes: 2_097_152,
    mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 4,
    mcpGatewayAllowInsecureHttp: true,
    mcpGatewayAllowPrivateEndpoints: true
  };
}

async function startHarness(
  runnerClient: RunnerClient,
  fetchImpl: GatewayFetchLike,
  overrides: Partial<ApiConfig> = {}
): Promise<Harness> {
  const config = { ...baseConfig(), ...overrides };
  const runtime: ApiRuntime = createApiApp(config, { runnerClient, gatewayFetchImpl: fetchImpl });
  const server: Server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API test server failed to bind');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp-gateway`);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    config,
    client,
    runtime,
    close: async () => {
      await client.close().catch(() => undefined);
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function toolResult(result: { structuredContent?: unknown; content?: unknown[] }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe('GET /mcp-gateway tools/list', () => {
  beforeAll(() => {
    dns.lookup.mockImplementation(async () => PUBLIC_ADDRESS);
  });
  afterAll(() => {
    dns.lookup.mockReset();
  });

  it('advertises exactly the five meta-tools', async () => {
    const { runner } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      const listed = await harness.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'execute',
        'inspect',
        'permissions',
        'search',
        'status'
      ]);
      expect(listed.tools.find((tool) => tool.name === 'execute')?.annotations?.destructiveHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === 'search')?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('stays at five tools with 500 downstream tools present', async () => {
    const big = serverView({ id: `mcps_${'f'.repeat(24)}`, name: 'big', toolCount: 500 });
    const tools = Array.from({ length: 500 }, (_value, index) =>
      toolView(big, {
        id: `mcpt_${String(index).padStart(22, '0')}`,
        qualifiedName: `big.tool_${index}`,
        upstreamName: `tool_${index}`,
        description: `Synthetic downstream tool ${index}`,
        inputSchema: { type: 'object', properties: { index: { type: 'number' } } }
      })
    );
    const { runner } = createFakeRunner({ catalog: { servers: [big], tools } });
    const { fetchImpl, state } = createFakeDownstream({ tools: tools.map((tool) => ({ name: tool.upstreamName })) });
    const harness = await startHarness(runner, fetchImpl);
    try {
      const listed = await harness.client.listTools();
      expect(listed.tools).toHaveLength(5);
      const search = toolResult(
        (await harness.client.callTool({ name: 'search', arguments: { query: 'synthetic downstream tool 499', limit: 5 } })) as {
          structuredContent?: unknown;
        }
      );
      const results = (search.data as { results: Array<{ tool: string }> }).results;
      expect(results.length).toBeGreaterThan(0);
      expect(state.list).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

describe('/mcp-gateway progressive disclosure', () => {
  beforeAll(() => {
    dns.lookup.mockImplementation(async () => PUBLIC_ADDRESS);
  });
  afterAll(() => {
    dns.lookup.mockReset();
  });

  it('searches permission-filtered tools and honours the server filter', async () => {
    const { runner } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      const found = toolResult(
        (await harness.client.callTool({
          name: 'search',
          arguments: { query: 'website analytics traffic', limit: 5 }
        })) as { structuredContent?: unknown }
      );
      expect((found.data as { results: Array<{ tool: string }> }).results.map((entry) => entry.tool)).toContain(
        'posthog.traffic_report'
      );

      const none = toolResult(
        (await harness.client.callTool({ name: 'search', arguments: { query: 'issue', server: 'posthog', limit: 5 } })) as {
          structuredContent?: unknown;
        }
      );
      expect((none.data as { results: unknown[] }).results).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns the upstream input schema unchanged from inspect', async () => {
    const { runner, state } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      const inspected = toolResult(
        (await harness.client.callTool({ name: 'inspect', arguments: { tool: 'posthog.traffic_report' } })) as {
          structuredContent?: unknown;
        }
      );
      expect(inspected.data).toMatchObject({
        name: 'posthog.traffic_report',
        server: 'posthog',
        permission: 'allow',
        availability: 'available'
      });
      expect((inspected.data as { inputSchema: unknown }).inputSchema).toEqual(TRAFFIC_SCHEMA);
      // Inspect reads only the single tool, never the whole fleet.
      const catalogCalls = state.calls.filter((call) => call.operation === 'mcp_gateway_catalog');
      expect(catalogCalls).toHaveLength(1);
      expect(catalogCalls[0]!.input).toEqual({ qualifiedName: 'posthog.traffic_report' });
    } finally {
      await harness.close();
    }
  });

  it('reports effective permissions for a tool, a server, and the server list', async () => {
    const { runner } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      const one = toolResult(
        (await harness.client.callTool({ name: 'permissions', arguments: { tool: 'posthog.traffic_report' } })) as {
          structuredContent?: unknown;
        }
      );
      expect(one.data).toEqual({ tool: 'posthog.traffic_report', allowed: true });

      const server = toolResult(
        (await harness.client.callTool({ name: 'permissions', arguments: { server: 'posthog' } })) as {
          structuredContent?: unknown;
        }
      );
      expect(server.data).toMatchObject({ server: 'posthog', permissionDefault: 'allow' });

      const all = toolResult((await harness.client.callTool({ name: 'permissions', arguments: {} })) as {
        structuredContent?: unknown;
      });
      expect((all.data as { servers: Array<{ name: string }> }).servers.map((entry) => entry.name)).toEqual([
        'github',
        'posthog'
      ]);
    } finally {
      await harness.close();
    }
  });

  it('reports server status without touching downstream', async () => {
    const { runner } = createFakeRunner();
    const { fetchImpl, state } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      const listed = toolResult((await harness.client.callTool({ name: 'status', arguments: {} })) as {
        structuredContent?: unknown;
      });
      const servers = (listed.data as { servers: Array<Record<string, unknown>> }).servers;
      expect(servers.map((entry) => entry.server)).toEqual(['github', 'posthog']);
      expect(servers.every((entry) => entry.connection === 'unknown')).toBe(true);
      expect(state.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe('/mcp-gateway execute credential boundary', () => {
  beforeAll(() => {
    dns.lookup.mockImplementation(async () => PUBLIC_ADDRESS);
  });
  afterAll(() => {
    dns.lookup.mockReset();
  });

  it('scopes the credential to exactly the tools/call request and to no trace', async () => {
    const { runner, state: runnerState } = createFakeRunner();
    const { fetchImpl, state } = createFakeDownstream({
      toolResult: () => ({
        content: [{ type: 'text', text: 'report ready' }],
        structuredContent: { reports: 3 },
        isError: false
      })
    });
    const harness = await startHarness(runner, fetchImpl);
    try {
      const result = await harness.client.callTool({
        name: 'execute',
        arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
      });
      const envelope = toolResult(result as { structuredContent?: unknown });
      expect(envelope.ok).toBe(true);
      expect((envelope.data as { structuredContent: unknown }).structuredContent).toEqual({ reports: 3 });

      // The caller's arguments arrive byte-identical.
      const call = state.requests.find((request) => request.body.method === 'tools/call');
      expect(call).toBeDefined();
      expect(call!.toolArguments).toEqual(CALLER_ARGUMENTS);
      expect(call!.authorization).toBe(`Bearer ${SECRET}`);

      // Exactly one tools/call, never a retry.
      expect(state.requests.filter((request) => request.body.method === 'tools/call')).toHaveLength(1);

      // The credential never reaches a discovery-path request.
      for (const request of state.requests) {
        if (request.path !== '/mcp') expect(request.authorization).toBeNull();
      }

      // The credential appears in no client result and in no recorded trace.
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(runnerState.traces)).not.toContain(SECRET);
      expect(runnerState.traces).toHaveLength(1);
      expect(runnerState.traces[0]).toMatchObject({ operation: 'execute', status: 'success', tool: 'posthog.traffic_report' });
      expect(runnerState.traces[0]).not.toHaveProperty('arguments');
      expect(JSON.stringify(runnerState.traces[0]!.requestBytes)).not.toContain(SECRET);
    } finally {
      await harness.close();
    }
  });

  it('attaches the credential to no request outside the configured endpoint path', async () => {
    const { runner, state: runnerState } = createFakeRunner();
    const { fetchImpl, state } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      // Connecting the SDK client to the gateway does not touch downstream at all.
      expect(state.requests).toHaveLength(0);

      const envelope = toolResult(
        (await harness.client.callTool({
          name: 'execute',
          arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
        })) as { structuredContent?: unknown }
      );
      expect(envelope.ok).toBe(true);

      // Exactly one tools/call is issued, and every request the gateway makes —
      // credentialed or not — addresses only the configured endpoint path.
      const calls = state.requests.filter((request) => request.body.method === 'tools/call');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.authorization).toBe(`Bearer ${SECRET}`);
      expect(calls[0]!.toolArguments).toEqual(CALLER_ARGUMENTS);
      expect(state.requests.some((request) => request.authorization !== null)).toBe(true);
      for (const request of state.requests) {
        expect(request.url.startsWith(ENDPOINT)).toBe(true);
      }
      expect(JSON.stringify(runnerState.traces)).not.toContain(SECRET);
    } finally {
      await harness.close();
    }
  });

  it('returns a denied envelope without calling downstream', async () => {
    const { runner, state: runnerState } = createFakeRunner({
      credentials: { allowed: false, reason: 'tool_denied' }
    });
    const { fetchImpl, state } = createFakeDownstream();
    const harness = await startHarness(runner, fetchImpl);
    try {
      const envelope = toolResult(
        (await harness.client.callTool({
          name: 'execute',
          arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
        })) as { structuredContent?: unknown }
      );
      expect(envelope.data).toMatchObject({ allowed: false, reason: 'tool_denied' });
      expect(state.requests.filter((request) => request.body.method === 'tools/call')).toHaveLength(0);
      expect(runnerState.traces).toHaveLength(1);
      expect(runnerState.traces[0]).toMatchObject({ status: 'denied', errorCode: 'FORBIDDEN' });
    } finally {
      await harness.close();
    }
  });

  it('refuses a rebinding resolver before any credentialed request is sent', async () => {
    let lookups = 0;
    dns.lookup.mockImplementation(async () => {
      lookups += 1;
      return lookups === 1 ? PUBLIC_ADDRESS : [{ address: '127.0.0.1', family: 4 }];
    });
    try {
      const { runner } = createFakeRunner();
      const { fetchImpl, state } = createFakeDownstream();
      const harness = await startHarness(runner, fetchImpl, {
        mcpGatewayAllowPrivateEndpoints: false,
        mcpGatewayAllowInsecureHttp: false
      });
      try {
        const envelope = toolResult(
          (await harness.client.callTool({
            name: 'execute',
            arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
          })) as { structuredContent?: unknown }
        );
        expect(envelope.ok).toBe(false);
        expect(lookups).toBeGreaterThanOrEqual(2);
        expect(state.requests).toHaveLength(0);
        expect(state.requests.filter((request) => request.authorization !== null)).toHaveLength(0);
      } finally {
        await harness.close();
      }
    } finally {
      dns.lookup.mockImplementation(async () => PUBLIC_ADDRESS);
    }
  });

  it('normalizes a downstream tools/call error into a sanitized non-throwing result', async () => {
    const { runner } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream({ toolResult: () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }) });
    const harness = await startHarness(runner, fetchImpl);
    try {
      const result = await harness.client.callTool({
        name: 'execute',
        arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
      });
      const envelope = toolResult(result as { structuredContent?: unknown });
      expect(envelope.ok).toBe(true);
      expect((envelope.data as { isError: boolean }).isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('fails a hung downstream tools/call with a TIMEOUT envelope inside the configured timeout', async () => {
    const { runner } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream({
      toolResult: () => new Promise<never>(() => undefined)
    });
    const harness = await startHarness(runner, fetchImpl, { mcpGatewayTimeoutMs: 1_000 });
    try {
      const started = Date.now();
      const envelope = toolResult(
        (await harness.client.callTool({
          name: 'execute',
          arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
        })) as { structuredContent?: unknown }
      );
      const elapsed = Date.now() - started;
      expect(envelope.ok).toBe(false);
      expect((envelope.error as { code: string }).code).toBe('TIMEOUT');
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await harness.close();
    }
  });
});

describe('/mcp-gateway execute output-schema boundary', () => {
  beforeAll(() => {
    dns.lookup.mockImplementation(async () => PUBLIC_ADDRESS);
  });
  afterAll(() => {
    dns.lookup.mockReset();
  });

  const OUTPUT_SCHEMA = {
    type: 'object',
    properties: { reports: { type: 'number' } },
    required: ['reports']
  };
  const downstreamTools = [
    {
      name: 'traffic_report',
      description: 'Website analytics traffic report',
      inputSchema: TRAFFIC_SCHEMA,
      outputSchema: OUTPUT_SCHEMA
    }
  ];
  const ownerPrincipal: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'owner' };

  // Warm the cached connection with a `tools/list` that declares the output schema,
  // which is what makes the SDK's structured-content guard reachable on `execute`.
  async function warmConnection(harness: Harness): Promise<void> {
    const warmed = await harness.runtime.gateway.testServer(ownerPrincipal, posthog.id);
    expect(warmed.ok).toBe(true);
  }

  it('executes a text-only result for a downstream tool that declares an outputSchema', async () => {
    const { runner } = createFakeRunner();
    const textOnly = { content: [{ type: 'text', text: 'report ready' }], isError: false };
    const { fetchImpl, state } = createFakeDownstream({
      tools: downstreamTools,
      toolResult: () => textOnly
    });
    const harness = await startHarness(runner, fetchImpl);
    try {
      await warmConnection(harness);
      expect(state.list).toBe(1);
      expect(state.initialize).toBe(1);

      const envelope = toolResult(
        (await harness.client.callTool({
          name: 'execute',
          arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
        })) as { structuredContent?: unknown }
      );
      expect(envelope.ok).toBe(true);
      expect((envelope.data as { content: unknown[] }).content).toEqual(textOnly.content);
      expect((envelope.data as { structuredContent?: unknown }).structuredContent).toBeUndefined();

      // The warm connection is reused across the text-only success: no reconnect churn.
      expect(state.initialize).toBe(1);
      expect(state.list).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('returns a mismatched structuredContent unchanged for a downstream tool that declares an outputSchema', async () => {
    const { runner } = createFakeRunner();
    const mismatched = { reports: 'not-a-number' };
    const { fetchImpl, state } = createFakeDownstream({
      tools: downstreamTools,
      toolResult: () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: mismatched, isError: false })
    });
    const harness = await startHarness(runner, fetchImpl);
    try {
      await warmConnection(harness);

      const envelope = toolResult(
        (await harness.client.callTool({
          name: 'execute',
          arguments: { tool: 'posthog.traffic_report', arguments: CALLER_ARGUMENTS }
        })) as { structuredContent?: unknown }
      );
      expect(envelope.ok).toBe(true);
      expect((envelope.data as { structuredContent: unknown }).structuredContent).toEqual(mismatched);
      expect(state.initialize).toBe(1);
    } finally {
      await harness.close();
    }
  });
});

describe('/mcp regression guard', () => {
  beforeAll(() => {
    dns.lookup.mockImplementation(async () => PUBLIC_ADDRESS);
  });
  afterAll(() => {
    dns.lookup.mockReset();
  });

  it('still lists the complete harness tool surface', async () => {
    const { runner, state } = createFakeRunner();
    const { fetchImpl } = createFakeDownstream();
    const config = { ...baseConfig() };
    const runtime = createApiApp(config, { runnerClient: runner, gatewayFetchImpl: fetchImpl });
    const server = createServer(runtime.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('API test server failed to bind');
    const client = new Client({ name: 'harness-test', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
        })
      );
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(TOOL_SPECS.length);
      expect(state.calls.filter((call) => call.operation.startsWith('mcp_gateway'))).toHaveLength(0);
    } finally {
      await client.close().catch(() => undefined);
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
