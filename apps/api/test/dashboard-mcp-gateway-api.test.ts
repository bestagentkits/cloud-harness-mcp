import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE,
  McpGatewaySetPermissionsInputSchema,
  type ApiConfig,
  type ErrorCode,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';
import type { McpGatewayService } from '../src/mcp-gateway/service.js';

// Write-time validation resolves hostnames; pin the resolver to a public address so
// the suite is deterministic and offline. Literal unsafe addresses never reach it.
const dns = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: false,
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

const serverId = `mcps_${'a'.repeat(24)}`;
const missingServerId = `mcps_${'b'.repeat(24)}`;
const secretRef = 'GITHUB_TOKEN';
// A distinctive value that must never appear in any dashboard response.
const secretValue = 'ghp_dashboard_boundary_secret_5f2c';

type HeaderView = { name: string; kind: 'literal' | 'secret'; secretRef?: string; value?: string };
type ServerView = {
  id: string; name: string; description: string | null; transport: 'streamable-http' | 'sse';
  endpoint: string; headers: HeaderView[]; enabled: boolean; status: string; toolCount: number;
  lastConnectedAt: number | null; lastError: string | null; lastCheckedAt: number | null;
  permissionDefault: 'allow' | 'deny'; generation: number; createdAt: number; updatedAt: number;
};

function serverView(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: serverId,
    name: 'github',
    description: 'GitHub MCP',
    transport: 'streamable-http',
    endpoint: 'https://github.example.com/mcp',
    headers: [{ name: 'Authorization', kind: 'secret', secretRef }],
    enabled: true,
    status: 'connected',
    toolCount: 3,
    lastConnectedAt: 1_700_000_000_000,
    lastError: null,
    lastCheckedAt: 1_700_000_000_000,
    permissionDefault: 'allow',
    generation: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  };
}

const toolView = {
  id: `mcpt_${'c'.repeat(24)}`,
  serverId,
  qualifiedName: 'github.issue_create',
  upstreamName: 'issue_create',
  description: 'Create a GitHub issue',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  annotations: null,
  availability: 'available',
  permission: 'allow',
  discoveredAt: 1_700_000_000_000
};

const traceView = {
  id: `mcpg_${'d'.repeat(24)}`,
  serverId,
  serverName: 'github',
  tool: 'issue_create',
  operation: 'execute',
  clientId: 'dashboard',
  durationMs: 12,
  status: 'success',
  errorCode: null,
  errorMessage: null,
  requestBytes: 10,
  responseBytes: 20,
  createdAt: 1_700_000_000_000
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };
let server: Server;
let port: number;
let runner: DashboardRunnerClient;
let calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;
let csrfHeaders: Record<string, string>;
let gatewayTestServer: ReturnType<typeof vi.fn>;
let gatewayRefreshServer: ReturnType<typeof vi.fn>;
let invalidateCatalog: ReturnType<typeof vi.fn>;
let invalidateConnection: ReturnType<typeof vi.fn>;

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const bodyBuf = options.body ? Buffer.from(options.body, 'utf8') : undefined;
  const headers: Record<string, string> = { host: 'dashboard.example', ...options.headers };
  if (bodyBuf && !headers['content-length'] && !headers['Content-Length']) {
    headers['content-length'] = String(bodyBuf.byteLength);
  }
  const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      resolve({ status: response.statusCode ?? 500, headers: response.headers as Record<string, string | string[] | undefined>, text, json });
    });
  });
  request.on('error', reject);
  request.end(options.body);
  return promise;
}

function mutate(path: string, method: string, body: unknown): Promise<Reply> {
  return send(path, { method, headers: csrfHeaders, body: JSON.stringify(body) });
}

beforeEach(async () => {
  calls = [];
  runner = {
    call: vi.fn(async (): Promise<RunnerResponse> => ({ ok: true, message: 'ok', truncated: false, data: {} })),
    callInternal: vi.fn(async (operation, input): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal });
      const ok = (data: unknown): RunnerResponse => ({ ok: true, message: 'ok', truncated: false, data });
      const failed = (code: ErrorCode, message: string): RunnerResponse => ({
        ok: false, message, truncated: false, error: { code, message, retryable: false }
      });
      switch (operation) {
        case 'mcp_server_list':
          return ok({ servers: [serverView()] });
        case 'mcp_server_get':
          if (input.serverId === missingServerId) return failed('NOT_FOUND', 'unknown or inaccessible MCP server');
          return ok({ server: serverView(), tools: [toolView] });
        case 'mcp_server_create':
          // The runner owns secret resolution; a missing reference surfaces here.
          if (input.name === 'missing-secret') return failed('NOT_FOUND', `global secret '${secretRef}' was not found`);
          return ok(serverView({ name: String(input.name) }));
        case 'mcp_server_update':
          return ok(serverView({ name: String(input.name ?? 'github'), generation: 2 }));
        case 'mcp_server_delete':
          return ok(serverView({ generation: 5 }));
        case 'mcp_server_set_enabled':
          return ok(serverView({ enabled: input.enabled === true, generation: 2 }));
        case 'mcp_server_set_permissions': {
          // The runner is the sole validator; a body carrying `default` cannot satisfy
          // this strict schema, so the missing `permissionDefault` is rejected.
          if (!McpGatewaySetPermissionsInputSchema.safeParse(input).success) {
            return failed('INVALID_INPUT', 'the permissions payload is invalid');
          }
          if (input.expectedGeneration === 99) return failed('CONFLICT', 'generation conflict');
          return ok(serverView({ permissionDefault: input.permissionDefault as 'allow' | 'deny', generation: 4 }));
        }
        case 'mcp_gateway_trace_list':
          return ok({ traces: [traceView] });
        default:
          return ok({});
      }
    })
  };
  gatewayTestServer = vi.fn(async () => ({
    ok: true, message: 'MCP server github is reachable', truncated: false,
    data: { server: 'github', status: 'connected', toolCount: 3, error: null }
  }));
  gatewayRefreshServer = vi.fn(async () => ({
    ok: true, message: 'Refreshed 3 MCP tool(s)', truncated: false,
    data: { server: 'github', status: 'connected', toolCount: 3, error: null }
  }));
  invalidateCatalog = vi.fn();
  invalidateConnection = vi.fn();
  const gateway = {
    testServer: gatewayTestServer,
    refreshServer: gatewayRefreshServer,
    invalidateCatalog,
    invalidateConnection
  } as unknown as McpGatewayService;

  const app = express();
  app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
  app.use('/dashboard', createDashboardRouter(config, runner, gateway));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;

  const session = await send('/api/v1/session');
  const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0]!;
  csrfHeaders = {
    origin: 'https://dashboard.example',
    cookie,
    'content-type': 'application/json',
    'x-csrf-token': session.json.csrfToken
  };
});

afterEach(async () => await new Promise<void>((resolve) => server.close(() => resolve())));

describe('Dashboard MCP server registry API', () => {
  it('maps the registry read routes to their operations', async () => {
    const list = await send('/api/v1/mcp-servers');
    expect(list.status).toBe(200);
    expect(list.json.data.servers[0].id).toBe(serverId);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_list', input: {} });

    const get = await send(`/api/v1/mcp-servers/${serverId}`);
    expect(get.status).toBe(200);
    expect(get.json.data.server.name).toBe('github');
    expect(get.json.data.tools[0].qualifiedName).toBe('github.issue_create');
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_get', input: { serverId } });

    const logs = await send(`/api/v1/mcp-servers/${serverId}/logs?limit=10`);
    expect(logs.status).toBe(200);
    expect(logs.json.data.traces[0].operation).toBe('execute');
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_gateway_trace_list', input: { serverId, limit: 10 } });
  });

  it('maps the registry mutation routes to their operations and input shapes', async () => {
    const create = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'github', transport: 'streamable-http', endpoint: 'https://github.example.com/mcp',
      headers: [{ name: 'Authorization', value: { secretRef } }], expectedGeneration: 0
    });
    expect(create.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_create' });
    expect(calls.at(-1)!.input).toMatchObject({ name: 'github', expectedGeneration: 0 });

    const update = await mutate(`/api/v1/mcp-servers/${serverId}`, 'PATCH', { name: 'github-renamed', expectedGeneration: 1 });
    expect(update.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_update', input: { serverId, name: 'github-renamed', expectedGeneration: 1 } });

    const enabled = await mutate(`/api/v1/mcp-servers/${serverId}/enabled`, 'POST', { enabled: false, expectedGeneration: 2 });
    expect(enabled.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_set_enabled', input: { serverId, enabled: false, expectedGeneration: 2 } });

    const permissions = await mutate(`/api/v1/mcp-servers/${serverId}/permissions`, 'PUT', {
      permissionDefault: 'deny', tools: [{ name: 'issue_create', permission: 'allow' }], expectedGeneration: 3
    });
    expect(permissions.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      operation: 'mcp_server_set_permissions',
      input: { serverId, permissionDefault: 'deny', tools: [{ name: 'issue_create', permission: 'allow' }], expectedGeneration: 3 }
    });

    const deleted = await mutate(`/api/v1/mcp-servers/${serverId}`, 'DELETE', { expectedGeneration: 4 });
    expect(deleted.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_delete', input: { serverId, expectedGeneration: 4 } });
  });

  it('rejects a malformed server id with 400 through the ZodError handler', async () => {
    const res = await send('/api/v1/mcp-servers/mcps_tooshort');
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('forwards permissionDefault and rejects a body that uses the legacy default field', async () => {
    const rejected = await mutate(`/api/v1/mcp-servers/${serverId}/permissions`, 'PUT', {
      default: 'deny', tools: [], expectedGeneration: 3
    });
    expect(rejected.status).toBe(400);
    expect(calls.at(-1)!.operation).toBe('mcp_server_set_permissions');
    // `default` is never forwarded; the frozen `permissionDefault` field is what reaches the runner.
    expect(calls.at(-1)!.input).not.toHaveProperty('default');
    expect(calls.at(-1)!.input).not.toHaveProperty('permissionDefault');

    const accepted = await mutate(`/api/v1/mcp-servers/${serverId}/permissions`, 'PUT', {
      permissionDefault: 'deny', tools: [], expectedGeneration: 3
    });
    expect(accepted.status).toBe(200);
    expect(calls.at(-1)!.input).toMatchObject({ permissionDefault: 'deny' });
  });

  it('maps a runner NOT_FOUND to 404 and names the missing secret reference', async () => {
    const res = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'missing-secret', transport: 'streamable-http', endpoint: 'https://github.example.com/mcp',
      headers: [{ name: 'Authorization', value: { secretRef } }], expectedGeneration: 0
    });
    expect(res.status).toBe(404);
    expect(res.json.message).toContain(secretRef);
    expect(res.json.message).not.toBe('Workspace not found or no longer available.');
  });

  it('maps a runner CONFLICT to 409 with gateway wording', async () => {
    const res = await mutate(`/api/v1/mcp-servers/${serverId}/permissions`, 'PUT', {
      permissionDefault: 'allow', tools: [], expectedGeneration: 99
    });
    expect(res.status).toBe(409);
    expect(res.json.message).toBe('This MCP server changed after you opened it.');
  });

  it('projects a literal header value but never a secret header value', async () => {
    const literalValue = '2024-01-01';
    // A stray `value` alongside `kind: 'secret'` must still be dropped.
    vi.mocked(runner.callInternal).mockImplementationOnce(async (): Promise<RunnerResponse> => ({
      ok: true,
      message: 'ok',
      truncated: false,
      data: {
        servers: [serverView({
          headers: [
            { name: 'Authorization', kind: 'secret', secretRef, value: secretValue },
            { name: 'X-Api-Version', kind: 'literal', value: literalValue }
          ]
        })]
      }
    }));

    const list = await send('/api/v1/mcp-servers');
    expect(list.status).toBe(200);
    expect(list.json.data.servers[0].headers).toEqual([
      { name: 'Authorization', kind: 'secret', secretRef },
      { name: 'X-Api-Version', kind: 'literal', value: literalValue }
    ]);
    expect(JSON.stringify(list.json)).not.toContain(secretValue);

    const create = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'github', transport: 'streamable-http', endpoint: 'https://github.example.com/mcp',
      headers: [{ name: 'Authorization', value: { secretRef } }], expectedGeneration: 0
    });
    expect(create.status).toBe(200);
    expect(create.json.data.headers).toEqual([{ name: 'Authorization', kind: 'secret', secretRef }]);
    expect(JSON.stringify(create.json)).not.toContain('"value"');
    expect(JSON.stringify(create.json)).not.toContain(secretValue);
  });
});

describe('Dashboard MCP server write-time endpoint validation', () => {
  it('rejects a metadata address on create without issuing a runner call', async () => {
    const res = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'metadata', transport: 'streamable-http', endpoint: 'https://169.254.169.254/x',
      headers: [], expectedGeneration: 0
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_input');
    // The unsafe URL is never echoed back and never forwarded to the runner.
    expect(res.json.message).not.toContain('169.254.169.254');
    expect(calls).toHaveLength(0);
  });

  it('rejects a cleartext loopback endpoint on create without issuing a runner call', async () => {
    const res = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'loopback', transport: 'streamable-http', endpoint: 'http://127.0.0.1:9/mcp',
      headers: [], expectedGeneration: 0
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_input');
    expect(res.json.message).not.toContain('127.0.0.1');
    expect(calls).toHaveLength(0);
  });

  it('forwards a safe https endpoint to the runner', async () => {
    const res = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'github', transport: 'streamable-http', endpoint: 'https://github.example.com/mcp',
      headers: [], expectedGeneration: 0
    });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_create' });
  });

  it('validates an update only when it carries an endpoint', async () => {
    const unsafe = await mutate(`/api/v1/mcp-servers/${serverId}`, 'PATCH', {
      endpoint: 'https://169.254.169.254/x', expectedGeneration: 1
    });
    expect(unsafe.status).toBe(400);
    expect(calls).toHaveLength(0);

    const safe = await mutate(`/api/v1/mcp-servers/${serverId}`, 'PATCH', {
      endpoint: 'https://github.example.com/mcp', expectedGeneration: 1
    });
    expect(safe.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      operation: 'mcp_server_update',
      input: { serverId, endpoint: 'https://github.example.com/mcp', expectedGeneration: 1 }
    });

    const omitted = await mutate(`/api/v1/mcp-servers/${serverId}`, 'PATCH', {
      name: 'github-renamed', expectedGeneration: 1
    });
    expect(omitted.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_update', input: { serverId, name: 'github-renamed' } });
  });
});

describe('Dashboard MCP server write-time credential validation', () => {
  it('rejects an SSE server with a secret header without issuing a runner call', async () => {
    const rejected = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'legacy-sse', transport: 'sse', endpoint: 'https://mcp.example.com/mcp',
      headers: [{ name: 'Authorization', value: { secretRef } }], expectedGeneration: 0
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toBe('invalid_input');
    expect(rejected.json.message).toBe(MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE);
    expect(calls).toHaveLength(0);

    // An update that carries both fields is refused the same way, still before the runner.
    const updated = await mutate(`/api/v1/mcp-servers/${serverId}`, 'PATCH', {
      transport: 'sse', headers: [{ name: 'Authorization', value: { secretRef } }], expectedGeneration: 1
    });
    expect(updated.status).toBe(400);
    expect(updated.json.message).toBe(MCP_GATEWAY_AUTHENTICATED_SSE_MESSAGE);
    expect(calls).toHaveLength(0);

    // A literal header on SSE widens no credential scope, so it still reaches the runner.
    const literal = await mutate('/api/v1/mcp-servers', 'POST', {
      name: 'legacy-sse', transport: 'sse', endpoint: 'https://mcp.example.com/mcp',
      headers: [{ name: 'X-Api-Version', value: '2024-01-01' }], expectedGeneration: 0
    });
    expect(literal.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'mcp_server_create' });
  });
});

describe('Dashboard MCP gateway routes', () => {
  it('delegates POST .../test to the gateway service and returns status and tool count', async () => {
    const res = await mutate(`/api/v1/mcp-servers/${serverId}/test`, 'POST', {});
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'connected', toolCount: 3 });
    expect(gatewayTestServer).toHaveBeenCalledWith(principal, serverId, { clientId: 'dashboard' });
    expect(calls).toHaveLength(0);
  });

  it('delegates POST .../refresh to the gateway service and evicts cached state', async () => {
    const res = await mutate(`/api/v1/mcp-servers/${serverId}/refresh`, 'POST', {});
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'connected', toolCount: 3 });
    expect(gatewayRefreshServer).toHaveBeenCalledWith(principal, serverId, { clientId: 'dashboard' });
    expect(invalidateCatalog).toHaveBeenCalledWith(principal);
    expect(invalidateConnection).toHaveBeenCalledWith(serverId);
  });

  it('reports an unreachable server as 200 data rather than a transport error', async () => {
    gatewayTestServer.mockResolvedValueOnce({
      ok: true, message: 'MCP server github is not reachable', truncated: false,
      data: { server: 'github', status: 'error', toolCount: 0, error: 'connection refused' }
    });
    const res = await mutate(`/api/v1/mcp-servers/${serverId}/test`, 'POST', {});
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'error', toolCount: 0, error: 'connection refused' });
  });

  it('evicts the catalog and connection after registry mutations and deletion', async () => {
    await mutate(`/api/v1/mcp-servers/${serverId}`, 'PATCH', { name: 'github-renamed', expectedGeneration: 1 });
    expect(invalidateCatalog).toHaveBeenCalledWith(principal);
    expect(invalidateConnection).toHaveBeenCalledWith(serverId);

    invalidateCatalog.mockClear();
    invalidateConnection.mockClear();
    await mutate(`/api/v1/mcp-servers/${serverId}/permissions`, 'PUT', {
      permissionDefault: 'deny', tools: [], expectedGeneration: 3
    });
    expect(invalidateCatalog).toHaveBeenCalledWith(principal);
    expect(invalidateConnection).toHaveBeenCalledWith(serverId);

    invalidateCatalog.mockClear();
    invalidateConnection.mockClear();
    await mutate(`/api/v1/mcp-servers/${serverId}`, 'DELETE', { expectedGeneration: 4 });
    expect(invalidateCatalog).toHaveBeenCalledWith(principal);
    expect(invalidateConnection).toHaveBeenCalledWith(serverId);
  });

  it('does not evict cached state when a mutation fails', async () => {
    await mutate(`/api/v1/mcp-servers/${serverId}/permissions`, 'PUT', {
      permissionDefault: 'allow', tools: [], expectedGeneration: 99
    });
    expect(invalidateCatalog).not.toHaveBeenCalled();
    expect(invalidateConnection).not.toHaveBeenCalled();
  });

  it('projects the gateway endpoint from the allowlisted Host with no query string', async () => {
    const res = await send('/api/v1/mcp-gateway?host=evil.example&next=/mcp');
    expect(res.status).toBe(200);
    expect(res.json.data.endpoint).toBe('/mcp-gateway');
    expect(res.json.data.publicUrl).toBe('https://dashboard.example/mcp-gateway');
    expect(res.json.data.publicUrl).not.toContain('?');
    expect(res.json.data.publicUrl).not.toContain('evil.example');
    expect(res.json.data.authMode).toBe('cloudflare-access');
  });
});
