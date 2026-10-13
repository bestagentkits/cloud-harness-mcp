import { describe, expect, it } from 'vitest';
import { HarnessError } from '@cloud-harness/contracts';
import { CloudflareAccessOAuthProvider } from '../src/cloudflare-access-oauth-provider.js';

const TOKEN = 'cf-test-token-' + 'z'.repeat(32);
const config = {
  apiToken: TOKEN,
  accountId: '0123456789abcdef0123456789abcdef',
  appId: '11111111-2222-4333-8444-555555555555',
  access: 'read-write' as const
};
const APP_URL = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/access/apps/${config.appId}`;

function application(grant: Record<string, unknown> | null = { access_token_lifetime: '15m' }) {
  return {
    id: config.appId,
    uid: config.appId,
    aud: 'aud-tag',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    type: 'self_hosted',
    name: 'Cloud Harness MCP',
    domain: 'harness.example.com/mcp',
    // Fields a self-hosted application GET also returns; a write must echo them unchanged.
    self_hosted_domains: ['harness.example.com/mcp'],
    destinations: [{ type: 'public', uri: 'harness.example.com/mcp' }],
    allowed_idps: ['idp-1'],
    auto_redirect_to_identity: false,
    app_launcher_visible: false,
    tags: ['cloud-harness'],
    cors_headers: { allowed_methods: ['GET', 'POST'], allowed_origins: ['https://claude.ai'], max_age: 600 },
    session_duration: '24h',
    policies: [{ id: 'policy-1', precedence: 1, name: 'Owner', decision: 'allow', include: [{ email: { email: 'owner@example.com' } }] }],
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: { enabled: true, allow_any_on_localhost: true },
      ...(grant ? { grant } : {})
    }
  };
}

type Call = { method: string; url: string; body?: Record<string, unknown>; authorization?: string };

/** An in-memory Access application behind the Cloudflare API shape. */
function fakeCloudflare(initial: Record<string, unknown>, options: { putStatus?: number; putThrows?: boolean; ignorePut?: boolean; getStatus?: number; failGetAfterPut?: boolean } = {}) {
  let stored: Record<string, unknown> = structuredClone(initial);
  const calls: Call[] = [];
  let putDone = false;
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, url: String(input), ...(body ? { body } : {}), authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    if (String(input) !== APP_URL) return new Response('{}', { status: 404 });
    if (method === 'PUT') {
      if (options.putThrows) throw new DOMException('timed out', 'TimeoutError');
      if (options.putStatus) return new Response(JSON.stringify({ success: false, errors: [{ message: `secret detail ${TOKEN}` }] }), { status: options.putStatus });
      putDone = true;
      if (!options.ignorePut) stored = { ...stored, ...body, updated_at: '2026-02-01T00:00:00Z' };
      return Response.json({ success: true, result: stored });
    }
    if (options.getStatus) return new Response('{}', { status: options.getStatus });
    if (putDone && options.failGetAfterPut) throw new TypeError('network down');
    return Response.json({ success: true, result: stored });
  }) as typeof fetch;
  return { request, calls, current: () => stored, replace: (next: Record<string, unknown>) => { stored = next; } };
}

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).message).not.toContain(TOKEN);
    return (error as HarnessError).details?.reason;
  }
  throw new Error('expected a provider error');
}

describe('Cloudflare Access Managed OAuth provider', () => {
  it('reads the effective grant and token lifetime with the runner-only bearer', async () => {
    const cloudflare = fakeCloudflare(application({ session_duration: '336h', access_token_lifetime: '15m' }));
    const provider = new CloudflareAccessOAuthProvider(config, cloudflare.request);
    const snapshot = await provider.read();
    expect(snapshot).toMatchObject({ oauthEnabled: true, grantSeconds: 1_209_600, grantExplicitlyConfigured: true, tokenLifetimeSeconds: 900, unsupportedReason: null });
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(cloudflare.calls).toEqual([{ method: 'GET', url: APP_URL, authorization: `Bearer ${TOKEN}` }]);
    expect(provider.maxGrantSeconds).toBe(2_592_000);
  });

  it('reports an unset grant as provider default rather than a guessed value', async () => {
    const provider = new CloudflareAccessOAuthProvider(config, fakeCloudflare(application(null)).request);
    expect(await provider.read()).toMatchObject({ grantSeconds: null, grantExplicitlyConfigured: false, tokenLifetimeSeconds: null });
  });

  it('writes a minimal diff: only the two grant fields change, policies stay referenced, server fields are dropped', async () => {
    const initial = application({ session_duration: '24h', access_token_lifetime: '15m' });
    const cloudflare = fakeCloudflare(initial);
    const provider = new CloudflareAccessOAuthProvider(config, cloudflare.request);
    const before = await provider.read();
    const after = await provider.write({ grantSeconds: 2_592_000, tokenLifetimeSeconds: 600 }, before.revision);
    expect(after).toMatchObject({ grantSeconds: 2_592_000, tokenLifetimeSeconds: 600 });
    expect(after.revision).not.toBe(before.revision);
    expect(cloudflare.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'PUT', 'GET']);
    const put = cloudflare.calls.find((call) => call.method === 'PUT')!.body!;
    const omit = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    const { policies, oauth_configuration: oauth } = put as Record<string, unknown>;
    expect(omit(put, ['policies', 'oauth_configuration'])).toEqual(omit(initial, ['id', 'uid', 'aud', 'created_at', 'updated_at', 'policies', 'oauth_configuration']));
    expect(policies).toEqual([{ id: 'policy-1', precedence: 1 }]);
    expect(oauth).toEqual({
      ...initial.oauth_configuration,
      grant: { session_duration: '720h', access_token_lifetime: '10m' }
    });
    for (const field of ['id', 'uid', 'aud', 'created_at', 'updated_at']) expect(put).not.toHaveProperty(field);
  });

  it('refuses to overwrite a configuration that changed since the caller read it', async () => {
    const cloudflare = fakeCloudflare(application({ session_duration: '24h' }));
    const provider = new CloudflareAccessOAuthProvider(config, cloudflare.request);
    const seen = await provider.read();
    cloudflare.replace(application({ session_duration: '48h' }));
    expect(await reason(provider.write({ grantSeconds: 86_400 * 7, tokenLifetimeSeconds: 900 }, seen.revision))).toBe('revision_conflict');
    expect(cloudflare.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('fails closed when the provider does not confirm the write on read-back', async () => {
    const ignored = fakeCloudflare(application(), { ignorePut: true });
    const provider = new CloudflareAccessOAuthProvider(config, ignored.request);
    const seen = await provider.read();
    expect(await reason(provider.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, seen.revision))).toBe('readback_mismatch');

    const lost = fakeCloudflare(application(), { failGetAfterPut: true });
    const second = new CloudflareAccessOAuthProvider(config, lost.request);
    const seenAgain = await second.read();
    expect(await reason(second.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, seenAgain.revision))).toBe('readback_mismatch');
  });

  it('maps provider failures to credential-free reasons', async () => {
    expect(await reason(new CloudflareAccessOAuthProvider(config, fakeCloudflare(application(), { getStatus: 403 }).request).read())).toBe('provider_permission_denied');
    expect(await reason(new CloudflareAccessOAuthProvider(config, fakeCloudflare(application(), { getStatus: 404 }).request).read())).toBe('provider_application_not_found');
    expect(await reason(new CloudflareAccessOAuthProvider(config, fakeCloudflare(application(), { getStatus: 500 }).request).read())).toBe('provider_unreachable');
    expect(await reason(new CloudflareAccessOAuthProvider(config, (async () => { throw new TypeError('offline'); }) as typeof fetch).read())).toBe('provider_unreachable');
    expect(await reason(new CloudflareAccessOAuthProvider(config, (async () => new Response('not json')) as typeof fetch).read())).toBe('provider_invalid_response');
    // A PUT that fails in transit or with a server error may still have landed, so it is never reported as unchanged.
    for (const [status, expected] of [[403, 'provider_write_denied'], [400, 'provider_rejected'], [422, 'provider_rejected'], [500, 'write_unconfirmed']] as const) {
      const cloudflare = fakeCloudflare(application(), { putStatus: status });
      const provider = new CloudflareAccessOAuthProvider(config, cloudflare.request);
      const seen = await provider.read();
      expect(await reason(provider.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, seen.revision))).toBe(expected);
    }
    const timedOut = new CloudflareAccessOAuthProvider(config, fakeCloudflare(application(), { putThrows: true }).request);
    expect(await reason(timedOut.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, (await timedOut.read()).revision))).toBe('write_unconfirmed');
  });

  it('never writes when read-only, disabled, or holding state a PUT cannot round-trip', async () => {
    const readOnly = fakeCloudflare(application());
    const readOnlyProvider = new CloudflareAccessOAuthProvider({ ...config, access: 'read-only' }, readOnly.request);
    expect(readOnlyProvider.canWrite).toBe(false);
    expect(await reason(readOnlyProvider.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, null))).toBe('provider_read_only');
    expect(readOnly.calls).toEqual([]);

    const disabled = application();
    disabled.oauth_configuration.enabled = false;
    const disabledCloudflare = fakeCloudflare(disabled);
    const disabledProvider = new CloudflareAccessOAuthProvider(config, disabledCloudflare.request);
    expect(await reason(disabledProvider.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, (await disabledProvider.read()).revision))).toBe('managed_oauth_disabled');

    const scim = { ...application(), scim_config: { enabled: true, remote_uri: 'https://scim.example.com' } };
    const scimCloudflare = fakeCloudflare(scim);
    const scimProvider = new CloudflareAccessOAuthProvider(config, scimCloudflare.request);
    const scimSnapshot = await scimProvider.read();
    expect(scimSnapshot.unsupportedReason).toBe('provider_unsupported_application');
    expect(await reason(scimProvider.write({ grantSeconds: 86_400, tokenLifetimeSeconds: 900 }, scimSnapshot.revision))).toBe('provider_unsupported_application');

    const saas = fakeCloudflare({ ...application(), type: 'saas' });
    expect((await new CloudflareAccessOAuthProvider(config, saas.request).read()).unsupportedReason).toBe('provider_unsupported_application');
    const untyped: Record<string, unknown> = application();
    delete untyped.type;
    const unknownType = fakeCloudflare(untyped);
    expect((await new CloudflareAccessOAuthProvider(config, unknownType.request).read()).unsupportedReason).toBe('provider_unsupported_application');
    for (const cloudflare of [disabledCloudflare, scimCloudflare, saas, unknownType]) expect(cloudflare.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('honours an operator-configured provider maximum', () => {
    expect(new CloudflareAccessOAuthProvider({ ...config, maxGrantSeconds: 1_209_600 }).maxGrantSeconds).toBe(1_209_600);
  });
});
