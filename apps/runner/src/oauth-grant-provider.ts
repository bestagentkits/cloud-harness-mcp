import type { OAuthProviderId } from '@cloud-harness/contracts';

/** The provider's own view of the inbound OAuth grant, as read back from it. */
export type OAuthGrantProviderSnapshot = {
  oauthEnabled: boolean;
  grantSeconds: number | null;
  /** True when an operator (or Cloud Harness) set the grant duration explicitly. */
  grantExplicitlyConfigured: boolean;
  tokenLifetimeSeconds: number | null;
  /** Fingerprint of the provider's OAuth configuration, used to detect concurrent edits. */
  revision: string;
  /** Set when the provider configuration cannot be written safely; the value is a reason code. */
  unsupportedReason: string | null;
};

/**
 * A provider that owns the inbound OAuth grant lifecycle. Cloudflare Access
 * Managed OAuth is the first adapter; a future Cloud Harness-owned
 * authorization server would implement the same contract with
 * `supportsUnboundedGrant` and its own revocation and rotation.
 */
export interface OAuthGrantProvider {
  readonly id: Exclude<OAuthProviderId, 'none'>;
  readonly label: string;
  readonly canWrite: boolean;
  readonly maxGrantSeconds: number;
  readonly supportsUnboundedGrant?: boolean;
  read(): Promise<OAuthGrantProviderSnapshot>;
  /** Write both values, then return the provider's read-back. Throws without writing on a revision mismatch. */
  write(next: { grantSeconds: number; tokenLifetimeSeconds: number }, expectedRevision: string | null): Promise<OAuthGrantProviderSnapshot>;
}
