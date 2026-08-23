import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { CloudflareAccessJwtVerifier } from '../src/access-jwt-verifier.js';
import { bearerAuth } from '../src/auth.js';

const issuer = 'https://team.cloudflareaccess.com';
const audience = 'application-audience';
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
const baseTime = 1_800_000_000_000;

function key(kid: string): { kid: string; privateKey: KeyObject; jwk: JsonWebKey & { kid: string; alg: string; use: string } } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const sharedSigningKey = key('current');

function jwt(signingKey: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: signingKey.kid, ...header })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), signingKey.privateKey).toString('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: issuer,
  aud: [audience],
  sub: 'access-subject',
  exp: Math.floor(baseTime / 1_000) + 60,
  nbf: Math.floor(baseTime / 1_000) - 10,
  type: 'app',
  email: 'owner@example.com',
  name: 'Owner',
  ...overrides
});

const fetchJwks = (jwks: JsonWebKey[]) => vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), {
  status: 200,
  headers: { 'content-type': 'application/json' }
}));

describe('Cloudflare Access assertion verification', () => {
  it('accepts a valid RS256 application assertion and normalizes identity', async () => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    await expect(verifier.verify(jwt(signingKey, claims()))).resolves.toEqual({
      principal: { issuer, subject: 'access-subject', email: 'owner@example.com', name: 'Owner' },
      expiresAt: Math.floor(baseTime / 1_000) + 60
    });
  });

  it.each([
    ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }],
    ['wrong audience', { aud: ['other-audience'] }],
    ['wrong token type', { type: 'org' }],
    ['expired', { exp: Math.floor(baseTime / 1_000) }],
    ['not active', { nbf: Math.floor(baseTime / 1_000) + 1 }],
    ['missing expiration', { exp: undefined }],
    ['missing not-before', { nbf: undefined }],
    ['empty subject without service identity', { sub: '', common_name: undefined }],
    ['human subject in reserved service namespace', { sub: 'cf-service:collision' }]
  ])('rejects %s', async (_name, override) => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    await expect(verifier.verify(jwt(signingKey, claims(override)))).rejects.toThrow('assertion verification failed');
  });

  it('rejects malformed assertions and algorithms other than RS256', async () => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    await expect(verifier.verify('not-a-jwt')).rejects.toThrow('assertion verification failed');
    await expect(verifier.verify(jwt(signingKey, claims(), { alg: 'RS512' }))).rejects.toThrow('assertion verification failed');
  });

  it.each([undefined, '', ' padded ', 'x'.repeat(321), 42])('rejects malformed service common_name %j', async (commonName) => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    await expect(verifier.verify(jwt(signingKey, claims({ sub: '', nbf: undefined, common_name: commonName })))).rejects.toThrow('assertion verification failed');
  });

  it('rejects an assertion whose signature does not match the selected key', async () => {
    const trusted = key('current');
    const attacker = key('current');
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([trusted.jwk]), now: () => baseTime });
    await expect(verifier.verify(jwt(attacker, claims()))).rejects.toThrow('assertion verification failed');
  });

  it('single-flights unknown-key refreshes and negatively caches bounded misses', async () => {
    const current = key('current');
    const unknown = key('unknown');
    const fetcher = fetchJwks([current.jwk]);
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher, now: () => baseTime, refreshCooldownMs: 5_000 });
    const assertion = jwt(unknown, claims());
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => verifier.verify(assertion)));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(verifier.verify(assertion)).rejects.toThrow('assertion verification failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes after rotation and accepts the new key', async () => {
    const first = key('first');
    const second = key('second');
    let now = baseTime;
    let activeKeys: JsonWebKey[] = [first.jwk];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: activeKeys }), { status: 200 }));
    const verifier = new CloudflareAccessJwtVerifier({
      issuer, audience, jwksUrl, fetcher, now: () => now, cacheTtlMs: 1_000, refreshCooldownMs: 100
    });
    await expect(verifier.verify(jwt(first, claims()))).resolves.toBeDefined();
    activeKeys = [second.jwk];
    now += 1_100;
    await expect(verifier.verify(jwt(second, claims({ exp: Math.floor(now / 1_000) + 60, nbf: Math.floor(now / 1_000) - 1 })))).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses a cached key only within its bounded stale window during a JWKS outage', async () => {
    const signingKey = sharedSigningKey;
    let now = baseTime;
    let available = true;
    const fetcher = vi.fn(async () => available
      ? new Response(JSON.stringify({ keys: [signingKey.jwk] }), { status: 200 })
      : new Response('unavailable', { status: 503 }));
    const verifier = new CloudflareAccessJwtVerifier({
      issuer, audience, jwksUrl, fetcher, now: () => now,
      cacheTtlMs: 1_000, maxStaleMs: 4_000, refreshCooldownMs: 100
    });
    const assertion = jwt(signingKey, claims({ exp: Math.floor(baseTime / 1_000) + 120 }));
    await expect(verifier.verify(assertion)).resolves.toBeDefined();
    available = false;
    now += 1_100;
    await expect(verifier.verify(assertion)).resolves.toBeDefined();
    now += 4_000;
    await expect(verifier.verify(assertion)).rejects.toThrow('assertion verification failed');
  });
});

describe('Access authentication middleware', () => {
  const config: ApiConfig = {
    host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
    accessIssuer: issuer, accessAudience: audience, accessJwksUrl: jwksUrl,
    runnerUrl: 'http://runner:3001', runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['localhost'], allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
    apiKeyAuthEnabled: false, mailboxProbeEnabled: false
  };

  function response() {
    return {
      setHeader: vi.fn(),
      status: vi.fn(function (this: unknown) { return this; }),
      json: vi.fn()
    };
  }

  it('uses only the verified assertion as identity while retaining opaque bearer transport', async () => {
    const signingKey = sharedSigningKey;
    const middleware = bearerAuth(config, { fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    const headers: Record<string, string> = {
      authorization: 'Bearer opaque-client-token',
      'cf-access-jwt-assertion': jwt(signingKey, claims())
    };
    const request = { header: (name: string) => headers[name.toLowerCase()] } as any;
    const reply = response();
    const next = vi.fn();
    await middleware(request, reply as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.auth.token).toBe('opaque-client-token');
    expect(request.auth.extra.externalPrincipal).toEqual({ issuer, subject: 'access-subject', email: 'owner@example.com', name: 'Owner' });
  });

  it('accepts a verified Access service assertion without an OAuth bearer', async () => {
    const signingKey = sharedSigningKey;
    const middleware = bearerAuth(config, { fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    const headers: Record<string, string> = {
      'cf-access-jwt-assertion': jwt(signingKey, claims({ sub: '', nbf: undefined, common_name: 'deploy-canary-service-token' }))
    };
    const request = { header: (name: string) => headers[name.toLowerCase()] } as any;
    const reply = response();
    const next = vi.fn();
    await middleware(request, reply as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(request.auth.token).toBe('cloudflare-access');
    expect(request.auth.extra.externalPrincipal.subject).toBe(`cf-service:${Buffer.from('deploy-canary-service-token').toString('base64url')}`);
  });

  it('rejects an opaque bearer without a verified Access assertion', async () => {
    const middleware = bearerAuth(config, { fetcher: fetchJwks([]), now: () => baseTime });
    const request = { header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer opaque-client-token' : undefined } as any;
    const reply = response();
    const next = vi.fn();
    await middleware(request, reply as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
