import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import type { RunnerClient } from '../src/runner-client.js';

// The managed API-key lane reaches the gateway only through the hidden origin route the
// Worker forwards to. These tests drive the real Express app end to end with an offline
// JWKS so the dual-credential boundary is exercised exactly as production composes it.

const issuer = 'https://team.cloudflareaccess.com';
const mainAudience = 'main-app';
const gatewayAudience = 'gateway-app';
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'lane-key';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const commonName = 'worker-service-client-id';
const gatewaySubject = `cf-service:${Buffer.from(commonName).toString('base64url')}`;
const KEY_ID = `apk_${'a'.repeat(24)}`;
const API_KEY = `chm_key_${KEY_ID}.${'b'.repeat(43)}`;
const PRINCIPAL: RunnerPrincipalSelector = { kind: 'external', issuer, subject: 'human-subject' };

function jwt(audience: string, service = true): string {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [audience], type: 'app', sub: service ? '' : 'human-subject',
    ...(service ? { common_name: commonName } : { nbf: nowSeconds - 1 }),
    exp: nowSeconds + 300
  })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

function laneConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1', port: 0, authMode: 'cloudflare-access', ownerId: 'owner',
    accessIssuer: issuer, accessAudience: mainAudience, accessJwksUrl: jwksUrl,
    apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: gatewayAudience,
    apiKeyGatewayServiceSubject: gatewaySubject, apiKeyGatewayPublicUrl: 'https://api.harness.example/mcp',
    runnerUrl: 'http://127.0.0.1:1', runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 5_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 1_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 4, mcpGatewayAllowInsecureHttp: true, mcpGatewayAllowPrivateEndpoints: true,
    ...overrides
  };
}

function createFakeRunner() {
  const calls: Array<{ operation: string; principal: RunnerPrincipalSelector }> = [];
  const authenticateApiKey = vi.fn(async (apiKey: string) => apiKey === API_KEY
    ? { ok: true as const, data: { principal: PRINCIPAL, keyId: KEY_ID } }
    : { ok: false as const, error: 'authentication_failed' as const });
  const runner = {
    authenticateApiKey,
    async callInternal(operation: string, _input: unknown, principal: RunnerPrincipalSelector): Promise<RunnerResponse> {
      calls.push({ operation, principal });
      return { ok: true, message: 'MCP gateway catalog', data: { servers: [], tools: [] }, truncated: false };
    },
    async ready(): Promise<boolean> {
      return true;
    }
  } as unknown as RunnerClient;
  return { runner, calls, authenticateApiKey };
}

type Harness = { origin: string; runtime: ApiRuntime; close: () => Promise<void> };
const open: Harness[] = [];

async function startApp(runner: RunnerClient, overrides: Partial<ApiConfig> = {}): Promise<Harness> {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
  const runtime = createApiApp(laneConfig(overrides), {
    runnerClient: runner,
    gatewayFetchImpl: async () => new Response('', { status: 404 }),
    accessVerifier: { fetcher }
  });
  const server: Server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API test server failed to bind');
  const harness: Harness = {
    origin: `http://127.0.0.1:${address.port}`,
    runtime,
    close: async () => {
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  open.push(harness);
  return harness;
}

function initializeRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lane-test', version: '1.0.0' } }
  });
}

async function post(origin: string, path: string, headers: Record<string, string>): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: initializeRequest()
  });
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

describe('MCP gateway on the managed API-key lane', () => {
  it('serves initialize and tools/list with exactly the five meta-tools to a managed key', async () => {
    const { runner, calls, authenticateApiKey } = createFakeRunner();
    const harness = await startApp(runner);
    const transport = new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp-api-key/gateway`), {
      requestInit: { headers: { authorization: `Bearer ${API_KEY}`, 'cf-access-jwt-assertion': jwt(gatewayAudience) } }
    });
    const client = new Client({ name: 'api-key-lane-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['execute', 'inspect', 'permissions', 'search', 'status']);

      // Gateway calls are authorized against the principal bound to the managed key.
      await client.callTool({ name: 'status', arguments: {} });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.principal).toEqual(PRINCIPAL);
      expect(authenticateApiKey).toHaveBeenCalledWith(API_KEY);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each([
    ['no Access assertion', { authorization: `Bearer ${API_KEY}` }],
    ['the hostname-wide human assertion', { authorization: `Bearer ${API_KEY}`, 'cf-access-jwt-assertion': jwt(mainAudience, false) }],
    ['a human assertion for the API-key audience', { authorization: `Bearer ${API_KEY}`, 'cf-access-jwt-assertion': jwt(gatewayAudience, false) }],
    ['the Worker assertion without a key', { 'cf-access-jwt-assertion': jwt(gatewayAudience) }],
    ['the Worker assertion with an unknown key', {
      authorization: `Bearer chm_key_apk_${'c'.repeat(24)}.${'d'.repeat(43)}`,
      'cf-access-jwt-assertion': jwt(gatewayAudience)
    }]
  ])('rejects %s on the API-key gateway route', async (_name, headers) => {
    const { runner, calls } = createFakeRunner();
    const harness = await startApp(runner);
    const response = await post(harness.origin, '/mcp-api-key/gateway', headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_failed' });
    expect(calls).toHaveLength(0);
  });

  it.each(['/mcp', '/mcp-gateway'])('still rejects a managed key that is valid on the gateway lane at %s', async (path) => {
    const { runner, authenticateApiKey } = createFakeRunner();
    const harness = await startApp(runner);
    for (const assertion of [jwt(gatewayAudience), jwt(mainAudience, false)]) {
      const response = await post(harness.origin, path, { authorization: `Bearer ${API_KEY}`, 'cf-access-jwt-assertion': assertion });
      expect(response.status).toBe(401);
    }
    expect(authenticateApiKey).not.toHaveBeenCalled();
  });

  it('still accepts the hostname-wide Access lane on /mcp-gateway', async () => {
    const { runner } = createFakeRunner();
    const harness = await startApp(runner);
    const response = await post(harness.origin, '/mcp-gateway', { 'cf-access-jwt-assertion': jwt(mainAudience, false) });
    expect(response.status).toBe(200);
  });

  it('does not serve extra path segments or the gateway when the API-key lane is disabled', async () => {
    const enabled = await startApp(createFakeRunner().runner);
    const credentials = { authorization: `Bearer ${API_KEY}`, 'cf-access-jwt-assertion': jwt(gatewayAudience) };
    expect((await post(enabled.origin, '/mcp-api-key/gateway/extra', credentials)).status).toBe(404);

    const disabled = await startApp(createFakeRunner().runner, {
      apiKeyAuthEnabled: false,
      apiKeyGatewayAccessAudience: undefined,
      apiKeyGatewayServiceSubject: undefined,
      apiKeyGatewayPublicUrl: undefined
    });
    expect((await post(disabled.origin, '/mcp-api-key/gateway', credentials)).status).toBe(404);
  });
});
