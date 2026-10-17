import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GatewayProfile, LeaseGrant, LeaseIssueInput, LeaseSettlement } from './types.js';

const AGENT_ID_PATTERN = /^agent_[A-Za-z0-9_-]{20,80}$/;
const LEASE_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** How long a revoked or expired lease stays known: replay is refused and its settlement can be read again. */
const RETENTION_MS = 86_400_000;

interface RetiredLease {
  retiredAt: number;
  reason: LeaseSettlement['reason'];
  grant: LeaseGrant;
}

export function createLeaseGrant(input: {
  agentId: string;
  profileId: string;
  expiresAt: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}): LeaseGrant {
  return {
    agentId: input.agentId,
    profileId: input.profileId,
    expiresAt: input.expiresAt,
    remainingInputTokens: input.inputTokens,
    remainingOutputTokens: input.outputTokens,
    remainingCostMicros: input.costMicros,
    accounting: {
      initialInputTokens: input.inputTokens,
      initialOutputTokens: input.outputTokens,
      initialCostMicros: input.costMicros,
      overrunCostMicros: 0,
      unabsorbedOverrunCostMicros: 0,
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: 0,
      requestsWithoutUsage: 0
    }
  };
}

/**
 * A settlement is read from the retired grant, so a request that was still
 * draining when the lease retired is counted at whatever it finally charged:
 * its reservation if it failed or was cancelled.
 */
function settlementOf(leaseId: string, retired: RetiredLease): LeaseSettlement {
  const { grant, reason, retiredAt } = retired;
  const { accounting } = grant;
  return {
    leaseId,
    reason,
    settledAt: retiredAt,
    initialInputTokens: accounting.initialInputTokens,
    initialOutputTokens: accounting.initialOutputTokens,
    initialCostMicros: accounting.initialCostMicros,
    costMicros: accounting.initialCostMicros - grant.remainingCostMicros + accounting.unabsorbedOverrunCostMicros,
    overrunCostMicros: accounting.overrunCostMicros,
    promptTokens: accounting.promptTokens,
    cacheReadTokens: accounting.cacheReadTokens,
    cacheWriteTokens: accounting.cacheWriteTokens,
    outputTokens: accounting.outputTokens,
    reasoningTokens: accounting.reasoningTokens,
    requests: accounting.requests,
    requestsWithoutUsage: accounting.requestsWithoutUsage
  };
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of bounds`);
  return value;
}

export class LeaseRegistry {
  readonly #leases = new Map<string, LeaseGrant>();
  readonly #active = new Map<string, LeaseGrant>();
  readonly #used = new Map<string, RetiredLease>();
  readonly #keysByLeaseId = new Map<string, string>();
  readonly #leaseIdsByKey = new Map<string, string>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  activeCount(): number {
    this.#prune();
    return this.#leases.size + this.#active.size;
  }
  issue(input: LeaseIssueInput, profile: GatewayProfile): string {
    this.#prune();
    if (this.#leases.size + this.#active.size + this.#used.size >= this.#maxEntries) throw new Error('lease capacity reached');
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.leaseId)) throw new Error('leaseId is invalid');
    if (this.#keysByLeaseId.has(input.leaseId)) throw new Error('leaseId already registered');
    if (!AGENT_ID_PATTERN.test(input.agentId)) throw new Error('agentId is invalid');
    if (input.profileId !== profile.id) throw new Error('profile mismatch');
    let lease = randomBytes(48).toString('base64url');
    let key = digest(lease).toString('hex');
    while (this.#leases.has(key) || this.#active.has(key) || this.#used.has(key)) {
      lease = randomBytes(48).toString('base64url');
      key = digest(lease).toString('hex');
    }
    const ttlMs = boundedInteger(input.ttlMs, 'ttlMs', 1_000, 86_400_000);
    this.#leases.set(key, createLeaseGrant({
      agentId: input.agentId,
      profileId: input.profileId,
      expiresAt: this.#now() + ttlMs,
      inputTokens: Math.min(boundedInteger(input.maxInputTokens, 'maxInputTokens', 1, 10_000_000), profile.limits.maxInputTokens),
      outputTokens: Math.min(boundedInteger(input.maxOutputTokens, 'maxOutputTokens', 1, 2_000_000), profile.limits.maxOutputTokens),
      costMicros: Math.min(boundedInteger(input.maxCostMicros, 'maxCostMicros', 0, 1_000_000_000_000), profile.limits.maxCostMicros)
    }));
    this.#keysByLeaseId.set(input.leaseId, key);
    this.#leaseIdsByKey.set(key, input.leaseId);
    return lease;
  }

  consume(lease: string, agentId: string, profileId: string): LeaseGrant {
    this.#prune();
    if (!LEASE_PATTERN.test(lease)) throw new Error('invalid lease');
    const candidate = digest(lease);
    const key = candidate.toString('hex');
    const pendingGrant = this.#leases.get(key);
    const grant = pendingGrant ?? this.#active.get(key);
    if (!grant) {
      for (const usedKey of this.#used.keys()) {
        const used = Buffer.from(usedKey, 'hex');
        if (used.length === candidate.length && timingSafeEqual(used, candidate)) throw new Error('lease revoked or expired');
      }
      throw new Error('invalid lease');
    }
    if (grant.expiresAt <= this.#now()) {
      this.#retire(key, grant, 'expired');
      throw new Error('lease expired');
    }
    if (grant.agentId !== agentId || grant.profileId !== profileId) throw new Error('lease binding mismatch');
    if (pendingGrant) {
      this.#leases.delete(key);
      this.#active.set(key, grant);
    }
    return grant;
  }

  /** The grant behind a lease id, live or retired, so requests still draining on it can be found. */
  bindingFor(leaseId: string): LeaseGrant | undefined {
    const key = this.#keysByLeaseId.get(leaseId);
    return key === undefined ? undefined : this.#leases.get(key) ?? this.#active.get(key) ?? this.#used.get(key)?.grant;
  }

  /**
   * Retires a live lease. Returns false when the lease is unknown or already
   * retired; a retired lease's settlement stays readable through settlementFor.
   */
  revoke(leaseId: string): boolean {
    this.#prune();
    const key = this.#keysByLeaseId.get(leaseId);
    if (key === undefined) return false;
    const grant = this.#leases.get(key) ?? this.#active.get(key);
    if (grant === undefined) return false;
    this.#retire(key, grant, 'revoked');
    return true;
  }

  /** The settlement of a revoked or expired lease, kept for the replay-retention horizon. */
  settlementFor(leaseId: string): LeaseSettlement | undefined {
    this.#prune();
    const key = this.#keysByLeaseId.get(leaseId);
    const retired = key === undefined ? undefined : this.#used.get(key);
    return retired === undefined ? undefined : settlementOf(leaseId, retired);
  }

  #retire(key: string, grant: LeaseGrant, reason: RetiredLease['reason']): void {
    this.#leases.delete(key);
    this.#active.delete(key);
    this.#used.set(key, { retiredAt: this.#now(), reason, grant });
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, grant] of this.#leases) if (grant.expiresAt <= now) this.#retire(key, grant, 'expired');
    for (const [key, grant] of this.#active) if (grant.expiresAt <= now) this.#retire(key, grant, 'expired');
    const horizon = now - RETENTION_MS;
    for (const [key, retired] of this.#used) {
      if (retired.retiredAt < horizon) {
        this.#used.delete(key);
        this.#removeLeaseId(key);
      }
    }
  }

  #removeLeaseId(key: string): void {
    const leaseId = this.#leaseIdsByKey.get(key);
    if (leaseId !== undefined) this.#keysByLeaseId.delete(leaseId);
    this.#leaseIdsByKey.delete(key);
  }
}
