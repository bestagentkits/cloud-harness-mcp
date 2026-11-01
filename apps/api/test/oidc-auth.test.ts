import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { NextFunction, Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiConfigSchema, type ApiConfig } from '@cloud-harness/contracts';
import { JwksJwtVerifier } from '../src/access-jwt-verifier.js';
import { createApiApp, type ApiRuntime } from '../src/app.js';
import { bearerAuth, type AuthenticatedRequest } from '../src/auth.js';
import { protectedResourceMetadataPath, protectedResourceMetadataUrl } from '../src/protected-resource-metadata.js';

const issuer = 'https://tose.example.test';
const jwksUrl = `${issuer}/oauth/jwks.json`;
const instanceA = 'https://ch-a.example.test';
const instanceB = 'https://ch-b.example.test';
const requiredScope = 'cloudharness:operator';
const baseTime = 1_800_000_000_000;
const nowSeconds = Math.floor(baseTime / 1_000);

type SigningKey = { kid: string; privateKey: KeyObject; jwk: JsonWebKey & { kid: string; alg: string; use: string } };

function key(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const signingKey = key('tose-current');

function jwt(signer: SigningKey, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: signer.kid }): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), signer.privateKey).toString('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/** The claim set the TOSE authorization server issues for one instance. */
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: issuer,
  aud: instanceA,
  sub: 'tose-user-42',
  iat: nowSeconds - 5,
  nbf: nowSeconds - 5,
  exp: nowSeconds + 600,
  jti: 'jti-1',
  scope: requiredScope,
  email: 'operator@example.test',
  name: 'Operator',
  tose_workspace: 'ws-1',
  tose_instance: 'ch-a',
  ...overrides
});

const fetchJwks = (keys: JsonWebKey[]) => vi.fn(async () => new Response(JSON.stringify({ keys }), {
  status: 200,
  headers: { 'content-type': 'application/json' }
}));

const verifierFor = (audience: string, fetcher = fetchJwks([signingKey.jwk]), now = () => baseTime) =>
  new JwksJwtVerifier({ issuer, audience, jwksUrl, requiredScope, fetcher, now });

describe('OIDC access token verification', () => {
  it('accepts a token issued for this instance and maps (issuer, sub) to the principal', async () => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims()))).resolves.toEqual({
      principal: { issuer, subject: 'tose-user-42', email: 'operator@example.test', name: 'Operator' },
      expiresAt: nowSeconds + 600
    });
  });

  it('accepts the required scope among other scopes and an audience array', async () => {
    const token = jwt(signingKey, claims({ scope: 'openid cloudharness:operator', aud: [instanceA, 'https://other.example.test'] }));
    await expect(verifierFor(instanceA).verify(token)).resolves.toBeDefined();
  });

  it('rejects a validly signed token issued for another instance', async () => {
    const tokenForB = jwt(signingKey, claims({ aud: instanceB, tose_instance: 'ch-b' }));
    await expect(verifierFor(instanceA).verify(tokenForB)).rejects.toMatchObject({ reason: 'wrong_audience' });
    await expect(verifierFor(instanceB).verify(tokenForB)).resolves.toBeDefined();
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ aud: [instanceB] })))).rejects.toMatchObject({ reason: 'wrong_audience' });
  });

  it('rejects an audience that only differs by a trailing slash or path', async () => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ aud: `${instanceA}/` })))).rejects.toMatchObject({ reason: 'wrong_audience' });
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ aud: `${instanceA}/mcp` })))).rejects.toMatchObject({ reason: 'wrong_audience' });
  });

  it.each([
    ['missing', { scope: undefined }],
    ['different', { scope: 'openid profile' }],
    ['a prefix of the required scope', { scope: 'cloudharness' }],
    ['not a string', { scope: [requiredScope] }]
  ])('rejects a token whose scope is %s', async (_name, override) => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims(override)))).rejects.toMatchObject({ reason: 'insufficient_scope' });
  });

  it.each([
    ['RS512', { alg: 'RS512', kid: signingKey.kid }],
    ['HS256', { alg: 'HS256', kid: signingKey.kid }],
    ['none', { alg: 'none', kid: signingKey.kid }]
  ])('rejects the %s algorithm', async (_name, header) => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims(), header))).rejects.toMatchObject({ reason: 'unsupported_algorithm' });
  });

  it('rejects a token without a key id', async () => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims(), { alg: 'RS256' }))).rejects.toMatchObject({ reason: 'malformed_assertion' });
  });

  it('rejects an expired token and one that is not active yet', async () => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ exp: nowSeconds })))).rejects.toMatchObject({ reason: 'expired_assertion' });
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ nbf: nowSeconds + 30 })))).rejects.toMatchObject({ reason: 'inactive_assertion' });
  });

  it('rejects another issuer and a signature from a key outside the JWKS', async () => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ iss: 'https://evil.example.test' })))).rejects.toMatchObject({ reason: 'wrong_issuer' });
    const forged = key(signingKey.kid);
    await expect(verifierFor(instanceA).verify(jwt(forged, claims()))).rejects.toMatchObject({ reason: 'invalid_signature' });
  });

  it('needs no Cloudflare type claim or nbf, but never treats an empty subject as a service token', async () => {
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ nbf: undefined })))).resolves.toBeDefined();
    await expect(verifierFor(instanceA).verify(jwt(signingKey, claims({ sub: '', common_name: 'service' })))).rejects.toMatchObject({ reason: 'invalid_subject' });
  });

  it('follows a key rotation by refreshing the cached JWKS on an unknown key id', async () => {
    const rotated = key('tose-next');
    let keys: JsonWebKey[] = [signingKey.jwk];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200 }));
    const verifier = new JwksJwtVerifier({ issuer, audience: instanceA, jwksUrl, requiredScope, fetcher, now: () => baseTime, refreshCooldownMs: 0 });
    await expect(verifier.verify(jwt(signingKey, claims()))).resolves.toBeDefined();
    keys = [signingKey.jwk, rotated.jwk];
    await expect(verifier.verify(jwt(rotated, claims()))).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(verifier.verify(jwt(signingKey, claims()))).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

function oidcConfig(overrides: Partial<Record<string, unknown>> = {}): ApiConfig {
  return ApiConfigSchema.parse({
    host: '127.0.0.1',
    authMode: 'oidc',
    oidcIssuer: issuer,
    oidcAudience: instanceA,
    oidcJwksUrl: jwksUrl,
    runnerUrl: 'http://127.0.0.1:9',
    runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['127.0.0.1'],
    ...overrides
  });
}

describe('OIDC configuration', () => {
  it('defaults the required scope and accepts a complete oidc configuration', () => {
    expect(oidcConfig().oidcRequiredScope).toBe(requiredScope);
    expect(oidcConfig({ oidcRequiredScope: 'harness:ops' }).oidcRequiredScope).toBe('harness:ops');
  });

  it.each([
    ['a missing issuer', { oidcIssuer: undefined }, 'oidcIssuer'],
    ['a missing audience', { oidcAudience: undefined }, 'oidcAudience'],
    ['a missing JWKS URL', { oidcJwksUrl: undefined }, 'oidcJwksUrl'],
    ['an audience with a trailing slash', { oidcAudience: `${instanceA}/` }, 'oidcAudience'],
    ['an audience with a query', { oidcAudience: `${instanceA}?x=1` }, 'oidcAudience'],
    ['a cleartext audience', { oidcAudience: 'http://ch-a.example.test' }, 'oidcAudience'],
    ['a scope with whitespace', { oidcRequiredScope: 'a b' }, 'oidcRequiredScope'],
    ['an owner bearer token', { bearerToken: 'owner-token-that-is-longer-than-32-characters' }, 'bearerToken'],
    ['Cloudflare Access settings', { accessIssuer: 'https://team.cloudflareaccess.com' }, 'authMode'],
    ['private MCP gateway endpoints', { mcpGatewayAllowPrivateEndpoints: 'true' }, 'authMode']
  ])('refuses %s', (_name, overrides, path) => {
    const result = ApiConfigSchema.safeParse({ ...oidcConfig(), ...overrides });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(path);
  });

  it('refuses OIDC settings outside oidc mode', () => {
    const result = ApiConfigSchema.safeParse({
      ...oidcConfig(), authMode: 'owner-bearer', bearerToken: 'owner-token-that-is-longer-than-32-characters'
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === 'OIDC settings are forbidden in owner-bearer mode')).toBe(true);
  });
});

describe('protected resource metadata location', () => {
  it('inserts the well-known segment between the host and the resource path', () => {
    expect(protectedResourceMetadataPath(instanceA)).toBe('/.well-known/oauth-protected-resource');
    expect(protectedResourceMetadataPath(`${instanceA}/tenant`)).toBe('/.well-known/oauth-protected-resource/tenant');
    expect(protectedResourceMetadataUrl(instanceA)).toBe(`${instanceA}/.well-known/oauth-protected-resource`);
  });
});

describe('OIDC bearer middleware', () => {
  function reply() {
    return {
      setHeader: vi.fn(),
      status: vi.fn(function (this: unknown) { return this; }),
      json: vi.fn()
    };
  }

  function request(headers: Record<string, string>): AuthenticatedRequest {
    return {
      method: 'POST', originalUrl: '/mcp', header: (name: string) => headers[name.toLowerCase()]
    } as unknown as AuthenticatedRequest;
  }

  it('authenticates the verified subject as an external operator principal', async () => {
    const middleware = bearerAuth(oidcConfig(), { fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    const token = jwt(signingKey, claims());
    const authenticated = request({ authorization: `Bearer ${token}` });
    const next = vi.fn() as unknown as NextFunction;
    await middleware(authenticated, reply() as unknown as ExpressResponse, next);
    expect(next).toHaveBeenCalledOnce();
    expect(authenticated.auth?.extra?.principal).toEqual({
      kind: 'external', issuer, subject: 'tose-user-42', email: 'operator@example.test', name: 'Operator'
    });
    expect(authenticated.auth?.scopes).toEqual(['workspace:read', 'workspace:write', 'workspace:execute']);
  });

  it('ignores a Cloudflare Access assertion header in oidc mode', async () => {
    const middleware = bearerAuth(oidcConfig(), { fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    const response = reply();
    const next = vi.fn() as unknown as NextFunction;
    await middleware(request({ 'cf-access-jwt-assertion': jwt(signingKey, claims()) }), response as unknown as ExpressResponse, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
  });
});

describe('OIDC HTTP surface', () => {
  let server: Server | undefined;
  let runtime: ApiRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    runtime = undefined;
  });

  async function start(config: ApiConfig): Promise<string> {
    runtime = createApiApp(config, { accessVerifier: { fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime } });
    server = createServer(runtime.app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed');
    return `http://127.0.0.1:${address.port}`;
  }

  const metadataUrl = `${instanceA}/.well-known/oauth-protected-resource`;
  const post = (url: string, token?: string) => fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}'
  });

  it('publishes RFC 9728 metadata naming the instance as resource and TOSE as authorization server', async () => {
    const url = await start(oidcConfig());
    const response = await fetch(`${url}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      resource: instanceA,
      authorization_servers: [issuer],
      scopes_supported: [requiredScope],
      bearer_methods_supported: ['header']
    });
  });

  it('challenges a request without a token with the metadata location', async () => {
    const url = await start(oidcConfig());
    const response = await post(url);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${metadataUrl}"`);
  });

  it('rejects a token issued for another instance as an invalid token', async () => {
    const url = await start(oidcConfig());
    const response = await post(url, jwt(signingKey, claims({ aud: instanceB })));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer error="invalid_token", resource_metadata="${metadataUrl}"`);
    expect(await response.json()).toEqual({ error: 'authentication_failed' });
  });

  it('answers a token without the operator scope with insufficient_scope', async () => {
    const url = await start(oidcConfig());
    const response = await post(url, jwt(signingKey, claims({ scope: 'openid' })));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${metadataUrl}"`);
  });

  it('lets a valid token past authentication on the MCP and gateway endpoints', async () => {
    const url = await start(oidcConfig());
    const token = jwt(signingKey, claims());
    expect((await post(url, token)).status).not.toBe(401);
    const gateway = await fetch(`${url}/mcp-gateway`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}'
    });
    expect([401, 403]).not.toContain(gateway.status);
  });

  it('serves no Dashboard in oidc mode', async () => {
    const url = await start(oidcConfig());
    expect((await fetch(`${url}/dashboard`)).status).toBe(404);
    expect((await fetch(`${url}/dashboard/api/v1/me`)).status).toBe(404);
  });

  it('publishes no protected resource metadata outside oidc mode', async () => {
    const url = await start(ApiConfigSchema.parse({
      host: '127.0.0.1', bearerToken: 'owner-token-that-is-longer-than-32-characters', runnerUrl: 'http://127.0.0.1:9',
      runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['127.0.0.1']
    }));
    expect((await fetch(`${url}/.well-known/oauth-protected-resource`)).status).toBe(404);
  });
});
