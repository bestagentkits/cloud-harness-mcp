import { describe, expect, it } from 'vitest';
import { InternalRunnerRequestSchema, OAuthClientRegistrationInputSchema, OAuthClientRegistrationResultSchema } from '../src/index.js';

const URI = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-e4a6f893e301cbbfc5ba7dab';

describe('Dashboard OAuth client registration contract', () => {
  it('accepts only a Gemini per-account callback', () => {
    expect(OAuthClientRegistrationInputSchema.parse({ client: 'gemini', redirectUri: URI })).toEqual({ client: 'gemini', redirectUri: URI });
    for (const input of [
      { client: 'gemini', redirectUri: 'https://oauth-redirect.googleusercontent.com/r/*' },
      { client: 'gemini', redirectUri: `${URI}?x=1` },
      { client: 'gemini', redirectUri: `${URI}/extra` },
      { client: 'gemini', redirectUri: 'http://oauth-redirect.googleusercontent.com/r/abc' },
      { client: 'gemini', redirectUri: 'https://oauth-redirect.googleusercontent.com.evil.example/r/abc' },
      { client: 'chatgpt', redirectUri: URI },
      { client: 'gemini', redirectUri: URI, tokenEndpointAuthMethod: 'none' }
    ]) {
      expect(OAuthClientRegistrationInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('describes a client_secret_post result and refuses extra fields', () => {
    const result = { client: 'gemini', clientId: 'c', clientSecret: 's', clientName: 'n', redirectUri: URI, tokenEndpointAuthMethod: 'client_secret_post' };
    expect(OAuthClientRegistrationResultSchema.safeParse(result).success).toBe(true);
    expect(OAuthClientRegistrationResultSchema.safeParse({ ...result, tokenEndpointAuthMethod: 'client_secret_basic' }).success).toBe(false);
    expect(OAuthClientRegistrationResultSchema.safeParse({ ...result, registrationAccessToken: 't' }).success).toBe(false);
  });

  it('is a strict internal runner operation', () => {
    const principal = { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' };
    expect(InternalRunnerRequestSchema.safeParse({ version: 2, principal, operation: 'oauth_client_register', input: { client: 'gemini', redirectUri: URI } }).success).toBe(true);
    expect(InternalRunnerRequestSchema.safeParse({ version: 2, principal, operation: 'oauth_client_register', input: { client: 'gemini', redirectUri: URI, extra: 1 } }).success).toBe(false);
  });
});
