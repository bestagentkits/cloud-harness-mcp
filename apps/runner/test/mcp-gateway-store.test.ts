import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetadataStore } from '../src/metadata-store.js';
import type { McpGatewayStore, McpGatewayToolInput } from '../src/mcp-gateway-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup(); } catch { /* ignore cleanup error */ }
  }
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-gateway-store-'));
  roots.push(root);
  const databasePath = join(root, 'state.db');
  const state = new StateStore(databasePath);
  const operatorA = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'operator-a' });
  const operatorB = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'operator-b' });
  state.close();
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  cleanups.push(() => {
    try { metadata.close(); } catch { /* ignore */ }
    try { keyring.close(); } catch { /* ignore */ }
  });
  return { metadata, gateway: metadata.mcpGateway, operatorA, operatorB };
}

const tool = (upstreamName: string, overrides: Partial<McpGatewayToolInput> = {}): McpGatewayToolInput => ({
  upstreamName,
  description: `${upstreamName} description`,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  annotations: null,
  availability: 'available',
  schemaBytes: 42,
  ...overrides
});

const createServer = (gateway: McpGatewayStore, principalId: string, name = 'github') => gateway.createServer(principalId, {
  name,
  transport: 'streamable-http',
  endpoint: 'https://mcp.example.com/mcp',
  headers: [],
  permissionDefault: 'allow',
  enabled: true
}, 0)!;

const traceInput = (serverId: string, serverName: string) => ({
  serverId,
  serverName,
  tool: 'issue_create',
  operation: 'execute',
  clientId: 'client-1',
  durationMs: 12,
  status: 'success' as const,
  errorCode: null,
  errorMessage: null,
  requestBytes: 10,
  responseBytes: 20
});

describe('McpGatewayStore', () => {
  it('creates a generation-1 server, rejects duplicate names, and fences stale updates', () => {
    const { gateway, operatorA } = setup();
    const created = createServer(gateway, operatorA);
    expect(created.generation).toBe(1);
    expect(created.status).toBe('unknown');
    expect(created.enabled).toBe(true);
    expect(created.toolCount).toBe(0);
    expect(gateway.createServer(operatorA, {
      name: 'github',
      transport: 'sse',
      endpoint: 'https://other.example.com/mcp',
      headers: [],
      permissionDefault: 'allow',
      enabled: true
    }, 0)).toBeUndefined();

    expect(gateway.updateServer(operatorA, created.id, created.generation + 1, { name: 'gh' })).toBeUndefined();
    expect(gateway.getServer(operatorA, created.id)?.name).toBe('github');
  });

  it('rewrites cached qualified tool names when a server is renamed', () => {
    const { gateway, operatorA } = setup();
    const server = createServer(gateway, operatorA, 'github');
    gateway.replaceTools(operatorA, server.id, [tool('issue_create')], 10);
    expect(gateway.getTool(operatorA, 'github.issue_create')?.upstreamName).toBe('issue_create');

    const renamed = gateway.updateServer(operatorA, server.id, server.generation, { name: 'gh' });
    expect(renamed?.name).toBe('gh');
    expect(gateway.getTool(operatorA, 'gh.issue_create')?.qualifiedName).toBe('gh.issue_create');
    expect(gateway.getTool(operatorA, 'github.issue_create')).toBeUndefined();
  });

  it('disables a server and deletes its tools, permissions, and traces with it', () => {
    const { gateway, operatorA, metadata } = setup();
    const server = createServer(gateway, operatorA);
    gateway.replaceTools(operatorA, server.id, [tool('issue_create')], 10);
    gateway.setPermissions(operatorA, {
      serverId: server.id,
      permissionDefault: 'allow',
      tools: [{ name: 'issue_create', permission: 'deny' }],
      expectedGeneration: server.generation
    });
    gateway.appendTrace(operatorA, {
      ...traceInput(server.id, 'github'),
      status: 'denied'
    }, 100);

    const disabled = gateway.setEnabled(operatorA, server.id, false, 2);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.status).toBe('disabled');

    const deleted = gateway.deleteServer(operatorA, server.id, disabled!.generation);
    expect(deleted).toBeDefined();
    expect(gateway.getServer(operatorA, server.id)).toBeUndefined();
    expect(gateway.listTools(operatorA, server.id)).toEqual([]);

    const counts = metadata.database.prepare(`SELECT
      (SELECT COUNT(*) FROM mcp_gateway_tools WHERE principal_id = ? AND server_id = ?) AS tools,
      (SELECT COUNT(*) FROM mcp_gateway_tool_permissions WHERE principal_id = ? AND server_id = ?) AS permissions,
      (SELECT COUNT(*) FROM mcp_gateway_traces WHERE principal_id = ? AND server_id = ?) AS traces`)
      .get(operatorA, server.id, operatorA, server.id, operatorA, server.id) as { tools: number; permissions: number; traces: number };
    expect(counts).toEqual({ tools: 0, permissions: 0, traces: 0 });
  });

  it('caps stored tools, keeps overflow rows unavailable, and leaves no orphans', () => {
    const { gateway, operatorA, metadata } = setup();
    const server = createServer(gateway, operatorA);
    const tools = [tool('first'), tool('second'), tool('third')];

    const stored = gateway.replaceTools(operatorA, server.id, tools, 2);
    expect(stored).toHaveLength(3);
    expect(stored.filter((entry) => entry.availability === 'available')).toHaveLength(2);
    const overflow = stored.find((entry) => entry.upstreamName === 'third');
    expect(overflow?.availability).toBe('unavailable');
    expect(overflow?.description).toBe('tool omitted: per-server tool limit reached');
    expect(gateway.getServer(operatorA, server.id)?.toolCount).toBe(3);
    expect(gateway.getServer(operatorA, server.id)?.status).toBe('connected');

    gateway.replaceTools(operatorA, server.id, tools, 2);
    const row = metadata.database.prepare('SELECT COUNT(*) AS count FROM mcp_gateway_tools WHERE principal_id = ? AND server_id = ?')
      .get(operatorA, server.id) as { count: number };
    expect(row.count).toBe(3);
  });

  it('resolves the effective permission with the tool override winning', () => {
    const { gateway, operatorA } = setup();
    const server = createServer(gateway, operatorA);
    expect(gateway.effectivePermission(operatorA, server.id, 'issue_create')).toBe('allow');

    gateway.setPermissions(operatorA, {
      serverId: server.id,
      permissionDefault: 'deny',
      tools: [{ name: 'issue_create', permission: 'allow' }],
      expectedGeneration: server.generation
    });
    expect(gateway.effectivePermission(operatorA, server.id, 'issue_create')).toBe('allow');
    expect(gateway.effectivePermission(operatorA, server.id, 'list_repos')).toBe('deny');
  });

  it('reports the effective permission, not a deny fallback, for every catalog tool view', () => {
    const { gateway, operatorA } = setup();
    const allowServer = createServer(gateway, operatorA, 'github');
    gateway.replaceTools(operatorA, allowServer.id, [tool('issue_create'), tool('list_repos')], 10);

    // The allow-by-default server's tools are allow everywhere the catalog is read.
    expect(gateway.listTools(operatorA, allowServer.id).map((entry) => entry.permission)).toEqual(['allow', 'allow']);
    expect(gateway.getServerTools(operatorA, allowServer.id).map((entry) => entry.permission)).toEqual(['allow', 'allow']);
    expect(gateway.catalog(operatorA).tools.filter((entry) => entry.serverId === allowServer.id).map((entry) => entry.permission))
      .toEqual(['allow', 'allow']);

    gateway.setPermissions(operatorA, {
      serverId: allowServer.id,
      permissionDefault: 'allow',
      tools: [{ name: 'issue_create', permission: 'deny' }],
      expectedGeneration: allowServer.generation
    });
    const overridden = gateway.listTools(operatorA, allowServer.id);
    expect(overridden.find((entry) => entry.upstreamName === 'issue_create')?.permission).toBe('deny');
    expect(overridden.find((entry) => entry.upstreamName === 'list_repos')?.permission).toBe('allow');
    expect(gateway.getServerTools(operatorA, allowServer.id).find((entry) => entry.upstreamName === 'list_repos')?.permission).toBe('allow');

    // A deny-by-default server with an allow override proves the default is read per row.
    const denyServer = gateway.createServer(operatorA, {
      name: 'posthog',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      headers: [],
      permissionDefault: 'deny',
      enabled: true
    }, 0)!;
    gateway.replaceTools(operatorA, denyServer.id, [tool('query_insight'), tool('delete_project')], 10);
    gateway.setPermissions(operatorA, {
      serverId: denyServer.id,
      permissionDefault: 'deny',
      tools: [{ name: 'query_insight', permission: 'allow' }],
      expectedGeneration: denyServer.generation
    });
    const denyTools = gateway.catalog(operatorA).tools.filter((entry) => entry.serverId === denyServer.id);
    expect(denyTools.find((entry) => entry.upstreamName === 'query_insight')?.permission).toBe('allow');
    expect(denyTools.find((entry) => entry.upstreamName === 'delete_project')?.permission).toBe('deny');
  });

  it('never exposes another principal rows', () => {
    const { gateway, operatorA, operatorB } = setup();
    const server = createServer(gateway, operatorA);
    gateway.replaceTools(operatorA, server.id, [tool('issue_create')], 10);
    gateway.appendTrace(operatorA, traceInput(server.id, 'github'), 100);

    expect(gateway.listServers(operatorB)).toEqual([]);
    expect(gateway.getServer(operatorB, server.id)).toBeUndefined();
    expect(gateway.listTools(operatorB)).toEqual([]);
    expect(gateway.listTools(operatorB, server.id)).toEqual([]);
    expect(gateway.getTool(operatorB, 'github.issue_create')).toBeUndefined();
    expect(gateway.getServerTools(operatorB, server.id)).toEqual([]);
    expect(gateway.catalog(operatorB)).toEqual({ servers: [], tools: [] });
    expect(gateway.effectivePermission(operatorB, server.id, 'issue_create')).toBe('deny');
    expect(gateway.listTraces(operatorB, { limit: 10 }).traces).toEqual([]);
    expect(gateway.updateServer(operatorB, server.id, server.generation, { name: 'stolen' })).toBeUndefined();
    expect(gateway.deleteServer(operatorB, server.id, server.generation)).toBeUndefined();
  });

  it('round-trips traces, filters by server, and prunes to maxRows', () => {
    const { gateway, operatorA } = setup();
    const first = createServer(gateway, operatorA, 'github');
    const second = createServer(gateway, operatorA, 'posthog');
    const created = gateway.appendTrace(operatorA, traceInput(first.id, 'github'), 100);
    gateway.appendTrace(operatorA, traceInput(second.id, 'posthog'), 100);

    const filtered = gateway.listTraces(operatorA, { serverId: first.id, limit: 10 });
    expect(filtered.traces.map((entry) => entry.id)).toEqual([created.id]);
    expect(filtered.traces[0]).toMatchObject({
      serverName: 'github', operation: 'execute', status: 'success',
      durationMs: 12, requestBytes: 10, responseBytes: 20
    });

    for (let index = 0; index < 5; index += 1) gateway.appendTrace(operatorA, traceInput(first.id, 'github'), 3);
    expect(gateway.listTraces(operatorA, { limit: 10 }).traces).toHaveLength(3);
  });

  it('records gateway registry audit events', () => {
    const { gateway, operatorA, metadata } = setup();
    const server = createServer(gateway, operatorA);
    gateway.updateServer(operatorA, server.id, server.generation, { description: 'Updated' });
    gateway.setPermissions(operatorA, {
      serverId: server.id, permissionDefault: 'deny', tools: [], expectedGeneration: 2
    });
    gateway.deleteServer(operatorA, server.id, 3);

    const actions = metadata.listAudit(operatorA, 50).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining([
      'mcp_server.created', 'mcp_server.updated', 'mcp_policy.updated', 'mcp_server.deleted'
    ]));
  });

  it('stores secret references as metadata only and never a value', () => {
    const { gateway, operatorA, metadata } = setup();
    const server = gateway.createServer(operatorA, {
      name: 'posthog',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      headers: [{ name: 'authorization', secretRef: 'POSTHOG_TOKEN' }],
      permissionDefault: 'allow',
      enabled: true
    }, 0)!;
    expect(server.headers).toEqual([
      { name: 'authorization', kind: 'secret', secretRef: 'POSTHOG_TOKEN' }
    ]);
    const row = metadata.database.prepare('SELECT headers_json FROM mcp_gateway_servers WHERE principal_id = ? AND id = ?')
      .get(operatorA, server.id) as { headers_json: string };
    expect(row.headers_json).toContain('POSTHOG_TOKEN');
    expect(row.headers_json).not.toContain('"value"');
  });
});

/**
 * Differential guard for the class of bug where `listTools` resolved permissions
 * differently from `effectivePermission` and the catalog reported `deny` for a tool
 * that was actually allowed. Every read path must agree for every cached tool.
 */
describe('McpGatewayStore permission derivations', () => {
  it('resolves one effective permission across catalog, listTools, getTool, and effectivePermission', () => {
    const { gateway, operatorA } = setup();
    const server = (name: string, permissionDefault: 'allow' | 'deny', tools: string[]) => {
      const created = gateway.createServer(operatorA, {
        name,
        transport: 'streamable-http',
        endpoint: 'https://mcp.example.com/mcp',
        headers: [],
        permissionDefault,
        enabled: true
      }, 0)!;
      gateway.replaceTools(operatorA, created.id, tools.map((upstreamName) => tool(upstreamName)), 10);
      return created;
    };

    // Case 1: server default allow with no overrides.
    const allowDefault = server('allow-default', 'allow', ['issue_create', 'list_repos']);
    // Case 2: server default deny with no overrides.
    const denyDefault = server('deny-default', 'deny', ['query_insight', 'delete_project']);
    // Case 3: explicit per-tool override opposite the server default.
    const override = server('override', 'allow', ['read_only', 'write_all']);
    gateway.setPermissions(operatorA, {
      serverId: override.id,
      permissionDefault: 'allow',
      tools: [{ name: 'write_all', permission: 'deny' }],
      expectedGeneration: override.generation
    });
    // Case 4: a disabled server keeps its cached tools and the stored default.
    const disabled = server('disabled', 'allow', ['legacy_tool']);
    const disabledView = gateway.setEnabled(operatorA, disabled.id, false, disabled.generation)!;
    // Case 5: a soft-deleted server is gone and must fail closed.
    const deleted = server('deleted', 'allow', ['ghost_tool']);
    const deletedNames = gateway.listTools(operatorA, deleted.id).map((entry) => entry.qualifiedName);
    gateway.deleteServer(operatorA, deleted.id, deleted.generation);

    // Every cached tool resolves to exactly one decision through every read path.
    const catalog = gateway.catalog(operatorA);
    const cached = gateway.listTools(operatorA);
    expect(cached.length).toBeGreaterThan(0);
    for (const entry of cached) {
      const fromCatalog = catalog.tools.find((view) => view.qualifiedName === entry.qualifiedName);
      const fromGetTool = gateway.getTool(operatorA, entry.qualifiedName);
      expect(fromCatalog, entry.qualifiedName).toBeDefined();
      expect(fromGetTool, entry.qualifiedName).toBeDefined();
      expect(fromCatalog!.permission, entry.qualifiedName).toBe(entry.permission);
      expect(fromGetTool!.permission, entry.qualifiedName).toBe(entry.permission);
      expect(gateway.effectivePermission(operatorA, entry.serverId, entry.upstreamName), entry.qualifiedName)
        .toBe(entry.permission);
    }

    // The matrix really covers allow, deny, an override, and a disabled server.
    const permissionsOf = (serverId: string) => gateway.listTools(operatorA, serverId).map((entry) => entry.permission);
    expect(permissionsOf(allowDefault.id)).toEqual(['allow', 'allow']);
    expect(permissionsOf(denyDefault.id)).toEqual(['deny', 'deny']);
    expect(permissionsOf(override.id)).toEqual(['allow', 'deny']);
    expect(permissionsOf(disabledView.id)).toEqual(['allow']);

    // The deleted server fails closed: no cached view survives and the decision is deny.
    expect(deletedNames).toEqual(['deleted.ghost_tool']);
    expect(gateway.listTools(operatorA, deleted.id)).toEqual([]);
    expect(gateway.catalog(operatorA).tools.filter((view) => view.serverId === deleted.id)).toEqual([]);
    expect(gateway.getTool(operatorA, 'deleted.ghost_tool')).toBeUndefined();
    expect(gateway.effectivePermission(operatorA, deleted.id, 'ghost_tool')).toBe('deny');
    for (const entry of cached) expect(entry.serverId).not.toBe(deleted.id);
  });
});
