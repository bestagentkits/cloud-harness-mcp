import type { DatabaseSync } from 'node:sqlite';

/**
 * Owner approvals of coding workflow steps. One row per pause: the step's idempotency key and receipt,
 * the exact descriptor and its digest, the gate decision and pinned policy revisions, the workflow's
 * pause counter, and the SHA-256 of the change the owner was shown (`content_digest`), which the
 * resumed step must still match. Like receipts, rows carry no foreign key and are purged with their workflow's retention.
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
      content_digest TEXT,
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
  const columns = (database.prepare('PRAGMA table_info(agent_action_approvals)').all() as { name: string }[]).map((column) => column.name);
  if (!columns.includes('content_digest')) database.exec('ALTER TABLE agent_action_approvals ADD COLUMN content_digest TEXT');
  // The sweeper's deadline scan reads PENDING rows by deadline across every principal.
  database.exec('CREATE INDEX IF NOT EXISTS agent_action_approvals_deadline ON agent_action_approvals(state, expires_at)');
}
