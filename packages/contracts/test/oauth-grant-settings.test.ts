import { describe, expect, it } from 'vitest';
import {
  InternalRunnerRequestSchema,
  OAUTH_REDIRECT_URI_PRESETS,
  OAuthGrantSettingsUpdateInputSchema,
  OAuthRedirectUrisUpdateInputSchema,
  formatOAuthDuration,
  oauthRedirectUriProblem,
  parseOAuthDurationSeconds
} from '../src/index.js';

describe('OAuth grant duration parsing', () => {
  it('reads the Go durations a provider returns', () => {
    expect(parseOAuthDurationSeconds('15m')).toBe(900);
    expect(parseOAuthDurationSeconds('720h')).toBe(2_592_000);
    expect(parseOAuthDurationSeconds('2h45m')).toBe(9_900);
    expect(parseOAuthDurationSeconds('24h0m0s')).toBe(86_400);
    expect(parseOAuthDurationSeconds('1.5h')).toBe(5_400);
    expect(parseOAuthDurationSeconds('0')).toBe(0);
  });

  it('treats anything else as unknown instead of guessing', () => {
    for (const value of ['', '15', '15 minutes', 'h', '1d', '-5m', '5m junk', 42, null, undefined, 'x'.repeat(65)]) {
      expect(parseOAuthDurationSeconds(value), String(value)).toBeUndefined();
    }
  });

  it('formats whole seconds as the shortest provider duration and round-trips', () => {
    expect(formatOAuthDuration(2_592_000)).toBe('720h');
    expect(formatOAuthDuration(900)).toBe('15m');
    expect(formatOAuthDuration(5_400)).toBe('1h30m');
    expect(formatOAuthDuration(0)).toBe('0s');
    for (const seconds of [60, 3_600, 86_400, 604_800, 1_209_600, 9_999]) {
      expect(parseOAuthDurationSeconds(formatOAuthDuration(seconds))).toBe(seconds);
    }
  });
});

describe('OAuth grant settings update input', () => {
  const revision = 'a'.repeat(64);

  it('accepts the provider maximum and bounded custom grants', () => {
    expect(OAuthGrantSettingsUpdateInputSchema.parse({ grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: revision }))
      .toEqual({ grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: revision });
    expect(OAuthGrantSettingsUpdateInputSchema.parse({ grant: { mode: 'custom', seconds: 604_800 }, tokenLifetimeSeconds: 300, expectedRevision: null }).grant)
      .toEqual({ mode: 'custom', seconds: 604_800 });
  });

  it('rejects out-of-bounds, fractional, unknown, and unbounded values', () => {
    for (const input of [
      { grant: { mode: 'custom', seconds: 59 }, tokenLifetimeSeconds: 900, expectedRevision: revision },
      { grant: { mode: 'custom', seconds: 315_360_001 }, tokenLifetimeSeconds: 900, expectedRevision: revision },
      { grant: { mode: 'custom', seconds: 3_600.5 }, tokenLifetimeSeconds: 900, expectedRevision: revision },
      { grant: { mode: 'forever' }, tokenLifetimeSeconds: 900, expectedRevision: revision },
      { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 30, expectedRevision: revision },
      { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 86_401, expectedRevision: revision },
      { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: 'stale' },
      { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 },
      { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: revision, apiToken: 'x' }
    ]) {
      expect(OAuthGrantSettingsUpdateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('is a strict internal runner operation', () => {
    const principal = { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' };
    expect(InternalRunnerRequestSchema.safeParse({ version: 2, principal, operation: 'oauth_settings_get', input: {} }).success).toBe(true);
    expect(InternalRunnerRequestSchema.safeParse({ version: 2, principal, operation: 'oauth_settings_get', input: { extra: 1 } }).success).toBe(false);
    expect(InternalRunnerRequestSchema.safeParse({
      version: 2, principal, operation: 'oauth_settings_update',
      input: { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: null }
    }).success).toBe(true);
  });
});

describe('OAuth redirect URI allowlist', () => {
  it('accepts every preset and exact or path-scoped callbacks', () => {
    for (const uri of [
      ...OAUTH_REDIRECT_URI_PRESETS.flatMap((preset) => preset.uris),
      'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1c0d36c88983d5e09b17fcee',
      'https://client.example/oauth/callback',
      'http://localhost/*',
      'https://Client.Example/cb',
      'http://127.0.0.1:3118/callback/*'
    ]) {
      expect(oauthRedirectUriProblem(uri), uri).toBeNull();
    }
  });

  it('refuses callbacks that could deliver codes beyond the intended client', () => {
    for (const uri of [
      '',
      'not a url',
      'https:client.example/cb',
      'https:///client.example/cb',
      'https://client.example/cb\u0001',
      'https:\\\\client.example\\cb',
      'https://client.example/a\\b',
      'http://127.1/cb',
      'http://0x7f.0.0.1/cb',
      'https://client%2Eexample/cb',
      'http://[::1]:8080/callback',
      'https://client.example/oauth/callback?tenant=a',
      'https://client.example/cb?token=secret',
      'https://client.example/a@b/cb',
      'client.example/callback',
      'http://client.example/callback',
      'ftp://client.example/callback',
      'javascript:alert(1)',
      'https://user:pass@client.example/callback',
      'https://client.example/callback#frag',
      'https://client.example/*',
      'https://*.client.example/callback',
      'https://client.example/*/callback',
      'https://client.example/callback*',
      'https://client.example/cb?next=/*',
      ' https://client.example/callback',
      `https://client.example/${'a'.repeat(2_048)}`
    ]) {
      expect(oauthRedirectUriProblem(uri), uri).not.toBeNull();
    }
  });

  it('is a strict, bounded internal runner operation', () => {
    const principal = { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' };
    const input = { uris: ['https://oauth-redirect.googleusercontent.com/r/*'], expectedRevision: 'a'.repeat(64) };
    expect(InternalRunnerRequestSchema.safeParse({ version: 2, principal, operation: 'oauth_redirect_uris_update', input }).success).toBe(true);
    for (const invalid of [
      { ...input, apiToken: 'x' },
      { uris: input.uris },
      { ...input, uris: Array.from({ length: 129 }, (_, index) => `https://c${index}.example/cb`) },
      { ...input, uris: 'https://client.example/cb' }
    ]) {
      expect(OAuthRedirectUrisUpdateInputSchema.safeParse(invalid).success, JSON.stringify(invalid).slice(0, 80)).toBe(false);
    }
  });
});
