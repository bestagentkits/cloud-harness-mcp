import { z } from 'zod';

/**
 * Inbound MCP OAuth session settings (`GET/POST /settings/oauth`). The provider is the
 * authority for every effective value; the answer is an unmapped runner passthrough (parity
 * matrix F7), so `readOAuthView` keeps only the known fields of
 * `OAuthGrantSettingsViewSchema` (packages/contracts/src/oauth-grant-settings.ts) and the
 * form renders only the controls the provider's capabilities allow.
 */

export type OAuthManagementState = 'unconfigured' | 'unmanaged' | 'managed' | 'drifted';
export type OAuthGrantSelection = { mode: 'provider-maximum' } | { mode: 'custom'; seconds: number };

export type OAuthView = {
  provider: { id: string; label: string };
  capabilities: {
    canWriteGrantConfiguration: boolean;
    supportsUnboundedGrant: boolean;
    maxGrantSeconds: number | null;
    minGrantSeconds: number;
    grantPresetsSeconds: number[];
    tokenLifetime: { minSeconds: number; maxSeconds: number; defaultSeconds: number };
  };
  effective: {
    grantSeconds: number | null;
    grantExplicitlyConfigured: boolean;
    grantIsProviderMaximum: boolean;
    tokenLifetimeSeconds: number | null;
  } | null;
  management: {
    state: OAuthManagementState | undefined;
    desired: { grant: OAuthGrantSelection; tokenLifetimeSeconds: number | undefined } | null;
    updatedAt: string | null;
    updatedBy: 'dashboard' | 'startup-default' | null;
  };
  revision: string | null;
  lastSync: { at: string; ok: boolean; errorCode: string | null } | null;
  readOnlyReason: string | null;
};

export type OAuthValues = { persistent: boolean; grant?: string | undefined; customHours?: string | undefined; tokenMinutes?: string | undefined };
export type OAuthErrors = Partial<Record<keyof OAuthValues, string>>;
export type OAuthUpdate = { grant: OAuthGrantSelection; tokenLifetimeSeconds: number; expectedRevision: string | null };

export const CUSTOM_GRANT = 'custom';
const DEFAULT_TOKEN_LIFETIME = { minSeconds: 60, maxSeconds: 3_600, defaultSeconds: 900 };
const MANAGEMENT_STATES: readonly OAuthManagementState[] = ['unconfigured', 'unmanaged', 'managed', 'drifted'];

export const MANAGEMENT_LABELS: Record<OAuthManagementState, string> = {
  unconfigured: 'Not managed by Cloud Harness (no provider integration)',
  unmanaged: 'Set outside Cloud Harness; left unchanged',
  managed: 'Managed by Cloud Harness',
  drifted: 'Changed outside Cloud Harness since the last save'
};

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const nonNegativeIntOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value ? value.slice(0, max) : null);

function readGrant(raw: unknown): OAuthGrantSelection | undefined {
  const grant = record(raw);
  if (grant?.mode === 'provider-maximum') return { mode: 'provider-maximum' };
  if (grant?.mode === 'custom' && positiveInt(grant.seconds)) return { mode: 'custom', seconds: grant.seconds };
  return undefined;
}

/** The known fields of the view, or `undefined` when the answer is not a settings view at all. */
export function readOAuthView(raw: unknown): OAuthView | undefined {
  const view = record(raw);
  const capabilities = record(view?.capabilities);
  if (!view || !capabilities) return undefined;
  const provider = record(view.provider) ?? {};
  const token = record(capabilities.tokenLifetime);
  const tokenLifetime = token && positiveInt(token.minSeconds) && positiveInt(token.maxSeconds) && positiveInt(token.defaultSeconds) && token.minSeconds <= token.maxSeconds
    ? { minSeconds: token.minSeconds, maxSeconds: token.maxSeconds, defaultSeconds: token.defaultSeconds }
    : DEFAULT_TOKEN_LIFETIME;
  const effective = record(view.effective);
  const management = record(view.management) ?? {};
  const desired = record(management.desired);
  const desiredGrant = readGrant(desired?.grant);
  const lastSync = record(view.lastSync);
  return {
    provider: { id: typeof provider.id === 'string' ? provider.id : 'none', label: text(provider.label, 120) ?? 'Not configured' },
    capabilities: {
      canWriteGrantConfiguration: capabilities.canWriteGrantConfiguration === true,
      supportsUnboundedGrant: capabilities.supportsUnboundedGrant === true,
      maxGrantSeconds: positiveInt(capabilities.maxGrantSeconds) ? capabilities.maxGrantSeconds : null,
      minGrantSeconds: positiveInt(capabilities.minGrantSeconds) ? capabilities.minGrantSeconds : 3_600,
      grantPresetsSeconds: Array.isArray(capabilities.grantPresetsSeconds) ? capabilities.grantPresetsSeconds.filter(positiveInt).slice(0, 12) : [],
      tokenLifetime
    },
    effective: effective
      ? {
        grantSeconds: nonNegativeIntOrNull(effective.grantSeconds),
        grantExplicitlyConfigured: effective.grantExplicitlyConfigured === true,
        grantIsProviderMaximum: effective.grantIsProviderMaximum === true,
        tokenLifetimeSeconds: nonNegativeIntOrNull(effective.tokenLifetimeSeconds)
      }
      : null,
    management: {
      state: MANAGEMENT_STATES.find((state) => state === management.state),
      desired: desiredGrant ? { grant: desiredGrant, tokenLifetimeSeconds: positiveInt(desired?.tokenLifetimeSeconds) ? desired.tokenLifetimeSeconds : undefined } : null,
      updatedAt: text(management.updatedAt, 64),
      updatedBy: management.updatedBy === 'dashboard' || management.updatedBy === 'startup-default' ? management.updatedBy : null
    },
    revision: typeof view.revision === 'string' && /^[a-f0-9]{64}$/.test(view.revision) ? view.revision : null,
    lastSync: lastSync && typeof lastSync.at === 'string'
      ? { at: lastSync.at, ok: lastSync.ok === true, errorCode: text(lastSync.errorCode, 64) }
      : null,
    readOnlyReason: text(view.readOnlyReason, 400)
  };
}

/** Human duration for OAuth lifetimes: whole days, then hours, then minutes. */
export function oauthDurationLabel(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Unknown';
  const plural = (amount: number, unit: string) => `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds >= 3_600 && seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

/** "until revoked" only when the provider supports it; a bounded provider never claims forever. */
export function maximumLabel(view: OAuthView): string {
  const { supportsUnboundedGrant, maxGrantSeconds } = view.capabilities;
  if (supportsUnboundedGrant) return 'until revoked';
  return maxGrantSeconds ? oauthDurationLabel(maxGrantSeconds) : 'provider maximum';
}

export function grantFact(view: OAuthView): string {
  const { effective } = view;
  if (!effective) return 'Not available';
  if (effective.grantSeconds === null) return effective.grantExplicitlyConfigured ? 'Set in the provider (format not recognised)' : 'Provider default (not set explicitly)';
  return `${oauthDurationLabel(effective.grantSeconds)}${effective.grantIsProviderMaximum ? ' — provider maximum' : ''}`;
}

export function tokenFact(view: OAuthView): string {
  if (!view.effective) return 'Not available';
  return view.effective.tokenLifetimeSeconds === null ? 'Provider default' : oauthDurationLabel(view.effective.tokenLifetimeSeconds);
}

/** Adopting the default is offered only when the provider value is not the one Cloud Harness applied. */
export function canAdoptDefault(view: OAuthView): boolean {
  return view.management.state === 'unmanaged' || view.management.state === 'drifted';
}

/** The form's initial values: the desired selection when Cloud Harness manages it, else the provider read-back. */
export function oauthDefaults(view: OAuthView): OAuthValues {
  const { capabilities, effective, management } = view;
  const desired = management.desired;
  const persistent = desired
    ? desired.grant.mode === 'provider-maximum'
    : (effective?.grantIsProviderMaximum ?? true) || (management.state === 'unmanaged' && effective?.grantSeconds === null);
  const currentSeconds = desired?.grant.mode === 'custom' ? desired.grant.seconds : effective?.grantSeconds ?? null;
  const presets = capabilities.grantPresetsSeconds;
  const presetSelected = !persistent && currentSeconds !== null && presets.includes(currentSeconds);
  const customSelected = !persistent && !presetSelected;
  // With "stay signed in" on, the (disabled) select shows its first option, as a native select does.
  const grant = presetSelected ? String(currentSeconds) : customSelected ? CUSTOM_GRANT : String(presets[0] ?? CUSTOM_GRANT);
  const customHours = customSelected && currentSeconds ? Math.round(currentSeconds / 3_600) : 24;
  const bounds = capabilities.tokenLifetime;
  const tokenSeconds = desired?.tokenLifetimeSeconds ?? effective?.tokenLifetimeSeconds ?? bounds.defaultSeconds;
  const tokenMinutes = Math.min(bounds.maxSeconds, Math.max(bounds.minSeconds, tokenSeconds)) / 60;
  return { persistent, grant, customHours: String(customHours), tokenMinutes: String(tokenMinutes) };
}

/** The save for the edited values, or the error on the field that blocks it. The provider re-validates. */
export function oauthUpdateInput(view: OAuthView, values: OAuthValues): { errors: OAuthErrors; body: OAuthUpdate | undefined } {
  const bounds = view.capabilities.tokenLifetime;
  const minutes = String(values.tokenMinutes ?? '').trim();
  const tokenSeconds = minutes === '' ? Number.NaN : Math.round(Number(minutes) * 60);
  if (!Number.isInteger(tokenSeconds) || tokenSeconds < bounds.minSeconds || tokenSeconds > bounds.maxSeconds) {
    return { errors: { tokenMinutes: `The access-token lifetime must be between ${bounds.minSeconds / 60} and ${bounds.maxSeconds / 60} minutes.` }, body: undefined };
  }
  let grant: OAuthGrantSelection = { mode: 'provider-maximum' };
  if (values.persistent !== true) {
    const custom = values.grant === CUSTOM_GRANT;
    const raw = String((custom ? values.customHours : values.grant) ?? '').trim();
    const seconds = raw === '' ? Number.NaN : custom ? Math.round(Number(raw) * 3_600) : Number(raw);
    const { minGrantSeconds, maxGrantSeconds } = view.capabilities;
    if (!Number.isInteger(seconds) || seconds < minGrantSeconds || (maxGrantSeconds !== null && seconds > maxGrantSeconds)) {
      const message = `The grant duration must be between ${minGrantSeconds / 3_600} hour(s) and ${maxGrantSeconds === null ? 'the provider maximum' : `${maxGrantSeconds / 3_600} hours`}.`;
      return { errors: custom ? { customHours: message } : { grant: message }, body: undefined };
    }
    grant = { mode: 'custom', seconds };
  }
  return { errors: {}, body: { grant, tokenLifetimeSeconds: tokenSeconds, expectedRevision: view.revision } };
}

/** The one-click default: stay signed in for the provider maximum with the default token lifetime. */
export function oauthAdoptInput(view: OAuthView): OAuthUpdate {
  return { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: view.capabilities.tokenLifetime.defaultSeconds, expectedRevision: view.revision };
}

/**
 * The form schema for `zodResolver`. A disabled control (the grant select while "stay signed
 * in" is on) submits no value, so every text field may be absent; the rules are
 * `oauthUpdateInput`'s, so the form and the save can never disagree.
 */
export function oauthSchema(view: OAuthView) {
  return z.object({
    persistent: z.boolean(),
    grant: z.string().optional(),
    customHours: z.string().optional(),
    tokenMinutes: z.string().optional()
  }).superRefine((values, context) => {
    const { errors } = oauthUpdateInput(view, values);
    for (const [path, message] of Object.entries(errors)) context.addIssue({ code: 'custom', path: [path], message });
  });
}
