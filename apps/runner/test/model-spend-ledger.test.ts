import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLeaseSettlement } from '../src/agent-gateway-control.js';
import {
  MODEL_SPEND_RETENTION_MS,
  ModelSpendLedger,
  initializeModelSpendSchema,
  type ModelSpendAdmission
} from '../src/model-spend-ledger.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
let sequence = 0;

function ledgerFixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const log = vi.fn();
  const ledger = new ModelSpendLedger(database, { log });
  return { database, ledger, log };
}

function admission(overrides: Partial<ModelSpendAdmission> = {}): ModelSpendAdmission {
  sequence += 1;
  return {
    leaseId: `lease_${String(sequence).padStart(24, '0')}`,
    principalId: 'principal-a',
    profileKey: 'profile-a',
    revisionId: null,
    agentId: `agent_${String(sequence).padStart(24, '0')}`,
    workspaceId: 'ws_workspace',
    reservedMicros: 100,
    now: NOW,
    ...overrides
  };
}

function settlement(leaseId: string, overrides: Partial<AgentLeaseSettlement> = {}): AgentLeaseSettlement {
  return {
    leaseId, reason: 'revoked', settledAt: NOW, initialInputTokens: 1_000, initialOutputTokens: 1_000, initialCostMicros: 100,
    costMicros: 40, overrunCostMicros: 0, promptTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5,
    reasoningTokens: 3, requests: 1, requestsWithoutUsage: 0, ...overrides
  };
}

describe('ModelSpendLedger', () => {
  it('initialises its schema idempotently and keeps existing rows', () => {
    const { database, ledger } = ledgerFixture();
    ledger.admit(admission({ leaseId: 'lease-kept' }));
    initializeModelSpendSchema(database);
    const reopened = new ModelSpendLedger(database, { log: vi.fn() });
    expect(reopened.find('lease-kept')).toMatchObject({ state: 'reserved', reservedMicros: 100 });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'model_spend_%' ORDER BY name").all();
    expect(tables).toEqual([{ name: 'model_spend_ledger' }, { name: 'model_spend_policies' }]);
  });

  it('sums each UTC window separately across a day and month boundary', () => {
    const { ledger } = ledgerFixture();
    const lastMoment = Date.parse('2026-10-31T23:59:59.999Z');
    const firstMoment = Date.parse('2026-11-01T00:00:00.000Z');
    ledger.admit(admission({ now: Date.parse('2026-10-30T08:00:00.000Z'), reservedMicros: 7 }));
    ledger.admit(admission({ now: lastMoment, reservedMicros: 100 }));
    ledger.admit(admission({ now: firstMoment, reservedMicros: 30 }));
    expect(ledger.windowTotals('principal-a', null, 'day', lastMoment).committedMicros).toBe(100);
    expect(ledger.windowTotals('principal-a', null, 'month', lastMoment).committedMicros).toBe(107);
    expect(ledger.windowTotals('principal-a', null, 'day', firstMoment).committedMicros).toBe(30);
    expect(ledger.windowTotals('principal-a', null, 'month', firstMoment).committedMicros).toBe(30);
    expect(ledger.find(`lease_${String(sequence - 1).padStart(24, '0')}`)).toMatchObject({ dayKey: '2026-10-31', monthKey: '2026-10' });
  });

  it.each([
    { scope: 'principal', period: 'day' as const, profileId: undefined },
    { scope: 'principal', period: 'month' as const, profileId: undefined },
    { scope: 'profile', period: 'day' as const, profileId: 'profile-a' },
    { scope: 'profile', period: 'month' as const, profileId: 'profile-a' }
  ])('admits up to the $scope $period limit and refuses one micro more', ({ period, profileId }) => {
    const { ledger, database } = ledgerFixture();
    ledger.setPolicy('principal-a', { ...(profileId ? { profileId } : {}), period, limitMicros: 1_000 }, NOW);
    ledger.admit(admission({ reservedMicros: 400 }));
    ledger.admit(admission({ reservedMicros: 600 }));
    const refused = admission({ reservedMicros: 1 });
    expect(() => ledger.admit(refused)).toThrow(expect.objectContaining({
      code: 'LIMIT_EXCEEDED',
      status: 429,
      retryable: false,
      message: expect.stringMatching(new RegExp(`model spend policy \\(${profileId ? 'profile profile-a' : 'principal'}, ${period}\\) would be exceeded; estimated committed 1000 of 1000`))
    }));
    expect(ledger.find(refused.leaseId)).toBeUndefined();
    // Other principals are never counted against the policy, and a profile policy leaves other profiles alone.
    expect(() => ledger.admit(admission({ principalId: 'principal-b', reservedMicros: 1_000 }))).not.toThrow();
    if (profileId) expect(() => ledger.admit(admission({ profileKey: 'profile-b', reservedMicros: 1_000 }))).not.toThrow();
    expect((database.prepare('SELECT COUNT(*) AS count FROM model_spend_ledger').get() as { count: number }).count).toBe(profileId ? 4 : 3);
  });

  it('releases a row whose lease was never issued and stops counting it', () => {
    const { ledger } = ledgerFixture();
    const entry = admission({ reservedMicros: 500 });
    ledger.admit(entry);
    expect(ledger.settle(entry.leaseId, { revoked: false, gatewayBootId: 'boot-1' }, NOW)).toMatchObject({ state: 'released', chargedMicros: 0 });
    expect(ledger.windowTotals('principal-a', null, 'day', NOW).committedMicros).toBe(0);
  });

  it('leaves a possibly issued lease without a settlement unreconciled at its reservation', () => {
    const { ledger } = ledgerFixture();
    const entry = admission({ reservedMicros: 500 });
    ledger.admit(entry);
    ledger.markIssuing(entry.leaseId);
    expect(ledger.settle(entry.leaseId, undefined, NOW)).toMatchObject({ state: 'unreconciled', chargedMicros: 500 });
    expect(ledger.windowTotals('principal-a', null, 'day', NOW)).toEqual({
      settledMicros: 0, reservedMicros: 0, unreconciledMicros: 500, committedMicros: 500
    });
  });

  it('releases a refused issue at zero, and leaves any other row alone', () => {
    const { ledger } = ledgerFixture();
    const refused = admission({ reservedMicros: 500 });
    const reserved = admission({ reservedMicros: 500 });
    ledger.admit(refused);
    ledger.admit(reserved);
    ledger.markIssuing(refused.leaseId);
    ledger.releaseRefusedIssue(refused.leaseId, NOW + 1);
    ledger.releaseRefusedIssue(reserved.leaseId, NOW + 1);
    expect(ledger.find(refused.leaseId)).toMatchObject({ state: 'released', chargedMicros: 0, settledAt: NOW + 1 });
    expect(ledger.find(reserved.leaseId)).toMatchObject({ state: 'reserved', chargedMicros: null });
    expect(ledger.settle(refused.leaseId, undefined, NOW + 2)).toMatchObject({ state: 'released', chargedMicros: 0 });
  });

  it('settles at the gateway cost, including an overrun above the reservation', () => {
    const { ledger, database } = ledgerFixture();
    const entry = admission({ reservedMicros: 100 });
    ledger.admit(entry);
    ledger.markIssuing(entry.leaseId);
    ledger.recordGatewayBoot(entry.leaseId, 'boot-1');
    const settled = ledger.settle(entry.leaseId, {
      revoked: true, gatewayBootId: 'boot-1', settlement: settlement(entry.leaseId, { costMicros: 130, overrunCostMicros: 30 })
    }, NOW + 5);
    expect(settled).toMatchObject({ state: 'settled', chargedMicros: 130, settledAt: NOW + 5, gatewayBootId: 'boot-1' });
    expect(database.prepare('SELECT prompt_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens FROM model_spend_ledger WHERE lease_id=?')
      .get(entry.leaseId)).toEqual({ prompt_tokens: 10, cache_read_tokens: 2, cache_write_tokens: 1, output_tokens: 5, reasoning_tokens: 3 });
    expect(ledger.windowTotals('principal-a', 'profile-a', 'month', NOW)).toMatchObject({ settledMicros: 130, committedMicros: 130 });
  });

  it('settles under the gateway cost only when every request reported usage', () => {
    const { ledger } = ledgerFixture();
    const entry = admission({ reservedMicros: 100 });
    ledger.admit(entry);
    ledger.markIssuing(entry.leaseId);
    expect(ledger.settle(entry.leaseId, {
      revoked: true, settlement: settlement(entry.leaseId, { costMicros: 40, requestsWithoutUsage: 1 })
    }, NOW)).toMatchObject({ state: 'settled', chargedMicros: 100 });
  });

  it('does not trust a settlement from a different gateway boot', () => {
    const { ledger } = ledgerFixture();
    const entry = admission({ reservedMicros: 100 });
    ledger.admit(entry);
    ledger.markIssuing(entry.leaseId);
    ledger.recordGatewayBoot(entry.leaseId, 'boot-1');
    expect(ledger.settle(entry.leaseId, {
      revoked: true, gatewayBootId: 'boot-2', settlement: settlement(entry.leaseId, { costMicros: 1 })
    }, NOW)).toMatchObject({ state: 'unreconciled', chargedMicros: 100 });
  });

  it('never changes a closed row again', () => {
    const { ledger } = ledgerFixture();
    const entry = admission({ reservedMicros: 100 });
    ledger.admit(entry);
    ledger.markIssuing(entry.leaseId);
    ledger.settle(entry.leaseId, { revoked: true, settlement: settlement(entry.leaseId, { costMicros: 40 }) }, NOW);
    expect(ledger.settle(entry.leaseId, undefined, NOW + 1)).toMatchObject({ state: 'settled', chargedMicros: 40, settledAt: NOW });
    expect(ledger.settle('lease-unknown', undefined, NOW)).toBeUndefined();
  });

  it('prunes closed rows past the retention horizon and keeps open ones', () => {
    const { ledger } = ledgerFixture();
    const old = NOW - MODEL_SPEND_RETENTION_MS - 1;
    const closed = admission({ now: old });
    const open = admission({ now: old });
    const recent = admission();
    for (const entry of [closed, open, recent]) ledger.admit(entry);
    ledger.settle(closed.leaseId, undefined, old);
    ledger.settle(recent.leaseId, undefined, NOW);
    expect(ledger.prune(NOW)).toBe(1);
    expect(ledger.find(closed.leaseId)).toBeUndefined();
    expect(ledger.find(open.leaseId)).toMatchObject({ state: 'reserved' });
    expect(ledger.find(recent.leaseId)).toMatchObject({ state: 'released' });
  });

  it('lists open rows older than the cutoff, oldest first', () => {
    const { ledger } = ledgerFixture();
    const older = admission({ now: NOW - 120_000 });
    const old = admission({ now: NOW - 61_000 });
    const fresh = admission({ now: NOW });
    const closed = admission({ now: NOW - 200_000 });
    for (const entry of [fresh, old, older, closed]) ledger.admit(entry);
    ledger.settle(closed.leaseId, undefined, NOW);
    expect(ledger.listOpen(NOW - 60_000, 10).map((entry) => entry.leaseId)).toEqual([older.leaseId, old.leaseId]);
  });

  it('logs a threshold crossing once, from admission or from settlement, with identifiers only', () => {
    const { ledger, log } = ledgerFixture();
    const policy = ledger.setPolicy('principal-a', { period: 'month', limitMicros: 1_000 }, NOW);
    ledger.reportThresholds(ledger.admit(admission({ reservedMicros: 500 })));
    expect(log).not.toHaveBeenCalled();
    ledger.reportThresholds(ledger.admit(admission({ reservedMicros: 300 })));
    ledger.reportThresholds(ledger.admit(admission({ reservedMicros: 100 })));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      msg: 'model spend threshold reached', isEstimate: true, policyId: policy.id, principalId: 'principal-a',
      profileId: null, period: 'month', window: '2026-10', warnPercent: 80
    });

    const settling = ledgerFixture();
    settling.ledger.setPolicy('principal-a', { profileId: 'profile-a', period: 'day', limitMicros: 1_000, warnPercent: 50 }, NOW);
    const entry = admission({ reservedMicros: 400 });
    settling.ledger.reportThresholds(settling.ledger.admit(entry));
    settling.ledger.markIssuing(entry.leaseId);
    settling.ledger.settle(entry.leaseId, { revoked: true, settlement: settlement(entry.leaseId, { costMicros: 600 }) }, NOW);
    expect(settling.log).toHaveBeenCalledTimes(1);
    expect(settling.log).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'profile-a', period: 'day', window: '2026-10-17', warnPercent: 50 }));
  });

  it('keeps one policy per scope and period, guarded by its generation', () => {
    const { ledger } = ledgerFixture();
    const created = ledger.setPolicy('principal-a', { period: 'day', limitMicros: 10 }, NOW);
    expect(created).toMatchObject({ profileId: null, period: 'day', limitMicros: 10, warnPercent: 80, generation: 1 });
    expect(() => ledger.setPolicy('principal-a', { period: 'day', limitMicros: 20 }, NOW)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    const updated = ledger.setPolicy('principal-a', { period: 'day', limitMicros: 20, warnPercent: 90, expectedGeneration: 1 }, NOW + 1);
    expect(updated).toMatchObject({ id: created.id, limitMicros: 20, warnPercent: 90, generation: 2, updatedAt: NOW + 1 });
    expect(() => ledger.setPolicy('principal-a', { profileId: 'profile-a', period: 'day', limitMicros: 5, expectedGeneration: 1 }, NOW))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    ledger.setPolicy('principal-a', { profileId: 'profile-a', period: 'day', limitMicros: 5 }, NOW);
    expect(ledger.listPolicies('principal-a')).toHaveLength(2);
    expect(ledger.listPolicies('principal-b')).toEqual([]);
    expect(() => ledger.deletePolicy('principal-b', { policyId: created.id, expectedGeneration: 2 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => ledger.deletePolicy('principal-a', { policyId: created.id, expectedGeneration: 1 })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    ledger.deletePolicy('principal-a', { policyId: created.id, expectedGeneration: 2 });
    expect(ledger.listPolicies('principal-a').map((policy) => policy.profileId)).toEqual(['profile-a']);
  });

  it('caps the number of policies per principal', () => {
    const { ledger } = ledgerFixture();
    for (let index = 0; index < 32; index += 1) {
      for (const period of ['day', 'month'] as const) ledger.setPolicy('principal-a', { profileId: `profile-${index}`, period, limitMicros: 1 }, NOW);
    }
    expect(() => ledger.setPolicy('principal-a', { period: 'day', limitMicros: 1 }, NOW)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
});
