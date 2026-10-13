import {
  HarnessError,
  OAuthGrantSettingsUpdateInputSchema,
  type OAuthGrantSelection,
  type OAuthGrantSettingsView,
  type OAuthProviderCapabilities
} from '@cloud-harness/contracts';
import { providerErrorMessage } from './cloudflare-access-oauth-provider.js';
import type { OAuthGrantProvider, OAuthGrantProviderSnapshot } from './oauth-grant-provider.js';
import type { OAuthGrantSettingsRecord } from './state-store.js';

/** Access tokens stay short: refresh re-evaluates provider policy, so a long grant does not weaken it. */
export const OAUTH_TOKEN_LIFETIME_DEFAULT_SECONDS = 900;
const TOKEN_LIFETIME_BOUNDS = { minSeconds: 60, maxSeconds: 3_600, defaultSeconds: OAUTH_TOKEN_LIFETIME_DEFAULT_SECONDS };
const MIN_GRANT_SECONDS = 3_600;
const GRANT_PRESETS_SECONDS = [86_400, 604_800, 1_209_600, 2_592_000];

type OAuthGrantStore = {
  getOAuthGrantSettings(): OAuthGrantSettingsRecord;
  setOAuthGrantDesired(desired: { grantMode: 'provider-maximum' | 'custom'; grantSeconds: number; tokenLifetimeSeconds: number }, at?: number): void;
  recordOAuthGrantSync(ok: boolean, errorCode: string | null, at?: number): void;
};
type AuditSink = (ownerId: string, action: string, details: Record<string, string | number | boolean>) => void;

export type OAuthDefaultReconcileOutcome = 'not-configured' | 'read-only' | 'already-managed' | 'left-unmanaged' | 'applied-provider-maximum' | 'failed';

/**
 * Owns the inbound MCP OAuth grant settings shown under Dashboard Settings.
 * The provider is always the authority for effective values: local state only
 * records what Cloud Harness applied and confirmed on read-back, so a provider
 * failure can never leave the Dashboard reporting a value the provider lacks.
 */
export class OAuthGrantSettingsService {
  constructor(
    private readonly store: OAuthGrantStore,
    private readonly provider: OAuthGrantProvider | undefined,
    private readonly audit: AuditSink = () => undefined,
    private readonly now: () => number = Date.now
  ) {}

  async view(): Promise<OAuthGrantSettingsView> {
    if (!this.provider) return this.unconfiguredView();
    let snapshot: OAuthGrantProviderSnapshot | undefined;
    let failure: string | undefined;
    try {
      snapshot = await this.provider.read();
      this.store.recordOAuthGrantSync(true, null, this.now());
    } catch (error) {
      failure = reasonOf(error);
      this.store.recordOAuthGrantSync(false, failure, this.now());
    }
    return this.buildView(snapshot, failure);
  }

  async update(ownerId: string, rawInput: unknown): Promise<OAuthGrantSettingsView> {
    const input = OAuthGrantSettingsUpdateInputSchema.parse(rawInput);
    const provider = this.provider;
    if (!provider) throw new HarnessError('FORBIDDEN', 'No OAuth provider integration is configured, so these settings are read-only.', 403, false, { reason: 'provider_not_configured' });
    const grantSeconds = input.grant.mode === 'provider-maximum' ? provider.maxGrantSeconds : input.grant.seconds;
    const bounds = this.capabilities(true);
    if (grantSeconds < bounds.minGrantSeconds || (bounds.maxGrantSeconds !== null && grantSeconds > bounds.maxGrantSeconds)) {
      throw new HarnessError('INVALID_INPUT', `The grant duration must be between ${bounds.minGrantSeconds} and ${bounds.maxGrantSeconds ?? grantSeconds} seconds.`, 400, false, { reason: 'grant_out_of_bounds' });
    }
    if (input.tokenLifetimeSeconds < bounds.tokenLifetime.minSeconds || input.tokenLifetimeSeconds > bounds.tokenLifetime.maxSeconds) {
      throw new HarnessError('INVALID_INPUT', `The access-token lifetime must be between ${bounds.tokenLifetime.minSeconds} and ${bounds.tokenLifetime.maxSeconds} seconds.`, 400, false, { reason: 'token_lifetime_out_of_bounds' });
    }
    let snapshot: OAuthGrantProviderSnapshot;
    try {
      snapshot = await provider.write({ grantSeconds, tokenLifetimeSeconds: input.tokenLifetimeSeconds }, input.expectedRevision);
    } catch (error) {
      this.store.recordOAuthGrantSync(false, reasonOf(error), this.now());
      throw error;
    }
    this.store.setOAuthGrantDesired({ grantMode: input.grant.mode, grantSeconds, tokenLifetimeSeconds: input.tokenLifetimeSeconds }, this.now());
    this.audit(ownerId, 'settings.oauth_grant.changed', {
      provider: provider.id,
      grantMode: input.grant.mode,
      grantSeconds,
      tokenLifetimeSeconds: input.tokenLifetimeSeconds
    });
    return this.buildView(snapshot);
  }

  /**
   * New installs default to the provider maximum. A provider value that an
   * operator already set explicitly is left unmanaged, never overwritten; the
   * Dashboard offers adopting the default instead.
   */
  async reconcileDefault(): Promise<OAuthDefaultReconcileOutcome> {
    const provider = this.provider;
    if (!provider) return 'not-configured';
    if (!provider.canWrite) return 'read-only';
    if (this.store.getOAuthGrantSettings().desired) return 'already-managed';
    try {
      const snapshot = await provider.read();
      if (!snapshot.oauthEnabled || snapshot.unsupportedReason || snapshot.grantExplicitlyConfigured) {
        this.store.recordOAuthGrantSync(true, null, this.now());
        return 'left-unmanaged';
      }
      const current = snapshot.tokenLifetimeSeconds;
      const tokenLifetimeSeconds = current !== null && current >= TOKEN_LIFETIME_BOUNDS.minSeconds && current <= TOKEN_LIFETIME_BOUNDS.maxSeconds
        ? current
        : TOKEN_LIFETIME_BOUNDS.defaultSeconds;
      await provider.write({ grantSeconds: provider.maxGrantSeconds, tokenLifetimeSeconds }, snapshot.revision);
      this.store.setOAuthGrantDesired({ grantMode: 'provider-maximum', grantSeconds: provider.maxGrantSeconds, tokenLifetimeSeconds }, this.now());
      return 'applied-provider-maximum';
    } catch (error) {
      this.store.recordOAuthGrantSync(false, reasonOf(error), this.now());
      return 'failed';
    }
  }

  private buildView(snapshot: OAuthGrantProviderSnapshot | undefined, failure?: string): OAuthGrantSettingsView {
    const provider = this.provider!;
    const record = this.store.getOAuthGrantSettings();
    const desired = record.desired;
    const writable = provider.canWrite && snapshot !== undefined && snapshot.oauthEnabled && snapshot.unsupportedReason === null;
    const matchesDesired = desired !== undefined && snapshot !== undefined
      && snapshot.grantSeconds === desired.grantSeconds && snapshot.tokenLifetimeSeconds === desired.tokenLifetimeSeconds;
    let readOnlyReason: string | null = null;
    if (failure) readOnlyReason = providerErrorMessage(failure);
    else if (!provider.canWrite) readOnlyReason = providerErrorMessage('provider_read_only');
    else if (snapshot?.unsupportedReason) readOnlyReason = providerErrorMessage(snapshot.unsupportedReason);
    else if (snapshot && !snapshot.oauthEnabled) readOnlyReason = providerErrorMessage('managed_oauth_disabled');
    return {
      provider: { id: provider.id, label: provider.label },
      capabilities: { ...this.capabilities(snapshot !== undefined), canWriteGrantConfiguration: writable },
      effective: snapshot ? {
        oauthEnabled: snapshot.oauthEnabled,
        grantSeconds: snapshot.grantSeconds,
        grantIsProviderMaximum: snapshot.grantSeconds !== null && snapshot.grantSeconds === provider.maxGrantSeconds,
        tokenLifetimeSeconds: snapshot.tokenLifetimeSeconds
      } : null,
      management: {
        state: desired === undefined ? 'unmanaged' : snapshot === undefined || matchesDesired ? 'managed' : 'drifted',
        desired: desired ? { grant: selection(desired), tokenLifetimeSeconds: desired.tokenLifetimeSeconds } : null,
        updatedAt: desired?.managedAt ? new Date(desired.managedAt).toISOString() : null
      },
      revision: snapshot?.revision ?? null,
      lastSync: record.lastSync ? { at: new Date(record.lastSync.at).toISOString(), ok: record.lastSync.ok, errorCode: record.lastSync.errorCode } : null,
      readOnlyReason
    };
  }

  private capabilities(canRead: boolean): OAuthProviderCapabilities {
    const max = this.provider?.maxGrantSeconds ?? null;
    return {
      canReadGrantConfiguration: canRead,
      canWriteGrantConfiguration: false,
      supportsUnboundedGrant: this.provider?.supportsUnboundedGrant === true,
      maxGrantSeconds: max,
      minGrantSeconds: MIN_GRANT_SECONDS,
      grantPresetsSeconds: max === null ? [] : GRANT_PRESETS_SECONDS.filter((seconds) => seconds < max),
      tokenLifetime: { ...TOKEN_LIFETIME_BOUNDS }
    };
  }

  private unconfiguredView(): OAuthGrantSettingsView {
    return {
      provider: { id: 'none', label: 'Not configured' },
      capabilities: this.capabilities(false),
      effective: null,
      management: { state: 'unconfigured', desired: null, updatedAt: null },
      revision: null,
      lastSync: null,
      readOnlyReason: 'No OAuth provider integration is configured. Grant and access-token lifetimes are managed outside Cloud Harness.'
    };
  }
}

function selection(desired: NonNullable<OAuthGrantSettingsRecord['desired']>): OAuthGrantSelection {
  return desired.grantMode === 'provider-maximum' ? { mode: 'provider-maximum' } : { mode: 'custom', seconds: desired.grantSeconds };
}

function reasonOf(error: unknown): string {
  const reason = error instanceof HarnessError ? error.details?.reason : undefined;
  return typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'provider_unreachable';
}
