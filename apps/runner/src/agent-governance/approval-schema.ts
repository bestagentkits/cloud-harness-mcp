import type { DatabaseSync } from 'node:sqlite';

/**
 * Owner approvals of coding workflow steps. One row per pause: the step's idempotency key and receipt,
 * the exact descriptor and its digest, the gate decision and pinned policy revisions, and the workflow's
 * pause counter. Like receipts, rows carry no foreign key and are purged with their workflow's retention.
 */
export function initializeAgentApprovalSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_action_approvals (
      approval_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      step TEXT NOT NULL,
      step_key TEXT NOT NULL,
      descriptor_digest TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      policy_revision_json TEXT NOT NULL,
      advisor_decision_id TEXT,
      generation INTEGER NOT NULL CHECK(generation > 0),
      diff_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL CHECK(state IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CONSUMED')),
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT CHECK(decided_by IS NULL OR decided_by IN ('owner', 'system')),
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_action_approvals_principal ON agent_action_approvals(principal_id, state, expires_at);
    CREATE INDEX IF NOT EXISTS agent_action_approvals_workflow ON agent_action_approvals(workflow_id, step_key);
  `);
}
