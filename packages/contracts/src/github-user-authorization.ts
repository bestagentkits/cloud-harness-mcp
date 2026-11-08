import { z } from 'zod';

/**
 * Where a GitHub credential for one repository operation came from. It is reported in clone
 * failures and recorded in `github_action` audit details, never the credential itself.
 *
 * - `github-app`: an installation token minted from the principal's own GitHub App binding.
 * - `github-user`: the principal's GitHub App user access token. Once selected it is final: a
 *   refusal never switches to another source.
 * - `principal-global-secret`: the principal's own `GH_TOKEN` or `GITHUB_TOKEN` global secret.
 * - `runner-environment`: the operator-wide environment credential (single-owner mode only).
 * - `none`: no credential was used.
 */
export const GITHUB_CREDENTIAL_SOURCES = ['github-app', 'github-user', 'principal-global-secret', 'runner-environment', 'none'] as const;
export const GitHubCredentialSourceSchema = z.enum(GITHUB_CREDENTIAL_SOURCES);
export type GitHubCredentialSource = z.infer<typeof GitHubCredentialSourceSchema>;

/**
 * `connected`: a stored token pair; the user token lane is selected and final.
 * `revoked`: GitHub refused the refresh; every credential-needing operation answers
 * `GITHUB_USER_AUTHORIZATION_REQUIRED`, even when a fallback secret exists.
 * `disconnected`: the user chose Disconnect; the legacy fallback lane is eligible again.
 * Only an explicit Disconnect moves `revoked` to `disconnected`, and only a successful `user`
 * authorization moves either back to `connected`.
 */
export const GITHUB_USER_AUTHORIZATION_STATUSES = ['connected', 'revoked', 'disconnected'] as const;
export const GitHubUserAuthorizationStatusSchema = z.enum(GITHUB_USER_AUTHORIZATION_STATUSES);
export type GitHubUserAuthorizationStatus = z.infer<typeof GitHubUserAuthorizationStatusSchema>;

/**
 * Why a user authorization was revoked. `bad_refresh_token`: GitHub refused the refresh token (the
 * user revoked the App, the token was already used, or it expired). `refresh_token_expired`: the
 * stored refresh token passed its recorded expiry.
 */
export const GITHUB_USER_AUTHORIZATION_REASON_CODES = ['bad_refresh_token', 'refresh_token_expired'] as const;
export const GitHubUserAuthorizationReasonCodeSchema = z.enum(GITHUB_USER_AUTHORIZATION_REASON_CODES);
export type GitHubUserAuthorizationReasonCode = z.infer<typeof GitHubUserAuthorizationReasonCodeSchema>;

/**
 * The principal's GitHub user authorization as `github_status` reports it. It carries no token,
 * no ciphertext and no generation: only what the dashboard shows and the policy keys on.
 * `refreshExpiresAt` (epoch milliseconds) is when the stored refresh token stops working, so the
 * authorization needs reconnecting after it; it is `null` unless the status is `connected`.
 */
export const GitHubUserAuthorizationViewSchema = z.object({
  status: GitHubUserAuthorizationStatusSchema,
  login: z.string().min(1).max(100),
  githubUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  refreshExpiresAt: z.number().int().nonnegative().nullable(),
  reasonCode: GitHubUserAuthorizationReasonCodeSchema.nullable()
}).strict();
export type GitHubUserAuthorizationView = z.infer<typeof GitHubUserAuthorizationViewSchema>;

/**
 * The `github_status` result. `userAuthorization` is `null` while the principal has never
 * authorized a GitHub user; a principal that disconnected keeps a `disconnected` entry.
 */
export const GitHubStatusResultSchema = z.object({
  configured: z.boolean(),
  userAuthorizationConfigured: z.boolean(),
  installations: z.array(z.record(z.string(), z.unknown())),
  installation: z.record(z.string(), z.unknown()).nullable(),
  repositories: z.array(z.record(z.string(), z.unknown())),
  userAuthorization: GitHubUserAuthorizationViewSchema.nullable()
}).strict();
export type GitHubStatusResult = z.infer<typeof GitHubStatusResultSchema>;

/** Where a person manages the connection; named by `GITHUB_USER_AUTHORIZATION_REQUIRED`. */
export const GITHUB_USER_AUTHORIZATION_DASHBOARD_PATH = 'Dashboard → Integrations → GitHub → GitHub user';
