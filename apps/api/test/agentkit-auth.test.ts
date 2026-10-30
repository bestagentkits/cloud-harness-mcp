import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiConfigSchema } from '@cloud-harness/contracts';
import { AgentkitJwtVerifier } from '../src/agentkit-jwt-verifier.js';
import { createApiApp } from '../src/app.js';

const issuer = 'https://agentkit.best';
const resource = 'https://harness.agentkit.test/mcp';
const baseTime = 1_800_000_000_000;
const nowSeconds = Math.floor(baseTime / 1_000);

function ecKey(kid: string): { kid: string; privateKey: KeyObject; jwk: JsonWebKey & { kid: string } } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

const signingKey = ecKey('as-1');

function token(claims: Record<string, unknown>, header: Record<string, unknown> = {}, key = signingKey): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: key.kid, ...header })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: issuer,
  aud: resource,
  sub: 'user-1',
  client_id: 'https://claude.ai/oauth/client.json',
  grant_id: 'grant-1',
  scope: 'cloud-harness:workspace',
  jti: 'token-1',
  iat: nowSeconds - 5,
  exp: nowSeconds + 55,
  ...overrides
});

const fetchJwks = (jwks: JsonWebKey[]) => vi.fn<(url: string | URL | Request) => Promise<Response>>(async () => new Response(JSON.stringify({ keys: jwks }), {
  status: 200,
  headers: { 'content-type': 'application/json' }
}));

function verifier(fetcher = fetchJwks([signingKey.jwk])) {
  return new AgentkitJwtVerifier({ issuer, resource, fetcher, now: () => baseTime });
}

describe('agentkit.best access token verification', () => {
  it('accepts an ES256 at+jwt for this resource and reads the JWKS from the issuer', async () => {
    const fetcher = fetchJwks([signingKey.jwk]);
    await expect(verifier(fetcher).verify(token(claims()))).resolves.toEqual({
      subject: 'user-1',
      clientId: 'https://claude.ai/oauth/client.json',
      scopes: ['cloud-harness:workspace'],
      expiresAt: nowSeconds + 55
    });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://agentkit.best/.well-known/jwks.json');
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example' }, {}],
    ['another resource', { aud: 'https://bwak.agentkit.best/mcp' }, {}],
    ['several audiences', { aud: [resource, 'https://bwak.agentkit.best/mcp'] }, {}],
    ['expired token', { exp: nowSeconds, iat: nowSeconds - 60 }, {}],
    ['long-lived token', { iat: nowSeconds - 5, exp: nowSeconds + 3_600 }, {}],
    ['token issued in the future', { iat: nowSeconds + 120, exp: nowSeconds + 150 }, {}],
    ['missing iat', { iat: undefined }, {}],
    ['missing workspace scope', { scope: 'build-with-ak:read' }, {}],
    ['empty subject', { sub: '' }, {}],
    ['ID token type', {}, { typ: 'JWT' }],
    ['RS256 header', {}, { alg: 'RS256' }],
    ['none algorithm', {}, { alg: 'none' }]
  ])('rejects %s', async (_name, claimOverrides, headerOverrides) => {
    await expect(verifier().verify(token(claims(claimOverrides), headerOverrides))).rejects.toThrow('verification failed');
  });

  it('rejects a token signed by a key that is not in the issuer JWKS', async () => {
    const attacker = ecKey('as-1');
    await expect(verifier().verify(token(claims(), {}, attacker))).rejects.toThrow('verification failed');
  });

  it('refuses a JWKS entry that carries private key material', async () => {
    const leaked = { ...signingKey.privateKey.export({ format: 'jwk' }), kid: 'as-1' };
    await expect(verifier(fetchJwks([leaked])).verify(token(claims()))).rejects.toMatchObject({ reason: 'jwks_unavailable' });
  });
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const ownerBearer = 'owner-bearer-token-for-tests-0123456789abcdef';

async function startApp() {
  const config = ApiConfigSchema.parse({
    runnerUrl: 'http://runner:3001',
    runnerToken: 'runner-token-for-tests-0123456789abcdef',
    bearerToken: ownerBearer,
    publicHosts: ['localhost', 'harness.agentkit.test'],
    agentkitAuthEnabled: true,
    agentkitAuthResource: resource,
    agentkitAuthSubjects: ['user-1']
  });
  const runtime = createApiApp(config, { agentkitVerifier: { fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime } });
  const server = runtime.app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
});
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('agentkit.best sign-in lane', () => {
  it('publishes protected resource metadata only on the agentkit.best host', async () => {
    const port = await startApp();
    const metadata = await send(port, 'GET', '/.well-known/oauth-protected-resource/mcp', { host: 'harness.agentkit.test' });
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body)).toMatchObject({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ['cloud-harness:workspace']
    });
    expect((await send(port, 'GET', '/.well-known/oauth-protected-resource', { host: 'localhost' })).status).toBe(404);
  });

  it('challenges an anonymous request with the resource metadata URL', async () => {
    const port = await startApp();
    const reply = await send(port, 'POST', '/mcp', { ...mcpHeaders, host: 'harness.agentkit.test' }, initialize);
    expect(reply.status).toBe(401);
    expect(reply.headers['www-authenticate']).toContain('resource_metadata="https://harness.agentkit.test/.well-known/oauth-protected-resource/mcp"');
  });

  it('serves MCP to a listed subject and refuses every other account', async () => {
    const port = await startApp();
    const allowed = await send(port, 'POST', '/mcp', { ...mcpHeaders, host: 'harness.agentkit.test', authorization: `Bearer ${token(claims())}` }, initialize);
    expect(allowed.status).toBe(200);
    const stranger = await send(port, 'POST', '/mcp', { ...mcpHeaders, host: 'harness.agentkit.test', authorization: `Bearer ${token(claims({ sub: 'user-2' }))}` }, initialize);
    expect(stranger.status).toBe(403);
  });

  it('never accepts the instance credential on the agentkit.best host, nor an agentkit.best token elsewhere', async () => {
    const port = await startApp();
    const ownerOnAgentkitHost = await send(port, 'POST', '/mcp', { ...mcpHeaders, host: 'harness.agentkit.test', authorization: `Bearer ${ownerBearer}` }, initialize);
    expect(ownerOnAgentkitHost.status).toBe(401);
    const agentkitOnInstanceHost = await send(port, 'POST', '/mcp', { ...mcpHeaders, host: 'localhost', authorization: `Bearer ${token(claims())}` }, initialize);
    expect(agentkitOnInstanceHost.status).toBe(401);
    const owner = await send(port, 'POST', '/mcp', { ...mcpHeaders, host: 'localhost', authorization: `Bearer ${ownerBearer}` }, initialize);
    expect(owner.status).toBe(200);
  });

  it('keeps the MCP gateway off the agentkit.best host', async () => {
    const port = await startApp();
    const reply = await send(port, 'POST', '/mcp-gateway', { ...mcpHeaders, host: 'harness.agentkit.test', authorization: `Bearer ${token(claims())}` }, initialize);
    expect(reply.status).toBe(404);
  });
});

describe('agentkit.best sign-in configuration', () => {
  const base = {
    runnerUrl: 'http://runner:3001',
    runnerToken: 'runner-token-for-tests-0123456789abcdef',
    bearerToken: ownerBearer,
    publicHosts: ['localhost', 'harness.agentkit.test']
  };

  it('is off by default and refuses stray settings while off', () => {
    expect(ApiConfigSchema.parse(base).agentkitAuthEnabled).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...base, agentkitAuthSubjects: ['user-1'] }).success).toBe(false);
  });

  it.each([
    ['no resource', { agentkitAuthSubjects: ['user-1'] }],
    ['no subjects', { agentkitAuthResource: resource }],
    ['resource host not public', { agentkitAuthResource: 'https://other.agentkit.test/mcp', agentkitAuthSubjects: ['user-1'] }],
    ['resource path other than /mcp', { agentkitAuthResource: 'https://harness.agentkit.test/api', agentkitAuthSubjects: ['user-1'] }]
  ])('rejects an enabled lane with %s', (_name, settings) => {
    expect(ApiConfigSchema.safeParse({ ...base, agentkitAuthEnabled: true, ...settings }).success).toBe(false);
  });
});
