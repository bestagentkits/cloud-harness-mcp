import type { DatabaseSync } from 'node:sqlite';

/**
 * Creates the agent execution-policy tables. Additive and idempotent, with no schema version bump and
 * no foreign keys, so an older release ignores them and a code-only rollback needs no data change.
 *
 * Revisions are immutable: a save or a rollback appends a row and moves the head. `project_id` is ''
 * for the global scope so the head primary key stays unique without NULL semantics.
 */
export function initializeAgentPolicySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_policy_revisions (
      revision_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      document_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL CHECK(created_by IN ('owner')),
      rollback_of TEXT,
      note TEXT,
      CHECK((scope = 'global') = (project_id = '')),
      UNIQUE(principal_id, scope, project_id, version)
    );
    CREATE TABLE IF NOT EXISTS agent_policy_heads (
      principal_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
      project_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id, scope, project_id)
    );
  `);
}
