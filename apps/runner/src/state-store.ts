import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunnerPrincipalSelectorSchema } from '@cloud-harness/contracts';
import {
  applyLegacyPrincipalMapping,
  applyPrincipalRelinks,
  migratePrincipalSchema,
  principalByExternalIdentity,
  resolveExternalPrincipal,
  resolveOwnerPrincipal,
  type ExternalPrincipalSelector,
  type PrincipalRecord,
  type PrincipalRelinkMapping,
  type PrincipalRelinkResult,
  type PrincipalSelector
} from './principal-store.js';

export type {
  ExternalPrincipalSelector,
  PrincipalRecord,
  PrincipalRelinkMapping,
  PrincipalRelinkResult,
  PrincipalSelector
} from './principal-store.js';

export type WorkspaceRecord = {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  repositoryUrl: string;
  repositoryRef: string | null;
  containerName: string | null;
  workspacePath: string;
  status: 'CREATING' | 'ACTIVE' | 'REAPING' | 'CLOSED' | 'FAILED' | 'EXPIRED_RECOVERABLE';
  networkMode: 'none' | 'bridge';
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  mutationLockedUntil: number | null;
  generation: number;
  error: string | null;
};

export type PrivilegeGrantStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED';

export type PrivilegeGrantRecord = {
  id: string;
  ownerId: string;
  workspaceId: string;
  command: string;
  cwd: string;
  commandSha256: string;
  status: PrivilegeGrantStatus;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
};

type PrivilegeGrantRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  command: string;
  cwd: string;
  command_sha256: string;
  status: PrivilegeGrantStatus;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

const fromPrivilegeGrantRow = (row: PrivilegeGrantRow): PrivilegeGrantRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  workspaceId: row.workspace_id,
  command: row.command,
  cwd: row.cwd || '.',
  commandSha256: row.command_sha256,
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at
});

type Row = {
  id: string; owner_id: string; idempotency_key: string; repository_url: string; repository_ref: string | null;
  container_name: string | null; workspace_path: string; status: WorkspaceRecord['status']; network_mode: 'none' | 'bridge';
  created_at: number; last_activity_at: number; expires_at: number; hard_expires_at?: number | null;
  git_author_name?: string | null; git_author_email?: string | null; mutation_locked_until?: number | null;
  generation: number; error: string | null;
};

const fromRow = (row: Row): WorkspaceRecord => ({
  id: row.id, ownerId: row.owner_id, idempotencyKey: row.idempotency_key, repositoryUrl: row.repository_url,
  repositoryRef: row.repository_ref, containerName: row.container_name, workspacePath: row.workspace_path,
  status: row.status, networkMode: row.network_mode, createdAt: row.created_at, lastActivityAt: row.last_activity_at,
  expiresAt: row.expires_at, hardExpiresAt: row.hard_expires_at ?? (row.created_at + 14_400_000),
  gitAuthorName: row.git_author_name ?? null, gitAuthorEmail: row.git_author_email ?? null,
  mutationLockedUntil: row.mutation_locked_until ?? null,
  generation: row.generation, error: row.error
});

export class StateStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
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
      CREATE TABLE IF NOT EXISTS privilege_grants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '.',
        command_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS privilege_grants_owner_workspace ON privilege_grants(owner_id, workspace_id);
    `);
    const cols = (this.database.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('hard_expires_at')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN hard_expires_at INTEGER;');
    }
    if (!cols.includes('git_author_name')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN git_author_name TEXT;');
    }
    if (!cols.includes('git_author_email')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN git_author_email TEXT;');
    }
    if (!cols.includes('mutation_locked_until')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN mutation_locked_until INTEGER;');
    }
    if (!cols.includes('mutation_lock_count')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN mutation_lock_count INTEGER NOT NULL DEFAULT 0;');
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS preferred_workspaces (owner_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS git_identities (owner_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comment_idempotency (owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS finalize_idempotency (owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, workspace_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS batch_write_idempotency (owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, workspace_id, idempotency_key));
    `);
    migratePrincipalSchema(this.database);
    this.database.prepare('INSERT OR IGNORE INTO runtime_meta(key, value) VALUES (?, ?)')
      .run('runner_instance_id', randomBytes(18).toString('hex'));
  }

  instanceId(): string {
    const row = this.database.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('runner_instance_id') as { value: string } | undefined;
    if (!row || !/^[a-f0-9]{36}$/.test(row.value)) throw new Error('invalid persisted runner instance identity');
    return row.value;
  }

  create(record: WorkspaceRecord): void {
    this.database.prepare(`INSERT INTO workspaces
      (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status, network_mode, created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, generation, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.ownerId,
        record.idempotencyKey,
        record.repositoryUrl,
        record.repositoryRef ?? null,
        record.containerName ?? null,
        record.workspacePath,
        record.status,
        record.networkMode,
        record.createdAt,
        record.lastActivityAt,
        record.expiresAt,
        record.hardExpiresAt ?? (record.createdAt + 14_400_000),
        record.gitAuthorName ?? null,
        record.gitAuthorEmail ?? null,
        record.mutationLockedUntil ?? null,
        record.generation ?? 1,
        record.error ?? null
      );
  }
  byId(id: string): WorkspaceRecord | undefined {
    const row = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  byOwnerAndId(ownerId: string, id: string): WorkspaceRecord | undefined {
    const row = this.database.prepare('SELECT * FROM workspaces WHERE owner_id = ? AND id = ?').get(ownerId, id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  resolvePrincipal(selector: PrincipalSelector): string {
    const parsed = RunnerPrincipalSelectorSchema.parse(selector);
    if (parsed.kind === 'owner') {
      return resolveOwnerPrincipal(this.database, parsed.ownerId);
    }
    return this.resolveExternalPrincipal(parsed);
  }

  resolveExternalPrincipal(selector: ExternalPrincipalSelector, options: { legacyOwnerId?: string } = {}): string {
    return resolveExternalPrincipal(this.database, selector, options);
  }

  principalByExternalIdentity(selector: Pick<ExternalPrincipalSelector, 'issuer' | 'subject'>): PrincipalRecord | undefined {
    return principalByExternalIdentity(this.database, selector);
  }

  legacyWorkspaceOwnerIds(): string[] {
    return (this.database.prepare(`SELECT DISTINCT workspaces.owner_id AS owner_id
      FROM workspaces
      LEFT JOIN principals ON principals.id = workspaces.owner_id
      WHERE principals.id IS NULL
      ORDER BY workspaces.owner_id`).all() as { owner_id: string }[]).map((row) => row.owner_id);
  }

  applyLegacyPrincipalMapping(mapping: { legacyOwnerId: string; issuer: string; subject: string }): string {
    return applyLegacyPrincipalMapping(this.database, mapping);
  }

  applyPrincipalRelinks(
    mappings: PrincipalRelinkMapping[],
    onApplied?: (database: DatabaseSync, result: PrincipalRelinkResult) => void
  ): PrincipalRelinkResult[] {
    return applyPrincipalRelinks(this.database, mappings, onApplied);
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
  update(id: string, changes: Partial<Pick<WorkspaceRecord, 'containerName' | 'status' | 'lastActivityAt' | 'expiresAt' | 'hardExpiresAt' | 'gitAuthorName' | 'gitAuthorEmail' | 'mutationLockedUntil' | 'generation' | 'error'>>): WorkspaceRecord {
    const current = this.byId(id);
    if (!current) throw new Error(`workspace ${id} missing`);
    const next = { ...current, ...changes };
    this.database.prepare('UPDATE workspaces SET container_name=?, status=?, last_activity_at=?, expires_at=?, hard_expires_at=?, git_author_name=?, git_author_email=?, mutation_locked_until=?, generation=?, error=? WHERE id=?')
      .run(
        next.containerName ?? null,
        next.status,
        next.lastActivityAt,
        next.expiresAt,
        next.hardExpiresAt ?? (next.createdAt + 14_400_000),
        next.gitAuthorName ?? null,
        next.gitAuthorEmail ?? null,
        next.mutationLockedUntil ?? null,
        next.generation,
        next.error ?? null,
        id
      );
    return next;
  }

  acquireMutationLease(id: string, expectedGeneration: number, holdExpiry: number): WorkspaceRecord {
    const now = Date.now();
    const result = this.database.prepare(`
      UPDATE workspaces
      SET mutation_lock_count = mutation_lock_count + 1,
          mutation_locked_until = MAX(COALESCE(mutation_locked_until, 0), ?),
          expires_at = MAX(expires_at, ?),
          last_activity_at = ?
      WHERE id = ? AND generation = ? AND status = 'ACTIVE'
    `).run(holdExpiry, holdExpiry, now, id, expectedGeneration);
    if (result.changes !== 1) {
      throw new Error('MUTATION_LEASE_LOST');
    }
    return this.byId(id)!;
  }

  acquireRecoverableMutationLease(id: string, expectedGeneration: number, holdExpiry: number): WorkspaceRecord {
    const now = Date.now();
    const result = this.database.prepare(`
      UPDATE workspaces
      SET mutation_lock_count = mutation_lock_count + 1,
          mutation_locked_until = MAX(COALESCE(mutation_locked_until, 0), ?),
          last_activity_at = ?
      WHERE id = ? AND generation = ? AND status IN ('ACTIVE', 'EXPIRED_RECOVERABLE')
    `).run(holdExpiry, now, id, expectedGeneration);
    if (result.changes !== 1) {
      throw new Error('MUTATION_LEASE_LOST');
    }
    return this.byId(id)!;
  }

  releaseMutationLease(id: string, expectedGeneration?: number): void {
    const sql = expectedGeneration !== undefined
      ? `UPDATE workspaces
         SET mutation_lock_count = MAX(0, mutation_lock_count - 1),
             mutation_locked_until = CASE WHEN mutation_lock_count <= 1 THEN NULL ELSE mutation_locked_until END
         WHERE id = ? AND generation = ? AND status IN ('ACTIVE', 'EXPIRED_RECOVERABLE')`
      : `UPDATE workspaces
         SET mutation_lock_count = MAX(0, mutation_lock_count - 1),
             mutation_locked_until = CASE WHEN mutation_lock_count <= 1 THEN NULL ELSE mutation_locked_until END
         WHERE id = ?`;
    if (expectedGeneration !== undefined) {
      this.database.prepare(sql).run(id, expectedGeneration);
    } else {
      this.database.prepare(sql).run(id);
    }
  }

  claimForExpiry(id: string, expectedGeneration: number): WorkspaceRecord | undefined {
    const now = Date.now();
    const result = this.database.prepare(`
      UPDATE workspaces
      SET status = 'REAPING',
          generation = generation + 1,
          mutation_lock_count = 0,
          mutation_locked_until = NULL,
          last_activity_at = ?
      WHERE id = ? AND generation = ? AND status = 'ACTIVE'
        AND (expires_at <= ? OR hard_expires_at <= ?)
        AND (mutation_locked_until IS NULL OR mutation_locked_until <= ?)
    `).run(now, id, expectedGeneration, now, now, now);
    return result.changes === 1 ? this.byId(id) : undefined;
  }

  setMutationLock(id: string, lockedUntil: number, expectedGeneration?: number): void {
    const sql = expectedGeneration !== undefined
      ? `UPDATE workspaces
         SET mutation_lock_count = mutation_lock_count + 1,
             mutation_locked_until = MAX(COALESCE(mutation_locked_until, 0), ?)
         WHERE id = ? AND generation = ? AND status = 'ACTIVE'`
      : `UPDATE workspaces
         SET mutation_lock_count = mutation_lock_count + 1,
             mutation_locked_until = MAX(COALESCE(mutation_locked_until, 0), ?)
         WHERE id = ?`;
    if (expectedGeneration !== undefined) {
      this.database.prepare(sql).run(lockedUntil, id, expectedGeneration);
    } else {
      this.database.prepare(sql).run(lockedUntil, id);
    }
  }

  clearMutationLock(id: string, expectedGeneration?: number): void {
    const sql = expectedGeneration !== undefined
      ? `UPDATE workspaces
         SET mutation_lock_count = MAX(0, mutation_lock_count - 1),
             mutation_locked_until = CASE WHEN mutation_lock_count <= 1 THEN NULL ELSE mutation_locked_until END
         WHERE id = ? AND generation = ? AND status = 'ACTIVE'`
      : `UPDATE workspaces
         SET mutation_lock_count = MAX(0, mutation_lock_count - 1),
             mutation_locked_until = CASE WHEN mutation_lock_count <= 1 THEN NULL ELSE mutation_locked_until END
         WHERE id = ?`;
    if (expectedGeneration !== undefined) {
      this.database.prepare(sql).run(id, expectedGeneration);
    } else {
      this.database.prepare(sql).run(id);
    }
  }

  setPreferredWorkspace(ownerId: string, workspaceId: string): void {
    this.database.prepare('INSERT INTO preferred_workspaces(owner_id, workspace_id) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET workspace_id = excluded.workspace_id')
      .run(ownerId, workspaceId);
  }

  getPreferredWorkspace(ownerId: string): string | undefined {
    const row = this.database.prepare('SELECT workspace_id FROM preferred_workspaces WHERE owner_id = ?').get(ownerId) as { workspace_id: string } | undefined;
    return row?.workspace_id;
  }

  setGitIdentity(ownerId: string, identity: { name: string; email: string }): void {
    this.database.prepare('INSERT INTO git_identities(owner_id, name, email) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET name = excluded.name, email = excluded.email')
      .run(ownerId, identity.name, identity.email);
  }

  getGitIdentity(ownerId: string): { name: string; email: string } | undefined {
    const row = this.database.prepare('SELECT name, email FROM git_identities WHERE owner_id = ?').get(ownerId) as { name: string; email: string } | undefined;
    return row ? { name: row.name, email: row.email } : undefined;
  }

  getCommentIdempotency(ownerId: string, key: string): string | undefined {
    const row = this.database.prepare('SELECT result_json FROM comment_idempotency WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, key) as { result_json: string } | undefined;
    return row?.result_json;
  }

  setCommentIdempotency(ownerId: string, key: string, resultJson: string): void {
    this.database.prepare('INSERT OR REPLACE INTO comment_idempotency(owner_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?)')
      .run(ownerId, key, resultJson, Date.now());
  }

  getFinalizeIdempotency(ownerId: string, workspaceId: string, key: string): string | undefined {
    const row = this.database.prepare('SELECT result_json FROM finalize_idempotency WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?').get(ownerId, workspaceId, key) as { result_json: string } | undefined;
    return row?.result_json;
  }

  setFinalizeIdempotency(ownerId: string, workspaceId: string, key: string, resultJson: string): void {
    this.database.prepare('INSERT OR REPLACE INTO finalize_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, workspaceId, key, resultJson, Date.now());
  }

  getBatchWriteIdempotency(ownerId: string, workspaceId: string, key: string): string | undefined {
    const row = this.database.prepare('SELECT result_json FROM batch_write_idempotency WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?').get(ownerId, workspaceId, key) as { result_json: string } | undefined;
    return row?.result_json;
  }

  setBatchWriteIdempotency(ownerId: string, workspaceId: string, key: string, resultJson: string): void {
    this.database.prepare('INSERT OR REPLACE INTO batch_write_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, workspaceId, key, resultJson, Date.now());
  }

  resolveActiveWorkspace(ownerId: string, explicitId?: string): WorkspaceRecord {
    if (explicitId) {
      const record = this.byOwnerAndId(ownerId, explicitId);
      if (!record) throw new Error('NOT_FOUND');
      return record;
    }
    const activeWorkspaces = this.list(ownerId).filter((w) => w.status === 'ACTIVE' || w.status === 'CREATING');
    const preferred = this.getPreferredWorkspace(ownerId);
    if (preferred) {
      const record = this.byOwnerAndId(ownerId, preferred);
      if (record && (record.status === 'ACTIVE' || record.status === 'CREATING')) {
        return record;
      }
    }
    const firstActive = activeWorkspaces[0];
    if (activeWorkspaces.length === 1 && firstActive) {
      return firstActive;
    }
    if (activeWorkspaces.length === 0) {
      if (preferred) {
        const record = this.byOwnerAndId(ownerId, preferred);
        if (record && record.status === 'EXPIRED_RECOVERABLE') {
          return record;
        }
      }
      const recoverable = this.list(ownerId).filter((w) => w.status === 'EXPIRED_RECOVERABLE');
      const firstRecoverable = recoverable[0];
      if (recoverable.length === 1 && firstRecoverable) {
        return firstRecoverable;
      }
      throw new Error('NO_ACTIVE_WORKSPACE');
    }
    throw new Error('AMBIGUOUS_ACTIVE_WORKSPACES');
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

  claimForReaping(id: string, generation: number, force = false): boolean {
    const now = Date.now();
    const sql = force
      ? "UPDATE workspaces SET status='REAPING', generation=generation+1, mutation_lock_count=0, mutation_locked_until=NULL WHERE id=? AND generation=? AND status IN ('CREATING','ACTIVE','FAILED','EXPIRED_RECOVERABLE')"
      : "UPDATE workspaces SET status='REAPING', generation=generation+1 WHERE id=? AND generation=? AND status IN ('CREATING','ACTIVE','FAILED','EXPIRED_RECOVERABLE') AND (mutation_locked_until IS NULL OR mutation_locked_until <= ?)";
    const result = force
      ? this.database.prepare(sql).run(id, generation)
      : this.database.prepare(sql).run(id, generation, now);
    return result.changes === 1;
  }
  createPrivilegeGrant(input: { ownerId: string; workspaceId: string; command: string; cwd?: string; ttlMs?: number }): PrivilegeGrantRecord {
    const now = Date.now();
    const cwd = input.cwd || '.';
    const commandSha256 = createHash('sha256').update(input.command).digest('hex');
    const existing = this.database.prepare(
      "SELECT * FROM privilege_grants WHERE owner_id = ? AND workspace_id = ? AND command_sha256 = ? AND cwd = ? AND status = 'PENDING' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
    ).get(input.ownerId, input.workspaceId, commandSha256, cwd, now) as PrivilegeGrantRow | undefined;
    if (existing) {
      return fromPrivilegeGrantRow(existing);
    }
    try {
      this.database.prepare("DELETE FROM privilege_grants WHERE owner_id = ? AND (status IN ('EXPIRED', 'REJECTED', 'CONSUMED') OR expires_at < ?) AND created_at < ?").run(input.ownerId, now, now - 3_600_000);
    } catch { /* ignore prune failure */ }
    const id = `pvg_${randomBytes(16).toString('hex')}`;
    const expiresAt = now + (input.ttlMs ?? 60_000);
    const record: PrivilegeGrantRecord = {
      id,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      command: input.command,
      cwd,
      commandSha256,
      status: 'PENDING',
      createdAt: now,
      expiresAt,
      consumedAt: null
    };
    this.database.prepare(`INSERT INTO privilege_grants
      (id, owner_id, workspace_id, command, cwd, command_sha256, status, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(record.id, record.ownerId, record.workspaceId, record.command, record.cwd, record.commandSha256, record.status, record.createdAt, record.expiresAt, record.consumedAt);
    return record;
  }

  getPrivilegeGrant(grantId: string): PrivilegeGrantRecord | undefined {
    const now = Date.now();
    const row = this.database.prepare('SELECT * FROM privilege_grants WHERE id = ?').get(grantId) as PrivilegeGrantRow | undefined;
    if (!row) return undefined;
    const grant = fromPrivilegeGrantRow(row);
    if ((grant.status === 'PENDING' || grant.status === 'APPROVED') && grant.expiresAt <= now) {
      this.database.prepare("UPDATE privilege_grants SET status = 'EXPIRED' WHERE id = ? AND status IN ('PENDING', 'APPROVED')").run(grantId);
      return { ...grant, status: 'EXPIRED' };
    }
    return grant;
  }
  listPrivilegeGrants(ownerId: string, workspaceId?: string, limit = 50): PrivilegeGrantRecord[] {
    const now = Date.now();
    const boundedLimit = Math.min(Math.max(1, limit), 100);
    const query = workspaceId
      ? 'SELECT * FROM privilege_grants WHERE owner_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM privilege_grants WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?';
    const rows = (workspaceId
      ? this.database.prepare(query).all(ownerId, workspaceId, boundedLimit)
      : this.database.prepare(query).all(ownerId, boundedLimit)) as PrivilegeGrantRow[];
    return rows.map((row) => {
      const grant = fromPrivilegeGrantRow(row);
      if ((grant.status === 'PENDING' || grant.status === 'APPROVED') && grant.expiresAt <= now) {
        return { ...grant, status: 'EXPIRED' };
      }
      return grant;
    });
  }

  pruneExpiredPrivilegeGrants(now: number = Date.now(), maxAgeMs: number = 86_400_000): number {
    const threshold = now - maxAgeMs;
    const result = this.database.prepare(
      "DELETE FROM privilege_grants WHERE (status IN ('EXPIRED', 'REJECTED', 'CONSUMED') AND (created_at < ? OR expires_at < ?)) OR (expires_at < ?)"
    ).run(threshold, threshold, threshold);
    return Number(result.changes);
  }
  approvePrivilegeGrant(
    ownerId: string,
    grantId: string,
    onApproved?: (database: DatabaseSync, grant: PrivilegeGrantRecord) => void
  ): boolean {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.prepare('SELECT * FROM privilege_grants WHERE id = ? AND owner_id = ?').get(grantId, ownerId) as PrivilegeGrantRow | undefined;
      if (!row || row.status !== 'PENDING' || row.expires_at <= now) {
        this.database.exec('ROLLBACK;');
        return false;
      }
      this.database.prepare(
        "UPDATE privilege_grants SET status = 'APPROVED' WHERE id = ? AND owner_id = ?"
      ).run(grantId, ownerId);
      const grant = { ...fromPrivilegeGrantRow(row), status: 'APPROVED' as const };
      if (onApproved) {
        onApproved(this.database, grant);
      }
      this.database.exec('COMMIT;');
      return true;
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  rejectPrivilegeGrant(
    ownerId: string,
    grantId: string,
    onRejected?: (database: DatabaseSync, grant: PrivilegeGrantRecord) => void
  ): boolean {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.prepare('SELECT * FROM privilege_grants WHERE id = ? AND owner_id = ?').get(grantId, ownerId) as PrivilegeGrantRow | undefined;
      if (!row || row.status !== 'PENDING') {
        this.database.exec('ROLLBACK;');
        return false;
      }
      this.database.prepare(
        "UPDATE privilege_grants SET status = 'REJECTED' WHERE id = ? AND owner_id = ?"
      ).run(grantId, ownerId);
      const grant = { ...fromPrivilegeGrantRow(row), status: 'REJECTED' as const };
      if (onRejected) {
        onRejected(this.database, grant);
      }
      this.database.exec('COMMIT;');
      return true;
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  consumePrivilegeGrant(input: { ownerId: string; workspaceId: string; grantId: string; commandSha256: string; cwd?: string }): boolean {
    const now = Date.now();
    const cwd = input.cwd || '.';
    const result = this.database.prepare(
      "UPDATE privilege_grants SET status = 'CONSUMED', consumed_at = ? WHERE id = ? AND owner_id = ? AND workspace_id = ? AND command_sha256 = ? AND cwd = ? AND status = 'APPROVED' AND expires_at > ?"
    ).run(now, input.grantId, input.ownerId, input.workspaceId, input.commandSha256, cwd, now);
    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}
