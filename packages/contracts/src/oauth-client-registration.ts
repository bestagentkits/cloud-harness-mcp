import { z } from 'zod';

/**
 * A Dashboard-created OAuth client for an MCP client whose own Dynamic Client
 * Registration against Cloudflare Access Managed OAuth fails. Gemini is the only
 * such client today: its callback is per Google account, and it sends the client
 * secret in the token request body, so the client is always registered with
 * `client_secret_post` for exactly one redirect URI.
 */

/** Gemini's per-account callback, as its "Copy redirect URI" button gives it. */
export const GEMINI_REDIRECT_URI_PATTERN = /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/[A-Za-z0-9_-]{1,128}$/;

export const OAuthClientRegistrationInputSchema = z.object({
  client: z.literal('gemini'),
  redirectUri: z.string().max(200).regex(GEMINI_REDIRECT_URI_PATTERN, 'Paste the redirect URI from Gemini: https://oauth-redirect.googleusercontent.com/r/…')
}).strict();
export type OAuthClientRegistrationInput = z.infer<typeof OAuthClientRegistrationInputSchema>;

/**
 * The one answer that carries the client secret. It is shown once and never
 * stored, logged, audited, or cached by Cloud Harness.
 */
export const OAuthClientRegistrationResultSchema = z.object({
  client: z.literal('gemini'),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(512),
  clientName: z.string().max(120),
  redirectUri: z.string().max(200).regex(GEMINI_REDIRECT_URI_PATTERN),
  tokenEndpointAuthMethod: z.literal('client_secret_post')
}).strict();
export type OAuthClientRegistrationResult = z.infer<typeof OAuthClientRegistrationResultSchema>;
