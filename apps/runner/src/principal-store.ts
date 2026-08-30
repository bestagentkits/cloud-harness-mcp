import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RunnerPrincipalSelectorSchema,
  type ExternalPrincipal,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';

export type ExternalPrincipalSelector = ExternalPrincipal & { kind: 'external' };
export type PrincipalSelector = RunnerPrincipalSelector;

export type PrincipalRecord = {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  legacyOwnerId: string | null;
};

export type PrincipalRelinkMapping = {
  oldIssuer: string;
  oldSubject: string;
  newIssuer: string;
  newSubject: string;
};

export type PrincipalRelinkResult = PrincipalRelinkMapping & {
  principalId: string;
  status: 'applied' | 'already-applied';
};

type PrincipalRow = {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  legacy_owner_id: string | null;
};

type PrincipalRelinkRow = {
  old_issuer: string;
  old_subject: string;
  new_issuer: string;
  new_subject: string;
  principal_id: string;
};

const ownerBearerIssuer = 'https://owner-bearer.invalid';

const fromRow = (row: PrincipalRow): PrincipalRecord => ({
  id: row.id,
  issuer: row.issuer,
  subject: row.subject,
  email: row.email,
  name: row.name,
  legacyOwnerId: row.legacy_owner_id
});

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function migratePrincipalSchema(database: DatabaseSync): void {
  const rows = database.prepare('SELECT version FROM schema_meta').all() as { version: number }[];
  if (rows.length !== 1) throw new Error('invalid state schema metadata');
  if (rows[0]!.version === 1) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE principals (
          id TEXT PRIMARY KEY,
          issuer TEXT NOT NULL,
          subject TEXT NOT NULL,
          email TEXT,
          name TEXT,
          legacy_owner_id TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(issuer, subject)
        );
        UPDATE schema_meta SET version = 2;
      `);
    });
  }
  let version = (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
  if (version === 2) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE principal_relinks (
          old_issuer TEXT NOT NULL,
          old_subject TEXT NOT NULL,
          new_issuer TEXT NOT NULL,
          new_subject TEXT NOT NULL,
          principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          applied_at INTEGER NOT NULL,
          PRIMARY KEY(old_issuer, old_subject),
          UNIQUE(new_issuer, new_subject)
        );
        UPDATE schema_meta SET version = 3;
      `);
    });
    version = 3;
  }
  if (version === 3) {
    transaction(database, () => {
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_id_id ON workspaces(owner_id, id);

        CREATE TABLE IF NOT EXISTS repo_caches (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          repository_url TEXT NOT NULL,
          repository_url_hash TEXT NOT NULL,
          cache_path TEXT NOT NULL,
          default_branch TEXT,
          last_fetched_at INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('INITIALIZING', 'READY', 'UPDATING', 'FAILED', 'DISABLED')),
          generation INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(owner_id, repository_url_hash)
        );
        CREATE INDEX IF NOT EXISTS repo_caches_owner_lookup ON repo_caches(owner_id, repository_url_hash);

        CREATE TABLE IF NOT EXISTS durable_tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          name TEXT,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL DEFAULT '.',
          status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED')),
          idempotency_key TEXT,
          request_fingerprint TEXT,
          boot_id TEXT NOT NULL,
          exit_code INTEGER,
          error_code TEXT,
          error_message TEXT,
          timeout_ms INTEGER NOT NULL DEFAULT 300000,
          max_bytes INTEGER NOT NULL DEFAULT 67108864,
          log_path TEXT NOT NULL,
          output_bytes INTEGER NOT NULL DEFAULT 0,
          output_artifact_id TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          generation INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          UNIQUE(owner_id, workspace_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS durable_tasks_workspace_created ON durable_tasks(owner_id, workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS durable_tasks_boot_status ON durable_tasks(boot_id, status);

        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          depends_on_task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          PRIMARY KEY(task_id, depends_on_task_id)
        );

        CREATE TABLE IF NOT EXISTS git_operation_idempotency (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('push', 'commit', 'finalize')),
          request_fingerprint TEXT NOT NULL,
          target_ref TEXT,
          expected_remote_oid TEXT,
          local_commit_sha TEXT,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCEEDED', 'UNKNOWN_REMOTE_STATE', 'CONFLICT', 'FAILED')),
          result_json TEXT,
          error_json TEXT,
          created_at INTEGER NOT NULL,
          finished_at INTEGER,
          PRIMARY KEY(owner_id, workspace_id, idempotency_key),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS git_op_idempotency_lookup ON git_operation_idempotency(owner_id, workspace_id, operation, created_at DESC);

        INSERT OR IGNORE INTO git_operation_idempotency (
          owner_id, workspace_id, idempotency_key, operation, request_fingerprint,
          status, result_json, created_at, finished_at
        )
        SELECT f.owner_id, f.workspace_id, f.idempotency_key, 'finalize', '',
          'SUCCEEDED', f.result_json, f.created_at, f.created_at
        FROM finalize_idempotency f
        WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = f.owner_id AND w.id = f.workspace_id)
          AND EXISTS (SELECT 1 FROM principals p WHERE p.id = f.owner_id);
        UPDATE schema_meta SET version = 4;
      `);
    });
    version = 4;
  }
  if (version === 4) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope IN ('owner','repository','workspace')),
          repository_key TEXT,
          workspace_id TEXT,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation > 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          deleted_at INTEGER,
          provenance_json TEXT NOT NULL,
          CHECK (
            (scope='owner' AND repository_key IS NULL AND workspace_id IS NULL) OR
            (scope='repository' AND repository_key IS NOT NULL AND workspace_id IS NULL) OR
            (scope='workspace' AND workspace_id IS NOT NULL)
          ),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS memories_owner_active ON memories(principal_id, name) WHERE deleted_at IS NULL AND scope='owner';
        CREATE UNIQUE INDEX IF NOT EXISTS memories_repo_active ON memories(principal_id, repository_key, name) WHERE deleted_at IS NULL AND scope='repository';
        CREATE UNIQUE INDEX IF NOT EXISTS memories_ws_active ON memories(principal_id, workspace_id, name) WHERE deleted_at IS NULL AND scope='workspace';
        CREATE INDEX IF NOT EXISTS memories_expiry ON memories(expires_at, deleted_at);
        CREATE INDEX IF NOT EXISTS memories_principal_lookup ON memories(principal_id, scope, updated_at DESC);

        CREATE TABLE IF NOT EXISTS memory_tags (
          principal_id TEXT NOT NULL,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          PRIMARY KEY(principal_id, memory_id, tag)
        );
        CREATE INDEX IF NOT EXISTS memory_tags_lookup ON memory_tags(principal_id, tag, memory_id);

        CREATE TABLE IF NOT EXISTS hook_activations (
          principal_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          event TEXT NOT NULL,
          manifest_sha256 TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY(principal_id, workspace_id, event),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        UPDATE schema_meta SET version = 5;
      `);
    });
    version = 5;
  }
  if (version === 5) {
    const cols = (database.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
    if (cols.includes('network_profile') && !cols.includes('network_mode')) {
      transaction(database, () => { database.exec('UPDATE schema_meta SET version = 6;'); });
      version = 6;
    }
  }
  if (version === 5) {
    database.exec('PRAGMA foreign_keys = OFF;');
    try {
      transaction(database, () => {
        const invalidRows = database.prepare("SELECT COUNT(*) as c FROM workspaces WHERE network_mode NOT IN ('none', 'bridge', 'network-none', 'dependency-access')").get() as { c: number } | undefined;
        if (invalidRows && invalidRows.c > 0) {
          throw new Error('invalid legacy network_mode in migration');
        }
        database.exec(`
          CREATE TABLE workspaces_v6 (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            repository_url TEXT NOT NULL,
            repository_ref TEXT,
            container_name TEXT,
            workspace_path TEXT NOT NULL,
            environment_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('CREATING', 'ACTIVE', 'REAPING', 'CLOSED', 'FAILED', 'EXPIRED_RECOVERABLE', 'NETWORK_QUARANTINED')),
            network_profile TEXT NOT NULL CHECK(network_profile IN ('network-none', 'dependency-access')),
            created_at INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            hard_expires_at INTEGER,
            git_author_name TEXT,
            git_author_email TEXT,
            mutation_locked_until INTEGER,
            mutation_lock_count INTEGER NOT NULL DEFAULT 0,
            generation INTEGER NOT NULL DEFAULT 1,
            error TEXT,
            UNIQUE(owner_id, idempotency_key),
            UNIQUE(owner_id, id)
          );

          INSERT INTO workspaces_v6
            (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, environment_id, status, network_profile, created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, mutation_lock_count, generation, error)
          SELECT
            id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, environment_id, status,
            CASE
              WHEN network_mode = 'bridge' THEN 'dependency-access'
              WHEN network_mode = 'none' THEN 'network-none'
              WHEN network_mode = 'dependency-access' THEN 'dependency-access'
              WHEN network_mode = 'network-none' THEN 'network-none'
            END,
            created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, COALESCE(mutation_lock_count, 0), generation, error
          FROM workspaces;

          DROP TABLE workspaces;
          ALTER TABLE workspaces_v6 RENAME TO workspaces;

          CREATE UNIQUE INDEX IF NOT EXISTS one_active_workspace_per_owner
            ON workspaces(owner_id)
            WHERE status IN ('CREATING','ACTIVE','REAPING','NETWORK_QUARANTINED');
          CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_id_id
            ON workspaces(owner_id, id);

          UPDATE schema_meta SET version = 6;
        `);
        const fkViolations = database.prepare('PRAGMA foreign_key_check').all();
        if (fkViolations.length > 0) {
          throw new Error(`foreign key integrity check failed after schema v6 migration: ${JSON.stringify(fkViolations)}`);
        }
      });
      version = 6;
    } finally {
      database.exec('PRAGMA foreign_keys = ON;');
    }
  }
  if (version === 6) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS runtime_epochs (
          instance_id TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          workspace_generation INTEGER NOT NULL,
          parent_agent_id TEXT,
          parent_generation INTEGER,
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          proxy_operations_json TEXT NOT NULL,
          max_ttl_seconds INTEGER NOT NULL,
          max_output_bytes INTEGER NOT NULL,
          max_input_tokens INTEGER NOT NULL,
          max_output_tokens INTEGER NOT NULL,
          max_cost_micros INTEGER NOT NULL,
          container_name TEXT NOT NULL,
          network_name TEXT NOT NULL,
          gateway_lease_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('SPAWNING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED')),
          generation INTEGER NOT NULL,
          runner_epoch INTEGER NOT NULL DEFAULT 1,
          spawn_admission_open INTEGER NOT NULL DEFAULT 1,
          message_admission_open INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          terminal_at INTEGER,
          expires_at INTEGER NOT NULL,
          terminal_reason TEXT,
          cleanup_reason TEXT,
          outcome_unknown INTEGER NOT NULL DEFAULT 0,
          UNIQUE(owner_id, workspace_id, idempotency_key),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS agents_workspace_lookup ON agents(owner_id, workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS agents_parent_lookup ON agents(owner_id, workspace_id, parent_agent_id);
        CREATE TABLE IF NOT EXISTS agent_workspace_admission (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          workspace_generation INTEGER NOT NULL,
          spawn_open INTEGER NOT NULL DEFAULT 1,
          message_open INTEGER NOT NULL DEFAULT 1,
          lifetime_records INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(owner_id, workspace_id),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_messages (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_generation INTEGER NOT NULL,
          runner_epoch INTEGER NOT NULL DEFAULT 1,
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('steer', 'followUp')),
          state TEXT NOT NULL CHECK(state IN ('RESERVED', 'SENT', 'REJECTED', 'UNKNOWN')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          error TEXT,
          PRIMARY KEY(owner_id, workspace_id, agent_id, idempotency_key),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_effects (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_generation INTEGER NOT NULL,
          runner_epoch INTEGER NOT NULL,
          request_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('INTENT', 'DISPATCHED', 'APPLIED', 'REJECTED', 'UNKNOWN')),
          reserved_input_tokens INTEGER NOT NULL DEFAULT 0,
          reserved_output_tokens INTEGER NOT NULL DEFAULT 0,
          reserved_cost_micros INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(agent_id, agent_generation, request_id, kind),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_usage (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_generation INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_micros INTEGER NOT NULL DEFAULT 0,
          output_bytes INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          tool_time_ms INTEGER NOT NULL DEFAULT 0,
          wall_time_ms INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_log_watermarks (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_generation INTEGER NOT NULL,
          retained_base_cursor INTEGER NOT NULL DEFAULT 0,
          next_cursor INTEGER NOT NULL DEFAULT 0,
          retained_bytes INTEGER NOT NULL DEFAULT 0,
          retained_events INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_log_chunks (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_generation INTEGER NOT NULL,
          cursor_start INTEGER NOT NULL,
          cursor_end INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          content TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation, cursor_start),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_cleanup_retries (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_generation INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE,
          FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_tombstones (
          owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY(owner_id, workspace_id, agent_id),
          UNIQUE(owner_id, workspace_id, idempotency_key),
          FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS agent_tombstones_expiry ON agent_tombstones(expires_at);

        UPDATE schema_meta SET version = 7;
      `);
    });
    version = 7;
  }
  if (version !== 7) throw new Error(`unsupported state schema version ${version}`);
}

export function downgradeStateSchemaToV6(database: DatabaseSync): void {
  const version = (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
  if (version !== 7) throw new Error(`state schema must be version 7 before downgrade, got ${version}`);
  transaction(database, () => {
    database.exec(`
      DROP TABLE IF EXISTS agent_tombstones;
      DROP TABLE IF EXISTS agent_cleanup_retries;
      DROP TABLE IF EXISTS agent_log_chunks;
      DROP TABLE IF EXISTS agent_log_watermarks;
      DROP TABLE IF EXISTS agent_usage;
      DROP TABLE IF EXISTS agent_effects;
      DROP TABLE IF EXISTS agent_messages;
      DROP TABLE IF EXISTS agent_workspace_admission;
      DROP TABLE IF EXISTS agents;
      DROP TABLE IF EXISTS runtime_epochs;
      UPDATE schema_meta SET version = 6;
    `);
  });
}

export function downgradeStateSchemaToV5(database: DatabaseSync): void {
  let version = (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
  if (version === 7) {
    downgradeStateSchemaToV6(database);
    version = 6;
  }
  if (version !== 6) throw new Error(`state schema must be version 6 before downgrade, got ${version}`);
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE workspaces_v5 (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          repository_url TEXT NOT NULL,
          repository_ref TEXT,
          container_name TEXT,
          workspace_path TEXT NOT NULL,
          environment_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('CREATING', 'ACTIVE', 'REAPING', 'CLOSED', 'FAILED', 'EXPIRED_RECOVERABLE', 'NETWORK_QUARANTINED')),
          network_mode TEXT NOT NULL CHECK(network_mode IN ('none', 'bridge')),
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          hard_expires_at INTEGER,
          git_author_name TEXT,
          git_author_email TEXT,
          mutation_locked_until INTEGER,
          mutation_lock_count INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT 1,
          error TEXT,
          UNIQUE(owner_id, idempotency_key),
          UNIQUE(owner_id, id)
        );

        INSERT INTO workspaces_v5
          (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, environment_id, status, network_mode, created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, mutation_lock_count, generation, error)
        SELECT
          id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, environment_id, status,
          CASE
            WHEN network_profile = 'dependency-access' THEN 'bridge'
            ELSE 'none'
          END,
          created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, mutation_lock_count, generation, error
        FROM workspaces;

        DROP TABLE workspaces;
        ALTER TABLE workspaces_v5 RENAME TO workspaces;

        CREATE UNIQUE INDEX IF NOT EXISTS one_active_workspace_per_owner
          ON workspaces(owner_id)
          WHERE status IN ('CREATING','ACTIVE','REAPING','NETWORK_QUARANTINED');
        CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_id_id
          ON workspaces(owner_id, id);

        UPDATE schema_meta SET version = 5;
      `);
    });
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

export function downgradeStateSchemaToV4(database: DatabaseSync, allowDataLoss = false): void {
  let version = (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
  if (version === 7) {
    downgradeStateSchemaToV6(database);
    version = 6;
  }
  if (version === 6) {
    downgradeStateSchemaToV5(database);
    version = 5;
  }
  if (version !== 5) throw new Error(`state schema must be version 5 before downgrade, got ${version}`);
  if (!allowDataLoss) {
    const memCount = (database.prepare('SELECT count(*) as count FROM memories').get() as { count: number }).count;
    const hookCount = (database.prepare('SELECT count(*) as count FROM hook_activations').get() as { count: number }).count;
    if (memCount > 0 || hookCount > 0) {
      throw new Error('cannot downgrade state schema to v4: feature tables contain active records (export or discard required)');
    }
  }
  transaction(database, () => {
    database.exec(`
      DROP TABLE IF EXISTS hook_activations;
      DROP TABLE IF EXISTS memory_tags;
      DROP TABLE IF EXISTS memories;
      DROP INDEX IF EXISTS memories_owner_active;
      DROP INDEX IF EXISTS memories_repo_active;
      DROP INDEX IF EXISTS memories_ws_active;
      DROP INDEX IF EXISTS memories_expiry;
      DROP INDEX IF EXISTS memories_principal_lookup;
      UPDATE schema_meta SET version = 4;
    `);
  });
}

export function downgradeStateSchemaToV3(database: DatabaseSync): void {
  let version = (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
  if (version === 7) {
    downgradeStateSchemaToV6(database);
    version = 6;
  }
  if (version === 6) {
    downgradeStateSchemaToV5(database);
    version = 5;
  }
  if (version === 5) {
    downgradeStateSchemaToV4(database, true);
    version = 4;
  }
  if (version !== 4) throw new Error(`state schema must be version 4 before downgrade, got ${version}`);
  transaction(database, () => {
    database.exec(`
      DROP TABLE IF EXISTS git_operation_idempotency;
      DROP TABLE IF EXISTS task_dependencies;
      DROP TABLE IF EXISTS durable_tasks;
      DROP TABLE IF EXISTS repo_caches;
      DROP INDEX IF EXISTS workspaces_owner_id_id;
      UPDATE schema_meta SET version = 3;
    `);
  });
}
export function applyPrincipalRelinks(
  database: DatabaseSync,
  mappings: PrincipalRelinkMapping[],
  onApplied?: (database: DatabaseSync, result: PrincipalRelinkResult) => void
): PrincipalRelinkResult[] {
  return transaction(database, () => mappings.map((mapping) => {
    const result = applyPrincipalRelinkInTransaction(database, mapping);
    if (result.status === 'applied') onApplied?.(database, result);
    return result;
  }));
}

function applyPrincipalRelinkInTransaction(
  database: DatabaseSync,
  mapping: PrincipalRelinkMapping
): PrincipalRelinkResult {
  const prior = database.prepare('SELECT * FROM principal_relinks WHERE old_issuer = ? AND old_subject = ?')
    .get(mapping.oldIssuer, mapping.oldSubject) as PrincipalRelinkRow | undefined;
  if (prior) {
    if (prior.new_issuer !== mapping.newIssuer || prior.new_subject !== mapping.newSubject) {
      throw new Error('principal relink source was already mapped to a different target');
    }
    if (!database.prepare('SELECT 1 FROM principals WHERE id = ?').get(prior.principal_id)) {
      throw new Error('principal relink ledger references a missing principal');
    }
    return { ...mapping, principalId: prior.principal_id, status: 'already-applied' };
  }

  const source = principalByExternalIdentity(database, { issuer: mapping.oldIssuer, subject: mapping.oldSubject });
  if (!source) throw new Error('principal relink source identity does not exist');
  if (principalByExternalIdentity(database, { issuer: mapping.newIssuer, subject: mapping.newSubject })) {
    throw new Error('principal relink target identity already exists');
  }

  const now = Date.now();
  database.prepare('UPDATE principals SET issuer = ?, subject = ?, updated_at = ? WHERE id = ?')
    .run(mapping.newIssuer, mapping.newSubject, now, source.id);
  database.prepare(`INSERT INTO principal_relinks
    (old_issuer, old_subject, new_issuer, new_subject, principal_id, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    mapping.oldIssuer, mapping.oldSubject, mapping.newIssuer, mapping.newSubject, source.id, now
  );
  return { ...mapping, principalId: source.id, status: 'applied' };
}

export function principalByExternalIdentity(
  database: DatabaseSync,
  selector: Pick<ExternalPrincipalSelector, 'issuer' | 'subject'>
): PrincipalRecord | undefined {
  const row = database.prepare('SELECT * FROM principals WHERE issuer = ? AND subject = ?')
    .get(selector.issuer, selector.subject) as PrincipalRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function principalByLegacyOwnerId(database: DatabaseSync, legacyOwnerId: string): PrincipalRecord | undefined {
  const row = database.prepare('SELECT * FROM principals WHERE legacy_owner_id = ?')
    .get(legacyOwnerId) as PrincipalRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function resolveOwnerPrincipal(database: DatabaseSync, ownerId: string): string {
  if (!ownerId || ownerId.length > 100) throw new Error('invalid owner identity');
  return transaction(database, () => {
    if (database.prepare('SELECT 1 FROM principals WHERE id = ?').get(ownerId)) return ownerId;
    const existing = principalByLegacyOwnerId(database, ownerId);
    if (existing) return existing.id;

    const principalId = `prn_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    database.prepare(`INSERT INTO principals
      (id, issuer, subject, email, name, legacy_owner_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`).run(
      principalId, ownerBearerIssuer, ownerId, ownerId, now, now
    );
    database.prepare('UPDATE workspaces SET owner_id = ? WHERE owner_id = ?').run(principalId, ownerId);
    return principalId;
  });
}

export function resolveExternalPrincipal(
  database: DatabaseSync,
  selector: ExternalPrincipalSelector,
  options: { legacyOwnerId?: string } = {}
): string {
  const parsed = RunnerPrincipalSelectorSchema.parse(selector) as ExternalPrincipalSelector;
  const legacyOwnerId = options.legacyOwnerId;
  if (legacyOwnerId !== undefined && (!legacyOwnerId || legacyOwnerId.length > 100)) throw new Error('invalid legacy owner mapping');

  return transaction(database, () => resolveExternalPrincipalInTransaction(database, parsed, legacyOwnerId));
}

function resolveExternalPrincipalInTransaction(
  database: DatabaseSync,
  selector: ExternalPrincipalSelector,
  legacyOwnerId?: string
): string {
  const existing = principalByExternalIdentity(database, selector);
  if (legacyOwnerId !== undefined && existing?.legacyOwnerId && existing.legacyOwnerId !== legacyOwnerId) {
    throw new Error('external identity is already mapped to a different legacy owner');
  }
  const now = Date.now();
  if (existing) {
    database.prepare(`UPDATE principals
      SET email = COALESCE(?, email), name = COALESCE(?, name), updated_at = ?
      WHERE id = ?`).run(selector.email ?? null, selector.name ?? null, now, existing.id);
    if (legacyOwnerId && !existing.legacyOwnerId) {
      database.prepare('UPDATE principals SET legacy_owner_id = ?, updated_at = ? WHERE id = ?')
        .run(legacyOwnerId, now, existing.id);
      database.prepare('UPDATE workspaces SET owner_id = ? WHERE owner_id = ?').run(existing.id, legacyOwnerId);
    }
    return existing.id;
  }

  if (legacyOwnerId) {
    const legacy = principalByLegacyOwnerId(database, legacyOwnerId);
    if (legacy) {
      if (legacy.issuer !== ownerBearerIssuer || legacy.subject !== legacyOwnerId) {
        throw new Error('legacy owner is already mapped to a different external identity');
      }
      database.prepare(`UPDATE principals
        SET issuer = ?, subject = ?, email = ?, name = ?, updated_at = ?
        WHERE id = ?`).run(
        selector.issuer, selector.subject, selector.email ?? null, selector.name ?? null, now, legacy.id
      );
      return legacy.id;
    }
  }

  const principalId = `prn_${randomBytes(24).toString('base64url')}`;
  database.prepare(`INSERT INTO principals
    (id, issuer, subject, email, name, legacy_owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    principalId, selector.issuer, selector.subject, selector.email ?? null, selector.name ?? null,
    legacyOwnerId ?? null, now, now
  );
  if (legacyOwnerId) {
    database.prepare('UPDATE workspaces SET owner_id = ? WHERE owner_id = ?').run(principalId, legacyOwnerId);
    try {
      database.prepare('UPDATE finalize_idempotency SET owner_id = ? WHERE owner_id = ?').run(principalId, legacyOwnerId);
      database.prepare(`
        INSERT OR IGNORE INTO git_operation_idempotency (
          owner_id, workspace_id, idempotency_key, operation, request_fingerprint,
          status, result_json, created_at, finished_at
        )
        SELECT f.owner_id, f.workspace_id, f.idempotency_key, 'finalize', '',
          'SUCCEEDED', f.result_json, f.created_at, f.created_at
        FROM finalize_idempotency f
        WHERE f.owner_id = ?
          AND EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = f.owner_id AND w.id = f.workspace_id)
          AND EXISTS (SELECT 1 FROM principals p WHERE p.id = f.owner_id);
      `).run(principalId);
    } catch { /* ignore if tables do not exist yet */ }
  }
  return principalId;
}

export function applyLegacyPrincipalMapping(
  database: DatabaseSync,
  mapping: { legacyOwnerId: string; issuer: string; subject: string }
): string {
  const selector = RunnerPrincipalSelectorSchema.parse({
    kind: 'external', issuer: mapping.issuer, subject: mapping.subject
  }) as ExternalPrincipalSelector;
  if (!mapping.legacyOwnerId || mapping.legacyOwnerId.length > 100) throw new Error('invalid legacy owner mapping');
  return transaction(database, () => {
    const principalId = resolveExternalPrincipalInTransaction(database, selector, mapping.legacyOwnerId);
    const unmapped = database.prepare(`SELECT 1
      FROM workspaces
      LEFT JOIN principals ON principals.id = workspaces.owner_id
      WHERE principals.id IS NULL
      LIMIT 1`).get();
    if (unmapped) throw new Error('unmapped legacy workspace owners remain');
    return principalId;
  });
}
