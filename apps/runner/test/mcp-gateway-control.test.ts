import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpGatewayServerView, McpGatewayToolView, MetadataRunnerRequest, RunnerConfig } from '@cloud-harness/contracts';
import type { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';

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
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-gateway-control-'));
  roots.push(root);
  const databasePath = join(root, 'state.db');
  const principals = new StateStore(databasePath);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  cleanups.push(() => {
    try { metadata.close(); } catch { /* ignore */ }
    try { principals.close(); } catch { /* ignore */ }
    try { keyring.close(); } catch { /* ignore */ }
  });
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60 } as RunnerConfig,
    principals,
    metadata,
    {} as ArtifactStore,
    {} as WorkspaceService
  );
  return { controls, principals, metadata };
}

const principalA = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
const principalB = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-b' };
const request = (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, selected = principalA) =>
  ({ version: 2 as const, principal: selected, operation, input }) as MetadataRunnerRequest;

const toolInput = (upstreamName: string, availability: 'available' | 'unavailable' = 'available') => ({
  upstreamName,
  description: `${upstreamName} description`,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  availability,
  schemaBytes: 40
});

async function createServer(
  controls: DashboardControlService,
  overrides: Record<string, unknown> = {},
  selected = principalA
): Promise<McpGatewayServerView> {
  const result = await controls.execute(request('mcp_server_create', {
    name: 'github',
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.com/mcp',
    headers: [],
    permissionDefault: 'allow',
    enabled: true,
    expectedGeneration: 0,
    ...overrides
  }, selected));
  return result.data as McpGatewayServerView;
}

const replaceTools = (
  controls: DashboardControlService,
  serverId: string,
  tools: unknown[],
  overrides: Record<string, unknown> = {},
  selected = principalA
) => controls.execute(request('mcp_server_replace_tools', { serverId, tools, ...overrides }, selected));

describe('MCP gateway control operations', () => {
  it('drives registry CRUD through the control service with the frozen permissionDefault field', async () => {
    const { controls } = setup();
    const created = await createServer(controls, { name: 'github' });
    expect(created).toMatchObject({ name: 'github', generation: 1, status: 'unknown', enabled: true, permissionDefault: 'allow' });

    const listed = await controls.execute(request('mcp_server_list', {}));
    expect((listed.data as { servers: { id: string }[] }).servers.map((server) => server.id)).toEqual([created.id]);

    const replaced = await replaceTools(controls, created.id, [toolInput('issue_create')]);
    expect((replaced.data as { server: { toolCount: number } }).server.toolCount).toBe(1);

    const fetched = await controls.execute(request('mcp_server_get', { serverId: created.id }));
    expect(fetched.data).toMatchObject({ server: { id: created.id }, tools: [{ qualifiedName: 'github.issue_create' }] });

    const updated = await controls.execute(request('mcp_server_update', {
      serverId: created.id, name: 'gh', description: 'renamed', expectedGeneration: 1
    }));
    expect(updated.data).toMatchObject({ name: 'gh', description: 'renamed', generation: 2 });

    const permissions = await controls.execute(request('mcp_server_set_permissions', {
      serverId: created.id, permissionDefault: 'deny', tools: [{ name: 'issue_create', permission: 'allow' }], expectedGeneration: 2
    }));
    expect(permissions.data).toMatchObject({ permissionDefault: 'deny', generation: 3 });

    // A `default` key is not the frozen field name and must be rejected outright.
    await expect(controls.execute(request('mcp_server_set_permissions', {
      serverId: created.id, default: 'deny', tools: [], expectedGeneration: 3
    }))).rejects.toThrow();

    const disabled = await controls.execute(request('mcp_server_set_enabled', {
      serverId: created.id, enabled: false, expectedGeneration: 3
    }));
    expect(disabled.data).toMatchObject({ enabled: false, status: 'disabled' });

    const deleted = await controls.execute(request('mcp_server_delete', { serverId: created.id, expectedGeneration: 4 }));
    expect((deleted.data as { id: string }).id).toBe(created.id);
    const remaining = await controls.execute(request('mcp_server_list', {}));
    expect((remaining.data as { servers: unknown[] }).servers).toEqual([]);
  });

  it('isolates principals and fences stale generations', async () => {
    const { controls } = setup();
    const server = await createServer(controls, { name: 'github' });

    await expect(controls.execute(request('mcp_server_get', { serverId: server.id }, principalB)))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(controls.execute(request('mcp_server_update', {
      serverId: server.id, name: 'stolen', expectedGeneration: 1
    }, principalB))).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await expect(controls.execute(request('mcp_server_delete', { serverId: server.id, expectedGeneration: 1 }, principalB)))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await expect(controls.execute(request('mcp_server_update', {
      serverId: server.id, name: 'stale', expectedGeneration: 99
    }))).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    expect((await controls.execute(request('mcp_gateway_catalog', {}, principalB))).data)
      .toEqual({ servers: [], tools: [] });
    const catalog = await controls.execute(request('mcp_gateway_catalog', {}, principalA));
    expect((catalog.data as { servers: { id: string }[] }).servers.map((entry) => entry.id)).toEqual([server.id]);
  });

  it('carries the effective permission into the control catalog response', async () => {
    const { controls } = setup();
    const allowServer = await createServer(controls, { name: 'github' });
    await replaceTools(controls, allowServer.id, [toolInput('issue_create'), toolInput('list_repos')]);

    const allowCatalog = await controls.execute(request('mcp_gateway_catalog', {}));
    const allowTools = (allowCatalog.data as { tools: McpGatewayToolView[] }).tools;
    expect(allowTools.map((entry) => [entry.upstreamName, entry.permission])).toEqual([
      ['issue_create', 'allow'],
      ['list_repos', 'allow']
    ]);

    await controls.execute(request('mcp_server_set_permissions', {
      serverId: allowServer.id,
      permissionDefault: 'allow',
      tools: [{ name: 'issue_create', permission: 'deny' }],
      expectedGeneration: allowServer.generation
    }));
    const overridden = (await controls.execute(request('mcp_gateway_catalog', { serverId: allowServer.id })))
      .data as { tools: McpGatewayToolView[] };
    expect(overridden.tools.find((entry) => entry.upstreamName === 'issue_create')?.permission).toBe('deny');
    expect(overridden.tools.find((entry) => entry.upstreamName === 'list_repos')?.permission).toBe('allow');

    const denyServer = await createServer(controls, { name: 'posthog', permissionDefault: 'deny' });
    await replaceTools(controls, denyServer.id, [toolInput('query_insight')]);
    await controls.execute(request('mcp_server_set_permissions', {
      serverId: denyServer.id,
      permissionDefault: 'deny',
      tools: [{ name: 'query_insight', permission: 'allow' }],
      expectedGeneration: denyServer.generation
    }));
    const allowed = (await controls.execute(request('mcp_gateway_catalog', { serverId: denyServer.id })))
      .data as { tools: McpGatewayToolView[] };
    expect(allowed.tools).toHaveLength(1);
    expect(allowed.tools[0]).toMatchObject({ upstreamName: 'query_insight', permission: 'allow' });
  });

  it('enforces the credential purpose matrix and never leaks a value', async () => {
    const { controls } = setup();
    const secret = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2';
    await controls.execute(request('global_secret_create', { name: 'DOWNSTREAM_PAT', value: secret, expectedGeneration: 0 }));
    const server = await createServer(controls, {
      name: 'github',
      permissionDefault: 'deny',
      headers: [{ name: 'authorization', value: { secretRef: 'DOWNSTREAM_PAT' } }]
    });
    await replaceTools(controls, server.id, [toolInput('issue_create')]);

    const denied = await controls.execute(request('mcp_server_get_credentials', {
      serverId: server.id, toolName: 'issue_create', purpose: 'execute'
    }));
    expect(denied.data).toEqual({ allowed: false, reason: 'tool_denied' });
    expect(JSON.stringify(denied)).not.toContain(secret);

    const unknownTool = await controls.execute(request('mcp_server_get_credentials', {
      serverId: server.id, toolName: 'does_not_exist', purpose: 'execute'
    }));
    expect(unknownTool.data).toEqual({ allowed: false, reason: 'tool_denied' });
    expect(JSON.stringify(unknownTool)).not.toContain(secret);

    // `connect` is the explicit server-level grant; a deny-by-default server stays testable.
    const connect = await controls.execute(request('mcp_server_get_credentials', { serverId: server.id, purpose: 'connect' }));
    expect(connect.data).toMatchObject({
      allowed: true,
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      headers: { authorization: secret }
    });

    await controls.execute(request('mcp_server_set_permissions', {
      serverId: server.id,
      permissionDefault: 'deny',
      tools: [{ name: 'issue_create', permission: 'allow' }],
      expectedGeneration: server.generation
    }));
    const allowed = await controls.execute(request('mcp_server_get_credentials', {
      serverId: server.id, toolName: 'issue_create', purpose: 'execute'
    }));
    expect(allowed.data).toMatchObject({ allowed: true, headers: { authorization: secret } });

    const audit = await controls.execute(request('audit_list', { limit: 50 }));
    expect(JSON.stringify(audit)).toContain('mcp_gateway.credentials_resolved');

    const emptyDeny = await createServer(controls, { name: 'empty', permissionDefault: 'deny' });
    const noTools = await controls.execute(request('mcp_server_get_credentials', {
      serverId: emptyDeny.id, toolName: 'issue_create', purpose: 'execute'
    }));
    expect(noTools.data).toEqual({ allowed: false, reason: 'tool_denied' });

    const disabled = await controls.execute(request('mcp_server_set_enabled', {
      serverId: server.id, enabled: false, expectedGeneration: server.generation + 1
    }));
    expect(disabled.data).toMatchObject({ enabled: false, status: 'disabled' });
    expect((await controls.execute(request('mcp_server_get_credentials', { serverId: server.id, purpose: 'connect' }))).data)
      .toEqual({ allowed: false, reason: 'server_disabled' });
    expect((await controls.execute(request('mcp_server_get_credentials', {
      serverId: server.id, toolName: 'issue_create', purpose: 'execute'
    }))).data).toEqual({ allowed: false, reason: 'server_disabled' });
  });

  it('names a missing secret reference without leaking a value', async () => {
    const { controls } = setup();
    const server = await createServer(controls, {
      name: 'posthog',
      permissionDefault: 'deny',
      headers: [{ name: 'authorization', value: { secretRef: 'MISSING_TOKEN' } }]
    });
    await expect(controls.execute(request('mcp_server_get_credentials', { serverId: server.id, purpose: 'connect' })))
      .rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
        message: expect.stringContaining('MISSING_TOKEN')
      });
  });

  it('resolves a global secret plaintext only for its own principal', async () => {
    const { controls, principals, metadata } = setup();
    const secret = 's3cr3t-global-value';
    await controls.execute(request('global_secret_create', { name: 'DOWNSTREAM_PAT', value: secret, expectedGeneration: 0 }));
    const ownerId = principals.resolvePrincipal(principalA);
    const foreignId = principals.resolvePrincipal(principalB);
    // Proves the ciphertext is bound to the 'global' AES-GCM associated data.
    expect(metadata.globalSecretValue(ownerId, 'DOWNSTREAM_PAT')).toBe(secret);
    expect(metadata.globalSecretValue(foreignId, 'DOWNSTREAM_PAT')).toBeUndefined();
    expect(metadata.globalSecretValue(ownerId, 'NO_SUCH_SECRET')).toBeUndefined();
  });

  it('returns the rotated plaintext after a global secret rotation', async () => {
    const { controls } = setup();
    const first = 'ghp_firstSecretValue12345';
    const second = 'ghp_secondSecretValue6789';
    await controls.execute(request('global_secret_create', { name: 'DOWNSTREAM_PAT', value: first, expectedGeneration: 0 }));
    const server = await createServer(controls, {
      name: 'github',
      permissionDefault: 'deny',
      headers: [{ name: 'authorization', value: { secretRef: 'DOWNSTREAM_PAT' } }]
    });
    expect((await controls.execute(request('mcp_server_get_credentials', { serverId: server.id, purpose: 'connect' }))).data)
      .toMatchObject({ headers: { authorization: first } });

    const rotated = await controls.execute(request('global_secret_rotate', { name: 'DOWNSTREAM_PAT', value: second, expectedGeneration: 1 }));
    expect(rotated.ok).toBe(true);

    const after = await controls.execute(request('mcp_server_get_credentials', { serverId: server.id, purpose: 'connect' }));
    expect(after.data).toMatchObject({ allowed: true, headers: { authorization: second } });
    expect(JSON.stringify(after)).not.toContain(first);
  });

  it('applies the tool cap and round-trips traces', async () => {
    const { controls } = setup();
    const server = await createServer(controls, { name: 'github' });
    const replaced = await replaceTools(
      controls, server.id, [toolInput('first'), toolInput('second'), toolInput('third')], { cap: 2 }
    );
    const data = replaced.data as { server: { toolCount: number }; tools: McpGatewayToolView[] };
    expect(data.server.toolCount).toBe(3);
    expect(data.tools.filter((entry) => entry.availability === 'available')).toHaveLength(2);
    expect(data.tools.find((entry) => entry.upstreamName === 'third')).toMatchObject({
      availability: 'unavailable',
      description: 'tool omitted: per-server tool limit reached'
    });

    const appended = await controls.execute(request('mcp_gateway_trace_append', {
      serverId: server.id, serverName: 'github', tool: 'first', operation: 'execute', clientId: 'client-1',
      durationMs: 15, status: 'success', requestBytes: 12, responseBytes: 34
    }));
    const traceId = (appended.data as { trace: { id: string } }).trace.id;
    const listed = await controls.execute(request('mcp_gateway_trace_list', { serverId: server.id, limit: 50 }));
    expect((listed.data as { traces: { id: string }[] }).traces.map((entry) => entry.id)).toEqual([traceId]);
  });

  it('scrubs raw, base64, and percent-encoded secret forms from traces', async () => {
    const { controls } = setup();
    const secret = 's3cr3t/value+token';
    const base64 = Buffer.from(secret, 'utf8').toString('base64');
    const percent = encodeURIComponent(secret);
    expect(base64).not.toBe(secret);
    expect(percent).not.toBe(secret);

    const server = await createServer(controls, { name: 'github' });
    await controls.execute(request('mcp_gateway_trace_append', {
      serverId: server.id,
      serverName: 'github',
      tool: 'first',
      operation: 'execute',
      durationMs: 15,
      status: 'error',
      errorCode: 'EXECUTION_FAILED',
      errorMessage: `upstream rejected request\nAuthorization: Bearer ${secret}\nbody: ${base64} and ${percent}`,
      secrets: [secret]
    }));
    const listed = await controls.execute(request('mcp_gateway_trace_list', { serverId: server.id, limit: 50 }));
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(base64);
    expect(serialized).not.toContain(percent);
    // The header-ish line is redacted wholesale; encoded forms are redacted by value.
    expect(serialized).toContain('Authorization: [REDACTED]');
    expect(serialized).toContain('body: [REDACTED_SECRET] and [REDACTED_SECRET]');
  });
});
