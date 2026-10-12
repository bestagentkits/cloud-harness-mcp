import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { McpGatewayServerView, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { GatewayConnectionManager } from '../src/mcp-gateway/connection-manager.js';
import { McpOAuthCoordinator } from '../src/mcp-gateway/oauth-flow.js';
import { McpGatewayService } from '../src/mcp-gateway/service.js';
import type { RunnerClient } from '../src/runner-client.js';

// Every hostname resolves to a public address so the policy, not DNS, is under test.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
dns.lookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);

const MCP = 'https://mcp.example.com/mcp';
const AS = 'https://as.example.com';
const REDIRECT = 'https://dash.example.com/dashboard/mcp-oauth/callback';
const SERVER_ID = `mcps_${'a'.repeat(24)}`;
const alice: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://access.example.com', subject: 'alice' };
const bob: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://access.example.com', subject: 'bob' };

type Recorded = { method: string; url: string; headers: Headers; body: string };

type WorldOptions = {
  issuerInMetadata?: string;
  tokenEndpoint?: string;
  authorizationResponseIss?: boolean;
  redirectToken?: boolean;
  oversizeToken?: boolean;
  noRevocation?: boolean;
};

/** An OAuth-protected MCP server and its authorization server, in process. */
function createWorld(options: WorldOptions = {}) {
  const requests: Recorded[] = [];
  const state = {
    access: 'access-0',
    refresh: 'refresh-0',
    counter: 0,
    challenge: '' as string,
    codes: new Set<string>(),
    refreshPosts: 0,
    revoked: [] as string[],
    failRefresh: false,
    registrations: 0
  };
  const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined || init.body === null ? '' : String(init.body);
    requests.push({ method, url: url.toString(), headers, body });

    if (url.origin === 'https://mcp.example.com') {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json({ resource: MCP, authorization_servers: [AS], scopes_supported: ['read'] });
      }
      if (url.pathname !== '/mcp') return new Response('', { status: 404 });
      if (method === 'GET') return new Response('', { status: 405 });
      if (method === 'DELETE') return new Response('', { status: 200 });
      if (headers.get('authorization') !== `Bearer ${state.access}`) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' }
        });
      }
      const rpc = JSON.parse(body || '{}') as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
      const id = rpc.id ?? null;
      if (rpc.method === 'initialize') {
        return json({ jsonrpc: '2.0', id, result: { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
      }
      if (rpc.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } });
      if (rpc.method === 'tools/call') return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } });
      return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }

    if (url.origin === AS) {
      if (url.pathname.startsWith('/.well-known/')) {
        return json({
          issuer: options.issuerInMetadata ?? AS,
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: options.tokenEndpoint ?? `${AS}/token`,
          registration_endpoint: `${AS}/register`,
          ...(options.noRevocation ? {} : { revocation_endpoint: `${AS}/revoke` }),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
          ...(options.authorizationResponseIss ? { authorization_response_iss_parameter_supported: true } : {})
        });
      }
      if (url.pathname === '/register') {
        state.registrations += 1;
        return json({ client_id: 'dcr-client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }, 201);
      }
      if (url.pathname === '/revoke') {
        state.revoked.push(new URLSearchParams(body).get('token') ?? '');
        return new Response('', { status: 200 });
      }
      if (url.pathname === '/token') {
        if (options.redirectToken) return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
        if (options.oversizeToken) return json({ access_token: 'x'.repeat(2_000_000), token_type: 'Bearer' });
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!state.codes.has(form.get('code') ?? '') || challenge !== state.challenge) return json({ error: 'invalid_grant' }, 400);
          if (form.get('resource') !== MCP) return json({ error: 'invalid_target' }, 400);
          state.codes.delete(form.get('code') ?? '');
          state.counter += 1;
          state.access = `access-${state.counter}`;
          state.refresh = `refresh-${state.counter}`;
          return json({ access_token: state.access, refresh_token: state.refresh, token_type: 'Bearer', expires_in: 3600, scope: 'read' });
        }
        if (form.get('grant_type') === 'refresh_token') {
          state.refreshPosts += 1;
          await Promise.resolve();
          if (state.failRefresh || form.get('refresh_token') !== state.refresh) return json({ error: 'invalid_grant' }, 400);
          state.counter += 1;
          state.access = `access-${state.counter}`;
          state.refresh = `refresh-${state.counter}`;
          return json({ access_token: state.access, refresh_token: state.refresh, token_type: 'Bearer', expires_in: 3600 });
        }
      }
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, state, requests };
}

type Grant = { blob: string; generation: number; issuer: string };

/** A principal-scoped fake of the runner operations the OAuth layer calls. */
function createRunner(oauthConfig: { scopes: string | null; clientId: string | null; clientSecret: string | null } = { scopes: 'read', clientId: null, clientSecret: null }, headers: Record<string, string> = {}) {
  const grants = new Map<string, Grant>();
  const flows = new Map<string, { principal: string; serverId: string; blob: string; issuer: string; scopes: string | null }>();
  const marks: { state: string; error: string | null }[] = [];
  const disconnects: unknown[] = [];
  const key = (p: RunnerPrincipalSelector) => (p.kind === 'external' ? `${p.issuer}|${p.subject}` : p.ownerId);
  const ok = (data: unknown): RunnerResponse => ({ ok: true, message: 'ok', data, truncated: false });
  const runner = {
    async callInternal(operation: string, input: Record<string, unknown>, principal: RunnerPrincipalSelector): Promise<RunnerResponse> {
      const slot = `${key(principal)}|${String(input.serverId)}`;
      switch (operation) {
        case 'mcp_server_get_credentials':
          return ok({ allowed: true, transport: 'streamable-http', endpoint: MCP, headers, oauth: oauthConfig });
        case 'mcp_oauth_grant_load': return ok({ grant: grants.get(slot) ?? null });
        case 'mcp_oauth_grant_save': {
          const current = grants.get(slot);
          if ((current?.generation ?? 0) !== input.expectedGeneration) {
            return { ok: false, message: 'conflict', error: { code: 'CONFLICT', message: 'changed', retryable: false }, truncated: false };
          }
          const generation = (current?.generation ?? 0) + 1;
          grants.set(slot, { blob: String(input.blob), generation, issuer: String(input.issuer) });
          return ok({ generation });
        }
        case 'mcp_oauth_grant_mark': marks.push({ state: String(input.state), error: (input.error as string | null) ?? null }); return ok({ marked: grants.has(slot) });
        case 'mcp_oauth_flow_begin': {
          flows.set(String(input.stateHash), { principal: key(principal), serverId: String(input.serverId), blob: String(input.blob), issuer: String(input.expectedIssuer), scopes: (input.scopes as string | null) ?? null });
          return ok({ expiresAt: 1 });
        }
        case 'mcp_oauth_flow_consume': {
          const flow = flows.get(String(input.stateHash));
          if (!flow || flow.principal !== key(principal)) return { ok: false, message: 'unknown', error: { code: 'NOT_FOUND', message: 'unknown', retryable: false }, truncated: false };
          flows.delete(String(input.stateHash));
          return ok({ serverId: flow.serverId, blob: flow.blob, expectedIssuer: flow.issuer, scopes: flow.scopes });
        }
        case 'mcp_oauth_disconnect': disconnects.push(input); return ok({ disconnected: grants.delete(slot) });
        case 'mcp_oauth_status': return ok({ status: { state: grants.has(slot) ? 'connected' : 'authorization_required' } });
        case 'mcp_gateway_catalog': return ok({ servers: [serverView()], tools: [] });
        case 'mcp_server_connection_result': case 'mcp_server_replace_tools': return ok({});
        default: return ok({});
      }
    }
  } as unknown as RunnerClient;
  return { runner, grants, flows, marks, disconnects };
}

function serverView(overrides: Partial<McpGatewayServerView> = {}): McpGatewayServerView {
  return {
    id: SERVER_ID, principalId: 'p', name: 'oauthsrv', description: null, transport: 'streamable-http', endpoint: MCP,
    headers: [], oauth: { scopes: 'read' }, enabled: true, status: 'unknown', toolCount: 0, lastConnectedAt: null,
    lastError: null, lastCheckedAt: null, permissionDefault: 'allow', generation: 1, createdAt: 1, updatedAt: 1, ...overrides
  } as McpGatewayServerView;
}

function build(world: ReturnType<typeof createWorld>, runnerSetup = createRunner(), config: { redirect?: string | undefined; cimd?: string | undefined } = { redirect: REDIRECT }) {
  const connections = new GatewayConnectionManager({
    timeoutMs: 5_000, maxResponseBytes: 262_144, maxConnections: 4,
    allowInsecureHttp: false, allowPrivateEndpoints: false, fetchImpl: world.fetchImpl
  });
  const coordinator = new McpOAuthCoordinator(runnerSetup.runner, connections, {
    redirectUrl: config.redirect, clientMetadataUrl: config.cimd,
    fetch: { timeoutMs: 5_000, maxResponseBytes: 262_144, allowInsecureHttp: false, allowPrivateEndpoints: false, fetchImpl: world.fetchImpl }
  });
  const service = new McpGatewayService(runnerSetup.runner, connections, {
    timeoutMs: 5_000, maxResponseBytes: 262_144, maxToolsPerServer: 50, maxSchemaBytes: 65_536, maxCatalogBytes: 1_000_000
  }, coordinator);
  return { ...runnerSetup, connections, coordinator, service };
}

async function authorize(world: ReturnType<typeof createWorld>, built: ReturnType<typeof build>, principal = alice) {
  const started = await built.coordinator.start(principal, SERVER_ID);
  const url = new URL(started.authorizationUrl);
  world.state.challenge = url.searchParams.get('code_challenge') ?? '';
  world.state.codes.add('code-1');
  return { url, state: url.searchParams.get('state') ?? '' };
}

describe('downstream MCP OAuth: authorization', () => {
  it('starts with PKCE S256, a one-time state, and the resource indicator, then connects on callback', async () => {
    const world = createWorld({ authorizationResponseIss: true });
    const built = build(world);
    const { url, state } = await authorize(world, built);
    expect(url.origin + url.pathname).toBe(`${AS}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(MCP);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('client_id')).toBe('dcr-client');
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(built.flows.size).toBe(1);

    const outcome = await built.coordinator.complete(alice, { code: 'code-1', state, iss: AS });
    expect(outcome).toEqual({ serverId: SERVER_ID, outcome: 'connected' });
    expect(built.flows.size).toBe(0);
    const grant = built.grants.get(`${alice.issuer}|${alice.subject}|${SERVER_ID}`)!;
    expect(grant.issuer).toBe(AS);
    expect(JSON.parse(grant.blob).tokens.access_token).toBe('access-1');

    const tested = await built.service.testServer(alice, SERVER_ID);
    expect(tested.ok).toBe(true);
    expect((tested.data as { toolCount: number }).toolCount).toBe(1);
    await built.connections.closeAll();
  });

  it('refuses state replay, unknown state, and another principal using the state', async () => {
    const world = createWorld({ authorizationResponseIss: true });
    const built = build(world);
    const { state } = await authorize(world, built);
    expect(await built.coordinator.complete(bob, { code: 'code-1', state, iss: AS })).toMatchObject({ outcome: 'error', reason: 'invalid_state' });
    expect(await built.coordinator.complete(alice, { code: 'code-1', state: 'unknown-state', iss: AS })).toMatchObject({ reason: 'invalid_state' });
    expect(await built.coordinator.complete(alice, { code: 'code-1', iss: AS })).toMatchObject({ reason: 'invalid_state' });
    expect(await built.coordinator.complete(alice, { code: 'code-1', state, iss: AS })).toMatchObject({ outcome: 'connected' });
    expect(await built.coordinator.complete(alice, { code: 'code-1', state, iss: AS })).toMatchObject({ reason: 'invalid_state' });
    await built.connections.closeAll();
  });

  it('rejects an authorization response whose issuer differs, without redeeming the code', async () => {
    const world = createWorld({ authorizationResponseIss: true });
    const built = build(world);
    const { state } = await authorize(world, built);
    const outcome = await built.coordinator.complete(alice, { code: 'code-1', state, iss: 'https://evil.example.com' });
    expect(outcome).toMatchObject({ outcome: 'error', reason: 'issuer_mismatch' });
    expect(world.requests.filter((r) => r.url === `${AS}/token`)).toHaveLength(0);
    expect(built.grants.size).toBe(0);
    await built.connections.closeAll();
  });

  it('refuses to start when the authorization server metadata names a different issuer', async () => {
    const world = createWorld({ issuerInMetadata: 'https://other.example.com' });
    const built = build(world);
    await expect(built.coordinator.start(alice, SERVER_ID)).rejects.toThrow();
    expect(built.flows.size).toBe(0);
    await built.connections.closeAll();
  });

  it('reports a denied authorization without exchanging a code and requires a configured redirect URL', async () => {
    const world = createWorld();
    const built = build(world);
    const { state } = await authorize(world, built);
    expect(await built.coordinator.complete(alice, { state, error: 'access_denied' })).toMatchObject({ outcome: 'error', reason: 'denied' });
    expect(world.requests.filter((r) => r.url === `${AS}/token`)).toHaveLength(0);

    const unconfigured = build(createWorld(), createRunner(), { redirect: undefined });
    await expect(unconfigured.coordinator.start(alice, SERVER_ID)).rejects.toThrow(/MCP_DOWNSTREAM_OAUTH_REDIRECT_URL/);
    await built.connections.closeAll();
    await unconfigured.connections.closeAll();
  });

  it('prefers a manually registered client and never registers dynamically', async () => {
    const world = createWorld();
    const built = build(world, createRunner({ scopes: null, clientId: 'manual-client', clientSecret: 'manual-secret' }));
    const { url } = await authorize(world, built);
    expect(url.searchParams.get('client_id')).toBe('manual-client');
    expect(world.state.registrations).toBe(0);
    await built.connections.closeAll();
  });

  it('uses the configured client metadata URL as client_id when the server supports it', async () => {
    const world = createWorld();
    const cimd = 'https://public.example.com/oauth/client/cloud-harness';
    const originalFetch = world.fetchImpl;
    const built = build({
      ...world,
      fetchImpl: async (input: string | URL, init?: RequestInit) => {
        const response = await originalFetch(input, init);
        if (String(input).startsWith(`${AS}/.well-known/`)) {
          const metadata = await response.json() as Record<string, unknown>;
          return new Response(JSON.stringify({ ...metadata, client_id_metadata_document_supported: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return response;
      }
    }, createRunner(), { redirect: REDIRECT, cimd });
    const { url } = await authorize(world, built);
    expect(url.searchParams.get('client_id')).toBe(cimd);
    expect(world.state.registrations).toBe(0);
    await built.connections.closeAll();
  });
});

describe('downstream MCP OAuth: background calls', () => {
  it('returns a structured AUTHORIZATION_REQUIRED result and creates no state at the authorization server', async () => {
    const world = createWorld();
    const built = build(world);
    const result = await built.service.testServer(alice, SERVER_ID);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUTHORIZATION_REQUIRED');
    expect(world.requests.filter((r) => r.method === 'POST' && r.url.startsWith(AS))).toHaveLength(0);
    expect(built.flows.size).toBe(0);
    await built.connections.closeAll();
  });

  it('refreshes an expired token once for concurrent callers and persists the rotated refresh token', async () => {
    const world = createWorld({ authorizationResponseIss: false });
    const built = build(world);
    const { state } = await authorize(world, built);
    await built.coordinator.complete(alice, { code: 'code-1', state });
    await built.connections.closeAll();
    const fresh = build(world, built);
    const slot = `${alice.issuer}|${alice.subject}|${SERVER_ID}`;
    // Age the stored token so the SDK refreshes before the first request.
    const grant = fresh.grants.get(slot)!;
    const blob = JSON.parse(grant.blob);
    blob.tokensObtainedAt = 1;
    fresh.grants.set(slot, { ...grant, blob: JSON.stringify(blob) });
    // The resource server stops honouring the aged access token.
    world.state.access = 'access-expired';

    const results = await Promise.all([fresh.service.testServer(alice, SERVER_ID), fresh.service.testServer(alice, SERVER_ID)]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(world.state.refreshPosts).toBe(1);
    expect(JSON.parse(fresh.grants.get(slot)!.blob).tokens.refresh_token).toBe(world.state.refresh);
    expect(fresh.grants.get(slot)!.generation).toBeGreaterThan(grant.generation);
    await fresh.connections.closeAll();
  });

  it('marks reauthorization required when the refresh is rejected and keeps diagnostics', async () => {
    const world = createWorld();
    const built = build(world);
    const { state } = await authorize(world, built);
    await built.coordinator.complete(alice, { code: 'code-1', state });
    await built.connections.closeAll();
    const fresh = build(world, built);
    const slot = `${alice.issuer}|${alice.subject}|${SERVER_ID}`;
    const grant = fresh.grants.get(slot)!;
    const blob = JSON.parse(grant.blob);
    blob.tokensObtainedAt = 1;
    fresh.grants.set(slot, { ...grant, blob: JSON.stringify(blob) });
    // The resource server stops honouring the aged access token.
    world.state.access = 'access-expired';
    world.state.failRefresh = true;

    const result = await fresh.service.testServer(alice, SERVER_ID);
    expect(result.error?.code).toBe('AUTHORIZATION_REQUIRED');
    expect(fresh.marks.some((m) => m.state === 'reauthorization_required')).toBe(true);
    expect(fresh.grants.has(slot)).toBe(true);
    await fresh.connections.closeAll();
  });

  it('rejects an oversized token response and an OAuth redirect', async () => {
    for (const options of [{ oversizeToken: true }, { redirectToken: true }]) {
      const world = createWorld(options);
      const built = build(world);
      const { state } = await authorize(world, built);
      const outcome = await built.coordinator.complete(alice, { code: 'code-1', state });
      expect(outcome).toMatchObject({ outcome: 'error' });
      expect(world.requests.some((r) => r.url.startsWith('http://169.254.169.254'))).toBe(false);
      expect(built.grants.size).toBe(0);
      await built.connections.closeAll();
    }
  });
});

describe('downstream MCP OAuth: credential boundaries', () => {
  it('refuses an authorization server whose token endpoint targets a private address', async () => {
    const world = createWorld({ tokenEndpoint: 'https://169.254.169.254/token' });
    const built = build(world);
    const { state } = await authorize(world, built);
    const outcome = await built.coordinator.complete(alice, { code: 'code-1', state });
    expect(outcome).toMatchObject({ outcome: 'error' });
    expect(world.requests.some((r) => r.url.includes('169.254.169.254'))).toBe(false);
    await built.connections.closeAll();
  });

  it('never sends custom MCP headers to OAuth endpoints or the bearer token anywhere but the MCP endpoint', async () => {
    const world = createWorld();
    const built = build(world, createRunner({ scopes: 'read', clientId: null, clientSecret: null }, { 'X-Api-Key': 'static-secret' }));
    const { state } = await authorize(world, built);
    await built.coordinator.complete(alice, { code: 'code-1', state });
    await built.service.testServer(alice, SERVER_ID);
    for (const request of world.requests) {
      const isMcpEndpoint = request.url === MCP;
      if (!isMcpEndpoint) {
        expect(request.headers.get('x-api-key'), request.url).toBeNull();
        expect(request.headers.get('authorization'), request.url).toBeNull();
      }
    }
    expect(world.requests.some((r) => r.url === MCP && r.headers.get('x-api-key') === 'static-secret')).toBe(true);
    await built.connections.closeAll();
  });

  it('keeps grants principal-scoped', async () => {
    const world = createWorld();
    const built = build(world);
    const { state } = await authorize(world, built);
    await built.coordinator.complete(alice, { code: 'code-1', state });
    const forBob = await built.service.testServer(bob, SERVER_ID);
    expect(forBob.error?.code).toBe('AUTHORIZATION_REQUIRED');
    await built.connections.closeAll();
  });
});

describe('downstream MCP OAuth: lifecycle', () => {
  it('revokes best effort, deletes the grant, and invalidates the cached connection on disconnect', async () => {
    const world = createWorld();
    const built = build(world);
    const { state } = await authorize(world, built);
    await built.coordinator.complete(alice, { code: 'code-1', state });
    await built.service.testServer(alice, SERVER_ID);
    expect(built.connections.size()).toBe(1);
    const result = await built.coordinator.disconnect(alice, SERVER_ID);
    expect(result).toEqual({ disconnected: true, revocation: 'attempted' });
    expect(world.state.revoked).toEqual(['refresh-1']);
    expect(built.grants.size).toBe(0);
    expect(built.connections.size()).toBe(0);
    expect((await built.service.testServer(alice, SERVER_ID)).error?.code).toBe('AUTHORIZATION_REQUIRED');
    await built.connections.closeAll();
  });

  it('reports unsupported revocation and still deletes locally', async () => {
    const world = createWorld({ noRevocation: true });
    const built = build(world);
    const { state } = await authorize(world, built);
    await built.coordinator.complete(alice, { code: 'code-1', state });
    expect(await built.coordinator.disconnect(alice, SERVER_ID)).toEqual({ disconnected: true, revocation: 'unsupported' });
    expect(built.grants.size).toBe(0);
    await built.connections.closeAll();
  });
});
