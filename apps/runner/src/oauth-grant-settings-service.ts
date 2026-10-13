import {
  HarnessError,
  OAUTH_GRANT_SECONDS_FLOOR,
  OAUTH_TOKEN_LIFETIME_SECONDS_CEILING,
  OAUTH_TOKEN_LIFETIME_SECONDS_FLOOR,
  OAuthGrantSettingsUpdateInputSchema,
  type OAuthGrantSelection,
  type OAuthGrantSettingsView,
  type OAuthProviderCapabilities
} from '@cloud-harness/contracts';
import { providerErrorMessage } from './cloudflare-access-oauth-provider.js';
import type { OAuthGrantProvider, OAuthGrantProviderSnapshot } from './oauth-grant-provider.js';
import type { OAuthGrantChangeSource, OAuthGrantSettingsRecord } from './state-store.js';

/** Access tokens stay short: refresh re-evaluates provider policy, so a long grant does not weaken it. */
export const OAUTH_TOKEN_LIFETIME_DEFAULT_SECONDS = 900;
const TOKEN_LIFETIME_BOUNDS = { minSeconds: OAUTH_TOKEN_LIFETIME_SECONDS_FLOOR, maxSeconds: OAUTH_TOKEN_LIFETIME_SECONDS_CEILING, defaultSeconds: OAUTH_TOKEN_LIFETIME_DEFAULT_SECONDS };
const MIN_GRANT_SECONDS = OAUTH_GRANT_SECONDS_FLOOR;
/**
 * Reasons that say the provider itself could not be read or confirmed. Refusals
 * such as a revision conflict reached the provider fine, so they are not
 * recorded as a failed sync.
 */
const SYNC_FAILURE_REASONS = new Set([
  'provider_unreachable', 'provider_invalid_response', 'provider_permission_denied',
  'provider_write_denied', 'provider_application_not_found', 'write_unconfirmed', 'readback_mismatch'
]);
const GRANT_PRESETS_SECONDS = [86_400, 604_800, 1_209_600, 2_592_000];

type OAuthGrantStore = {
  getOAuthGrantSettings(): OAuthGrantSettingsRecord;
  setOAuthGrantDesired(desired: { grantMode: 'provider-maximum' | 'custom'; grantSeconds: number; tokenLifetimeSeconds: number; managedBy: OAuthGrantChangeSource }, at?: number): void;
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
  /**
   * Provider writes are read-check-write with no provider-side lock, so every
   * write from this runner runs one at a time; otherwise the startup default
   * and a Dashboard save could both pass the revision check and the later PUT
   * would silently replace a value the operator was told was saved.
   */
  private writes: Promise<unknown> = Promise.resolve();

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
    return await this.serialized(() => this.applyUpdate(ownerId, rawInput));
  }

  private async applyUpdate(ownerId: string, rawInput: unknown): Promise<OAuthGrantSettingsView> {
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
      this.recordFailure(error);
      throw error;
    }
    this.store.setOAuthGrantDesired({ grantMode: input.grant.mode, grantSeconds, tokenLifetimeSeconds: input.tokenLifetimeSeconds, managedBy: 'dashboard' }, this.now());
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
   * Dashboard offers adopting the default instead. The same holds for an
   * explicit access-token lifetime: it is kept, and one outside the bounds
   * this panel offers leaves the whole configuration unmanaged. The result is
   * recorded as applied by the startup default; it never throws.
   */
  async reconcileDefault(): Promise<OAuthDefaultReconcileOutcome> {
    const provider = this.provider;
    if (!provider) return 'not-configured';
    if (!provider.canWrite) return 'read-only';
    return await this.serialized(async () => {
      try {
        // Checked inside the write queue, so a Dashboard save that finished
        // first is never replaced by the default.
        if (this.store.getOAuthGrantSettings().desired) return 'already-managed';
        const snapshot = await provider.read();
        const token = snapshot.tokenLifetimeSeconds;
        const tokenInBounds = token !== null && token >= TOKEN_LIFETIME_BOUNDS.minSeconds && token <= TOKEN_LIFETIME_BOUNDS.maxSeconds;
        if (!snapshot.oauthEnabled || snapshot.unsupportedReason || snapshot.grantExplicitlyConfigured
          || (snapshot.tokenLifetimeExplicitlyConfigured && !tokenInBounds)) {
          this.store.recordOAuthGrantSync(true, null, this.now());
          return 'left-unmanaged';
        }
        const tokenLifetimeSeconds = tokenInBounds ? token : TOKEN_LIFETIME_BOUNDS.defaultSeconds;
        await provider.write({ grantSeconds: provider.maxGrantSeconds, tokenLifetimeSeconds }, snapshot.revision);
        this.store.setOAuthGrantDesired({ grantMode: 'provider-maximum', grantSeconds: provider.maxGrantSeconds, tokenLifetimeSeconds, managedBy: 'startup-default' }, this.now());
        return 'applied-provider-maximum';
      } catch (error) {
        try { this.recordFailure(error); } catch { /* the outcome below is still logged */ }
        return 'failed';
      }
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task, task);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private recordFailure(error: unknown): void {
    const reason = reasonOf(error);
    if (SYNC_FAILURE_REASONS.has(reason)) this.store.recordOAuthGrantSync(false, reason, this.now());
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
        grantExplicitlyConfigured: snapshot.grantExplicitlyConfigured,
        grantIsProviderMaximum: snapshot.grantSeconds !== null && snapshot.grantSeconds === provider.maxGrantSeconds,
        tokenLifetimeSeconds: snapshot.tokenLifetimeSeconds
      } : null,
      management: {
        state: desired === undefined ? 'unmanaged' : snapshot === undefined || matchesDesired ? 'managed' : 'drifted',
        desired: desired ? { grant: selection(desired), tokenLifetimeSeconds: desired.tokenLifetimeSeconds } : null,
        updatedAt: desired?.managedAt ? new Date(desired.managedAt).toISOString() : null,
        updatedBy: desired?.managedBy ?? null
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
      management: { state: 'unconfigured', desired: null, updatedAt: null, updatedBy: null },
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
