import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MAX_ACTIVE_WORKSPACES_PER_OWNER, RunnerPrincipalSelectorSchema, type ExecutorNetworkProfile } from '@cloud-harness/contracts';
import type { EncryptedSecret } from './secret-keyring.js';
import {
  ActiveWorkspaceLimitReachedError,
  COUNTED_WORKSPACE_STATUSES,
  ENUMERATED_WORKSPACE_STATUSES,
  ENUMERATED_WORKSPACE_STATUS_PARAMS,
  applyLegacyPrincipalMapping,
  applyPrincipalRelinks,
  countOwnerCountedWorkspaces as countOwnerCountedWorkspacesInDb,
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

import { KnowledgeStore } from './knowledge-store.js';
export { KnowledgeStore } from './knowledge-store.js';
export type {
  CreateKnowledgeItemParams,
  UpdateKnowledgeItemParams,
  DeleteKnowledgeItemParams,
  ListKnowledgeItemsParams,
  CreateKnowledgeLinkParams,
  DeleteKnowledgeLinkParams,
  KnowledgeItemWithLinks
} from './knowledge-store.js';
export type {
  ExternalPrincipalSelector,
  PrincipalRecord,
  PrincipalRelinkMapping,
  PrincipalRelinkResult,
  PrincipalSelector
} from './principal-store.js';
export {
  ActiveWorkspaceLimitReachedError,
  COUNTED_WORKSPACE_STATUSES,
  downgradeStateSchemaToV3,
  downgradeStateSchemaToV4,
  downgradeStateSchemaToV5,
  downgradeStateSchemaToV6,
  downgradeStateSchemaToV7,
  downgradeStateSchemaToV8,
  downgradeStateSchemaToV9,
  downgradeStateSchemaToV10,
  downgradeStateSchemaToV11
} from './principal-store.js';

export type MemoryRecord = {
  id: string;
  principalId: string;
  scope: 'owner' | 'repository' | 'workspace';
  repositoryKey: string | null;
  workspaceId: string | null;
  name: string;
  content: string;
  contentSha256: string;
  tags: string[];
  generation: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  deletedAt: number | null;
  provenance: Record<string, unknown>;
};

export type HookActivationRecord = {
  principalId: string;
  workspaceId: string;
  event: string;
  manifestSha256: string;
  createdAt: number;
  expiresAt: number;
};

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
  status: 'CREATING' | 'ACTIVE' | 'REAPING' | 'CLOSED' | 'FAILED' | 'EXPIRED_RECOVERABLE' | 'NETWORK_QUARANTINED';
  networkProfile: ExecutorNetworkProfile;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  mutationLockedUntil: number | null;
  generation: number;
  error: string | null;
  requestFingerprint?: string | null;
};

export type ToolkitCacheEntryRecord = {
  cacheKey: string;
  ownerId: string;
  sourceIdentity: string;
  resolvedRevision: string;
  adapterVersion: number;
  bundleSha256: string;
  status: 'INITIALIZING' | 'READY' | 'FAILED';
  byteCount: number;
  fileCount: number;
  createdAt: number;
  lastUsedAt: number;
  errorSummary: string | null;
};

export type WorkspaceToolkitRecord = {
  workspaceId: string;
  ordinal: number;
  ownerId: string;
  toolkitId: string;
  scope: 'owner' | 'workspace';
  requestedJson: string;
  resolvedJson: string;
  bundleSha256: string;
};

type ToolkitCacheEntryRow = {
  cache_key: string;
  owner_id: string;
  source_identity: string;
  resolved_revision: string;
  adapter_version: number;
  bundle_sha256: string;
  status: 'INITIALIZING' | 'READY' | 'FAILED';
  byte_count: number;
  file_count: number;
  created_at: number;
  last_used_at: number;
  error_summary: string | null;
};

type WorkspaceToolkitRow = {
  workspace_id: string;
  ordinal: number;
  owner_id: string;
  toolkit_id: string;
  scope: 'owner' | 'workspace';
  requested_json: string;
  resolved_json: string;
  bundle_sha256: string;
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
  container_name: string | null; workspace_path: string; environment_id?: string | null; status: WorkspaceRecord['status']; network_profile: ExecutorNetworkProfile;
  created_at: number; last_activity_at: number; expires_at: number; hard_expires_at?: number | null;
  git_author_name?: string | null; git_author_email?: string | null; mutation_locked_until?: number | null;
  generation: number; error: string | null; request_fingerprint?: string | null;
};

/**
 * A provenance column that cannot be parsed is reported as absent rather than thrown, because a reader that
 * fails on one legacy row would hide every other row on the same page.
 */function parseProvenance(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * SAFETY: `networkMode` only exists on rows written before the profile field replaced it, so the cast is
 * what lets this reader keep working for those rows. A row carrying neither field falls back to the
 * strictest profile rather than to an open one, which is the direction that cannot widen access.
 */
function legacyNetworkMode(record: WorkspaceRecord | Row): string | undefined {
  // SAFETY: `networkMode` only exists on rows written before the profile field replaced it, so the cast is
  // what lets this reader keep working for those rows. A record carrying neither field falls back to the
  // strictest profile rather than to an open one, which is the direction that cannot widen access.
  return (record as unknown as { networkMode?: string }).networkMode;
}

const fromRow = (row: Row): WorkspaceRecord => ({
  id: row.id, ownerId: row.owner_id, idempotencyKey: row.idempotency_key, repositoryUrl: row.repository_url,
  repositoryRef: row.repository_ref, containerName: row.container_name, workspacePath: row.workspace_path,
  environmentId: row.environment_id ?? null,
  status: row.status, networkProfile: row.network_profile, createdAt: row.created_at, lastActivityAt: row.last_activity_at,
  expiresAt: row.expires_at, hardExpiresAt: row.hard_expires_at ?? (row.created_at + 14_400_000),
  gitAuthorName: row.git_author_name ?? null, gitAuthorEmail: row.git_author_email ?? null,
  mutationLockedUntil: row.mutation_locked_until ?? null,
  generation: row.generation, error: row.error,
  requestFingerprint: row.request_fingerprint ?? null
});

/**
 * Selects every workspace a sweep or startup reconciliation must visit: the counted
 * slots plus in-flight teardown, so a record stuck in `REAPING` is still reconciled.
 * Capacity is counted from the counted statuses alone, never from this set.
 */
const SELECT_ENUMERATED_WORKSPACES_SQL = `SELECT * FROM workspaces WHERE status IN (${ENUMERATED_WORKSPACE_STATUS_PARAMS})`;

export type SkillSourceState = 'enabled' | 'disabled' | 'archived';
export type SkillSourceKind = 'built-in' | 'owner' | 'workspace' | 'repository' | 'registry';
export type SkillProvider = 'skills-sh' | 'skillx' | 'git' | 'custom';
export type SkillRevisionOrigin = 'import' | 'refresh' | 'edit' | 'restore' | 'fork';
export type SkillImportJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type SkillImportSourceKind = 'skills-sh' | 'skillx' | 'git';
export type SkillTier = 'built-in' | 'owner' | 'workspace' | 'repository';

/** Store-level failure with a stable code so the control plane can map it to a status without the store importing HTTP types. */
export class SkillRegistryError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT', message: string) {
    super(message);
    this.name = 'SkillRegistryError';
  }
}

const MAX_SKILL_TAGS = 16;
const MAX_SKILL_TAG_LENGTH = 32;
// The same allowlist as an array, for the readers that pass it as a parameter instead of interpolating it,
// so the statement text stays constant whatever the list contains.
const ACTIVE_WORKSPACE_STATUS_LIST = ['CREATING', 'ACTIVE', 'REAPING', 'NETWORK_QUARANTINED'];

function parseSkillTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeSkillTags(tags: string[]): string {
  if (tags.length > MAX_SKILL_TAGS) {
    throw new SkillRegistryError('INVALID_INPUT', `a skill source accepts at most ${MAX_SKILL_TAGS} tags`);
  }
  const normalized = tags.map((tag) => tag.trim());
  for (const tag of normalized) {
    if (tag.length === 0 || tag.length > MAX_SKILL_TAG_LENGTH) {
      throw new SkillRegistryError('INVALID_INPUT', `each skill tag must be 1 to ${MAX_SKILL_TAG_LENGTH} characters`);
    }
    if (tag.includes('\0')) throw new SkillRegistryError('INVALID_INPUT', 'a skill tag cannot contain a null byte');
  }
  return JSON.stringify([...new Set(normalized)]);
}

export class StateStore {
  readonly database: DatabaseSync;
  readonly knowledge: KnowledgeStore;
  /** Per-principal active-workspace limit, applied to legacy ownership merges. */
  readonly maxActiveWorkspacesPerOwner: number;
  constructor(path: string, options: { maxActiveWorkspacesPerOwner?: number } = {}) {
    this.maxActiveWorkspacesPerOwner = options.maxActiveWorkspacesPerOwner ?? DEFAULT_MAX_ACTIVE_WORKSPACES_PER_OWNER;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try {
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
    if (!cols.includes('request_fingerprint')) {
      this.database.exec('ALTER TABLE workspaces ADD COLUMN request_fingerprint TEXT;');
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
      CREATE TABLE IF NOT EXISTS instance_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        default_network_profile TEXT CHECK(default_network_profile IN ('network-none','dependency-access')),
        updated_at INTEGER NOT NULL
      );
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
    // One-way migration. A database written by an earlier release may still carry
    // the retired single-active index, including via the former v5->v6 upgrade
    // path, and it cannot be re-created once an owner legally holds two counted
    // workspaces. The boot path never re-creates it.
    this.database.exec('DROP INDEX IF EXISTS one_active_workspace_per_owner;');
      this.database.prepare('INSERT OR IGNORE INTO runtime_meta(key, value) VALUES (?, ?)')
        .run('runner_instance_id', randomBytes(18).toString('hex'));
      this.knowledge = new KnowledgeStore(this.database);
    } catch (err) {
      try { this.database.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  instanceId(): string {
    const row = this.database.prepare('SELECT value FROM runtime_meta WHERE key = ?').get('runner_instance_id') as { value: string } | undefined;
    if (!row || !/^[a-f0-9]{36}$/.test(row.value)) throw new Error('invalid persisted runner instance identity');
    return row.value;
  }

  create(record: WorkspaceRecord): void {
    this.database.prepare(`INSERT INTO workspaces
      (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, environment_id, status, network_profile, created_at, last_activity_at, expires_at, hard_expires_at, git_author_name, git_author_email, mutation_locked_until, generation, error, request_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        record.networkProfile ?? (legacyNetworkMode(record) === 'bridge' ? 'dependency-access' : 'network-none'),
        record.createdAt,
        record.lastActivityAt,
        record.expiresAt,
        record.hardExpiresAt ?? (record.createdAt + 14_400_000),
        record.gitAuthorName ?? null,
        record.gitAuthorEmail ?? null,
        record.mutationLockedUntil ?? null,
        record.generation ?? 1,
        record.error ?? null,
        record.requestFingerprint ?? null
      );
  }

  /**
   * Atomically admits a new active workspace while the owner is below
   * `activeLimit`. The count and the insert share one transaction, which makes this
   * the admission authority: `WorkspaceService.ensureCapacity` awaits container and
   * disk work before calling it, so no pre-check can be trusted on its own.
   */
  admit(record: WorkspaceRecord, activeLimit: number): void {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const active = this.countOwnerCountedWorkspaces(record.ownerId);
      if (active >= activeLimit) throw new ActiveWorkspaceLimitReachedError(active, activeLimit);
      this.create(record);
      this.database.exec('COMMIT;');
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  /**
   * Fenced activation that charges a slot only when the record is not already
   * counted, so every promotion out of `EXPIRED_RECOVERABLE` is bounded by the
   * limit while re-activating an already-counted record (startup reconciliation)
   * is never blocked by a lowered limit.
   */
  activateWithLimit(
    id: string,
    expectedGeneration: number,
    expectedStatuses: WorkspaceRecord['status'][],
    changes: Partial<Pick<WorkspaceRecord, 'containerName' | 'status' | 'lastActivityAt' | 'expiresAt' | 'generation' | 'error'>>,
    activeLimit: number
  ): WorkspaceRecord | undefined {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const current = this.byId(id);
      if (!current || current.generation !== expectedGeneration || !expectedStatuses.includes(current.status)) {
        this.database.exec('ROLLBACK;');
        return undefined;
      }
      const countedStatuses: readonly string[] = COUNTED_WORKSPACE_STATUSES;
      if (!countedStatuses.includes(current.status)) {
        const active = this.countOwnerCountedWorkspaces(current.ownerId);
        if (active >= activeLimit) throw new ActiveWorkspaceLimitReachedError(active, activeLimit);
      }
      const updated = this.updateFenced(id, expectedGeneration, expectedStatuses, changes);
      this.database.exec('COMMIT;');
      return updated;
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  /** Counts the workspaces currently occupying one owner's active slots. */
  countOwnerCountedWorkspaces(ownerId: string): number {
    return countOwnerCountedWorkspacesInDb(this.database, ownerId);
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
      return resolveOwnerPrincipal(this.database, parsed.ownerId, this.maxActiveWorkspacesPerOwner);
    }
    return this.resolveExternalPrincipal(parsed);
  }

  resolveExternalPrincipal(selector: ExternalPrincipalSelector, options: { legacyOwnerId?: string } = {}): string {
    return resolveExternalPrincipal(this.database, selector, options, this.maxActiveWorkspacesPerOwner);
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
    return applyLegacyPrincipalMapping(this.database, mapping, this.maxActiveWorkspacesPerOwner);
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
    return (this.database.prepare(SELECT_ENUMERATED_WORKSPACES_SQL)
      .all(...ENUMERATED_WORKSPACE_STATUSES) as Row[]).map(fromRow);
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

  /**
   * The operator-selected default network profile for newly opened workspaces.
   * `undefined` means no choice has been persisted, so the runner configuration
   * (`WORKSPACE_NETWORK_PROFILE` or the built-in default) applies.
   */
  getWorkspaceDefaultNetworkProfile(): ExecutorNetworkProfile | undefined {
    const row = this.database
      .prepare('SELECT default_network_profile FROM instance_settings WHERE id = 1')
      .get() as { default_network_profile: string | null } | undefined;
    const value = row?.default_network_profile;
    return value === 'network-none' || value === 'dependency-access' ? value : undefined;
  }

  /** Persist the operator's default, or clear it with `null` to restore the runner default. */
  setWorkspaceDefaultNetworkProfile(value: ExecutorNetworkProfile | null, updatedAt: number = Date.now()): void {
    this.database.prepare(`INSERT INTO instance_settings(id, default_network_profile, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET default_network_profile = excluded.default_network_profile, updated_at = excluded.updated_at`)
      .run(value, updatedAt);
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
    // More than one active workspace makes an implicit target ambiguous. The
    // destructive tools (`workspace_close`, `workspace_finalize`, `files_write`,
    // `git_commit`) accept an optional `workspaceId`, so honouring the stored
    // preference here would silently act on a workspace the caller may not mean.
    // Refuse and name the candidates instead of guessing.
    if (activeWorkspaces.length > 1) throw new Error('AMBIGUOUS_ACTIVE_WORKSPACES');
    const firstActive = activeWorkspaces[0];
    if (firstActive) return firstActive;
    const recoverable = this.list(ownerId).filter((w) => w.status === 'EXPIRED_RECOVERABLE' || w.status === 'NETWORK_QUARANTINED');
    if (recoverable.length === 0) throw new Error('NO_ACTIVE_WORKSPACE');
    // With nothing active the preference selects among recoverable records, which is
    // the only remaining case where it is unambiguous.
    const preferred = this.getPreferredWorkspace(ownerId);
    if (preferred) {
      const record = this.byOwnerAndId(ownerId, preferred);
      if (record && (record.status === 'EXPIRED_RECOVERABLE' || record.status === 'NETWORK_QUARANTINED')) {
        return record;
      }
    }
    const firstRecoverable = recoverable[0];
    if (recoverable.length === 1 && firstRecoverable) return firstRecoverable;
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
    // The status allowlist travels as one parameter and is expanded by SQLite, so the statement text is
    // constant no matter how many statuses are passed and nothing is ever interpolated into it.
    const result = this.database.prepare(`UPDATE workspaces SET container_name=?, status=?, last_activity_at=?, expires_at=?, generation=?, error=?
      WHERE id=? AND generation=? AND status IN (SELECT value FROM json_each(?))`)
      .run(next.containerName, next.status, next.lastActivityAt, next.expiresAt, next.generation, next.error, id, expectedGeneration, JSON.stringify(expectedStatuses));
    return result.changes === 1 ? next : undefined;
  }

  claimForReaping(id: string, generation: number, force = false): boolean {
    const now = Date.now();
    const sql = force
      ? "UPDATE workspaces SET status='REAPING', generation=generation+1, mutation_lock_count=0, mutation_locked_until=NULL WHERE id=? AND generation=? AND status IN ('CREATING','ACTIVE','FAILED','EXPIRED_RECOVERABLE','NETWORK_QUARANTINED')"
      : "UPDATE workspaces SET status='REAPING', generation=generation+1 WHERE id=? AND generation=? AND status IN ('CREATING','ACTIVE','FAILED','EXPIRED_RECOVERABLE','NETWORK_QUARANTINED') AND (mutation_locked_until IS NULL OR mutation_locked_until <= ?)";
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


  createMemory(params: {
    principalId: string;
    scope: 'owner' | 'repository' | 'workspace';
    repositoryKey?: string | null;
    workspaceId?: string | null;
    name: string;
    content: string;
    tags?: string[];
    retentionSeconds?: number;
  }): MemoryRecord {
    const now = Date.now();
    const id = `mem_${randomBytes(16).toString('base64url')}`;
    const contentSha256 = createHash('sha256').update(params.content).digest('hex');
    const ttl = params.retentionSeconds ? params.retentionSeconds * 1000 : (90 * 86_400_000);
    const expiresAt = now + ttl;
    const provenance = {
      source: params.scope === 'owner' ? 'owner' : params.scope === 'repository' ? 'repository' : 'workspace',
      trust: params.scope === 'owner' ? 'owner-controlled' : 'untrusted-executor',
      mutableBy: params.scope === 'owner' ? 'owner' : params.scope === 'repository' ? 'repository-commit' : 'workspace-process',
      contentSha256,
      discoveredAt: new Date(now).toISOString()
    };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      // Check conflict on active name in scope
      let conflictQuery = '';
      const conflictArgs: (string | number | null)[] = [params.principalId, params.name];
      if (params.scope === 'owner') {
        conflictQuery = 'SELECT id FROM memories WHERE principal_id = ? AND name = ? AND scope = \'owner\' AND deleted_at IS NULL AND expires_at > ?';
        conflictArgs.push(now);
      } else if (params.scope === 'repository') {
        conflictQuery = 'SELECT id FROM memories WHERE principal_id = ? AND name = ? AND repository_key = ? AND scope = \'repository\' AND deleted_at IS NULL AND expires_at > ?';
        conflictArgs.splice(2, 0, params.repositoryKey ?? null);
        conflictArgs.push(now);
      } else {
        conflictQuery = 'SELECT id FROM memories WHERE principal_id = ? AND name = ? AND workspace_id = ? AND scope = \'workspace\' AND deleted_at IS NULL AND expires_at > ?';
        conflictArgs.splice(2, 0, params.workspaceId ?? null);
        conflictArgs.push(now);
      }

      const existing = this.database.prepare(conflictQuery).get(...conflictArgs);
      if (existing) {
        throw new Error('memory note already exists with this name in the given scope');
      }

      if (params.scope === 'owner') {
        this.database.prepare('DELETE FROM memories WHERE principal_id = ? AND name = ? AND scope = \'owner\' AND (expires_at <= ? OR deleted_at IS NOT NULL)')
          .run(params.principalId, params.name, now);
      } else if (params.scope === 'repository') {
        this.database.prepare('DELETE FROM memories WHERE principal_id = ? AND name = ? AND repository_key = ? AND scope = \'repository\' AND (expires_at <= ? OR deleted_at IS NOT NULL)')
          .run(params.principalId, params.name, params.repositoryKey ?? null, now);
      } else {
        this.database.prepare('DELETE FROM memories WHERE principal_id = ? AND name = ? AND workspace_id = ? AND scope = \'workspace\' AND (expires_at <= ? OR deleted_at IS NOT NULL)')
          .run(params.principalId, params.name, params.workspaceId ?? null, now);
      }
      this.database.prepare(`
        INSERT INTO memories
        (id, principal_id, scope, repository_key, workspace_id, name, content, content_sha256, generation, created_at, updated_at, expires_at, deleted_at, provenance_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
      `).run(
        id, params.principalId, params.scope, params.repositoryKey ?? null, params.workspaceId ?? null,
        params.name, params.content, contentSha256, now, now, expiresAt, JSON.stringify(provenance)
      );

      const tags = (params.tags || []).map(t => t.toLowerCase().trim()).filter(Boolean);
      for (const tag of tags) {
        this.database.prepare('INSERT OR IGNORE INTO memory_tags (principal_id, memory_id, tag) VALUES (?, ?, ?)')
          .run(params.principalId, id, tag);
      }

      this.database.exec('COMMIT');
      return {
        id,
        principalId: params.principalId,
        scope: params.scope,
        repositoryKey: params.repositoryKey ?? null,
        workspaceId: params.workspaceId ?? null,
        name: params.name,
        content: params.content,
        contentSha256,
        tags,
        generation: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        deletedAt: null,
        provenance
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  updateMemory(params: {
    principalId: string;
    id?: string;
    name?: string;
    scope?: 'owner' | 'repository' | 'workspace';
    repositoryKey?: string | null;
    workspaceId?: string | null;
    content: string;
    tags?: string[];
    retentionSeconds?: number;
    expectedGeneration: number;
  }): MemoryRecord {
    const now = Date.now();
    const contentSha256 = createHash('sha256').update(params.content).digest('hex');
    const ttl = params.retentionSeconds ? params.retentionSeconds * 1000 : (90 * 86_400_000);
    const expiresAt = now + ttl;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      let row: any = null;
      if (params.id) {
        row = this.database.prepare(`
          SELECT * FROM memories
          WHERE id = ? AND principal_id = ? AND deleted_at IS NULL AND expires_at > ?
        `).get(params.id, params.principalId, now);
      } else if (params.name && params.scope) {
        let query = 'SELECT * FROM memories WHERE principal_id = ? AND name = ? AND scope = ? AND deleted_at IS NULL AND expires_at > ?';
        const args: (string | number | null)[] = [params.principalId, params.name, params.scope, now];
        if (params.scope === 'repository') {
          query = 'SELECT * FROM memories WHERE principal_id = ? AND name = ? AND scope = ? AND repository_key = ? AND deleted_at IS NULL AND expires_at > ?';
          args.splice(3, 0, params.repositoryKey ?? null);
        } else if (params.scope === 'workspace') {
          query = 'SELECT * FROM memories WHERE principal_id = ? AND name = ? AND scope = ? AND workspace_id = ? AND deleted_at IS NULL AND expires_at > ?';
          args.splice(3, 0, params.workspaceId ?? null);
        }
        row = this.database.prepare(query).get(...args);
      }

      if (!row) {
        throw new Error('memory note not found');
      }

      if (row.generation !== params.expectedGeneration) {
        throw new Error(`memory generation conflict: expected ${params.expectedGeneration}, current is ${row.generation}`);
      }

      const nextGen = row.generation + 1;
      const prov = JSON.parse(row.provenance_json);
      prov.contentSha256 = contentSha256;
      prov.discoveredAt = new Date(now).toISOString();

      this.database.prepare(`
        UPDATE memories
        SET content = ?, content_sha256 = ?, generation = ?, updated_at = ?, expires_at = ?, provenance_json = ?
        WHERE id = ? AND generation = ?
      `).run(params.content, contentSha256, nextGen, now, expiresAt, JSON.stringify(prov), row.id, row.generation);

      const tags = (params.tags || []).map(t => t.toLowerCase().trim()).filter(Boolean);
      this.database.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(row.id);
      for (const tag of tags) {
        this.database.prepare('INSERT OR IGNORE INTO memory_tags (principal_id, memory_id, tag) VALUES (?, ?, ?)')
          .run(params.principalId, row.id, tag);
      }

      this.database.exec('COMMIT');
      return {
        id: row.id,
        principalId: row.principal_id,
        scope: row.scope,
        repositoryKey: row.repository_key,
        workspaceId: row.workspace_id,
        name: row.name,
        content: params.content,
        contentSha256,
        tags,
        generation: nextGen,
        createdAt: row.created_at,
        updatedAt: now,
        expiresAt,
        deletedAt: null,
        provenance: prov
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteMemory(params: {
    principalId: string;
    id?: string;
    name?: string;
    scope?: 'owner' | 'repository' | 'workspace';
    repositoryKey?: string | null;
    workspaceId?: string | null;
    expectedGeneration: number;
  }): boolean {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      let row: any = null;
      if (params.id) {
        row = this.database.prepare(`
          SELECT * FROM memories WHERE id = ? AND principal_id = ? AND deleted_at IS NULL
        `).get(params.id, params.principalId);
      } else if (params.name && params.scope) {
        let query = 'SELECT * FROM memories WHERE principal_id = ? AND name = ? AND scope = ? AND deleted_at IS NULL';
        const args: (string | number | null)[] = [params.principalId, params.name, params.scope];
        if (params.scope === 'repository') {
          query += ' AND repository_key = ?';
          args.push(params.repositoryKey ?? null);
        } else if (params.scope === 'workspace') {
          query += ' AND workspace_id = ?';
          args.push(params.workspaceId ?? null);
        }
        row = this.database.prepare(query).get(...args);
      } else if (params.name) {
        let query = 'SELECT * FROM memories WHERE principal_id = ? AND name = ? AND deleted_at IS NULL';
        const args: (string | number | null)[] = [params.principalId, params.name];
        if (params.repositoryKey || params.workspaceId) {
          query += ' AND (scope = \'owner\'';
          if (params.repositoryKey) {
            query += ' OR (scope = \'repository\' AND repository_key = ?)';
            args.push(params.repositoryKey);
          }
          if (params.workspaceId) {
            query += ' OR (scope = \'workspace\' AND workspace_id = ?)';
            args.push(params.workspaceId);
          }
          query += ')';
        }
        query += ' ORDER BY updated_at DESC LIMIT 1';
        row = this.database.prepare(query).get(...args);
      }
      if (!row) {
        throw new Error('memory note not found');
      }
      if (row.generation !== params.expectedGeneration) {
        throw new Error(`memory generation conflict: expected ${params.expectedGeneration}, current is ${row.generation}`);
      }
      this.database.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(now, row.id);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  readMemory(params: {
    principalId: string;
    id?: string;
    name?: string;
    scope?: 'owner' | 'repository' | 'workspace';
    repositoryKey?: string | null;
    workspaceId?: string | null;
  }): MemoryRecord | null {
    const now = Date.now();
    let query = 'SELECT * FROM memories WHERE principal_id = ? AND deleted_at IS NULL AND expires_at > ?';
    const args: (string | number | null)[] = [params.principalId, now];
    if (params.id) {
      query += ' AND id = ?';
      args.push(params.id);
    } else if (params.name) {
      query += ' AND name = ?';
      args.push(params.name);
    } else {
      return null;
    }

    if (params.scope) {
      query += ' AND scope = ?';
      args.push(params.scope);
      if (params.scope === 'repository' && params.repositoryKey) {
        query += ' AND repository_key = ?';
        args.push(params.repositoryKey);
      } else if (params.scope === 'workspace' && params.workspaceId) {
        query += ' AND workspace_id = ?';
        args.push(params.workspaceId);
      }
    } else if (params.repositoryKey || params.workspaceId) {
      query += ' AND (scope = \'owner\'';
      if (params.repositoryKey) {
        query += ' OR (scope = \'repository\' AND repository_key = ?)';
        args.push(params.repositoryKey);
      }
      if (params.workspaceId) {
        query += ' OR (scope = \'workspace\' AND workspace_id = ?)';
        args.push(params.workspaceId);
      }
      query += ')';
    }

    query += ' ORDER BY updated_at DESC LIMIT 1';
    const row = this.database.prepare(query).get(...args) as any;
    if (!row) return null;
    const tagRows = this.database.prepare('SELECT tag FROM memory_tags WHERE memory_id = ?').all(row.id) as { tag: string }[];
    return {
      id: row.id,
      principalId: row.principal_id,
      scope: row.scope,
      repositoryKey: row.repository_key,
      workspaceId: row.workspace_id,
      name: row.name,
      content: row.content,
      contentSha256: row.content_sha256,
      tags: tagRows.map((t) => t.tag),
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      deletedAt: row.deleted_at,
      provenance: parseProvenance(row.provenance_json)
    };
  }

  listMemories(params: {
    principalId: string;
    scope?: 'owner' | 'repository' | 'workspace';
    repositoryKey?: string | null;
    workspaceId?: string | null;
    tags?: string[];
    tagMatch?: 'all' | 'any';
    limit?: number;
    cursor?: string;
  }): { memories: MemoryRecord[]; nextCursor?: string } {
    const now = Date.now();
    const limit = Math.min(Math.max(params.limit || 50, 1), 100);
    const offset = Number(params.cursor || 0);

    let query = 'SELECT * FROM memories WHERE principal_id = ? AND deleted_at IS NULL AND expires_at > ?';
    const args: (string | number | null)[] = [params.principalId, now];

    if (params.scope) {
      query += ' AND scope = ?';
      args.push(params.scope);
      if (params.scope === 'repository' && params.repositoryKey) {
        query += ' AND repository_key = ?';
        args.push(params.repositoryKey);
      } else if (params.scope === 'workspace' && params.workspaceId) {
        query += ' AND workspace_id = ?';
        args.push(params.workspaceId);
      }
    } else if (params.repositoryKey || params.workspaceId) {
      query += ' AND (scope = \'owner\'';
      if (params.repositoryKey) {
        query += ' OR (scope = \'repository\' AND repository_key = ?)';
        args.push(params.repositoryKey);
      }
      if (params.workspaceId) {
        query += ' OR (scope = \'workspace\' AND workspace_id = ?)';
        args.push(params.workspaceId);
      }
      query += ')';
    } else {
      query += ' AND scope = \'owner\'';
    }

    const cleanTags = (params.tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean);
    if (cleanTags.length > 0) {
      const placeholders = cleanTags.map(() => '?').join(',');
      if (params.tagMatch === 'any') {
        query += ` AND id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}))`;
        args.push(...cleanTags);
      } else {
        query += ` AND id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}) GROUP BY memory_id HAVING COUNT(DISTINCT tag) = ${cleanTags.length})`;
        args.push(...cleanTags);
      }
    }

    query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    args.push(limit + 1, offset);

    const rows = this.database.prepare(query).all(...args) as any[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(offset + limit) : undefined;

    const memories = page.map((row) => {
      const tagRows = this.database.prepare('SELECT tag FROM memory_tags WHERE memory_id = ?').all(row.id) as { tag: string }[];
      return {
        id: row.id,
        principalId: row.principal_id,
        scope: row.scope,
        repositoryKey: row.repository_key,
        workspaceId: row.workspace_id,
        name: row.name,
        content: row.content,
        contentSha256: row.content_sha256,
        tags: tagRows.map((t) => t.tag),
        generation: row.generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        deletedAt: row.deleted_at,
        provenance: parseProvenance(row.provenance_json)
      };
    });

    return {
      memories,
      ...(nextCursor ? { nextCursor } : {})
    };
  }

  searchMemories(params: {
    principalId: string;
    query: string;
    scope?: 'owner' | 'repository' | 'workspace';
    repositoryKey?: string | null;
    workspaceId?: string | null;
    tags?: string[];
    tagMatch?: 'all' | 'any';
    limit?: number;
    cursor?: string;
  }): { memories: MemoryRecord[]; nextCursor?: string } {
    const now = Date.now();
    const limit = Math.min(Math.max(params.limit || 20, 1), 50);
    const offset = Number(params.cursor || 0);
    const tokens = params.query.toLowerCase().trim().split(/\s+/).filter(Boolean);

    let sql = 'SELECT * FROM memories WHERE principal_id = ? AND deleted_at IS NULL AND expires_at > ?';
    const args: (string | number | null)[] = [params.principalId, now];

    if (params.scope) {
      sql += ' AND scope = ?';
      args.push(params.scope);
      if (params.scope === 'repository' && params.repositoryKey) {
        sql += ' AND repository_key = ?';
        args.push(params.repositoryKey);
      } else if (params.scope === 'workspace' && params.workspaceId) {
        sql += ' AND workspace_id = ?';
        args.push(params.workspaceId);
      }
    } else if (params.repositoryKey || params.workspaceId) {
      sql += ' AND (scope = \'owner\'';
      if (params.repositoryKey) {
        sql += ' OR (scope = \'repository\' AND repository_key = ?)';
        args.push(params.repositoryKey);
      }
      if (params.workspaceId) {
        sql += ' OR (scope = \'workspace\' AND workspace_id = ?)';
        args.push(params.workspaceId);
      }
      sql += ')';
    } else {
      sql += ' AND scope = \'owner\'';
    }

    const cleanTags = (params.tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean);
    if (cleanTags.length > 0) {
      const placeholders = cleanTags.map(() => '?').join(',');
      if (params.tagMatch === 'any') {
        sql += ` AND id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}))`;
        args.push(...cleanTags);
      } else {
        sql += ` AND id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}) GROUP BY memory_id HAVING COUNT(DISTINCT tag) = ${cleanTags.length})`;
        args.push(...cleanTags);
      }
    }

    for (const token of tokens) {
      sql += ' AND (instr(lower(name), ?) > 0 OR instr(lower(content), ?) > 0)';
      args.push(token, token);
    }

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    args.push(limit + 1, offset);

    const rows = this.database.prepare(sql).all(...args) as any[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(offset + limit) : undefined;

    const memories = page.map((row) => {
      const tagRows = this.database.prepare('SELECT tag FROM memory_tags WHERE memory_id = ?').all(row.id) as { tag: string }[];
      return {
        id: row.id,
        principalId: row.principal_id,
        scope: row.scope,
        repositoryKey: row.repository_key,
        workspaceId: row.workspace_id,
        name: row.name,
        content: row.content,
        contentSha256: row.content_sha256,
        tags: tagRows.map((t) => t.tag),
        generation: row.generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        deletedAt: row.deleted_at,
        provenance: parseProvenance(row.provenance_json)
      };
    });

    return {
      memories,
      ...(nextCursor ? { nextCursor } : {})
    };
  }
  reapWorkspaceMemories(principalId: string, workspaceId: string): number {
    const res = this.database.prepare('DELETE FROM memories WHERE principal_id = ? AND workspace_id = ? AND scope = \'workspace\'')
      .run(principalId, workspaceId);
    this.database.prepare('DELETE FROM hook_activations WHERE principal_id = ? AND workspace_id = ?')
      .run(principalId, workspaceId);
    return Number(res.changes);
  }

  activateHook(params: {
    principalId: string;
    workspaceId: string;
    event: string;
    manifestSha256: string;
    retentionSeconds?: number;
  }): HookActivationRecord {
    const now = Date.now();
    const ttl = params.retentionSeconds ? params.retentionSeconds * 1000 : (30 * 86_400_000);
    const expiresAt = now + ttl;

    this.database.prepare(`
      INSERT INTO hook_activations (principal_id, workspace_id, event, manifest_sha256, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(principal_id, workspace_id, event) DO UPDATE SET
        manifest_sha256 = excluded.manifest_sha256,
        expires_at = excluded.expires_at
    `).run(params.principalId, params.workspaceId, params.event, params.manifestSha256, now, expiresAt);

    return {
      principalId: params.principalId,
      workspaceId: params.workspaceId,
      event: params.event,
      manifestSha256: params.manifestSha256,
      createdAt: now,
      expiresAt
    };
  }

  deactivateHook(params: {
    principalId: string;
    workspaceId: string;
    event?: string;
  }): boolean {
    if (params.event) {
      const res = this.database.prepare('DELETE FROM hook_activations WHERE principal_id = ? AND workspace_id = ? AND event = ?')
        .run(params.principalId, params.workspaceId, params.event);
      return Number(res.changes) > 0;
    }
    const res = this.database.prepare('DELETE FROM hook_activations WHERE principal_id = ? AND workspace_id = ?')
      .run(params.principalId, params.workspaceId);
    return Number(res.changes) > 0;
  }

  getActiveHookActivations(principalId: string, workspaceId: string): HookActivationRecord[] {
    const now = Date.now();
    const rows = this.database.prepare(`
      SELECT * FROM hook_activations
      WHERE principal_id = ? AND workspace_id = ? AND expires_at > ?
    `).all(principalId, workspaceId, now) as any[];

    return rows.map(r => ({
      principalId: r.principal_id,
      workspaceId: r.workspace_id,
      event: r.event,
      manifestSha256: r.manifest_sha256,
      createdAt: r.created_at,
      expiresAt: r.expires_at
    }));
  }

  upsertToolkitCacheEntry(entry: ToolkitCacheEntryRecord): void {
    this.database.prepare(`
      INSERT INTO toolkit_cache_entries (
        cache_key, owner_id, source_identity, resolved_revision, adapter_version,
        bundle_sha256, status, byte_count, file_count, created_at, last_used_at, error_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        status = excluded.status,
        bundle_sha256 = excluded.bundle_sha256,
        byte_count = excluded.byte_count,
        file_count = excluded.file_count,
        last_used_at = excluded.last_used_at,
        error_summary = excluded.error_summary
    `).run(
      entry.cacheKey,
      entry.ownerId,
      entry.sourceIdentity,
      entry.resolvedRevision,
      entry.adapterVersion,
      entry.bundleSha256,
      entry.status,
      entry.byteCount,
      entry.fileCount,
      entry.createdAt,
      entry.lastUsedAt,
      entry.errorSummary ?? null
    );
  }

  getToolkitCacheEntry(cacheKey: string): ToolkitCacheEntryRecord | undefined {
    const row = this.database.prepare('SELECT * FROM toolkit_cache_entries WHERE cache_key = ?').get(cacheKey) as ToolkitCacheEntryRow | undefined;
    if (!row) return undefined;
    return {
      cacheKey: row.cache_key,
      ownerId: row.owner_id,
      sourceIdentity: row.source_identity,
      resolvedRevision: row.resolved_revision,
      adapterVersion: row.adapter_version,
      bundleSha256: row.bundle_sha256,
      status: row.status,
      byteCount: row.byte_count,
      fileCount: row.file_count,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      errorSummary: row.error_summary
    };
  }

  /**
   * Every toolkit pin an owner's live workspaces hold. This is what makes a cached toolkit locked: the bytes
   * are not merely present, something is still resolving against them.
   */
  listOwnerToolkitPins(ownerId: string): Array<{ toolkitId: string; workspaceId: string; bundleSha256: string; resolvedJson: string }> {
    return this.database.prepare(
      `SELECT wt.toolkit_id AS toolkitId, wt.workspace_id AS workspaceId, wt.bundle_sha256 AS bundleSha256, wt.resolved_json AS resolvedJson
       FROM workspace_toolkits wt
       JOIN workspaces w ON w.id = wt.workspace_id
       WHERE wt.owner_id = ? AND w.status IN (SELECT value FROM json_each(?))`
    ).all(ownerId, JSON.stringify(ACTIVE_WORKSPACE_STATUS_LIST)) as Array<{ toolkitId: string; workspaceId: string; bundleSha256: string; resolvedJson: string }>;
  }

  listToolkitCacheEntries(ownerId: string): ToolkitCacheEntryRecord[] {
    const rows = this.database.prepare('SELECT * FROM toolkit_cache_entries WHERE owner_id = ? ORDER BY last_used_at DESC').all(ownerId) as ToolkitCacheEntryRow[];
    return rows.map(row => ({
      cacheKey: row.cache_key,
      ownerId: row.owner_id,
      sourceIdentity: row.source_identity,
      resolvedRevision: row.resolved_revision,
      adapterVersion: row.adapter_version,
      bundleSha256: row.bundle_sha256,
      status: row.status,
      byteCount: row.byte_count,
      fileCount: row.file_count,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      errorSummary: row.error_summary
    }));
  }

  deleteToolkitCacheEntry(cacheKey: string): void {
    this.database.prepare('DELETE FROM toolkit_cache_entries WHERE cache_key = ?').run(cacheKey);
  }

  saveWorkspaceToolkits(
    workspaceId: string,
    ownerId: string,
    items: Array<{ ordinal: number; toolkitId: string; scope: 'owner' | 'workspace'; requestedJson: string; resolvedJson: string; bundleSha256: string }>
  ): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM workspace_toolkits WHERE workspace_id = ?').run(workspaceId);
      const insertStmt = this.database.prepare(`
        INSERT INTO workspace_toolkits (workspace_id, ordinal, owner_id, toolkit_id, scope, requested_json, resolved_json, bundle_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertStmt.run(
          workspaceId,
          item.ordinal,
          ownerId,
          item.toolkitId,
          item.scope,
          item.requestedJson,
          item.resolvedJson,
          item.bundleSha256
        );
      }
      this.database.exec('COMMIT');
    } catch (err) {
      this.database.exec('ROLLBACK');
      throw err;
    }
  }

  getWorkspaceToolkits(workspaceId: string): WorkspaceToolkitRecord[] {
    const rows = this.database.prepare('SELECT * FROM workspace_toolkits WHERE workspace_id = ? ORDER BY ordinal ASC').all(workspaceId) as WorkspaceToolkitRow[];
    return rows.map(r => ({
      workspaceId: r.workspace_id,
      ordinal: r.ordinal,
      ownerId: r.owner_id,
      toolkitId: r.toolkit_id,
      scope: r.scope,
      requestedJson: r.requested_json,
      resolvedJson: r.resolved_json,
      bundleSha256: r.bundle_sha256
    }));
  }

  deleteWorkspaceToolkits(workspaceId: string): void {
    this.database.prepare('DELETE FROM workspace_toolkits WHERE workspace_id = ?').run(workspaceId);
  }

  listReferencedToolkitBundleShas(): Set<string> {
    const rows = this.database.prepare(`
      SELECT DISTINCT wt.bundle_sha256
      FROM workspace_toolkits wt
      JOIN workspaces w ON w.id = wt.workspace_id AND w.owner_id = wt.owner_id
      WHERE w.status IN ('CREATING', 'ACTIVE', 'EXPIRED_RECOVERABLE')
    `).all() as { bundle_sha256: string }[];
    return new Set(rows.map(r => r.bundle_sha256));
  }
  // -------------------------------------------------------------------------
  // Skill registry
  // -------------------------------------------------------------------------

  private requireSkillGeneration(table: 'skill_sources' | 'skill_sets', ownerId: string, id: string, expectedGeneration: number): void {
    const statement = table === 'skill_sources'
      ? 'SELECT generation FROM skill_sources WHERE owner_id = ? AND id = ?'
      : 'SELECT generation FROM skill_sets WHERE owner_id = ? AND id = ?';
    const row = this.database.prepare(statement).get(ownerId, id) as { generation: number } | undefined;
    if (!row) throw new SkillRegistryError('NOT_FOUND', `${table} entry ${id} was not found for this owner`);
    if (row.generation !== expectedGeneration) {
      throw new SkillRegistryError('CONFLICT', `${table} entry ${id} is at generation ${row.generation}, expected ${expectedGeneration}`);
    }
  }

  createSkillSource(input: {
    ownerId: string;
    slug: string;
    displayName: string;
    kind: SkillSourceKind;
    description?: string;
    provider?: SkillProvider;
    sourceRef?: string;
    tags?: string[];
    revision: { bundleSha256: string; contentSha256: string; hasExecutableAssets: boolean; origin?: SkillRevisionOrigin };
  }): { sourceId: string; revisionId: string } {
    const now = Date.now();
    const sourceId = `sk_${randomBytes(16).toString('hex')}`;
    const revisionId = `skrev_${randomBytes(16).toString('hex')}`;
    const tags = normalizeSkillTags(input.tags ?? []);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO skill_sources
        (owner_id, id, slug, display_name, description, kind, provider, source_ref, current_revision_id, state, tags, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'enabled', ?, 1, ?, ?)`)
        .run(input.ownerId, sourceId, input.slug, input.displayName, input.description ?? '', input.kind,
          input.provider ?? null, input.sourceRef ?? null, tags, now, now);
      this.database.prepare(`INSERT INTO skill_revisions
        (owner_id, skill_source_id, id, parent_revision_id, origin, bundle_sha256, content_sha256, has_executable_assets, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
        .run(input.ownerId, sourceId, revisionId, input.revision.origin ?? 'import', input.revision.bundleSha256,
          input.revision.contentSha256, input.revision.hasExecutableAssets ? 1 : 0, now);
      this.database.prepare('UPDATE skill_sources SET current_revision_id = ? WHERE owner_id = ? AND id = ?')
        .run(revisionId, input.ownerId, sourceId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return { sourceId, revisionId };
  }

  addSkillRevision(input: {
    ownerId: string;
    skillSourceId: string;
    bundleSha256: string;
    contentSha256: string;
    hasExecutableAssets: boolean;
    origin: SkillRevisionOrigin;
    parentRevisionId?: string;
    expectedGeneration?: number;
  }): string {
    const now = Date.now();
    const revisionId = `skrev_${randomBytes(16).toString('hex')}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (input.expectedGeneration !== undefined) {
        this.requireSkillGeneration('skill_sources', input.ownerId, input.skillSourceId, input.expectedGeneration);
      }
      this.database.prepare(`INSERT INTO skill_revisions
        (owner_id, skill_source_id, id, parent_revision_id, origin, bundle_sha256, content_sha256, has_executable_assets, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.ownerId, input.skillSourceId, revisionId, input.parentRevisionId ?? null, input.origin,
          input.bundleSha256, input.contentSha256, input.hasExecutableAssets ? 1 : 0, now);
      this.database.prepare(`UPDATE skill_sources
        SET current_revision_id = ?, generation = generation + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?`)
        .run(revisionId, now, input.ownerId, input.skillSourceId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return revisionId;
  }

  getSkillSource(ownerId: string, id: string): {
    id: string; slug: string; displayName: string; description: string; kind: SkillSourceKind;
    provider: SkillProvider | null; sourceRef: string | null; currentRevisionId: string | null;
    state: SkillSourceState; tags: string[]; generation: number; updatedAt: number;
  } | undefined {
    const row = this.database.prepare(`SELECT id, slug, display_name, description, kind, provider, source_ref,
      current_revision_id, state, tags, generation, updated_at FROM skill_sources WHERE owner_id = ? AND id = ?`)
      .get(ownerId, id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), slug: String(row.slug), displayName: String(row.display_name),
      description: String(row.description), kind: row.kind as SkillSourceKind,
      provider: (row.provider as SkillProvider | null) ?? null,
      sourceRef: (row.source_ref as string | null) ?? null,
      currentRevisionId: (row.current_revision_id as string | null) ?? null,
      state: row.state as SkillSourceState, tags: parseSkillTags(String(row.tags)),
      generation: Number(row.generation), updatedAt: Number(row.updated_at)
    };
  }

  listSkillSources(ownerId: string, options: { state?: SkillSourceState; kind?: SkillSourceKind; provider?: SkillProvider; limit?: number } = {}): ReturnType<StateStore['getSkillSource']>[] {
    const rows = this.database.prepare(`SELECT id FROM skill_sources
      WHERE owner_id = ?
        AND (? IS NULL OR state = ?)
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR provider = ?)
      ORDER BY updated_at DESC LIMIT ?`)
      .all(ownerId,
        options.state ?? null, options.state ?? null,
        options.kind ?? null, options.kind ?? null,
        options.provider ?? null, options.provider ?? null,
        Math.min(options.limit ?? 100, 500)) as { id: string }[];
    return rows.map((row) => this.getSkillSource(ownerId, row.id)!).filter(Boolean);
  }

  listSkillRevisions(ownerId: string, skillSourceId: string, limit = 100): {
    id: string; origin: SkillRevisionOrigin; parentRevisionId: string | null; contentSha256: string;
    hasExecutableAssets: boolean; createdAt: number;
  }[] {
    const rows = this.database.prepare(`SELECT id, origin, parent_revision_id, content_sha256, has_executable_assets, created_at
      FROM skill_revisions WHERE owner_id = ? AND skill_source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(ownerId, skillSourceId, Math.min(limit, 500)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), origin: row.origin as SkillRevisionOrigin,
      parentRevisionId: (row.parent_revision_id as string | null) ?? null,
      contentSha256: String(row.content_sha256),
      hasExecutableAssets: Number(row.has_executable_assets) === 1, createdAt: Number(row.created_at)
    }));
  }

  /**
   * The full row for one revision. `listSkillRevisions` projects only what the UI renders, so a
   * caller that has to republish these bytes (restore) needs the bundle digest that projection omits.
   */
  getSkillRevision(ownerId: string, skillSourceId: string, id: string): {
    id: string; skillSourceId: string; origin: SkillRevisionOrigin; parentRevisionId: string | null;
    bundleSha256: string; contentSha256: string; hasExecutableAssets: boolean; createdAt: number;
  } | undefined {
    const row = this.database.prepare(`SELECT id, skill_source_id, origin, parent_revision_id, bundle_sha256, content_sha256, has_executable_assets, created_at
      FROM skill_revisions WHERE owner_id = ? AND skill_source_id = ? AND id = ?`)
      .get(ownerId, skillSourceId, id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), skillSourceId: String(row.skill_source_id), origin: row.origin as SkillRevisionOrigin,
      parentRevisionId: (row.parent_revision_id as string | null) ?? null,
      bundleSha256: String(row.bundle_sha256), contentSha256: String(row.content_sha256),
      hasExecutableAssets: Number(row.has_executable_assets) === 1, createdAt: Number(row.created_at)
    };
  }

  setSkillState(ownerId: string, id: string, state: SkillSourceState, expectedGeneration: number): { state: SkillSourceState; generation: number } {
    this.requireSkillGeneration('skill_sources', ownerId, id, expectedGeneration);
    const current = this.getSkillSource(ownerId, id)!;
    const allowed: Record<SkillSourceState, SkillSourceState[]> = {
      enabled: ['enabled', 'disabled', 'archived'],
      disabled: ['disabled', 'enabled', 'archived'],
      archived: ['archived']
    };
    if (!allowed[current.state].includes(state)) {
      throw new SkillRegistryError('INVALID_INPUT', `cannot move skill ${id} from ${current.state} to ${state}`);
    }
    const now = Date.now();
    this.database.prepare('UPDATE skill_sources SET state = ?, generation = generation + 1, updated_at = ? WHERE owner_id = ? AND id = ?')
      .run(state, now, ownerId, id);
    return { state, generation: current.generation + 1 };
  }

  updateSkillMetadata(input: {
    ownerId: string; id: string; expectedGeneration: number;
    displayName?: string; description?: string; tags?: string[];
  }): { generation: number } {
    this.requireSkillGeneration('skill_sources', input.ownerId, input.id, input.expectedGeneration);
    const tags = input.tags === undefined ? undefined : normalizeSkillTags(input.tags);
    const now = Date.now();
    this.database.prepare(`UPDATE skill_sources SET
        display_name = COALESCE(?, display_name),
        description = COALESCE(?, description),
        tags = COALESCE(?, tags),
        generation = generation + 1,
        updated_at = ?
      WHERE owner_id = ? AND id = ?`)
      .run(input.displayName ?? null, input.description ?? null, tags ?? null, now, input.ownerId, input.id);
    return { generation: input.expectedGeneration + 1 };
  }

  listSkillUsage(ownerId: string, skillSourceId: string): {
    sets: { skillSetId: string; name: string }[];
    liveWorkspaces: { workspaceId: string; status: string; name: string; revisionId: string }[];
  } {
    const sets = this.database.prepare('SELECT DISTINCT i.skill_set_id AS skillSetId, s.name AS name FROM skill_set_items i JOIN skill_sets s ON s.owner_id = i.owner_id AND s.id = i.skill_set_id WHERE i.owner_id = ? AND i.skill_source_id = ? ORDER BY s.name')
      .all(ownerId, skillSourceId) as { skillSetId: string; name: string }[];
    // The status allowlist travels as one parameter and is expanded by SQLite, so the statement text is
    // constant and nothing is interpolated into it.
    const liveWorkspaces = this.database.prepare(`SELECT DISTINCT a.workspace_id AS workspaceId, w.status AS status,
        a.name AS name, a.revision_id AS revisionId
      FROM workspace_skill_assignments a
      JOIN workspaces w ON w.owner_id = a.owner_id AND w.id = a.workspace_id
      WHERE a.owner_id = ? AND a.skill_source_id = ? AND w.status IN (SELECT value FROM json_each(?))
      ORDER BY a.workspace_id`)
      .all(ownerId, skillSourceId, JSON.stringify(ACTIVE_WORKSPACE_STATUS_LIST)) as { workspaceId: string; status: string; name: string; revisionId: string }[];
    return { sets, liveWorkspaces };
  }

  createSkillSet(input: {
    ownerId: string; name: string; description?: string;
    items: { skillSourceId: string; revisionId: string; name: string }[];
  }): string {
    const now = Date.now();
    const id = `skset_${randomBytes(16).toString('hex')}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO skill_sets (owner_id, id, name, description, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`)
        .run(input.ownerId, id, input.name, input.description ?? '', now, now);
      this.replaceSkillSetItems(input.ownerId, id, input.items);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return id;
  }

  private replaceSkillSetItems(ownerId: string, skillSetId: string, items: { skillSourceId: string; revisionId: string; name: string }[]): void {
    this.database.prepare('DELETE FROM skill_set_items WHERE owner_id = ? AND skill_set_id = ?').run(ownerId, skillSetId);
    items.forEach((item, ordinal) => {
      this.database.prepare(`INSERT INTO skill_set_items (owner_id, skill_set_id, ordinal, skill_source_id, revision_id, name)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(ownerId, skillSetId, ordinal, item.skillSourceId, item.revisionId, item.name);
    });
  }

  getSkillSet(ownerId: string, id: string): {
    id: string; name: string; description: string; generation: number;
    items: { ordinal: number; skillSourceId: string; revisionId: string; name: string }[];
  } | undefined {
    const row = this.database.prepare('SELECT id, name, description, generation FROM skill_sets WHERE owner_id = ? AND id = ?')
      .get(ownerId, id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const items = this.database.prepare(`SELECT ordinal, skill_source_id, revision_id, name FROM skill_set_items
      WHERE owner_id = ? AND skill_set_id = ? ORDER BY ordinal`)
      .all(ownerId, id) as Record<string, unknown>[];
    return {
      id: String(row.id), name: String(row.name), description: String(row.description),
      generation: Number(row.generation),
      items: items.map((item) => ({
        ordinal: Number(item.ordinal), skillSourceId: String(item.skill_source_id),
        revisionId: String(item.revision_id), name: String(item.name)
      }))
    };
  }

  listSkillSets(ownerId: string, limit = 100): NonNullable<ReturnType<StateStore['getSkillSet']>>[] {
    const rows = this.database.prepare('SELECT id FROM skill_sets WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(ownerId, Math.min(limit, 500)) as { id: string }[];
    return rows.map((row) => this.getSkillSet(ownerId, row.id)!).filter(Boolean);
  }

  updateSkillSet(input: {
    ownerId: string; id: string; expectedGeneration: number;
    name?: string; description?: string;
    items?: { skillSourceId: string; revisionId: string; name: string }[];
  }): { generation: number } {
    this.requireSkillGeneration('skill_sets', input.ownerId, input.id, input.expectedGeneration);
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`UPDATE skill_sets SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          generation = generation + 1,
          updated_at = ?
        WHERE owner_id = ? AND id = ?`)
        .run(input.name ?? null, input.description ?? null, now, input.ownerId, input.id);
      if (input.items) this.replaceSkillSetItems(input.ownerId, input.id, input.items);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return { generation: input.expectedGeneration + 1 };
  }

  deleteSkillSet(ownerId: string, id: string, expectedGeneration: number): void {
    this.requireSkillGeneration('skill_sets', ownerId, id, expectedGeneration);
    const holders = this.database.prepare('SELECT count(*) as count FROM workspace_skill_set_snapshots WHERE owner_id = ? AND skill_set_id = ?')
      .get(ownerId, id) as { count: number };
    if (holders.count > 0) {
      throw new SkillRegistryError('CONFLICT', `skill set ${id} is referenced by ${holders.count} workspace snapshot(s)`);
    }
    this.database.prepare('DELETE FROM skill_sets WHERE owner_id = ? AND id = ?').run(ownerId, id);
  }

  recordWorkspaceSkillSelection(input: {
    ownerId: string; workspaceId: string;
    sets: { skillSetId: string; skillSetGeneration: number; snapshotSha256: string }[];
    assignments: { name: string; skillSourceId: string; revisionId: string; tier: SkillTier; pinned: boolean }[];
  }): void {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM workspace_skill_set_snapshots WHERE owner_id = ? AND workspace_id = ?').run(input.ownerId, input.workspaceId);
      this.database.prepare('DELETE FROM workspace_skill_assignments WHERE owner_id = ? AND workspace_id = ?').run(input.ownerId, input.workspaceId);
      input.sets.forEach((set, ordinal) => {
        this.database.prepare(`INSERT INTO workspace_skill_set_snapshots
          (owner_id, workspace_id, ordinal, skill_set_id, skill_set_generation, snapshot_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(input.ownerId, input.workspaceId, ordinal, set.skillSetId, set.skillSetGeneration, set.snapshotSha256, now);
      });
      input.assignments.forEach((assignment, ordinal) => {
        this.database.prepare(`INSERT INTO workspace_skill_assignments
          (owner_id, workspace_id, ordinal, name, skill_source_id, revision_id, tier, pinned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.ownerId, input.workspaceId, ordinal, assignment.name, assignment.skillSourceId,
            assignment.revisionId, assignment.tier, assignment.pinned ? 1 : 0);
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createSkillImportJob(input: { ownerId: string; sourceKind: SkillImportSourceKind; sourceRef: string }): string {
    const now = Date.now();
    const id = `skjob_${randomBytes(16).toString('hex')}`;
    this.database.prepare(`INSERT INTO skill_import_jobs
      (owner_id, id, source_kind, source_ref, state, progress_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', '{}', ?, ?)`)
      .run(input.ownerId, id, input.sourceKind, input.sourceRef, now, now);
    return id;
  }

  advanceSkillImportJob(input: {
    ownerId: string; id: string; state: SkillImportJobState;
    progressJson?: string; resultJson?: string | null; errorCode?: string | null; skillRevisionId?: string | null;
  }): void {
    const now = Date.now();
    this.database.prepare(`UPDATE skill_import_jobs SET
        state = ?,
        progress_json = COALESCE(?, progress_json),
        result_json = COALESCE(?, result_json),
        error_code = COALESCE(?, error_code),
        skill_revision_id = COALESCE(?, skill_revision_id),
        updated_at = ?
      WHERE owner_id = ? AND id = ?`)
      .run(input.state, input.progressJson ?? null, input.resultJson ?? null, input.errorCode ?? null,
        input.skillRevisionId ?? null, now, input.ownerId, input.id);
  }

  getSkillImportJob(ownerId: string, id: string): {
    id: string; sourceKind: SkillImportSourceKind; sourceRef: string; state: SkillImportJobState;
    progressJson: string; resultJson: string | null; errorCode: string | null;
    skillRevisionId: string | null; updatedAt: number;
  } | undefined {
    const row = this.database.prepare(`SELECT id, source_kind, source_ref, state, progress_json, result_json,
      error_code, skill_revision_id, updated_at FROM skill_import_jobs WHERE owner_id = ? AND id = ?`)
      .get(ownerId, id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), sourceKind: row.source_kind as SkillImportSourceKind, sourceRef: String(row.source_ref),
      state: row.state as SkillImportJobState, progressJson: String(row.progress_json),
      resultJson: (row.result_json as string | null) ?? null, errorCode: (row.error_code as string | null) ?? null,
      skillRevisionId: (row.skill_revision_id as string | null) ?? null, updatedAt: Number(row.updated_at)
    };
  }

  listSkillImportJobs(ownerId: string, limit = 50): NonNullable<ReturnType<StateStore['getSkillImportJob']>>[] {
    const rows = this.database.prepare('SELECT id FROM skill_import_jobs WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(ownerId, Math.min(limit, 200)) as { id: string }[];
    return rows.map((row) => this.getSkillImportJob(ownerId, row.id)!).filter(Boolean);
  }

  upsertSkillCatalogEntry(input: {
    ownerId: string; provider: 'skills-sh' | 'skillx'; slug: string;
    displayName: string; description?: string; metadataJson?: string;
  }): void {
    const now = Date.now();
    this.database.prepare(`INSERT INTO skill_catalog_entries
        (owner_id, id, provider, slug, display_name, description, metadata_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, provider, slug) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        metadata_json = excluded.metadata_json,
        fetched_at = excluded.fetched_at`)
      .run(input.ownerId, `skc_${randomBytes(16).toString('hex')}`, input.provider, input.slug,
        input.displayName, input.description ?? '', input.metadataJson ?? '{}', now);
  }

  /**
   * Startup recovery needs every interrupted job rather than one owner's, because the runner does not know
   * which owners were mid-import when it stopped, and a job left running would otherwise never reach a
   * terminal state on its own.
   */
  listInterruptedSkillImportJobs(): Array<{ ownerId: string; id: string }> {
    return this.database.prepare(
      "SELECT owner_id AS ownerId, id FROM skill_import_jobs WHERE state IN ('queued', 'running')"
    ).all() as Array<{ ownerId: string; id: string }>;
  }

  listSkillCatalogEntries(ownerId: string, provider?: 'skills-sh' | 'skillx'): {
    id: string; provider: string; slug: string; displayName: string; description: string; fetchedAt: number;
  }[] {
    const rows = (provider
      ? this.database.prepare('SELECT id, provider, slug, display_name, description, fetched_at FROM skill_catalog_entries WHERE owner_id = ? AND provider = ? ORDER BY display_name')
        .all(ownerId, provider)
      : this.database.prepare('SELECT id, provider, slug, display_name, description, fetched_at FROM skill_catalog_entries WHERE owner_id = ? ORDER BY display_name')
        .all(ownerId)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), provider: String(row.provider), slug: String(row.slug),
      displayName: String(row.display_name), description: String(row.description), fetchedAt: Number(row.fetched_at)
    }));
  }

  close(): void {
    this.database.close();
  }
}
