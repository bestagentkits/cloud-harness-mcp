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
  status: 'CREATING' | 'ACTIVE' | 'REAPING' | 'CLOSED' | 'FAILED';
  networkMode: 'none' | 'bridge';
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
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
  created_at: number; last_activity_at: number; expires_at: number; generation: number; error: string | null;
};

const fromRow = (row: Row): WorkspaceRecord => ({
  id: row.id, ownerId: row.owner_id, idempotencyKey: row.idempotency_key, repositoryUrl: row.repository_url,
  repositoryRef: row.repository_ref, containerName: row.container_name, workspacePath: row.workspace_path,
  status: row.status, networkMode: row.network_mode, createdAt: row.created_at, lastActivityAt: row.last_activity_at,
  expiresAt: row.expires_at, generation: row.generation, error: row.error
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
      (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status, network_mode, created_at, last_activity_at, expires_at, generation, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.ownerId, record.idempotencyKey, record.repositoryUrl, record.repositoryRef, record.containerName, record.workspacePath, record.status, record.networkMode, record.createdAt, record.lastActivityAt, record.expiresAt, record.generation, record.error);
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
