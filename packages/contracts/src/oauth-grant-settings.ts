import { z } from 'zod';

/**
 * Inbound MCP OAuth session settings (client -> Cloud Harness). Three lifetimes
 * are independent and must not be conflated:
 *
 * - the OAuth access-token lifetime, which stays short and is refreshed silently;
 * - the OAuth grant (refresh-token) session duration, which decides how long a
 *   client keeps working without an interactive sign-in;
 * - the provider's browser session, which this contract does not touch.
 *
 * The provider is the authority for the effective values. Cloud Harness reads
 * them through a runner-only credential, writes a minimal diff, and reports
 * only what the provider returns on read-back.
 */

export const OAuthProviderIdSchema = z.enum(['none', 'cloudflare-access']);
export type OAuthProviderId = z.infer<typeof OAuthProviderIdSchema>;

/** Longest grant any provider adapter may request: ten years, in seconds. */
export const OAUTH_GRANT_SECONDS_CEILING = 315_360_000;
export const OAUTH_GRANT_SECONDS_FLOOR = 3_600;
export const OAUTH_TOKEN_LIFETIME_SECONDS_FLOOR = 60;
export const OAUTH_TOKEN_LIFETIME_SECONDS_CEILING = 3_600;

const GO_DURATION_UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  'µs': 1e-6,
  'μs': 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3_600
};

/**
 * Parse a Go-style duration (`15m`, `720h`, `2h45m`, `24h0m0s`) as the provider
 * returns it. Returns whole seconds, or `undefined` for anything else, so an
 * unexpected provider value is shown as unknown rather than guessed.
 */
export function parseOAuthDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '0') return 0;
  if (text.length === 0 || text.length > 64) return undefined;
  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gy;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== consumed) return undefined;
    total += Number(match[1]) * GO_DURATION_UNIT_SECONDS[match[2]!]!;
    consumed += match[0].length;
  }
  if (consumed !== text.length || !Number.isFinite(total)) return undefined;
  return Math.floor(total);
}

/** Format whole seconds as the shortest Go duration a provider accepts (`720h`, `15m`, `1h30m`). */
export function formatOAuthDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const rest = whole % 60;
  const parts = [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', rest ? `${rest}s` : ''].join('');
  return parts || '0s';
}

export const OAuthGrantSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('provider-maximum') }).strict(),
  z.object({
    mode: z.literal('custom'),
    seconds: z.number().int().min(OAUTH_GRANT_SECONDS_FLOOR).max(OAUTH_GRANT_SECONDS_CEILING)
  }).strict()
]);
export type OAuthGrantSelection = z.infer<typeof OAuthGrantSelectionSchema>;

/**
 * A Dashboard save. `expectedRevision` is the provider fingerprint the operator
 * last saw; a mismatch means the provider changed underneath and the save is
 * refused instead of overwriting it. `null` is accepted only when the provider
 * reported no fingerprint.
 */
export const OAuthGrantSettingsUpdateInputSchema = z.object({
  grant: OAuthGrantSelectionSchema,
  tokenLifetimeSeconds: z.number().int().min(OAUTH_TOKEN_LIFETIME_SECONDS_FLOOR).max(OAUTH_TOKEN_LIFETIME_SECONDS_CEILING),
  expectedRevision: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.null()])
}).strict();
export type OAuthGrantSettingsUpdateInput = z.infer<typeof OAuthGrantSettingsUpdateInputSchema>;

/** What the configured provider lets Cloud Harness do. The Dashboard renders only supported controls. */
export const OAuthProviderCapabilitiesSchema = z.object({
  canReadGrantConfiguration: z.boolean(),
  canWriteGrantConfiguration: z.boolean(),
  supportsUnboundedGrant: z.boolean(),
  maxGrantSeconds: z.number().int().positive().nullable(),
  minGrantSeconds: z.number().int().positive(),
  grantPresetsSeconds: z.array(z.number().int().positive()).max(12),
  tokenLifetime: z.object({
    minSeconds: z.number().int().positive(),
    maxSeconds: z.number().int().positive(),
    defaultSeconds: z.number().int().positive()
  }).strict()
}).strict();
export type OAuthProviderCapabilities = z.infer<typeof OAuthProviderCapabilitiesSchema>;

export const OAuthManagementStateSchema = z.enum([
  /** No provider integration is configured; nothing is read or written. */
  'unconfigured',
  /** The provider value was set outside Cloud Harness and is left alone. */
  'unmanaged',
  /** Cloud Harness applied the current value and the provider still reports it. */
  'managed',
  /** Cloud Harness applied a value, but the provider now reports something else. */
  'drifted'
]);
export type OAuthManagementState = z.infer<typeof OAuthManagementStateSchema>;

export const OAuthGrantSettingsViewSchema = z.object({
  provider: z.object({ id: OAuthProviderIdSchema, label: z.string().max(120) }).strict(),
  capabilities: OAuthProviderCapabilitiesSchema,
  effective: z.object({
    oauthEnabled: z.boolean(),
    grantSeconds: z.number().int().nonnegative().nullable(),
    /** True when the provider holds a grant value, even one Cloud Harness cannot parse. */
    grantExplicitlyConfigured: z.boolean(),
    grantIsProviderMaximum: z.boolean(),
    tokenLifetimeSeconds: z.number().int().nonnegative().nullable()
  }).strict().nullable(),
  management: z.object({
    state: OAuthManagementStateSchema,
    desired: z.object({
      grant: OAuthGrantSelectionSchema,
      tokenLifetimeSeconds: z.number().int().positive()
    }).strict().nullable(),
    updatedAt: z.string().datetime().nullable(),
    /** Who applied the managed value: a Dashboard save, or the first-start provider-maximum default. */
    updatedBy: z.enum(['dashboard', 'startup-default']).nullable()
  }).strict(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  lastSync: z.object({
    at: z.string().datetime(),
    ok: z.boolean(),
    errorCode: z.string().max(64).nullable()
  }).strict().nullable(),
  readOnlyReason: z.string().max(400).nullable()
}).strict();
export type OAuthGrantSettingsView = z.infer<typeof OAuthGrantSettingsViewSchema>;
