import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunnerPrincipalSelectorSchema } from '@cloud-harness/contracts';
import type { EncryptedSecret } from './secret-keyring.js';
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
export { downgradeStateSchemaToV3 } from './principal-store.js';

export type RepoCacheStatus = 'INITIALIZING' | 'READY' | 'UPDATING' | 'FAILED' | 'DISABLED';
export type RepoCacheRecord = {
  id: string;
  ownerId: string;
  repositoryUrl: string;
  repositoryUrlHash: string;
  cachePath: string;
  defaultBranch: string | null;
  lastFetchedAt: number;
  sizeBytes: number;
  status: RepoCacheStatus;
  generation: number;
  createdAt: number;
  updatedAt: number;
};

export type DurableTaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
export type DurableTaskRecord = {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string | null;
  command: string;
  cwd: string;
  status: DurableTaskStatus;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  bootId: string;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  timeoutMs: number;
  maxBytes: number;
  logPath: string;
  outputBytes: number;
  outputArtifactId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  generation: number;
  dependsOn?: string[];
};

export type GitOperationStatus = 'PENDING' | 'SUCCEEDED' | 'UNKNOWN_REMOTE_STATE' | 'CONFLICT' | 'FAILED';
export type GitOperationKind = 'push' | 'commit' | 'finalize';
export type GitOperationRecord = {
  ownerId: string;
  workspaceId: string;
  idempotencyKey: string;
  operation: GitOperationKind;
  requestFingerprint: string;
  targetRef: string | null;
  expectedRemoteOid: string | null;
  localCommitSha: string | null;
  status: GitOperationStatus;
  resultJson: string | null;
  errorJson: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type WorkspaceRecord = {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  repositoryUrl: string;
  repositoryRef: string | null;
  containerName: string | null;
  workspacePath: string;
  environmentId: string | null;
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
  container_name: string | null; workspace_path: string; environment_id?: string | null; status: WorkspaceRecord['status']; network_mode: 'none' | 'bridge';
  created_at: number; last_activity_at: number; expires_at: number; hard_expires_at?: number | null;
  git_author_name?: string | null; git_author_email?: string | null; mutation_locked_until?: number | null;
  generation: number; error: string | null;
};

const fromRow = (row: Row): WorkspaceRecord => ({
  id: row.id, ownerId: row.owner_id, idempotencyKey: row.idempotency_key, repositoryUrl: row.repository_url,
  repositoryRef: row.repository_ref, containerName: row.container_name, workspacePath: row.workspace_path,
  environmentId: row.environment_id ?? null,
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
      CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_id_id
        ON workspaces(owner_id, id);
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
    if (!cols.includes('environment_id')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN environment_id TEXT;');
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_secret_snapshots (
        workspace_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        key_version INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        PRIMARY KEY(workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS workspace_secret_snapshots_ws ON workspace_secret_snapshots(workspace_id);
      CREATE TABLE IF NOT EXISTS workspace_secret_snapshot_headers (
        workspace_id TEXT PRIMARY KEY,
        environment_id TEXT,
        item_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS preferred_workspaces (owner_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS git_identities (owner_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comment_idempotency (owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS finalize_idempotency (owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, workspace_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS batch_write_idempotency (owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, workspace_id, idempotency_key));
    `);
    const commentCols = (this.database.prepare('PRAGMA table_info(comment_idempotency)').all() as { name: string }[]).map((c) => c.name);
    if (!commentCols.includes('fingerprint')) {
      this.database.exec('ALTER TABLE comment_idempotency ADD COLUMN fingerprint TEXT;');
    }
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
      (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, environment_id, status, network_mode, created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, generation, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.ownerId,
        record.idempotencyKey,
        record.repositoryUrl,
        record.repositoryRef ?? null,
        record.containerName ?? null,
        record.workspacePath,
        record.environmentId ?? null,
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

  saveSecretSnapshot(
    workspaceId: string,
    secrets: Array<{ name: string; version: number; environmentId: string; envelope: EncryptedSecret }>
  ): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT OR REPLACE INTO workspace_secret_snapshot_headers (workspace_id, environment_id, item_count, created_at)
        VALUES (?, ?, ?, ?)
      `).run(workspaceId, secrets[0]?.environmentId ?? 'global', secrets.length, Date.now());
      const stmt = this.database.prepare(`
        INSERT OR REPLACE INTO workspace_secret_snapshots (workspace_id, environment_id, name, version, key_version, nonce, ciphertext, auth_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const secret of secrets) {
        stmt.run(
          workspaceId,
          secret.environmentId,
          secret.name,
          secret.version,
          secret.envelope.keyVersion,
          secret.envelope.nonce,
          secret.envelope.ciphertext,
          secret.envelope.authTag
        );
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getSecretSnapshot(workspaceId: string): {
    initialized: boolean;
    environmentId?: string;
    secrets: Array<{ name: string; version: number; envelope: EncryptedSecret; environmentId: string }>;
  } {
    const header = this.database.prepare(`
      SELECT environment_id, item_count FROM workspace_secret_snapshot_headers WHERE workspace_id = ?
    `).get(workspaceId) as { environment_id: string; item_count: number } | undefined;
    if (!header) {
      return { initialized: false, secrets: [] };
    }
    const rows = this.database.prepare(`
      SELECT name, version, key_version, nonce, ciphertext, auth_tag, environment_id
      FROM workspace_secret_snapshots
      WHERE workspace_id = ?
      ORDER BY name
    `).all(workspaceId) as Array<{
      name: string;
      version: number;
      key_version: number;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      auth_tag: Uint8Array;
      environment_id: string;
    }>;
    if (rows.length !== header.item_count) {
      throw new Error(`snapshot item count mismatch for workspace ${workspaceId}: expected ${header.item_count}, got ${rows.length}`);
    }
    return {
      initialized: true,
      environmentId: header.environment_id,
      secrets: rows.map((r) => ({
        name: r.name,
        version: r.version,
        environmentId: r.environment_id,
        envelope: {
          keyVersion: r.key_version,
          nonce: Buffer.from(r.nonce),
          ciphertext: Buffer.from(r.ciphertext),
          authTag: Buffer.from(r.auth_tag)
        }
      }))
    };
  }
  deleteSecretSnapshot(workspaceId: string): void {
    this.database.prepare('DELETE FROM workspace_secret_snapshots WHERE workspace_id = ?').run(workspaceId);
    this.database.prepare('DELETE FROM workspace_secret_snapshot_headers WHERE workspace_id = ?').run(workspaceId);
  }

  reencryptSnapshots(
    reencryptFn: (item: {
      workspaceId: string;
      environmentId: string;
      ownerId: string;
      name: string;
      version: number;
      envelope: EncryptedSecret;
    }) => EncryptedSecret
  ): number {
    const rows = this.database.prepare(`
      SELECT s.*, w.owner_id
      FROM workspace_secret_snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
    `).all() as Array<{
      workspace_id: string;
      environment_id: string;
      name: string;
      version: number;
      key_version: number;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      auth_tag: Uint8Array;
      owner_id: string;
    }>;

    let updated = 0;
    for (const row of rows) {
      const envelope: EncryptedSecret = {
        keyVersion: row.key_version,
        nonce: Buffer.from(row.nonce),
        ciphertext: Buffer.from(row.ciphertext),
        authTag: Buffer.from(row.auth_tag)
      };
      const next = reencryptFn({
        workspaceId: row.workspace_id,
        environmentId: row.environment_id,
        ownerId: row.owner_id,
        name: row.name,
        version: row.version,
        envelope
      });
      if (next.keyVersion !== row.key_version) {
        this.database.prepare(`
          UPDATE workspace_secret_snapshots
          SET key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?
          WHERE workspace_id = ? AND name = ?
        `).run(next.keyVersion, next.nonce, next.ciphertext, next.authTag, row.workspace_id, row.name);
        updated++;
      }
    }
    return updated;
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

  refreshMutationLock(id: string, lockedUntil: number, expectedGeneration?: number): void {
    const sql = expectedGeneration !== undefined
      ? `UPDATE workspaces
         SET mutation_locked_until = MAX(COALESCE(mutation_locked_until, 0), ?)
         WHERE id = ? AND generation = ? AND status = 'ACTIVE'`
      : `UPDATE workspaces
         SET mutation_locked_until = MAX(COALESCE(mutation_locked_until, 0), ?)
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

  getCommentIdempotency(ownerId: string, key: string, expectedFingerprint?: string): { resultJson?: string; mismatch?: boolean } | undefined {
    const row = this.database.prepare('SELECT fingerprint, result_json, created_at FROM comment_idempotency WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, key) as { fingerprint: string | null; result_json: string; created_at: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.created_at >= 86_400_000) {
      this.database.prepare('DELETE FROM comment_idempotency WHERE owner_id = ? AND idempotency_key = ?').run(ownerId, key);
      return undefined;
    }
    if (expectedFingerprint && row.fingerprint && row.fingerprint !== expectedFingerprint) {
      return { mismatch: true };
    }
    return { resultJson: row.result_json };
  }

  setCommentIdempotency(ownerId: string, key: string, resultJson: string, fingerprint?: string): void {
    this.database.prepare('INSERT OR REPLACE INTO comment_idempotency(owner_id, idempotency_key, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, key, fingerprint ?? null, resultJson, Date.now());
  }

  getFinalizeIdempotency(ownerId: string, workspaceId: string, key: string): string | undefined {
    const gitOp = this.getGitOperation(ownerId, workspaceId, key);
    if (gitOp?.resultJson) return gitOp.resultJson;
    const row = this.database.prepare('SELECT result_json FROM finalize_idempotency WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?').get(ownerId, workspaceId, key) as { result_json: string } | undefined;
    return row?.result_json;
  }

  setFinalizeIdempotency(ownerId: string, workspaceId: string, key: string, resultJson: string): void {
    const now = Date.now();
    this.database.prepare('INSERT OR REPLACE INTO finalize_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, workspaceId, key, resultJson, now);
    this.database.prepare(`
      INSERT OR REPLACE INTO git_operation_idempotency
      (owner_id, workspace_id, idempotency_key, operation, request_fingerprint, target_ref,
       expected_remote_oid, local_commit_sha, status, result_json, error_json, created_at, finished_at)
      VALUES (?, ?, ?, 'finalize', '', NULL, NULL, NULL, 'SUCCEEDED', ?, NULL, ?, ?)
    `).run(ownerId, workspaceId, key, resultJson, now, now);
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

  getRepoCache(ownerId: string, urlHash: string): RepoCacheRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM repo_caches WHERE owner_id = ? AND repository_url_hash = ?'
    ).get(ownerId, urlHash) as {
      id: string; owner_id: string; repository_url: string; repository_url_hash: string;
      cache_path: string; default_branch: string | null; last_fetched_at: number;
      size_bytes: number; status: RepoCacheStatus; generation: number;
      created_at: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      ownerId: row.owner_id,
      repositoryUrl: row.repository_url,
      repositoryUrlHash: row.repository_url_hash,
      cachePath: row.cache_path,
      defaultBranch: row.default_branch,
      lastFetchedAt: row.last_fetched_at,
      sizeBytes: row.size_bytes,
      status: row.status,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  upsertRepoCache(record: Omit<RepoCacheRecord, 'generation'>): RepoCacheRecord {
    const existing = this.getRepoCache(record.ownerId, record.repositoryUrlHash);
    if (existing) {
      this.database.prepare(`
        UPDATE repo_caches
        SET cache_path = ?, default_branch = ?, last_fetched_at = ?, size_bytes = ?,
            status = ?, generation = generation + 1, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        record.cachePath, record.defaultBranch, record.lastFetchedAt, record.sizeBytes,
        record.status, record.updatedAt, existing.id, record.ownerId
      );
      return { ...record, id: existing.id, generation: existing.generation + 1 };
    }
    this.database.prepare(`
      INSERT INTO repo_caches
      (id, owner_id, repository_url, repository_url_hash, cache_path, default_branch,
       last_fetched_at, size_bytes, status, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      record.id, record.ownerId, record.repositoryUrl, record.repositoryUrlHash,
      record.cachePath, record.defaultBranch, record.lastFetchedAt, record.sizeBytes,
      record.status, record.createdAt, record.updatedAt
    );
    return { ...record, generation: 1 };
  }
  touchRepoCache(ownerId: string, urlHash: string, now: number = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE repo_caches
      SET last_fetched_at = ?, updated_at = ?, generation = generation + 1
      WHERE owner_id = ? AND repository_url_hash = ?
    `).run(now, now, ownerId, urlHash);
    return Number(result.changes) === 1;
  }

  listStaleRepoCaches(unusedBefore: number): RepoCacheRecord[] {
    const rows = this.database.prepare(
      'SELECT * FROM repo_caches WHERE last_fetched_at < ?'
    ).all(unusedBefore) as {
      id: string; owner_id: string; repository_url: string; repository_url_hash: string;
      cache_path: string; default_branch: string | null; last_fetched_at: number;
      size_bytes: number; status: RepoCacheStatus; generation: number;
      created_at: number; updated_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      repositoryUrl: row.repository_url,
      repositoryUrlHash: row.repository_url_hash,
      cachePath: row.cache_path,
      defaultBranch: row.default_branch,
      lastFetchedAt: row.last_fetched_at,
      sizeBytes: row.size_bytes,
      status: row.status,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  deleteRepoCache(id: string): boolean {
    const result = this.database.prepare('DELETE FROM repo_caches WHERE id = ?').run(id);
    return result.changes === 1;
  }

  createDurableTask(task: Omit<DurableTaskRecord, 'generation'>, dependsOn: string[] = []): DurableTaskRecord {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`
        INSERT INTO durable_tasks
        (id, workspace_id, owner_id, name, command, cwd, status, idempotency_key,
         request_fingerprint, boot_id, exit_code, error_code, error_message, timeout_ms,
         max_bytes, log_path, output_bytes, output_artifact_id, created_at, started_at,
         finished_at, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        task.id, task.workspaceId, task.ownerId, task.name, task.command, task.cwd,
        task.status, task.idempotencyKey, task.requestFingerprint, task.bootId,
        task.exitCode, task.errorCode, task.errorMessage, task.timeoutMs, task.maxBytes,
        task.logPath, task.outputBytes, task.outputArtifactId, task.createdAt,
        task.startedAt, task.finishedAt
      );
      for (const depId of dependsOn) {
        this.database.prepare(
          'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)'
        ).run(task.id, depId);
      }
      this.database.exec('COMMIT;');
      return { ...task, generation: 1, dependsOn };
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  getDurableTask(ownerId: string, workspaceId: string, taskId: string): DurableTaskRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM durable_tasks WHERE owner_id = ? AND workspace_id = ? AND id = ?'
    ).get(ownerId, workspaceId, taskId) as {
      id: string; workspace_id: string; owner_id: string; name: string | null;
      command: string; cwd: string; status: DurableTaskStatus; idempotency_key: string | null;
      request_fingerprint: string | null; boot_id: string; exit_code: number | null;
      error_code: string | null; error_message: string | null; timeout_ms: number;
      max_bytes: number; log_path: string; output_bytes: number; output_artifact_id: string | null;
      created_at: number; started_at: number | null; finished_at: number | null; generation: number;
    } | undefined;
    if (!row) return undefined;
    const deps = (this.database.prepare(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?'
    ).all(row.id) as { depends_on_task_id: string }[]).map((d) => d.depends_on_task_id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      name: row.name,
      command: row.command,
      cwd: row.cwd,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      bootId: row.boot_id,
      exitCode: row.exit_code,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      timeoutMs: row.timeout_ms,
      maxBytes: row.max_bytes,
      logPath: row.log_path,
      outputBytes: row.output_bytes,
      outputArtifactId: row.output_artifact_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      generation: row.generation,
      dependsOn: deps
    };
  }

  getDurableTaskByIdempotencyKey(ownerId: string, workspaceId: string, key: string): DurableTaskRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM durable_tasks WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?'
    ).get(ownerId, workspaceId, key) as {
      id: string; workspace_id: string; owner_id: string; name: string | null;
      command: string; cwd: string; status: DurableTaskStatus; idempotency_key: string | null;
      request_fingerprint: string | null; boot_id: string; exit_code: number | null;
      error_code: string | null; error_message: string | null; timeout_ms: number;
      max_bytes: number; log_path: string; output_bytes: number; output_artifact_id: string | null;
      created_at: number; started_at: number | null; finished_at: number | null; generation: number;
    } | undefined;
    if (!row) return undefined;
    const deps = (this.database.prepare(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?'
    ).all(row.id) as { depends_on_task_id: string }[]).map((d) => d.depends_on_task_id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      name: row.name,
      command: row.command,
      cwd: row.cwd,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      bootId: row.boot_id,
      exitCode: row.exit_code,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      timeoutMs: row.timeout_ms,
      maxBytes: row.max_bytes,
      logPath: row.log_path,
      outputBytes: row.output_bytes,
      outputArtifactId: row.output_artifact_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      generation: row.generation,
      dependsOn: deps
    };
  }

  listDurableTasks(ownerId: string, workspaceId: string): DurableTaskRecord[] {
    const rows = this.database.prepare(
      'SELECT * FROM durable_tasks WHERE owner_id = ? AND workspace_id = ? ORDER BY created_at ASC'
    ).all(ownerId, workspaceId) as {
      id: string; workspace_id: string; owner_id: string; name: string | null;
      command: string; cwd: string; status: DurableTaskStatus; idempotency_key: string | null;
      request_fingerprint: string | null; boot_id: string; exit_code: number | null;
      error_code: string | null; error_message: string | null; timeout_ms: number;
      max_bytes: number; log_path: string; output_bytes: number; output_artifact_id: string | null;
      created_at: number; started_at: number | null; finished_at: number | null; generation: number;
    }[];
    return rows.map((row) => {
      const deps = (this.database.prepare(
        'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?'
      ).all(row.id) as { depends_on_task_id: string }[]).map((d) => d.depends_on_task_id);
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        ownerId: row.owner_id,
        name: row.name,
        command: row.command,
        cwd: row.cwd,
        status: row.status,
        idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint,
        bootId: row.boot_id,
        exitCode: row.exit_code,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        timeoutMs: row.timeout_ms,
        maxBytes: row.max_bytes,
        logPath: row.log_path,
        outputBytes: row.output_bytes,
        outputArtifactId: row.output_artifact_id,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        generation: row.generation,
        dependsOn: deps
      };
    });
  }

  updateDurableTaskStatus(
    taskId: string,
    expectedGeneration: number,
    updates: Partial<Pick<DurableTaskRecord, 'status' | 'exitCode' | 'errorCode' | 'errorMessage' | 'startedAt' | 'finishedAt' | 'outputBytes' | 'outputArtifactId'>>
  ): boolean {
    const sets: string[] = ['generation = generation + 1'];
    const values: (string | number | null)[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.exitCode !== undefined) { sets.push('exit_code = ?'); values.push(updates.exitCode); }
    if (updates.errorCode !== undefined) { sets.push('error_code = ?'); values.push(updates.errorCode); }
    if (updates.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(updates.errorMessage); }
    if (updates.startedAt !== undefined) { sets.push('started_at = ?'); values.push(updates.startedAt); }
    if (updates.finishedAt !== undefined) { sets.push('finished_at = ?'); values.push(updates.finishedAt); }
    if (updates.outputBytes !== undefined) { sets.push('output_bytes = ?'); values.push(updates.outputBytes); }
    if (updates.outputArtifactId !== undefined) { sets.push('output_artifact_id = ?'); values.push(updates.outputArtifactId); }
    values.push(taskId, expectedGeneration);
    const sql = `UPDATE durable_tasks SET ${sets.join(', ')} WHERE id = ? AND generation = ?`;
    const result = this.database.prepare(sql).run(...values);
    return Number(result.changes) === 1;
  }

  reconcileRunningTasks(currentBootId: string, now: number): number {
    const result = this.database.prepare(`
      UPDATE durable_tasks
      SET status = 'FAILED', error_code = 'RUNNER_RESTARTED',
          error_message = 'Task execution interrupted by runner restart',
          finished_at = ?, generation = generation + 1
      WHERE status IN ('QUEUED', 'RUNNING') AND boot_id != ?
    `).run(now, currentBootId);
    return Number(result.changes);
  }

  listStaleDurableTasks(olderThan: number): { id: string; logPath: string }[] {
    const rows = this.database.prepare(
      "SELECT id, log_path FROM durable_tasks WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL AND finished_at < ?"
    ).all(olderThan) as { id: string; log_path: string }[];
    return rows.map((row) => ({ id: row.id, logPath: row.log_path }));
  }

  deleteDurableTask(taskId: string): boolean {
    const result = this.database.prepare('DELETE FROM durable_tasks WHERE id = ?').run(taskId);
    return result.changes === 1;
  }

  getGitOperation(ownerId: string, workspaceId: string, idempotencyKey: string): GitOperationRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM git_operation_idempotency WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?'
    ).get(ownerId, workspaceId, idempotencyKey) as {
      owner_id: string; workspace_id: string; idempotency_key: string; operation: GitOperationKind;
      request_fingerprint: string; target_ref: string | null; expected_remote_oid: string | null;
      local_commit_sha: string | null; status: GitOperationStatus; result_json: string | null;
      error_json: string | null; created_at: number; finished_at: number | null;
    } | undefined;
    if (!row) return undefined;
    return {
      ownerId: row.owner_id,
      workspaceId: row.workspace_id,
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      requestFingerprint: row.request_fingerprint,
      targetRef: row.target_ref,
      expectedRemoteOid: row.expected_remote_oid,
      localCommitSha: row.local_commit_sha,
      status: row.status,
      resultJson: row.result_json,
      errorJson: row.error_json,
      createdAt: row.created_at,
      finishedAt: row.finished_at
    };
  }

  acquireGitOperation(record: {
    ownerId: string;
    workspaceId: string;
    idempotencyKey: string;
    operation: GitOperationKind;
    requestFingerprint: string;
    targetRef?: string | null;
    expectedRemoteOid?: string | null;
    localCommitSha?: string | null;
    createdAt: number;
  }): {
    action: 'ACQUIRED' | 'REPLAY_SUCCEEDED' | 'FINGERPRINT_CONFLICT' | 'IN_FLIGHT' | 'RECONCILE_REQUIRED';
    existing?: GitOperationRecord;
  } {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.getGitOperation(record.ownerId, record.workspaceId, record.idempotencyKey);
      if (!existing) {
        let legacyResultJson: string | undefined;
        let legacyCreatedAt = record.createdAt;
        if (record.operation === 'finalize') {
          try {
            const legacy = this.database.prepare(
              'SELECT result_json, created_at FROM finalize_idempotency WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?'
            ).get(record.ownerId, record.workspaceId, record.idempotencyKey) as { result_json: string; created_at: number } | undefined;
            if (legacy) {
              legacyResultJson = legacy.result_json;
              legacyCreatedAt = legacy.created_at;
            }
          } catch { /* ignore if table absent */ }
        }

        if (legacyResultJson) {
          this.database.prepare(`
            INSERT INTO git_operation_idempotency
            (owner_id, workspace_id, idempotency_key, operation, request_fingerprint, target_ref,
             expected_remote_oid, local_commit_sha, status, result_json, error_json, created_at, finished_at)
            VALUES (?, ?, ?, 'finalize', '', NULL, NULL, NULL, 'SUCCEEDED', ?, NULL, ?, ?)
          `).run(
            record.ownerId, record.workspaceId, record.idempotencyKey,
            legacyResultJson, legacyCreatedAt, legacyCreatedAt
          );
          this.database.exec('COMMIT;');
          return {
            action: 'REPLAY_SUCCEEDED',
            existing: {
              ownerId: record.ownerId,
              workspaceId: record.workspaceId,
              idempotencyKey: record.idempotencyKey,
              operation: 'finalize',
              requestFingerprint: '',
              targetRef: null,
              expectedRemoteOid: null,
              localCommitSha: null,
              status: 'SUCCEEDED',
              resultJson: legacyResultJson,
              errorJson: null,
              createdAt: legacyCreatedAt,
              finishedAt: legacyCreatedAt
            }
          };
        }

        this.database.prepare(`
          INSERT INTO git_operation_idempotency
          (owner_id, workspace_id, idempotency_key, operation, request_fingerprint, target_ref,
           expected_remote_oid, local_commit_sha, status, result_json, error_json, created_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, NULL)
        `).run(
          record.ownerId, record.workspaceId, record.idempotencyKey, record.operation,
          record.requestFingerprint, record.targetRef ?? null, record.expectedRemoteOid ?? null,
          record.localCommitSha ?? null, record.createdAt
        );
        this.database.exec('COMMIT;');
        return { action: 'ACQUIRED' };
      }

      this.database.exec('COMMIT;');
      if (existing.operation !== record.operation) {
        return { action: 'FINGERPRINT_CONFLICT', existing };
      }
      if (existing.operation === 'finalize' && record.operation === 'finalize' && existing.status === 'SUCCEEDED' && existing.requestFingerprint === '') {
        return { action: 'REPLAY_SUCCEEDED', existing };
      }
      if (existing.requestFingerprint !== record.requestFingerprint) {
        return { action: 'FINGERPRINT_CONFLICT', existing };
      }
      if (existing.status === 'SUCCEEDED') {
        return { action: 'REPLAY_SUCCEEDED', existing };
      }
      if (existing.status === 'PENDING') {
        return { action: 'IN_FLIGHT', existing };
      }
      return { action: 'RECONCILE_REQUIRED', existing };
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* ignore */ }
      throw error;
    }
  }

  recordGitOperationPending(record: Omit<GitOperationRecord, 'status' | 'resultJson' | 'errorJson' | 'finishedAt'>): GitOperationRecord {
    this.database.prepare(`
      INSERT INTO git_operation_idempotency
      (owner_id, workspace_id, idempotency_key, operation, request_fingerprint, target_ref,
       expected_remote_oid, local_commit_sha, status, result_json, error_json, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, NULL)
    `).run(
      record.ownerId, record.workspaceId, record.idempotencyKey, record.operation,
      record.requestFingerprint, record.targetRef, record.expectedRemoteOid,
      record.localCommitSha, record.createdAt
    );
    return {
      ...record,
      status: 'PENDING',
      resultJson: null,
      errorJson: null,
      finishedAt: null
    };
  }

  updateGitOperationStatus(
    ownerId: string,
    workspaceId: string,
    idempotencyKey: string,
    status: GitOperationStatus,
    resultJson?: string | null,
    errorJson?: string | null,
    localCommitSha?: string | null
  ): boolean {
    const now = Date.now();
    const result = this.database.prepare(`
      UPDATE git_operation_idempotency
      SET status = ?, result_json = COALESCE(?, result_json), error_json = COALESCE(?, error_json),
          local_commit_sha = COALESCE(?, local_commit_sha), finished_at = ?
      WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?
    `).run(
      status, resultJson ?? null, errorJson ?? null, localCommitSha ?? null,
      now, ownerId, workspaceId, idempotencyKey
    );
    return result.changes === 1;
  }
  reconcilePendingGitOperations(now: number): number {
    const pushResult = this.database.prepare(`
      UPDATE git_operation_idempotency
      SET status = 'UNKNOWN_REMOTE_STATE', error_json = '{"message":"Operation interrupted by runner restart"}', finished_at = ?
      WHERE status = 'PENDING' AND operation IN ('push', 'finalize')
    `).run(now);

    const commitResult = this.database.prepare(`
      UPDATE git_operation_idempotency
      SET status = 'FAILED', error_json = '{"message":"Commit interrupted by runner restart"}', finished_at = ?
      WHERE status = 'PENDING' AND operation = 'commit'
    `).run(now);

    return Number(pushResult.changes) + Number(commitResult.changes);
  }

  close(): void {
    this.database.close();
  }
}
