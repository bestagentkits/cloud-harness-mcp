import { describe, expect, it } from 'vitest';
import { HarnessError } from '@cloud-harness/contracts';
import { allowlistAdmits, OAuthClientRegistrar } from '../src/oauth-client-registrar.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const REGISTRATION = `${ISSUER}/cdn-cgi/access/oauth/registration`;
const URI = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-e4a6f893e301cbbfc5ba7dab';
const SECRET = 'client-secret-value-' + 'q'.repeat(12);

type Call = { url: string; method: string; body?: Record<string, unknown> };

/** A Cloudflare Access team domain double: RFC 8414 metadata and an RFC 7591 registration endpoint. */
function fakeAccess(options: { registrationEndpoint?: string; postStatus?: number; postThrows?: boolean; answer?: (body: Record<string, unknown>) => unknown; rawPostBody?: BodyInit } = {}) {
  const calls: Call[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url: String(input), method, ...(body ? { body } : {}) });
    if (String(input) === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({ issuer: ISSUER, registration_endpoint: options.registrationEndpoint ?? REGISTRATION });
    }
    if (String(input) === (options.registrationEndpoint ?? REGISTRATION) && method === 'POST') {
      if (options.postThrows) throw new DOMException('timed out', 'TimeoutError');
      if (options.postStatus) return Response.json({ error: 'invalid_client_metadata', error_description: 'redirect_uri is not allowed' }, { status: options.postStatus });
      if (options.rawPostBody !== undefined) return new Response(options.rawPostBody, { status: 201, headers: { 'content-type': 'application/json' } });
      const answer = options.answer ?? ((sent: Record<string, unknown>) => ({ client_id: 'client-1', client_secret: SECRET, ...sent }));
      return Response.json(answer(body ?? {}), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { request, calls };
}

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).message).not.toContain(SECRET);
    return (error as HarnessError).details?.reason as string | undefined;
  }
  throw new Error('expected a refusal');
}

describe('OAuth client registration for Gemini', () => {
  it('registers a client_secret_post client for exactly the given callback and audits the client id only', async () => {
    const access = fakeAccess();
    const audits: Array<{ ownerId: string; action: string; details: Record<string, unknown> }> = [];
    const registrar = new OAuthClientRegistrar(ISSUER, async () => ['https://oauth-redirect.googleusercontent.com/r/*'], (ownerId, action, details) => audits.push({ ownerId, action, details }), access.request);
    const result = await registrar.register('owner-1', { client: 'gemini', redirectUri: URI });
    expect(result).toEqual({ client: 'gemini', clientId: 'client-1', clientSecret: SECRET, clientName: expect.any(String), redirectUri: URI, tokenEndpointAuthMethod: 'client_secret_post' });
    const post = access.calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe(REGISTRATION);
    expect(post.body).toMatchObject({ redirect_uris: [URI], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(audits).toEqual([{ ownerId: 'owner-1', action: 'oauth_client.registered', details: { client: 'gemini', clientId: 'client-1' } }]);
    expect(JSON.stringify(audits)).not.toContain(URI);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it('refuses before any request when unconfigured, unlisted, or not a Gemini callback', async () => {
    const access = fakeAccess();
    expect(await reason(new OAuthClientRegistrar(undefined, undefined, undefined, access.request).register('owner', { client: 'gemini', redirectUri: URI }))).toBe('oauth_client_not_configured');
    const unlisted = new OAuthClientRegistrar(ISSUER, async () => ['https://claude.ai/api/mcp/auth_callback'], undefined, access.request);
    expect(await reason(unlisted.register('owner', { client: 'gemini', redirectUri: URI }))).toBe('oauth_client_not_allowlisted');
    for (const redirectUri of ['https://evil.example/r/x', 'https://oauth-redirect.googleusercontent.com/other/x', `${URI}?next=1`, 'http://oauth-redirect.googleusercontent.com/r/x']) {
      await expect(unlisted.register('owner', { client: 'gemini', redirectUri }), redirectUri).rejects.toThrow();
    }
    expect(access.calls).toEqual([]);
  });

  it('lets Cloudflare decide when the allowlist cannot be read', async () => {
    const access = fakeAccess();
    const registrar = new OAuthClientRegistrar(ISSUER, async () => { throw new Error('provider down'); }, undefined, access.request);
    expect((await registrar.register('owner', { client: 'gemini', redirectUri: URI })).clientId).toBe('client-1');
  });

  it('never posts to a registration endpoint outside the team domain', async () => {
    const access = fakeAccess({ registrationEndpoint: 'https://attacker.example/register' });
    const registrar = new OAuthClientRegistrar(ISSUER, undefined, undefined, access.request);
    expect(await reason(registrar.register('owner', { client: 'gemini', redirectUri: URI }))).toBe('oauth_client_invalid_response');
    expect(access.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('maps refusals and unusable answers without exposing credentials', async () => {
    const register = (options: Parameters<typeof fakeAccess>[0]) => new OAuthClientRegistrar(ISSUER, undefined, undefined, fakeAccess(options).request).register('owner', { client: 'gemini', redirectUri: URI });
    expect(await reason(register({ postStatus: 400 }))).toBe('oauth_client_rejected');
    expect(await reason(register({ postThrows: true }))).toBe('oauth_client_unreachable');
    expect(await reason(register({ postStatus: 429 }))).toBe('oauth_client_throttled');
    // The cap counts bytes as they stream, so a multibyte or chunked body cannot slip past it.
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('é'.repeat(8_192))); }
    });
    expect(await reason(register({ rawPostBody: oversized }))).toBe('oauth_client_invalid_response');
    // A client registered with another auth method would fail Gemini's token exchange.
    expect(await reason(register({ answer: (sent) => ({ client_id: 'c', client_secret: SECRET, ...sent, token_endpoint_auth_method: 'client_secret_basic' }) }))).toBe('oauth_client_invalid_response');
    expect(await reason(register({ answer: (sent) => ({ client_id: 'c', client_secret: SECRET, ...sent, redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/other'] }) }))).toBe('oauth_client_invalid_response');
    expect(await reason(register({ answer: (sent) => ({ client_id: 'c', ...sent }) }))).toBe('oauth_client_invalid_response');
  });

  it('does not start a registration once the dashboard request is cancelled', async () => {
    const access = fakeAccess();
    const controller = new AbortController();
    const registrar = new OAuthClientRegistrar(ISSUER, async () => { controller.abort(); return null; }, undefined, access.request);
    expect(await reason(registrar.register('owner', { client: 'gemini', redirectUri: URI }, controller.signal))).toBe('oauth_client_cancelled');
    expect(access.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('matches allowlist entries exactly or by a trailing /* prefix', () => {
    expect(allowlistAdmits(['https://oauth-redirect.googleusercontent.com/r/*'], URI)).toBe(true);
    expect(allowlistAdmits([URI], URI)).toBe(true);
    expect(allowlistAdmits(['https://oauth-redirect.googleusercontent.com/x/*', 'https://chatgpt.com/*'], URI)).toBe(false);
  });
});
