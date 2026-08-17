import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ArtifactStoragePaths, type StagedDeletion } from './artifact-storage-paths.js';
import {
  artifactMetadata,
  initializeArtifactSchema,
  type ArtifactMetadata,
  type ArtifactRow
} from './artifact-store-schema.js';

export { initializeArtifactSchema, type ArtifactMetadata } from './artifact-store-schema.js';

export class ArtifactStoreError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'LIMIT_EXCEEDED' | 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

export class ArtifactStore {
  private readonly paths: ArtifactStoragePaths;

  constructor(private readonly database: DatabaseSync, private readonly options: {
    root: string;
    maxArtifactBytes: number;
    maxPrincipalBytes: number;
    defaultRetentionMs: number;
    maxRetentionMs: number;
  }) {
    for (const value of [options.maxArtifactBytes, options.maxPrincipalBytes, options.defaultRetentionMs, options.maxRetentionMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid artifact store bound');
    }
    if (options.maxArtifactBytes > options.maxPrincipalBytes || options.defaultRetentionMs > options.maxRetentionMs) {
      throw new Error('invalid artifact store bounds');
    }
    initializeArtifactSchema(database);
    this.paths = new ArtifactStoragePaths(options.root, database);
  }

  create(principalId: string, input: {
    logicalName: string;
    content: Uint8Array;
    projectId?: string;
    environmentId?: string;
    workspaceId?: string;
    retentionMs?: number;
    now?: number;
  }, audit?: (database: DatabaseSync, principalId: string, artifact: ArtifactMetadata) => void): ArtifactMetadata {
    this.validatePrincipal(principalId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.logicalName) || input.logicalName === '.' || input.logicalName === '..') {
      throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact logical name');
    }
    for (const value of [input.projectId, input.environmentId, input.workspaceId]) this.validateProvenance(value);
    const content = Buffer.from(input.content);
    if (content.byteLength > this.options.maxArtifactBytes) throw new ArtifactStoreError('LIMIT_EXCEEDED', 'artifact exceeds per-artifact quota');
    const now = input.now ?? Date.now();
    const retentionMs = input.retentionMs ?? this.options.defaultRetentionMs;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(retentionMs) || retentionMs <= 0 || retentionMs > this.options.maxRetentionMs) {
      throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact retention');
    }
    const artifactId = `art_${randomBytes(24).toString('base64url')}`;
    let staged: ReturnType<ArtifactStoragePaths['stage']> | undefined;
    let committedFile = false;
    let inTransaction = false;
    this.database.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const usage = this.database.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM artifacts WHERE principal_id = ?')
        .get(principalId) as { bytes: number };
      if (usage.bytes + content.byteLength > this.options.maxPrincipalBytes) {
        throw new ArtifactStoreError('LIMIT_EXCEEDED', 'artifact quota exceeded');
      }
      staged = this.paths.stage(artifactId, content);
      this.paths.commitStage(staged);
      committedFile = true;
      const sha256 = createHash('sha256').update(content).digest('hex');
      const expiresAt = now + retentionMs;
      if (!Number.isSafeInteger(expiresAt)) throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact retention');
      this.database.prepare(`INSERT INTO artifacts
        (id, principal_id, logical_name, sha256, size_bytes, project_id, environment_id, workspace_id,
         relative_path, created_at, updated_at, expires_at, retention_ms, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
        artifactId, principalId, input.logicalName, sha256, content.byteLength, input.projectId ?? null,
        input.environmentId ?? null, input.workspaceId ?? null, staged.relativePath, now, now, expiresAt, retentionMs
      );
      const row = this.rowByOwner(principalId, artifactId);
      if (!row) throw new Error('artifact insert was not persisted');
      const created = artifactMetadata(row);
      audit?.(this.database, principalId, created);
      this.database.exec('COMMIT');
      inTransaction = false;
      return created;
    } catch (error) {
      if (inTransaction) this.database.exec('ROLLBACK');
      if (staged) this.paths.discardStage(staged, committedFile);
      throw error;
    }
  }

  metadata(principalId: string, artifactId: string, now = Date.now()): ArtifactMetadata {
    const row = this.rowByOwner(principalId, artifactId);
    if (!row || row.expires_at <= now) throw new ArtifactStoreError('NOT_FOUND', 'artifact not found');
    return artifactMetadata(row);
  }

  list(principalId: string, input: { limit: number; cursor?: string; now?: number }): { artifacts: ArtifactMetadata[]; cursor?: string } {
    this.validatePrincipal(principalId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact page limit');
    const now = input.now ?? Date.now();
    const cursor = input.cursor ? this.decodeCursor(input.cursor) : undefined;
    const rows = this.database.prepare(`SELECT * FROM artifacts
      WHERE principal_id = ? AND expires_at > ?
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(
      principalId, now, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
      cursor?.createdAt ?? null, cursor?.artifactId ?? null, input.limit + 1
    ) as ArtifactRow[];
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      artifacts: page.map(artifactMetadata),
      ...(rows.length > input.limit && last ? { cursor: this.encodeCursor(last) } : {})
    };
  }

  delete(
    principalId: string,
    artifactId: string,
    expectedGeneration: number,
    audit?: (database: DatabaseSync, principalId: string, artifact: ArtifactMetadata) => void
  ): ArtifactMetadata {
    this.validatePrincipal(principalId);
    let staged: StagedDeletion | undefined;
    let inTransaction = false;
    this.database.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const row = this.rowByOwner(principalId, artifactId);
      if (!row) throw new ArtifactStoreError('NOT_FOUND', 'artifact not found');
      if (row.generation !== expectedGeneration) throw new ArtifactStoreError('CONFLICT', 'artifact generation changed');
      staged = this.paths.stageDeletion(row.relative_path, row.id, row.generation);
      const result = this.database.prepare('DELETE FROM artifacts WHERE principal_id = ? AND id = ? AND generation = ?')
        .run(principalId, artifactId, expectedGeneration);
      if (result.changes !== 1) throw new ArtifactStoreError('CONFLICT', 'artifact generation changed');
      const deleted = artifactMetadata(row);
      audit?.(this.database, principalId, deleted);
      this.database.exec('COMMIT');
      inTransaction = false;
      try {
        this.paths.finishDeletion(staged);
      } catch {
        // A bounded tombstone is reconciled on the next store initialization.
      }
      return deleted;
    } catch (error) {
      if (inTransaction) {
        this.database.exec('ROLLBACK');
        if (staged) this.paths.rollbackDeletion(staged);
      }
      throw error;
    }
  }

  reapExpired(
    now = Date.now(),
    limit = 100,
    audit?: (database: DatabaseSync, principalId: string, artifact: ArtifactMetadata) => void
  ): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact reap limit');
    const rows = this.database.prepare('SELECT principal_id, id, generation FROM artifacts WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?')
      .all(now, limit) as Pick<ArtifactRow, 'principal_id' | 'id' | 'generation'>[];
    let deleted = 0;
    for (const row of rows) {
      try {
        this.delete(row.principal_id, row.id, row.generation, audit);
        deleted += 1;
      } catch (error) {
        if (!(error instanceof ArtifactStoreError) || (error.code !== 'NOT_FOUND' && error.code !== 'CONFLICT')) throw error;
      }
    }
    return deleted;
  }

  private rowByOwner(principalId: string, artifactId: string): ArtifactRow | undefined {
    return this.database.prepare('SELECT * FROM artifacts WHERE principal_id = ? AND id = ?')
      .get(principalId, artifactId) as ArtifactRow | undefined;
  }

  private validatePrincipal(principalId: string): void {
    if (!principalId || principalId.length > 200) throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact principal');
  }

  private validateProvenance(value: string | undefined): void {
    if (value !== undefined && (
      value.length < 1 || value.length > 200 || [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 31 || code === 127;
      })
    )) {
      throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact provenance');
    }
  }

  private encodeCursor(row: ArtifactRow): string {
    return Buffer.from(JSON.stringify({ createdAt: row.created_at, artifactId: row.id })).toString('base64url');
  }

  private decodeCursor(value: string): { createdAt: number; artifactId: string } {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; artifactId?: unknown };
      if (!Number.isSafeInteger(parsed.createdAt) || typeof parsed.artifactId !== 'string' || !/^art_[A-Za-z0-9_-]{32}$/.test(parsed.artifactId)) throw new Error();
      return parsed as { createdAt: number; artifactId: string };
    } catch {
      throw new ArtifactStoreError('INVALID_INPUT', 'invalid artifact cursor');
    }
  }
}
