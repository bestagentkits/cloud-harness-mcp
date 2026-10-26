import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AgentApprovalDiffSchema,
  AgentApprovalSummarySchema,
  type AgentActionDescriptor,
  type AgentApprovalDiff,
  type AgentApprovalState,
  type AgentApprovalSummary,
  type CodingActionStep,
  type GateDecision
} from '@cloud-harness/contracts';
import { initializeAgentApprovalSchema } from './approval-schema.js';

type ApprovalRow = {
  approval_id: string; principal_id: string; workflow_id: string; action_id: string; step: CodingActionStep; step_key: string;
  descriptor_digest: string; descriptor_json: string; decision_json: string; policy_revision_json: string;
  advisor_decision_id: string | null; generation: number; diff_json: string; state: AgentApprovalState;
  expires_at: number; decided_at: number | null; decided_by: 'owner' | 'system' | null; consumed_at: number | null; created_at: number;
};

export type AgentApprovalRecord = {
  approvalId: string;
  principalId: string;
  workflowId: string;
  actionId: string;
  step: CodingActionStep;
  /** The idempotency key of the step the gate held back; its resumed run uses a key of its own. */
  stepKey: string;
  descriptorDigest: string;
  descriptor: AgentActionDescriptor;
  gate: GateDecision;
  generation: number;
  diff: AgentApprovalDiff;
  state: AgentApprovalState;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: 'owner' | 'system' | null;
  consumedAt: number | null;
  createdAt: number;
};

export type NewAgentApproval = {
  principalId: string;
  workflowId: string;
  actionId: string;
  step: CodingActionStep;
  stepKey: string;
  descriptor: AgentActionDescriptor;
  gate: GateDecision;
  generation: number;
  diff: AgentApprovalDiff;
  expiresAt: number;
};

const iso = (value: number) => new Date(value).toISOString();

function recordOf(row: ApprovalRow): AgentApprovalRecord {
  return {
    approvalId: row.approval_id, principalId: row.principal_id, workflowId: row.workflow_id, actionId: row.action_id,
    step: row.step, stepKey: row.step_key, descriptorDigest: row.descriptor_digest,
    descriptor: JSON.parse(row.descriptor_json) as AgentActionDescriptor,
    gate: JSON.parse(row.decision_json) as GateDecision,
    generation: row.generation,
    diff: AgentApprovalDiffSchema.catch({ artifactId: null, files: null, additions: null, deletions: null }).parse(JSON.parse(row.diff_json)),
    state: row.state, expiresAt: row.expires_at, decidedAt: row.decided_at, decidedBy: row.decided_by,
    consumedAt: row.consumed_at, createdAt: row.created_at
  };
}

/** The approval as the owner sees it. */
export function approvalSummary(record: AgentApprovalRecord): AgentApprovalSummary {
  return AgentApprovalSummarySchema.parse({
    approvalId: record.approvalId,
    workflowId: record.workflowId,
    actionId: record.actionId,
    step: record.step,
    state: record.state,
    descriptor: record.descriptor,
    descriptorDigest: record.descriptorDigest,
    gate: record.gate,
    generation: record.generation,
    diff: record.diff,
    expiresAt: iso(record.expiresAt),
    decidedAt: record.decidedAt === null ? null : iso(record.decidedAt),
    decidedBy: record.decidedBy,
    consumedAt: record.consumedAt === null ? null : iso(record.consumedAt),
    createdAt: iso(record.createdAt)
  });
}

/**
 * Durable owner approvals with compare-and-set transitions. Every transition names the state it leaves,
 * and a decision also names the principal, the descriptor digest and an unexpired deadline in the same
 * statement, so exactly one decision can change a PENDING row and a stale or late one changes nothing.
 */
export class AgentApprovalStore {
  constructor(private readonly database: DatabaseSync) {
    initializeAgentApprovalSchema(database);
  }

  create(input: NewAgentApproval, now: number): AgentApprovalRecord {
    const approvalId = `apv_${randomBytes(16).toString('hex')}`;
    this.database.prepare(`INSERT INTO agent_action_approvals (approval_id, principal_id, workflow_id, action_id, step, step_key,
      descriptor_digest, descriptor_json, decision_json, policy_revision_json, advisor_decision_id, generation, diff_json, state,
      expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`).run(
      approvalId, input.principalId, input.workflowId, input.actionId, input.step, input.stepKey,
      input.gate.inputFingerprint, JSON.stringify(input.descriptor), JSON.stringify(input.gate),
      JSON.stringify({ globalRevisionId: input.gate.policy.globalRevisionId, projectRevisionId: input.gate.policy.projectRevisionId }),
      input.gate.advisor.decisionId, input.generation, JSON.stringify(AgentApprovalDiffSchema.parse(input.diff)), input.expiresAt, now
    );
    return this.require(approvalId);
  }

  get(approvalId: string): AgentApprovalRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agent_action_approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow | undefined;
    return row ? recordOf(row) : undefined;
  }

  /** The principal's approvals, pending ones first, then newest first. */
  list(principalId: string, input: { state?: AgentApprovalState | undefined; limit: number }): AgentApprovalRecord[] {
    const rows = (input.state
      ? this.database.prepare('SELECT * FROM agent_action_approvals WHERE principal_id = ? AND state = ? ORDER BY created_at DESC, approval_id LIMIT ?')
        .all(principalId, input.state, input.limit)
      : this.database.prepare(`SELECT * FROM agent_action_approvals WHERE principal_id = ?
          ORDER BY CASE state WHEN 'PENDING' THEN 0 ELSE 1 END, created_at DESC, approval_id LIMIT ?`).all(principalId, input.limit)) as ApprovalRow[];
    return rows.map(recordOf);
  }

  /** PENDING to APPROVED or DENIED, only for this principal, this digest and before the deadline. */
  decide(approvalId: string, principalId: string, digest: string, state: 'APPROVED' | 'DENIED', now: number): boolean {
    const result = this.database.prepare(`UPDATE agent_action_approvals SET state = ?, decided_at = ?, decided_by = 'owner'
      WHERE approval_id = ? AND state = 'PENDING' AND principal_id = ? AND descriptor_digest = ? AND expires_at > ?`)
      .run(state, now, approvalId, principalId, digest, now);
    return Number(result.changes) === 1;
  }

  /** PENDING to EXPIRED, decided by the system (deadline, a drained wait, or a workflow that stopped waiting). */
  expire(approvalId: string, now: number): boolean {
    const result = this.database.prepare(`UPDATE agent_action_approvals SET state = 'EXPIRED', decided_at = ?, decided_by = 'system'
      WHERE approval_id = ? AND state = 'PENDING'`).run(now, approvalId);
    return Number(result.changes) === 1;
  }

  /** APPROVED to CONSUMED: the approved action was admitted to run. */
  consume(approvalId: string, now: number): boolean {
    const result = this.database.prepare(`UPDATE agent_action_approvals SET state = 'CONSUMED', consumed_at = ?
      WHERE approval_id = ? AND state = 'APPROVED'`).run(now, approvalId);
    return Number(result.changes) === 1;
  }

  /** The newest approved (or already used) approval of this workflow for the step key, if any. */
  approvedForStep(principalId: string, workflowId: string, stepKey: string): AgentApprovalRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM agent_action_approvals WHERE principal_id = ? AND workflow_id = ? AND step_key = ?
      AND state IN ('APPROVED', 'CONSUMED') ORDER BY created_at DESC, approval_id LIMIT 1`).get(principalId, workflowId, stepKey) as ApprovalRow | undefined;
    return row ? recordOf(row) : undefined;
  }

  /** The newest approved (or already used) approval of this workflow for the descriptor digest, if any. */
  approvedForDigest(principalId: string, workflowId: string, digest: string): AgentApprovalRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM agent_action_approvals WHERE principal_id = ? AND workflow_id = ? AND descriptor_digest = ?
      AND state IN ('APPROVED', 'CONSUMED') ORDER BY created_at DESC, approval_id LIMIT 1`).get(principalId, workflowId, digest) as ApprovalRow | undefined;
    return row ? recordOf(row) : undefined;
  }

  /**
   * PENDING approvals that can no longer be decided: past their deadline, or whose workflow is no longer
   * waiting for them (cancelled, drained, or deleted).
   */
  undecidable(now: number, limit: number): AgentApprovalRecord[] {
    const rows = this.database.prepare(`SELECT a.* FROM agent_action_approvals a
      LEFT JOIN automation_workflows w ON w.id = a.workflow_id
      WHERE a.state = 'PENDING' AND (a.expires_at <= ? OR w.id IS NULL OR w.state != 'WAITING_FOR_HUMAN' OR w.approval_id IS NOT a.approval_id)
      ORDER BY a.expires_at, a.approval_id LIMIT ?`).all(now, limit) as ApprovalRow[];
    return rows.map(recordOf);
  }

  /** Removes the approvals of workflows that no longer exist, once they are older than the horizon. */
  purgeOrphans(horizon: number): number {
    const result = this.database.prepare(`DELETE FROM agent_action_approvals WHERE created_at < ?
      AND workflow_id NOT IN (SELECT id FROM automation_workflows)`).run(horizon);
    return Number(result.changes);
  }

  private require(approvalId: string): AgentApprovalRecord {
    const record = this.get(approvalId);
    if (!record) throw new Error('approval was not recorded');
    return record;
  }
}
