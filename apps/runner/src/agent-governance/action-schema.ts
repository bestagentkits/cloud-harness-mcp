import type { DatabaseSync } from 'node:sqlite';

/**
 * Coding action receipts and the coding columns of automation workflows. Receipts carry no foreign
 * key to workspaces, agents or workflows on purpose: they stay readable after the workspace closes and
 * after its agent rows are compacted. They are purged with their workflow's retention.
 */
const WORKFLOW_COLUMNS: readonly [string, string][] = [
  ['project_id', 'TEXT'],
  ['coding_phase', 'TEXT'],
  ['coding_started_at', 'INTEGER'],
  ['policy_revision_json', 'TEXT'],
  ['workspace_generation', 'INTEGER'],
  ['base_oid', 'TEXT'],
  ['branch', 'TEXT'],
  ['commit_sha', 'TEXT'],
  ['pr_number', 'INTEGER'],
  ['pr_url', 'TEXT'],
  ['agent_generation', 'INTEGER'],
  ['trace_id', 'TEXT']
];

export function initializeCodingActionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS coding_actions (
      action_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workspace_id TEXT,
      agent_id TEXT,
      agent_generation INTEGER,
      idempotency_key TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('agent', 'runner')),
      step TEXT NOT NULL,
      action_class TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,
      descriptor_digest TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('ALLOW', 'REQUIRE_APPROVAL', 'DENY')),
      reason_code TEXT NOT NULL,
      decision_json TEXT,
      project_id TEXT,
      global_revision_id TEXT,
      project_revision_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('INTENT', 'DISPATCHED', 'APPLIED', 'REJECTED', 'UNKNOWN', 'BLOCKED')),
      outcome_json TEXT NOT NULL DEFAULT '{}',
      trace_id TEXT,
      span_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(principal_id, workflow_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS coding_actions_workflow ON coding_actions(workflow_id, created_at, action_id);
  `);
  const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_workflows'").get();
  if (!table) return;
  const present = new Set((database.prepare('PRAGMA table_info(automation_workflows)').all() as { name: string }[]).map((column) => column.name));
  for (const [name, type] of WORKFLOW_COLUMNS) {
    if (!present.has(name)) database.exec(`ALTER TABLE automation_workflows ADD COLUMN ${name} ${type}`);
  }
}
