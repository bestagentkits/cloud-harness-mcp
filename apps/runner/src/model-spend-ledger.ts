import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HarnessError,
  MODEL_SPEND_DEFAULT_WARN_PERCENT,
  MODEL_SPEND_MAX_POLICIES_PER_PRINCIPAL,
  ModelSpendPolicyDeleteInputSchema,
  ModelSpendPolicyInputSchema,
  ModelSpendPolicySchema,
  type ModelSpendPeriod,
  type ModelSpendPolicy
} from '@cloud-harness/contracts';
import type { AgentLeaseRevocation } from './agent-gateway-control.js';

/**
 * The durable model spend ledger. A gateway lease is the reservation: admission
 * reserves the run's whole cost cap in the same transaction that admits the
 * spawn, and the row settles from the gateway's frozen accounting when the
 * runner revokes the lease. Every aggregate it reports is an estimate; the
 * per-run cap is still enforced by the gateway and is never changed here.
 */

export type ModelSpendLedgerState = 'reserved' | 'issuing' | 'settled' | 'unreconciled' | 'released';

/** How long closed rows are kept; longer than any policy window. */
export const MODEL_SPEND_RETENTION_MS = 400 * 86_400_000;

export type ModelSpendLedgerEntry = {
  leaseId: string;
  principalId: string;
  profileKey: string;
  revisionId: string | null;
  agentId: string;
  workspaceId: string;
  dayKey: string;
  monthKey: string;
  reservedMicros: number;
  state: ModelSpendLedgerState;
  chargedMicros: number | null;
  gatewayBootId: string | null;
  createdAt: number;
  settledAt: number | null;
};

export type ModelSpendAdmission = {
  leaseId: string;
  principalId: string;
  /** The stable profile id of a saved profile, or the id of a static profile. */
  profileKey: string;
  revisionId: string | null;
  agentId: string;
  workspaceId: string;
  reservedMicros: number;
  now: number;
};

export type ModelSpendWindowTotals = {
  settledMicros: number;
  reservedMicros: number;
  unreconciledMicros: number;
  /** What admission compares with a policy limit: every row except released ones. */
  committedMicros: number;
};

export type ModelSpendThresholdCrossing = {
  policyId: string;
  principalId: string;
  profileId: string | null;
  period: ModelSpendPeriod;
  window: string;
  warnPercent: number;
};

export type ModelSpendLogger = (record: Record<string, unknown>) => void;

type LedgerRow = {
  lease_id: string;
  principal_id: string;
  profile_key: string;
  revision_id: string | null;
  agent_id: string;
  workspace_id: string;
  day_key: string;
  month_key: string;
  reserved_micros: number;
  state: ModelSpendLedgerState;
  charged_micros: number | null;
  gateway_boot_id: string | null;
  created_at: number;
  settled_at: number | null;
};

type PolicyRow = {
  id: string;
  principal_id: string;
  profile_id: string | null;
  period: ModelSpendPeriod;
  limit_micros: number;
  warn_percent: number;
  generation: number;
  created_at: number;
  updated_at: number;
};

/**
 * Creates the ledger and policy tables. Additive and idempotent, with no schema
 * version bump and no foreign keys, so an older release ignores them and a
 * code-only rollback needs no data change.
 */
export function initializeModelSpendSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_spend_ledger (
      lease_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      revision_id TEXT,
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      reserved_micros INTEGER NOT NULL CHECK(reserved_micros >= 0),
      state TEXT NOT NULL CHECK(state IN ('reserved', 'issuing', 'settled', 'unreconciled', 'released')),
      charged_micros INTEGER CHECK(charged_micros IS NULL OR charged_micros >= 0),
      prompt_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      gateway_boot_id TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS model_spend_ledger_principal_month ON model_spend_ledger(principal_id, month_key);
    CREATE INDEX IF NOT EXISTS model_spend_ledger_profile_month ON model_spend_ledger(principal_id, profile_key, month_key);
    CREATE INDEX IF NOT EXISTS model_spend_ledger_state ON model_spend_ledger(state);
    CREATE TABLE IF NOT EXISTS model_spend_policies (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      profile_id TEXT,
      period TEXT NOT NULL CHECK(period IN ('day', 'month')),
      limit_micros INTEGER NOT NULL CHECK(limit_micros > 0),
      warn_percent INTEGER NOT NULL DEFAULT 80 CHECK(warn_percent BETWEEN 1 AND 100),
      generation INTEGER NOT NULL CHECK(generation > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS model_spend_policies_scope
      ON model_spend_policies(principal_id, COALESCE(profile_id, ''), period);
  `);
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcMonthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function entryFromRow(row: LedgerRow): ModelSpendLedgerEntry {
  return {
    leaseId: row.lease_id,
    principalId: row.principal_id,
    profileKey: row.profile_key,
    revisionId: row.revision_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    dayKey: row.day_key,
    monthKey: row.month_key,
    reservedMicros: row.reserved_micros,
    state: row.state,
    chargedMicros: row.charged_micros,
    gatewayBootId: row.gateway_boot_id,
    createdAt: row.created_at,
    settledAt: row.settled_at
  };
}

function policyFromRow(row: PolicyRow): ModelSpendPolicy {
  return ModelSpendPolicySchema.parse({
    id: row.id,
    profileId: row.profile_id,
    period: row.period,
    limitMicros: row.limit_micros,
    warnPercent: row.warn_percent,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function reachesWarning(committed: number, policy: PolicyRow): boolean {
  return committed * 100 >= policy.limit_micros * policy.warn_percent;
}

function scopeLabel(policy: PolicyRow): string {
  return policy.profile_id === null ? 'principal' : `profile ${policy.profile_id}`;
}

function defaultLogger(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'warn', time: Date.now(), ...record })}\n`);
}

export class ModelSpendLedger {
  private readonly log: ModelSpendLogger;

  constructor(private readonly database: DatabaseSync, options: { log?: ModelSpendLogger } = {}) {
    this.log = options.log ?? defaultLogger;
    initializeModelSpendSchema(database);
  }

  /**
   * Reserves the run's cost cap, or refuses the spawn with LIMIT_EXCEEDED when
   * any applicable policy would be exceeded. It opens no transaction: the
   * caller runs it inside the spawn's write transaction, so a replay never
   * reserves twice and concurrent spawns are serialised. Returns the threshold
   * crossings to report once that transaction commits.
   */
  admit(input: ModelSpendAdmission): ModelSpendThresholdCrossing[] {
    if (!Number.isSafeInteger(input.reservedMicros) || input.reservedMicros < 0) {
      throw new HarnessError('INVALID_INPUT', 'model spend reservation must be a nonnegative safe integer');
    }
    const dayKey = utcDayKey(input.now);
    const monthKey = utcMonthKey(input.now);
    const crossings: ModelSpendThresholdCrossing[] = [];
    for (const policy of this.applicablePolicies(input.principalId, input.profileKey)) {
      const window = policy.period === 'day' ? dayKey : monthKey;
      const committed = this.committed(policy, window);
      if (committed + input.reservedMicros > policy.limit_micros) {
        const headroom = Math.max(0, policy.limit_micros - committed);
        throw new HarnessError(
          'LIMIT_EXCEEDED',
          `model spend policy (${scopeLabel(policy)}, ${policy.period}) would be exceeded; estimated committed ${committed} of ${policy.limit_micros} micros, `
            + `so at most ${headroom} micros of headroom remain for this run's maxCostMicros of ${input.reservedMicros}. `
            + 'Lower maxCostMicros or wait for open runs to settle; aggregate spend is an estimate',
          429,
          false
        );
      }
      if (!reachesWarning(committed, policy) && reachesWarning(committed + input.reservedMicros, policy)) {
        crossings.push(this.crossing(policy, window));
      }
    }
    this.database.prepare(`INSERT INTO model_spend_ledger
      (lease_id, principal_id, profile_key, revision_id, agent_id, workspace_id, day_key, month_key,
       reserved_micros, state, charged_micros, gateway_boot_id, created_at, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, NULL)`)
      .run(input.leaseId, input.principalId, input.profileKey, input.revisionId, input.agentId, input.workspaceId,
        dayKey, monthKey, input.reservedMicros, input.now);
    return crossings;
  }

  /** Writes one structured line per crossing, with identifiers only. */
  reportThresholds(crossings: readonly ModelSpendThresholdCrossing[]): void {
    for (const crossing of crossings) {
      try {
        this.log({ msg: 'model spend threshold reached', isEstimate: true, ...crossing });
      } catch {
        // A logging failure must never change admission or settlement.
      }
    }
  }

  find(leaseId: string): ModelSpendLedgerEntry | undefined {
    const row = this.database.prepare('SELECT * FROM model_spend_ledger WHERE lease_id=?').get(leaseId) as LedgerRow | undefined;
    return row ? entryFromRow(row) : undefined;
  }

  /**
   * Marks that the lease may now exist in the gateway. From here on a row that
   * cannot be settled from the gateway is charged its whole reservation.
   */
  markIssuing(leaseId: string): void {
    this.database.prepare("UPDATE model_spend_ledger SET state='issuing' WHERE lease_id=? AND state='reserved'").run(leaseId);
  }

  recordGatewayBoot(leaseId: string, gatewayBootId: string): void {
    this.database.prepare("UPDATE model_spend_ledger SET gateway_boot_id=? WHERE lease_id=? AND state='issuing'")
      .run(gatewayBootId, leaseId);
  }

  /**
   * Closes an open row from a revoke outcome:
   * - a settlement from the gateway that issued the lease settles it at the
   *   settlement cost, which may exceed the reservation on overrun, and at no
   *   less than the reservation when any request reported no usage;
   * - no settlement before the lease could exist releases it at zero;
   * - no settlement after that, or a settlement from another gateway boot,
   *   leaves it unreconciled at the reservation.
   * A closed row is never changed again, so a retried revoke is harmless.
   */
  settle(leaseId: string, revocation: AgentLeaseRevocation | undefined, now: number): ModelSpendLedgerEntry | undefined {
    let crossings: ModelSpendThresholdCrossing[] = [];
    const settled = this.immediate(() => {
      const row = this.database.prepare('SELECT * FROM model_spend_ledger WHERE lease_id=?').get(leaseId) as LedgerRow | undefined;
      if (!row) return undefined;
      if (row.state !== 'reserved' && row.state !== 'issuing') return entryFromRow(row);
      const settlement = revocation?.settlement;
      const sameBoot = row.gateway_boot_id === null || revocation?.gatewayBootId === undefined
        || revocation.gatewayBootId === row.gateway_boot_id;
      let state: ModelSpendLedgerState;
      let charged: number;
      if (settlement && settlement.leaseId === leaseId && sameBoot) {
        state = 'settled';
        charged = settlement.requestsWithoutUsage > 0
          ? Math.max(settlement.costMicros, row.reserved_micros)
          : settlement.costMicros;
      } else if (row.state === 'reserved' && !settlement) {
        state = 'released';
        charged = 0;
      } else {
        state = 'unreconciled';
        charged = row.reserved_micros;
      }
      const policies = this.applicablePolicies(row.principal_id, row.profile_key);
      const before = policies.map((policy) => this.committed(policy, this.windowOf(policy, row)));
      const tokens = state === 'settled' && settlement ? settlement : undefined;
      this.database.prepare(`UPDATE model_spend_ledger SET state=?, charged_micros=?, settled_at=?,
        prompt_tokens=?, cache_read_tokens=?, cache_write_tokens=?, output_tokens=?, reasoning_tokens=?
        WHERE lease_id=?`)
        .run(state, charged, now,
          tokens?.promptTokens ?? null, tokens?.cacheReadTokens ?? null, tokens?.cacheWriteTokens ?? null,
          tokens?.outputTokens ?? null, tokens?.reasoningTokens ?? null, leaseId);
      crossings = policies.flatMap((policy, index) => {
        const window = this.windowOf(policy, row);
        return !reachesWarning(before[index]!, policy) && reachesWarning(this.committed(policy, window), policy)
          ? [this.crossing(policy, window)]
          : [];
      });
      return entryFromRow(this.database.prepare('SELECT * FROM model_spend_ledger WHERE lease_id=?').get(leaseId) as LedgerRow);
    });
    this.reportThresholds(crossings);
    return settled;
  }

  /** Open rows admitted before `createdBefore`, oldest first. */
  listOpen(createdBefore: number, limit: number): ModelSpendLedgerEntry[] {
    const rows = this.database.prepare(`SELECT * FROM model_spend_ledger
      WHERE state IN ('reserved', 'issuing') AND created_at < ?
      ORDER BY created_at ASC, lease_id ASC LIMIT ?`)
      .all(createdBefore, limit) as LedgerRow[];
    return rows.map(entryFromRow);
  }

  /** Deletes closed rows older than the retention horizon; open rows are never pruned. */
  prune(now: number): number {
    const result = this.database.prepare(`DELETE FROM model_spend_ledger
      WHERE state IN ('settled', 'unreconciled', 'released') AND settled_at < ?`)
      .run(now - MODEL_SPEND_RETENTION_MS);
    return Number(result.changes);
  }

  /** The estimated spend of one window, for the principal or one of its profiles. */
  windowTotals(principalId: string, profileKey: string | null, period: ModelSpendPeriod, now: number): ModelSpendWindowTotals {
    const column = period === 'day' ? 'day_key' : 'month_key';
    const window = period === 'day' ? utcDayKey(now) : utcMonthKey(now);
    const row = this.database.prepare(`SELECT
        COALESCE(SUM(CASE WHEN state='settled' THEN charged_micros ELSE 0 END), 0) AS settled,
        COALESCE(SUM(CASE WHEN state IN ('reserved', 'issuing') THEN reserved_micros ELSE 0 END), 0) AS reserved,
        COALESCE(SUM(CASE WHEN state='unreconciled' THEN charged_micros ELSE 0 END), 0) AS unreconciled
      FROM model_spend_ledger
      WHERE principal_id=? AND (? IS NULL OR profile_key=?) AND ${column}=?`)
      .get(principalId, profileKey, profileKey, window) as { settled: number; reserved: number; unreconciled: number };
    return {
      settledMicros: row.settled,
      reservedMicros: row.reserved,
      unreconciledMicros: row.unreconciled,
      committedMicros: row.settled + row.reserved + row.unreconciled
    };
  }

  listPolicies(principalId: string): ModelSpendPolicy[] {
    const rows = this.database.prepare(`SELECT * FROM model_spend_policies WHERE principal_id=?
      ORDER BY profile_id IS NOT NULL, profile_id, period`).all(principalId) as PolicyRow[];
    return rows.map(policyFromRow);
  }

  /**
   * Creates or updates the policy for a scope and period. Updating requires the
   * current generation, and creating refuses one, so a lost update or a policy
   * deleted meanwhile is reported as CONFLICT.
   */
  setPolicy(principalId: string, rawInput: unknown, now: number): ModelSpendPolicy {
    const input = ModelSpendPolicyInputSchema.parse(rawInput);
    const profileId = input.profileId ?? null;
    return this.immediate(() => {
      const existing = this.database.prepare(`SELECT * FROM model_spend_policies
        WHERE principal_id=? AND profile_id IS ? AND period=?`).get(principalId, profileId, input.period) as PolicyRow | undefined;
      if (existing) {
        if (input.expectedGeneration !== existing.generation) {
          throw new HarnessError('CONFLICT', 'model spend policy changed; reload it and retry', 409, false);
        }
        this.database.prepare(`UPDATE model_spend_policies SET limit_micros=?, warn_percent=?, generation=generation+1, updated_at=?
          WHERE id=?`)
          .run(input.limitMicros, input.warnPercent ?? existing.warn_percent, now, existing.id);
        return this.requirePolicy(principalId, existing.id);
      }
      if (input.expectedGeneration !== undefined) {
        throw new HarnessError('CONFLICT', 'model spend policy no longer exists; reload and retry', 409, false);
      }
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM model_spend_policies WHERE principal_id=?')
        .get(principalId) as { count: number };
      if (count.count >= MODEL_SPEND_MAX_POLICIES_PER_PRINCIPAL) {
        throw new HarnessError('LIMIT_EXCEEDED', `at most ${MODEL_SPEND_MAX_POLICIES_PER_PRINCIPAL} model spend policies are allowed`, 429, false);
      }
      const id = `msp_${randomBytes(24).toString('base64url')}`;
      this.database.prepare(`INSERT INTO model_spend_policies
        (id, principal_id, profile_id, period, limit_micros, warn_percent, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, principalId, profileId, input.period, input.limitMicros, input.warnPercent ?? MODEL_SPEND_DEFAULT_WARN_PERCENT, now, now);
      return this.requirePolicy(principalId, id);
    });
  }

  deletePolicy(principalId: string, rawInput: unknown): void {
    const input = ModelSpendPolicyDeleteInputSchema.parse(rawInput);
    this.immediate(() => {
      const existing = this.database.prepare('SELECT generation FROM model_spend_policies WHERE principal_id=? AND id=?')
        .get(principalId, input.policyId) as { generation: number } | undefined;
      if (!existing) throw new HarnessError('NOT_FOUND', 'model spend policy was not found', 404, false);
      if (existing.generation !== input.expectedGeneration) {
        throw new HarnessError('CONFLICT', 'model spend policy changed; reload it and retry', 409, false);
      }
      this.database.prepare('DELETE FROM model_spend_policies WHERE principal_id=? AND id=?').run(principalId, input.policyId);
    });
  }

  private requirePolicy(principalId: string, id: string): ModelSpendPolicy {
    const row = this.database.prepare('SELECT * FROM model_spend_policies WHERE principal_id=? AND id=?').get(principalId, id) as PolicyRow;
    return policyFromRow(row);
  }

  /** The principal's own policies and those of the profile, at most four. */
  private applicablePolicies(principalId: string, profileKey: string): PolicyRow[] {
    return this.database.prepare(`SELECT * FROM model_spend_policies
      WHERE principal_id=? AND (profile_id IS NULL OR profile_id=?)
      ORDER BY profile_id IS NOT NULL, period`).all(principalId, profileKey) as PolicyRow[];
  }

  private committed(policy: PolicyRow, window: string): number {
    const column = policy.period === 'day' ? 'day_key' : 'month_key';
    const row = this.database.prepare(`SELECT COALESCE(SUM(COALESCE(charged_micros, reserved_micros)), 0) AS committed
      FROM model_spend_ledger
      WHERE principal_id=? AND (? IS NULL OR profile_key=?) AND ${column}=? AND state <> 'released'`)
      .get(policy.principal_id, policy.profile_id, policy.profile_id, window) as { committed: number };
    return row.committed;
  }

  private windowOf(policy: PolicyRow, row: LedgerRow): string {
    return policy.period === 'day' ? row.day_key : row.month_key;
  }

  private crossing(policy: PolicyRow, window: string): ModelSpendThresholdCrossing {
    return {
      policyId: policy.id,
      principalId: policy.principal_id,
      profileId: policy.profile_id,
      period: policy.period,
      window,
      warnPercent: policy.warn_percent
    };
  }

  private immediate<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
