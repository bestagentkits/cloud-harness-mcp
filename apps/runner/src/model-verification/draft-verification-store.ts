import { randomBytes } from 'node:crypto';
import {
  ModelVerificationRefSchema,
  type AgentModelApiMode,
  type ModelConnectionVerifyResult,
  type ModelVerificationRef
} from '@cloud-harness/contracts';

/** How long a draft check can still be kept by the profile save that follows it. */
export const DRAFT_VERIFICATION_TTL_MS = 15 * 60_000;
// Checks are rate limited per principal, so this only bounds a long-running runner.
const MAX_DRAFT_VERIFICATIONS = 1_000;

/** Everything a draft check depended on. A save attaches the result only when all of it is unchanged. */
export interface DraftVerificationRoute {
  credentialId: string;
  credentialVersion: number;
  model: string;
  apiMode: AgentModelApiMode;
  upstreamUrl: string;
}

interface DraftVerificationEntry {
  principalId: string;
  route: DraftVerificationRoute;
  result: ModelConnectionVerifyResult;
  expiresAt: number;
}

function sameRoute(left: DraftVerificationRoute, right: DraftVerificationRoute): boolean {
  return left.credentialId === right.credentialId
    && left.credentialVersion === right.credentialVersion
    && left.model === right.model
    && left.apiMode === right.apiMode
    && left.upstreamUrl === right.upstreamUrl;
}

/**
 * Draft check results the runner keeps for a short time, keyed by a random
 * reference that is the only thing the browser receives. The result itself never
 * comes back from the browser, so nothing it sends can forge one. Entries live in
 * memory only: a runner restart forgets them, and the next save simply stores no
 * result, which is the same as saving without a check.
 */
export class DraftVerificationStore {
  private readonly entries = new Map<string, DraftVerificationEntry>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = DRAFT_VERIFICATION_TTL_MS) {}

  remember(principalId: string, route: DraftVerificationRoute, result: ModelConnectionVerifyResult): ModelVerificationRef {
    this.prune();
    // Insertion order is age order, so the first key is always the oldest.
    while (this.entries.size >= MAX_DRAFT_VERIFICATIONS) this.entries.delete(this.entries.keys().next().value!);
    const ref = ModelVerificationRefSchema.parse(`vref_${randomBytes(16).toString('hex')}`);
    this.entries.set(ref, { principalId, route: { ...route }, result, expiresAt: this.now() + this.ttlMs });
    return ref;
  }

  /**
   * Returns the stored result when the reference belongs to this principal, has
   * not expired, and was made for exactly this route. A reference is spent by
   * its owner's first attempt whether or not it matched; another principal's
   * attempt neither sees nor spends it.
   */
  take(principalId: string, ref: string, route: DraftVerificationRoute): ModelConnectionVerifyResult | undefined {
    const entry = this.entries.get(ref);
    if (!entry || entry.principalId !== principalId) return undefined;
    this.entries.delete(ref);
    if (entry.expiresAt <= this.now() || !sameRoute(entry.route, route)) return undefined;
    return entry.result;
  }

  private prune(): void {
    const now = this.now();
    for (const [ref, entry] of this.entries) {
      if (entry.expiresAt > now) break;
      this.entries.delete(ref);
    }
  }
}
