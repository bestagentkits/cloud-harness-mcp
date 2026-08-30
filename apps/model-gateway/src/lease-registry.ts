import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GatewayProfile, LeaseGrant, LeaseIssueInput } from './types.js';

const AGENT_ID_PATTERN = /^agent_[A-Za-z0-9_-]{20,80}$/;
const LEASE_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of bounds`);
  return value;
}

export class LeaseRegistry {
  readonly #leases = new Map<string, LeaseGrant>();
  readonly #active = new Map<string, LeaseGrant>();
  readonly #used = new Map<string, number>();
  readonly #keysByLeaseId = new Map<string, string>();
  readonly #leaseIdsByKey = new Map<string, string>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#now = options.now ?? Date.now;
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
    this.#leases.set(key, {
      agentId: input.agentId,
      profileId: input.profileId,
      expiresAt: this.#now() + ttlMs,
      remainingInputTokens: Math.min(boundedInteger(input.maxInputTokens, 'maxInputTokens', 1, 10_000_000), profile.limits.maxInputTokens),
      remainingOutputTokens: Math.min(boundedInteger(input.maxOutputTokens, 'maxOutputTokens', 1, 2_000_000), profile.limits.maxOutputTokens),
      remainingCostMicros: Math.min(boundedInteger(input.maxCostMicros, 'maxCostMicros', 0, 1_000_000_000_000), profile.limits.maxCostMicros)
    });
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
      this.#leases.delete(key);
      this.#active.delete(key);
      this.#used.set(key, this.#now());
      throw new Error('lease expired');
    }
    if (grant.agentId !== agentId || grant.profileId !== profileId) throw new Error('lease binding mismatch');
    if (pendingGrant) {
      this.#leases.delete(key);
      this.#active.set(key, grant);
    }
    return grant;
  }

  bindingFor(leaseId: string): LeaseGrant | undefined {
    const key = this.#keysByLeaseId.get(leaseId);
    return key === undefined ? undefined : this.#leases.get(key) ?? this.#active.get(key);
  }

  revoke(leaseId: string): boolean {
    const key = this.#keysByLeaseId.get(leaseId);
    if (key === undefined) return false;
    const removed = this.#leases.delete(key) || this.#active.delete(key);
    this.#active.delete(key);
    this.#keysByLeaseId.delete(leaseId);
    this.#leaseIdsByKey.delete(key);
    this.#used.set(key, this.#now());
    this.#prune();
    return removed;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, grant] of this.#leases) {
      if (grant.expiresAt <= now) {
        this.#leases.delete(key);
        this.#removeLeaseId(key);
        this.#used.set(key, now);
      }
    }
    for (const [key, grant] of this.#active) {
      if (grant.expiresAt <= now) {
        this.#active.delete(key);
        this.#removeLeaseId(key);
        this.#used.set(key, now);
      }
    }
    const replayHorizon = now - 86_400_000;
    for (const [key, usedAt] of this.#used) if (usedAt < replayHorizon) this.#used.delete(key);
  }
  #removeLeaseId(key: string): void {
    const leaseId = this.#leaseIdsByKey.get(key);
    if (leaseId !== undefined) this.#keysByLeaseId.delete(leaseId);
    this.#leaseIdsByKey.delete(key);
  }

}
