import type { DatabaseSync } from 'node:sqlite';

export type ArtifactMetadata = {
  artifactId: string;
  logicalName: string;
  sha256: string;
  sizeBytes: number;
  projectId?: string;
  environmentId?: string;
  workspaceId?: string;
  /** The checkout of a multi-repository workspace the snapshot was read from, when one was selected. */
  repositoryId?: string;
  repositoryAlias?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  retentionMs: number;
  generation: number;
};

export type ArtifactRow = {
  id: string; principal_id: string; logical_name: string; sha256: string; size_bytes: number;
  project_id: string | null; environment_id: string | null; workspace_id: string | null; relative_path: string;
  repository_id?: string | null; repository_alias?: string | null;
  created_at: number; updated_at: number; expires_at: number; retention_ms: number; generation: number;
};

export function initializeArtifactSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      logical_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      project_id TEXT,
      environment_id TEXT,
      workspace_id TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      retention_ms INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS artifacts_principal_created
      ON artifacts(principal_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS artifacts_expiry ON artifacts(expires_at, id);
  `);
  // Repository provenance is additive: rows written before it read as having no repository.
  const columns = new Set((database.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]).map((column) => column.name));
  if (!columns.has('repository_id')) database.exec('ALTER TABLE artifacts ADD COLUMN repository_id TEXT');
  if (!columns.has('repository_alias')) database.exec('ALTER TABLE artifacts ADD COLUMN repository_alias TEXT');
}

export const artifactMetadata = (row: ArtifactRow): ArtifactMetadata => ({
  artifactId: row.id,
  logicalName: row.logical_name,
  sha256: row.sha256,
  sizeBytes: row.size_bytes,
  ...(row.project_id ? { projectId: row.project_id } : {}),
  ...(row.environment_id ? { environmentId: row.environment_id } : {}),
  ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
  ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
  ...(row.repository_alias ? { repositoryAlias: row.repository_alias } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  retentionMs: row.retention_ms,
  generation: row.generation
});
