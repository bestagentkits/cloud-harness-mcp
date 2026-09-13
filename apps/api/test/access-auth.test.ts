import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { CloudflareAccessJwtVerifier } from '../src/access-jwt-verifier.js';
import { accessAssertionAuth, bearerAuth, type AuthenticatedRequest } from '../src/auth.js';
import { apiLogger } from '../src/logging.js';

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

  it.each([
    ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }, 'wrong_issuer'],
    ['wrong audience', { aud: ['other-audience'] }, 'wrong_audience'],
    ['wrong token type', { type: 'org' }, 'wrong_token_type'],
    ['expired', { exp: Math.floor(baseTime / 1_000) }, 'expired_assertion'],
    ['not active', { nbf: Math.floor(baseTime / 1_000) + 1 }, 'inactive_assertion'],
    ['missing expiration', { exp: undefined }, 'invalid_lifetime'],
    ['missing not-before', { nbf: undefined }, 'invalid_lifetime'],
    ['empty subject without service identity', { sub: '', common_name: undefined }, 'invalid_subject'],
    ['human subject in reserved service namespace', { sub: 'cf-service:collision' }, 'invalid_subject']
  ])('classifies %s as %s', async (_name, override, reason) => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    await expect(verifier.verify(jwt(signingKey, claims(override)))).rejects.toMatchObject({ reason });
  });

  it('classifies absent, malformed, mis-algorithm, unknown-key, and mis-signed assertions distinctly', async () => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher: fetchJwks([signingKey.jwk]), now: () => baseTime });
    await expect(verifier.verify('')).rejects.toMatchObject({ reason: 'missing_assertion' });
    await expect(verifier.verify('not-a-jwt')).rejects.toMatchObject({ reason: 'malformed_assertion' });
    await expect(verifier.verify(jwt(signingKey, claims(), { alg: 'RS512' }))).rejects.toMatchObject({ reason: 'unsupported_algorithm' });
    await expect(verifier.verify(jwt(key('absent'), claims()))).rejects.toMatchObject({ reason: 'unknown_key' });
    await expect(verifier.verify(jwt(key('current'), claims()))).rejects.toMatchObject({ reason: 'invalid_signature' });
  });

  it('classifies an unreachable signing-key document as a JWKS outage', async () => {
    const signingKey = sharedSigningKey;
    const verifier = new CloudflareAccessJwtVerifier({
      issuer, audience, jwksUrl,
      fetcher: async () => { throw new Error('jwks endpoint unreachable'); },
      now: () => baseTime
    });
    await expect(verifier.verify(jwt(signingKey, claims()))).rejects.toMatchObject({ reason: 'jwks_unavailable' });
  });

  it('keeps reporting the JWKS outage when the key document body fails or is negatively cached', async () => {
    const signingKey = sharedSigningKey;
    const erroredBody = new Response(
      new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const fetcher = vi.fn(async () => erroredBody);
    const verifier = new CloudflareAccessJwtVerifier({ issuer, audience, jwksUrl, fetcher, now: () => baseTime });
    const assertion = jwt(signingKey, claims());
    await expect(verifier.verify(assertion)).rejects.toMatchObject({ reason: 'jwks_unavailable' });
    await expect(verifier.verify(assertion)).rejects.toMatchObject({ reason: 'jwks_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Access authentication middleware', () => {
  const config: ApiConfig = {
    host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
    accessIssuer: issuer, accessAudience: audience, accessJwksUrl: jwksUrl,
    runnerUrl: 'http://runner:3001', runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['localhost'], allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
  };

  function response() {
    return {
      setHeader: vi.fn(),
      status: vi.fn(function (this: unknown) { return this; }),
      type: vi.fn(function (this: unknown) { return this; }),
      json: vi.fn(),
      send: vi.fn()
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

  // Test seam: the assertion guard only reads the method, path, and request headers.
  function requestFor(method: string, path: string, headers: Record<string, string> = {}): AuthenticatedRequest {
    return { method, path, originalUrl: path, header: (name: string) => headers[name.toLowerCase()] } as unknown as AuthenticatedRequest;
  }

  it('answers a dashboard document navigation with the diagnostic page and every other dashboard request with the compact body', async () => {
    const middleware = accessAssertionAuth(config, { fetcher: fetchJwks([sharedSigningKey.jwk]), now: () => baseTime });

    const page = response();
    await middleware(requestFor('GET', '/dashboard', { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' }), page as unknown as Response, vi.fn());
    expect(page.status).toHaveBeenCalledWith(401);
    expect(page.json).not.toHaveBeenCalled();
    expect(page.type).toHaveBeenCalledWith('html');
    const html = String(page.send.mock.calls[0]?.[0]);
    expect(html).toContain('missing_assertion');
    expect(html).not.toContain('eyJ');
    expect(page.setHeader.mock.calls.find(([name]) => name === 'WWW-Authenticate')).toBeUndefined();

    for (const headers of [
      { accept: 'application/json' },
      { accept: 'application/json,text/html;q=0' },
      { accept: 'text/html', 'sec-fetch-dest': 'empty' }
    ]) {
      const reply = response();
      await middleware(requestFor('GET', '/dashboard/api/v1/workspaces', headers), reply as unknown as Response, vi.fn());
      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.json).toHaveBeenCalledWith({ error: 'authentication_failed' });
      expect(reply.send).not.toHaveBeenCalled();
    }
  });

  it('keeps the MCP lane on the compact JSON body even when a client asks for HTML', async () => {
    const middleware = bearerAuth(config, { fetcher: fetchJwks([sharedSigningKey.jwk]), now: () => baseTime });
    const reply = response();
    await middleware(requestFor('GET', '/mcp', { accept: 'text/html', 'sec-fetch-dest': 'document' }), reply as unknown as Response, vi.fn());
    expect(reply.json).toHaveBeenCalledWith({ error: 'authentication_failed' });
    expect(reply.send).not.toHaveBeenCalled();
    expect(reply.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="cloud-harness-mcp"');
  });

  it('names the audience mismatch when a dashboard navigation carries a foreign assertion', async () => {
    const middleware = accessAssertionAuth(config, { fetcher: fetchJwks([sharedSigningKey.jwk]), now: () => baseTime });
    const reply = response();
    await middleware(
      requestFor('GET', '/dashboard', { accept: 'text/html', 'cf-access-jwt-assertion': jwt(sharedSigningKey, claims({ aud: ['other-audience'] })) }),
      reply as unknown as Response,
      vi.fn()
    );
    expect(String(reply.send.mock.calls[0]?.[0])).toContain('wrong_audience');
  });

  it('logs one bounded rejection line carrying the query-free path', async () => {
    const warn = vi.spyOn(apiLogger, 'warn');
    try {
      const middleware = accessAssertionAuth(config, { fetcher: fetchJwks([sharedSigningKey.jwk]), now: () => baseTime });
      await middleware(
        requestFor('GET', '/dashboard/api/v1/workspaces?token=secret-sentinel', { accept: 'application/json', host: 'localhost' }),
        response() as unknown as Response,
        vi.fn()
      );
      expect(warn).toHaveBeenCalledTimes(1);
      // Mock argument read: the guard's log fields are the operator-facing contract under test.
      const fields = warn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(fields).toEqual({ reason: 'missing_assertion', method: 'GET', path: '/dashboard/api/v1/workspaces', host: 'localhost' });
      expect(JSON.stringify(fields)).not.toContain('secret-sentinel');

      await middleware(
        requestFor('GET', `/dashboard/${'a'.repeat(512)}`, { accept: 'application/json' }),
        response() as unknown as Response,
        vi.fn()
      );
      const longPath = warn.mock.calls[1]?.[0] as Record<string, unknown>;
      expect(String(longPath.path)).toHaveLength(256);
    } finally {
      warn.mockRestore();
    }
  });
});
