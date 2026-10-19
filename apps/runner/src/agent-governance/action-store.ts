import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CodingActionOutcomeSchema,
  CodingActionReceiptSchema,
  CODING_LIMITS,
  type AgentActionDescriptor,
  type CodingActionOrigin,
  type CodingActionOutcome,
  type CodingActionReceipt,
  type CodingActionState,
  type CodingActionStep,
  type GateDecision
} from '@cloud-harness/contracts';
import { initializeCodingActionSchema } from './action-schema.js';

type ActionRow = {
  action_id: string; principal_id: string; workflow_id: string; workspace_id: string | null; agent_id: string | null;
  agent_generation: number | null; idempotency_key: string; origin: CodingActionOrigin; step: CodingActionStep;
  action_class: string; descriptor_json: string; descriptor_digest: string | null; decision: GateDecision['decision'];
  reason_code: string; decision_json: string | null; project_id: string | null; global_revision_id: string | null;
  project_revision_id: string | null; state: CodingActionState; outcome_json: string; trace_id: string | null;
  span_id: string | null; created_at: number; updated_at: number;
};

export type CodingActionRecord = {
  actionId: string;
  principalId: string;
  workflowId: string;
  idempotencyKey: string;
  step: CodingActionStep;
  state: CodingActionState;
  decision: GateDecision['decision'];
  reasonCode: string;
  outcome: CodingActionOutcome;
  descriptor: AgentActionDescriptor;
  agentId: string | null;
  agentGeneration: number | null;
  createdAt: number;
};

export type NewCodingAction = {
  principalId: string;
  workflowId: string;
  workspaceId: string | null;
  agentId: string | null;
  agentGeneration: number | null;
  idempotencyKey: string;
  origin: CodingActionOrigin;
  step: CodingActionStep;
  descriptor: AgentActionDescriptor;
  projectId: string | null;
  /** The gate decision; null only for refusals decided before the gate (kill switch, unsupported input). */
  decision: GateDecision | null;
  /** Decision and reason recorded when `decision` is null. */
  refusal?: { reasonCode: string } | undefined;
  state: Extract<CodingActionState, 'INTENT' | 'REJECTED'>;
  outcome?: CodingActionOutcome | undefined;
};

const iso = (value: number) => new Date(value).toISOString();

function recordOf(row: ActionRow): CodingActionRecord {
  return {
    actionId: row.action_id, principalId: row.principal_id, workflowId: row.workflow_id, idempotencyKey: row.idempotency_key,
    step: row.step, state: row.state, decision: row.decision, reasonCode: row.reason_code,
    outcome: CodingActionOutcomeSchema.parse(JSON.parse(row.outcome_json)),
    descriptor: JSON.parse(row.descriptor_json) as AgentActionDescriptor,
    agentId: row.agent_id, agentGeneration: row.agent_generation, createdAt: row.created_at
  };
}

/**
 * Durable action receipts with compare-and-set state transitions. A receipt is keyed by
 * (principal, workflow, idempotency key), so a replayed step finds its first record instead of
 * acting twice; every transition names the states it may leave, so a stale writer changes nothing.
 */
export class CodingActionStore {
  private readonly now: () => number;

  constructor(private readonly database: DatabaseSync, now?: () => number) {
    this.now = now ?? Date.now;
    initializeCodingActionSchema(database);
  }

  /** Inserts the action, or returns the existing record for the same key with `replayed: true`. */
  record(input: NewCodingAction): { record: CodingActionRecord; replayed: boolean } {
    const existing = this.byKey(input.principalId, input.workflowId, input.idempotencyKey);
    if (existing) return { record: existing, replayed: true };
    const now = this.now();
    const actionId = `act_${randomBytes(16).toString('hex')}`;
    const decision = input.decision;
    this.database.prepare(`INSERT INTO coding_actions (action_id, principal_id, workflow_id, workspace_id, agent_id, agent_generation,
      idempotency_key, origin, step, action_class, descriptor_json, descriptor_digest, decision, reason_code, decision_json, project_id,
      global_revision_id, project_revision_id, state, outcome_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      actionId, input.principalId, input.workflowId, input.workspaceId, input.agentId, input.agentGeneration,
      input.idempotencyKey, input.origin, input.step, input.descriptor.actionClass, JSON.stringify(input.descriptor),
      decision?.inputFingerprint ?? null, decision?.decision ?? 'DENY', decision?.reasonCode ?? input.refusal?.reasonCode ?? 'ACTION_DENIED',
      decision ? JSON.stringify(decision) : null, input.projectId, decision?.policy.globalRevisionId ?? null,
      decision?.policy.projectRevisionId ?? null, input.state, JSON.stringify(CodingActionOutcomeSchema.parse(input.outcome ?? {})), now, now
    );
    return { record: this.require(actionId), replayed: false };
  }

  /** Moves the action to `state` only from one of `from`; merges `outcome` into the stored outcome. */
  transition(actionId: string, from: readonly CodingActionState[], state: CodingActionState, outcome?: CodingActionOutcome): boolean {
    const row = this.row(actionId);
    if (!row || !from.includes(row.state)) return false;
    const merged = CodingActionOutcomeSchema.parse({ ...JSON.parse(row.outcome_json) as object, ...(outcome ?? {}) });
    const result = this.database.prepare('UPDATE coding_actions SET state = ?, outcome_json = ?, updated_at = ? WHERE action_id = ? AND state = ?')
      .run(state, JSON.stringify(merged), this.now(), actionId, row.state);
    return Number(result.changes) === 1;
  }

  attachTrace(actionId: string, traceId: string, spanId: string): void {
    this.database.prepare('UPDATE coding_actions SET trace_id = ?, span_id = ? WHERE action_id = ?').run(traceId, spanId, actionId);
  }

  get(actionId: string): CodingActionRecord | undefined {
    const row = this.row(actionId);
    return row ? recordOf(row) : undefined;
  }

  byKey(principalId: string, workflowId: string, idempotencyKey: string): CodingActionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM coding_actions WHERE principal_id = ? AND workflow_id = ? AND idempotency_key = ?')
      .get(principalId, workflowId, idempotencyKey) as ActionRow | undefined;
    return row ? recordOf(row) : undefined;
  }

  /** The workflow's receipts, oldest first, scoped to the principal that owns the workflow. */
  receipts(principalId: string, workflowId: string, limit: number = CODING_LIMITS.maxReceiptsPerWorkflow): CodingActionReceipt[] {
    const rows = this.database.prepare('SELECT * FROM coding_actions WHERE principal_id = ? AND workflow_id = ? ORDER BY created_at, rowid LIMIT ?')
      .all(principalId, workflowId, limit) as ActionRow[];
    return rows.map((row) => {
      const descriptor = JSON.parse(row.descriptor_json) as AgentActionDescriptor;
      // The full gate decision is stored with the receipt; its advisor block carries the Decision Plane id.
      const stored = row.decision_json ? JSON.parse(row.decision_json) as { advisor?: { decisionId?: unknown } } : null;
      const decisionId = typeof stored?.advisor?.decisionId === 'string' ? stored.advisor.decisionId : null;
      return CodingActionReceiptSchema.parse({
        actionId: row.action_id,
        workflowId: row.workflow_id,
        origin: row.origin,
        step: row.step,
        actionClass: row.action_class,
        repository: descriptor.repository,
        branch: descriptor.branch ?? null,
        paths: (descriptor.paths ?? []).slice(0, CODING_LIMITS.maxPathsPerReceipt),
        command: descriptor.command ?? null,
        decision: row.decision,
        reasonCode: row.reason_code,
        state: row.state,
        projectId: row.project_id,
        globalRevisionId: row.global_revision_id,
        projectRevisionId: row.project_revision_id,
        inputFingerprint: row.descriptor_digest,
        decisionId,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        traceId: row.trace_id,
        spanId: row.span_id,
        outcome: JSON.parse(row.outcome_json) as unknown,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
      });
    });
  }

  /** Removes the receipts of workflows that no longer exist, once they are older than the horizon. */
  purgeOrphans(horizon: number): number {
    const result = this.database.prepare(`DELETE FROM coding_actions WHERE updated_at < ?
      AND workflow_id NOT IN (SELECT id FROM automation_workflows)`).run(horizon);
    return Number(result.changes);
  }

  private row(actionId: string): ActionRow | undefined {
    return this.database.prepare('SELECT * FROM coding_actions WHERE action_id = ?').get(actionId) as ActionRow | undefined;
  }

  private require(actionId: string): CodingActionRecord {
    const row = this.row(actionId);
    if (!row) throw new Error('coding action was not recorded');
    return recordOf(row);
  }
}
