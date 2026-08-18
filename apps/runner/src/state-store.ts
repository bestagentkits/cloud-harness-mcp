import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type WorkspaceRecord = {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  repositoryUrl: string;
  repositoryRef: string | null;
  containerName: string | null;
  workspacePath: string;
  status: 'CREATING' | 'ACTIVE' | 'REAPING' | 'CLOSED' | 'FAILED';
  networkMode: 'none' | 'bridge';
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  generation: number;
  error: string | null;
};

type Row = {
  id: string; owner_id: string; idempotency_key: string; repository_url: string; repository_ref: string | null;
  container_name: string | null; workspace_path: string; status: WorkspaceRecord['status']; network_mode: 'none' | 'bridge';
  created_at: number; last_activity_at: number; expires_at: number; generation: number; error: string | null;
};

const fromRow = (row: Row): WorkspaceRecord => ({
  id: row.id, ownerId: row.owner_id, idempotencyKey: row.idempotency_key, repositoryUrl: row.repository_url,
  repositoryRef: row.repository_ref, containerName: row.container_name, workspacePath: row.workspace_path,
  status: row.status, networkMode: row.network_mode, createdAt: row.created_at, lastActivityAt: row.last_activity_at,
  expiresAt: row.expires_at, generation: row.generation, error: row.error
});

const WORKSPACE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    repository_url TEXT NOT NULL, repository_ref TEXT, container_name TEXT, workspace_path TEXT NOT NULL,
    status TEXT NOT NULL, network_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
    error TEXT, UNIQUE(owner_id, idempotency_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_workspace_per_owner
    ON workspaces(owner_id)
    WHERE status IN ('CREATING','ACTIVE','REAPING');
`;

const AGENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
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
    status TEXT NOT NULL CHECK (status IN ('SPAWNING','RUNNING','CANCELLING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','LIMIT_EXCEEDED','INTERRUPTED')),
    generation INTEGER NOT NULL,
    spawn_admission_open INTEGER NOT NULL DEFAULT 1 CHECK (spawn_admission_open IN (0,1)),
    message_admission_open INTEGER NOT NULL DEFAULT 1 CHECK (message_admission_open IN (0,1)),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    terminal_at INTEGER,
    expires_at INTEGER NOT NULL,
    terminal_reason TEXT,
    cleanup_reason TEXT,
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0,1)),
    UNIQUE(owner_id, workspace_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS agents_owner_workspace_status
    ON agents(owner_id, workspace_id, status, created_at, id);
  CREATE INDEX IF NOT EXISTS agents_parent_status
    ON agents(owner_id, workspace_id, parent_agent_id, status);
  CREATE INDEX IF NOT EXISTS agents_active_global
    ON agents(status) WHERE status IN ('SPAWNING','RUNNING','CANCELLING');

  CREATE TABLE IF NOT EXISTS agent_workspace_admission (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    workspace_generation INTEGER NOT NULL,
    spawn_open INTEGER NOT NULL CHECK (spawn_open IN (0,1)),
    message_open INTEGER NOT NULL CHECK (message_open IN (0,1)),
    lifetime_records INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, workspace_id)
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_generation INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('steer','followUp')),
    state TEXT NOT NULL CHECK (state IN ('RESERVED','SENT','REJECTED','UNKNOWN')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY(owner_id, workspace_id, agent_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS agent_usage (
    owner_id TEXT NOT NULL,
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
    PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation)
  );

  CREATE TABLE IF NOT EXISTS agent_log_watermarks (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_generation INTEGER NOT NULL,
    retained_base_cursor INTEGER NOT NULL DEFAULT 0,
    next_cursor INTEGER NOT NULL DEFAULT 0,
    retained_bytes INTEGER NOT NULL DEFAULT 0,
    retained_events INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation)
  );

  CREATE TABLE IF NOT EXISTS agent_log_chunks (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_generation INTEGER NOT NULL,
    cursor_start INTEGER NOT NULL,
    cursor_end INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation, cursor_start)
  );
  CREATE INDEX IF NOT EXISTS agent_logs_retention
    ON agent_log_chunks(owner_id, workspace_id, agent_id, agent_generation, cursor_start);

  CREATE TABLE IF NOT EXISTS agent_cleanup_retries (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_generation INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, workspace_id, agent_id, agent_generation)
  );

  CREATE TABLE IF NOT EXISTS agent_tombstones (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, workspace_id, agent_id),
    UNIQUE(owner_id, workspace_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS agent_tombstones_expiry
    ON agent_tombstones(expires_at);
`;

export class StateStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.database.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);');
      const meta = this.database.prepare('SELECT version FROM schema_meta').get() as { version: number } | undefined;
      if (meta && meta.version !== 1 && meta.version !== 2) {
        throw new Error(`unsupported state schema version ${meta.version}`);
      }
      if (!meta || meta.version === 1) {
        this.database.exec('BEGIN IMMEDIATE');
        try {
          this.database.exec(WORKSPACE_SCHEMA_SQL);
          this.database.exec(AGENT_SCHEMA_SQL);
          if (meta) {
            this.database.prepare('UPDATE schema_meta SET version = 2 WHERE version = 1').run();
          } else {
            this.database.prepare('INSERT INTO schema_meta(version) VALUES (2)').run();
          }
          this.database.exec('COMMIT');
        } catch (error) {
          this.database.exec('ROLLBACK');
          throw error;
        }
      }
      this.database.prepare('INSERT OR IGNORE INTO runtime_meta(key, value) VALUES (?, ?)')
        .run('runner_instance_id', randomBytes(18).toString('hex'));
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  instanceId(): string {
    const row = this.database.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('runner_instance_id') as { value: string } | undefined;
    if (!row || !/^[a-f0-9]{36}$/.test(row.value)) throw new Error('invalid persisted runner instance identity');
    return row.value;
  }

  create(record: WorkspaceRecord): void {
    this.database.prepare(`INSERT INTO workspaces
      (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status, network_mode, created_at, last_activity_at, expires_at, generation, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.ownerId, record.idempotencyKey, record.repositoryUrl, record.repositoryRef, record.containerName, record.workspacePath, record.status, record.networkMode, record.createdAt, record.lastActivityAt, record.expiresAt, record.generation, record.error);
  }

  byId(id: string): WorkspaceRecord | undefined {
    const row = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  byIdempotency(ownerId: string, key: string): WorkspaceRecord | undefined {
    const row = this.database.prepare('SELECT * FROM workspaces WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, key) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(ownerId: string): WorkspaceRecord[] {
    return (this.database.prepare('SELECT * FROM workspaces WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId) as Row[]).map(fromRow);
  }

  active(): WorkspaceRecord[] {
    return (this.database.prepare("SELECT * FROM workspaces WHERE status IN ('CREATING','ACTIVE','REAPING')").all() as Row[]).map(fromRow);
  }

  update(id: string, changes: Partial<Pick<WorkspaceRecord, 'containerName' | 'status' | 'lastActivityAt' | 'expiresAt' | 'generation' | 'error'>>): WorkspaceRecord {
    const current = this.byId(id);
    if (!current) throw new Error(`workspace ${id} missing`);
    const next = { ...current, ...changes };
    this.database.prepare('UPDATE workspaces SET container_name=?, status=?, last_activity_at=?, expires_at=?, generation=?, error=? WHERE id=?')
      .run(next.containerName, next.status, next.lastActivityAt, next.expiresAt, next.generation, next.error, id);
    return next;
  }

  updateFenced(
    id: string,
    expectedGeneration: number,
    expectedStatuses: WorkspaceRecord['status'][],
    changes: Partial<Pick<WorkspaceRecord, 'containerName' | 'status' | 'lastActivityAt' | 'expiresAt' | 'generation' | 'error'>>
  ): WorkspaceRecord | undefined {
    const current = this.byId(id);
    if (!current || current.generation !== expectedGeneration || !expectedStatuses.includes(current.status)) return undefined;
    const next = { ...current, ...changes };
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.database.prepare(`UPDATE workspaces SET container_name=?, status=?, last_activity_at=?, expires_at=?, generation=?, error=?
      WHERE id=? AND generation=? AND status IN (${placeholders})`)
      .run(next.containerName, next.status, next.lastActivityAt, next.expiresAt, next.generation, next.error, id, expectedGeneration, ...expectedStatuses);
    return result.changes === 1 ? next : undefined;
  }

  claimForReaping(id: string, generation: number): boolean {
    const result = this.database.prepare("UPDATE workspaces SET status='REAPING', generation=generation+1 WHERE id=? AND generation=? AND status IN ('CREATING','ACTIVE','FAILED')").run(id, generation);
    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}
