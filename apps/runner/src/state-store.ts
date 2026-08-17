import { randomBytes } from 'node:crypto';
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

  close(): void {
    this.database.close();
  }
}
