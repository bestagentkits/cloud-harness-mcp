import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '@cloud-harness/contracts';
import { apiKeyGatewayAuth, bearerAuth } from '../src/auth.js';

const issuer = 'https://team.cloudflareaccess.com';
const mainAudience = 'main-app';
const gatewayAudience = 'gateway-app';
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
const now = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'gateway-key';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const commonName = 'worker-service-client-id';
const gatewaySubject = `cf-service:${Buffer.from(commonName).toString('base64url')}`;

function jwt(audience: string, service = true): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [audience], type: 'app', sub: service ? '' : 'human-subject',
    ...(service ? { common_name: commonName } : { nbf: Math.floor(now / 1_000) - 1 }),
    exp: Math.floor(now / 1_000) + 60
  })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: issuer, accessAudience: mainAudience, accessJwksUrl: jwksUrl,
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: gatewayAudience,
  apiKeyGatewayServiceSubject: gatewaySubject, apiKeyGatewayPublicUrl: 'https://api.harness.example/mcp',
  runnerUrl: 'http://runner:3001', runnerToken: 'runner-token-that-is-longer-than-32-characters',
  publicHosts: ['localhost'], allowedOrigins: [], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mailboxProbeEnabled: false
};

const verifier = {
  fetcher: vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
  now: () => now
};

function request(assertion: string, authorization = '') {
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': assertion, authorization };
  return { header: (name: string) => headers[name.toLowerCase()] } as any;
}

function response() {
  return { setHeader: vi.fn(), status: vi.fn(function (this: unknown) { return this; }), json: vi.fn() } as any;
}

describe('API-key gateway authentication boundary', () => {
  it('requires gateway-audience service assertion and a valid managed key', async () => {
    const runner = { authenticateApiKey: vi.fn(async () => ({
      ok: true as const,
      data: { principal: { kind: 'external' as const, issuer, subject: 'human-subject' }, keyId: `apk_${'a'.repeat(24)}` }
    })) };
    const middleware = apiKeyGatewayAuth(config, runner, verifier);
    const current = request(jwt(gatewayAudience), `Bearer chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}`);
    const reply = response(); const next = vi.fn();
    await middleware(current, reply, next);
    expect(next).toHaveBeenCalledOnce();
    expect(current.auth.token).toBe('managed-api-key');
    expect(current.auth.clientId).toBe(`api-key:apk_${'a'.repeat(24)}`);
    expect(current.auth.extra.apiKeyId).toBe(`apk_${'a'.repeat(24)}`);
    expect(JSON.stringify(current.auth)).not.toContain('chm_key_');
  });

  it('uses immutable credential IDs to isolate two keys owned by the same principal', async () => {
    const runner = { authenticateApiKey: vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        data: { principal: { kind: 'external' as const, issuer, subject: 'human-subject' }, keyId: `apk_${'a'.repeat(24)}` }
      })
      .mockResolvedValueOnce({
        ok: true as const,
        data: { principal: { kind: 'external' as const, issuer, subject: 'human-subject' }, keyId: `apk_${'c'.repeat(24)}` }
      }) };
    const middleware = apiKeyGatewayAuth(config, runner, verifier);
    const first = request(jwt(gatewayAudience), `Bearer chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}`);
    const second = request(jwt(gatewayAudience), `Bearer chm_key_apk_${'c'.repeat(24)}.${'d'.repeat(43)}`);
    await middleware(first, response(), vi.fn());
    await middleware(second, response(), vi.fn());
    expect(first.auth.clientId).toBe(`api-key:apk_${'a'.repeat(24)}`);
    expect(second.auth.clientId).toBe(`api-key:apk_${'c'.repeat(24)}`);
    expect(first.auth.extra.principal).toEqual(second.auth.extra.principal);
  });

  it.each([
    ['human assertion', jwt(gatewayAudience, false)],
    ['main application audience', jwt(mainAudience)]
  ])('rejects %s before key verification', async (_name, assertion) => {
    const runner = { authenticateApiKey: vi.fn() };
    const middleware = apiKeyGatewayAuth(config, runner as any, verifier);
    const reply = response(); const next = vi.fn();
    await middleware(request(assertion, `Bearer chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}`), reply, next);
    expect(next).not.toHaveBeenCalled();
    expect(runner.authenticateApiKey).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('rejects a missing key with the generic authentication response', async () => {
    const runner = { authenticateApiKey: vi.fn(async () => ({ ok: false as const, error: 'authentication_failed' as const })) };
    const middleware = apiKeyGatewayAuth(config, runner, verifier);
    const reply = response(); const next = vi.fn();
    await middleware(request(jwt(gatewayAudience)), reply, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.json).toHaveBeenCalledWith({ error: 'authentication_failed' });
  });

  it('defensively rejects the reserved gateway subject on normal MCP auth', async () => {
    const middleware = bearerAuth(config, verifier);
    const reply = response(); const next = vi.fn();
    await middleware(request(jwt(mainAudience)), reply, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('rejects a managed key on the normal MCP lane even with a human assertion', async () => {
    const middleware = bearerAuth(config, verifier);
    const reply = response(); const next = vi.fn();
    await middleware(request(jwt(mainAudience, false), `Bearer chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}`), reply, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
