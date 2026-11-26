import { apiClient } from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';

/**
 * Creates an OAuth client for the Gemini web app (`POST /settings/oauth/clients`). The rules
 * mirror `OAuthClientRegistrationInputSchema` and `OAuthClientRegistrationResultSchema`
 * (packages/contracts/src/oauth-client-registration.ts); the runner re-validates. The answer
 * carries the client secret, so it goes straight to the caller's one-time reveal and never
 * into a form, the query cache, or storage.
 */

export const GEMINI_REDIRECT_URI_PATTERN = /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/[A-Za-z0-9_-]{1,128}$/;
export const GEMINI_REDIRECT_URI_HINT = 'Paste the redirect URI from Gemini: https://oauth-redirect.googleusercontent.com/r/…';

export type GeminiClientCredentials = { clientId: string; clientSecret: string; redirectUri: string };

/** The error for the typed value, or `undefined` when it may be sent. */
export function geminiRedirectUriProblem(value: string): string | undefined {
  return GEMINI_REDIRECT_URI_PATTERN.test(value.trim()) ? undefined : GEMINI_REDIRECT_URI_HINT;
}

export async function createGeminiClient(redirectUri: string): Promise<GeminiClientCredentials> {
  const body = await apiClient.request<{ data?: { clientId?: unknown; clientSecret?: unknown; redirectUri?: unknown } }>(
    '/settings/oauth/clients',
    { method: 'POST', body: { client: 'gemini', redirectUri: redirectUri.trim() } }
  );
  const { clientId, clientSecret, redirectUri: registered } = body.data ?? {};
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret || registered !== redirectUri.trim()) {
    throw new ClientValidationError('The new client credentials were unavailable. Create another client.');
  }
  return { clientId, clientSecret, redirectUri: registered };
}
