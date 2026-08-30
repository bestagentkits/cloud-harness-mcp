import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type MetadataState = 'ACTIVE' | 'DELETED';
export type ProjectView = { id: string; name: string; state: MetadataState; generation: number; createdAt: number; updatedAt: number; deletedAt: number | null };
export type EnvironmentView = ProjectView & { projectId: string };
export type SecretView = { id: string; environmentId: string; name: string; description: string | null; state: MetadataState; version: number; generation: number; createdAt: number; updatedAt: number; deletedAt: number | null };
export type AuditView = { id: string; action: string; subjectType: string; subjectId: string; subjectGeneration: number; details: Record<string, string | number | boolean>; createdAt: number };

type ProjectRow = { id: string; name: string; state: MetadataState; generation: number; created_at: number; updated_at: number; deleted_at: number | null };
type EnvironmentRow = ProjectRow & { project_id: string };
type SecretRow = { id: string; environment_id: string; name: string; description: string | null; state: MetadataState; current_version: number; generation: number; created_at: number; updated_at: number; deleted_at: number | null };
type AuditRow = { id: string; action: string; subject_type: string; subject_id: string; subject_generation: number; details_json: string; created_at: number };

export const opaqueId = (prefix: string): string => `${prefix}_${randomBytes(24).toString('base64url')}`;

export const projectView = (row: ProjectRow): ProjectView => ({
  id: row.id, name: row.name, state: row.state, generation: row.generation,
  createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at
});
export const environmentView = (row: EnvironmentRow): EnvironmentView => ({ ...projectView(row), projectId: row.project_id });
export const secretView = (row: SecretRow): SecretView => ({
  id: row.id, environmentId: row.environment_id, name: row.name, description: row.description ?? null, state: row.state,
  version: row.current_version, generation: row.generation, createdAt: row.created_at,
  updatedAt: row.updated_at, deletedAt: row.deleted_at
});
export const auditView = (row: AuditRow): AuditView => ({
  id: row.id, action: row.action, subjectType: row.subject_type, subjectId: row.subject_id,
  subjectGeneration: row.subject_generation,
  details: JSON.parse(row.details_json) as AuditView['details'], createdAt: row.created_at
});

export function transaction<T>(database: DatabaseSync, action: () => T): T {
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

export function appendAudit(
  database: DatabaseSync,
  principalId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  generation: number,
  details: Record<string, string | number | boolean>,
  now: number
): void {
  database.prepare(`INSERT INTO audit_events
    (id, principal_id, action, subject_type, subject_id, subject_generation, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    opaqueId('aud'), principalId, action, subjectType, subjectId, generation, JSON.stringify(details), now
  );
}
