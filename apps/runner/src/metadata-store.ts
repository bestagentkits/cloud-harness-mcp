import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateMetadataSchema } from './metadata-schema.js';
import {
  appendAudit, auditView, environmentView, opaqueId, projectView, transaction,
  secretView, type AuditView, type EnvironmentView, type ProjectView, type SecretView
} from './metadata-records.js';
import { SecretMetadataStore } from './secret-metadata-store.js';
import type { SecretKeyring } from './secret-keyring.js';

const normalizedName = (name: string): string => {
  const value = name.trim();
  if (!value || value.length > 100) throw new Error('metadata name must contain 1 to 100 characters');
  return value;
};

export class MetadataStore {
  readonly database: DatabaseSync;
  private readonly availableSecretStore?: SecretMetadataStore;
  private readonly secretReadinessError?: Error;

  constructor(path: string, keyring?: SecretKeyring, secretReadinessError?: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    migrateMetadataSchema(this.database);
    if (!keyring) {
      this.secretReadinessError = new Error(secretReadinessError ?? 'secret keyring is unavailable');
      return;
    }
    try {
      this.availableSecretStore = new SecretMetadataStore(this.database, keyring);
    } catch (error) {
      this.secretReadinessError = error instanceof Error ? error : new Error('secret store is unavailable');
    }
  }

  get secrets(): SecretMetadataStore {
    if (!this.availableSecretStore) throw this.secretReadinessError ?? new Error('secret store is unavailable');
    return this.availableSecretStore;
  }

  secretReadiness(): { ready: true } | { ready: false; error: string } {
    return this.secretReadinessError ? { ready: false, error: this.secretReadinessError.message } : { ready: true };
  }

  listProjects(principalId: string): ProjectView[] {
    const rows = this.database.prepare("SELECT * FROM projects WHERE principal_id = ? AND state = 'ACTIVE' ORDER BY updated_at DESC, id").all(principalId);
    return (rows as Parameters<typeof projectView>[0][]).map(projectView);
  }

  createProject(principalId: string, name: string, expectedGeneration: 0): ProjectView | undefined {
    if (expectedGeneration !== 0) return undefined;
    return transaction(this.database, () => {
      const projectName = normalizedName(name);
      if (this.database.prepare('SELECT 1 FROM projects WHERE principal_id = ? AND name = ?').get(principalId, projectName)) return undefined;
      const id = opaqueId('prj');
      const now = Date.now();
      this.database.prepare(`INSERT INTO projects
        (id, principal_id, name, state, generation, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, 'ACTIVE', 1, ?, ?, NULL)`).run(id, principalId, projectName, now, now);
      appendAudit(this.database, principalId, 'project.created', 'project', id, 1, {}, now);
      return this.project(principalId, id)!;
    });
  }

  updateProject(principalId: string, id: string, expectedGeneration: number, name: string): ProjectView | undefined {
    return transaction(this.database, () => {
      const now = Date.now();
      const result = this.database.prepare(`UPDATE projects SET name = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(normalizedName(name), now, principalId, id, expectedGeneration);
      if (result.changes !== 1) return undefined;
      const value = this.project(principalId, id)!;
      appendAudit(this.database, principalId, 'project.updated', 'project', id, value.generation, {}, now);
      return value;
    });
  }

  deleteProject(principalId: string, id: string, expectedGeneration: number): ProjectView | undefined {
    return transaction(this.database, () => {
      const current = this.project(principalId, id);
      if (!current || current.state !== 'ACTIVE' || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      const environmentIds = this.database.prepare(`SELECT id FROM environments
        WHERE principal_id = ? AND project_id = ?`).all(principalId, id) as { id: string }[];
      for (const environment of environmentIds) this.removeEnvironmentRecords(principalId, environment.id);
      const result = this.database.prepare(`DELETE FROM projects
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(principalId, id, expectedGeneration);
      if (result.changes !== 1) throw new Error('project generation changed during deletion');
      const value: ProjectView = { ...current, state: 'DELETED', generation: current.generation + 1, updatedAt: now, deletedAt: now };
      appendAudit(this.database, principalId, 'project.deleted', 'project', id, value.generation, {}, now);
      return value;
    });
  }

  listEnvironments(principalId: string, projectId: string): EnvironmentView[] {
    const rows = this.database.prepare(`SELECT environments.* FROM environments
      JOIN projects ON projects.principal_id = environments.principal_id AND projects.id = environments.project_id
      WHERE environments.principal_id = ? AND environments.project_id = ?
        AND environments.state = 'ACTIVE' AND projects.state = 'ACTIVE'
      ORDER BY environments.updated_at DESC, environments.id`).all(principalId, projectId);
    return (rows as Parameters<typeof environmentView>[0][]).map(environmentView);
  }

  listSecretReferences(principalId: string, environmentId: string): SecretView[] {
    const rows = this.database.prepare(`SELECT refs.* FROM secret_references refs
      JOIN environments env ON env.principal_id = refs.principal_id AND env.id = refs.environment_id
      JOIN projects ON projects.principal_id = env.principal_id AND projects.id = env.project_id
      WHERE refs.principal_id = ? AND refs.environment_id = ? AND refs.state = 'ACTIVE'
        AND env.state = 'ACTIVE' AND projects.state = 'ACTIVE'
      ORDER BY refs.updated_at DESC, refs.id`).all(principalId, environmentId);
    return (rows as Parameters<typeof secretView>[0][]).map(secretView);
  }

  validateArtifactProvenance(
    principalId: string,
    provenance: { projectId?: string; environmentId?: string }
  ): boolean {
    if (!provenance.projectId && !provenance.environmentId) return true;
    if (provenance.environmentId) {
      const row = this.database.prepare(`SELECT env.project_id FROM environments env
        JOIN projects ON projects.principal_id = env.principal_id AND projects.id = env.project_id
        WHERE env.principal_id = ? AND env.id = ? AND env.state = 'ACTIVE' AND projects.state = 'ACTIVE'`)
        .get(principalId, provenance.environmentId) as { project_id: string } | undefined;
      if (!row || (provenance.projectId && row.project_id !== provenance.projectId)) return false;
      return true;
    }
    const projectId = provenance.projectId;
    if (!projectId) return false;
    return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE principal_id = ? AND id = ? AND state = 'ACTIVE'")
      .get(principalId, projectId));
  }

  environmentValues(principalId: string, environmentId: string): Record<string, string> | undefined {
    const environment = this.database.prepare(`SELECT 1 FROM environments env
      JOIN projects ON projects.principal_id = env.principal_id AND projects.id = env.project_id
      WHERE env.principal_id = ? AND env.id = ? AND env.state = 'ACTIVE' AND projects.state = 'ACTIVE'`)
      .get(principalId, environmentId);
    return environment ? this.secrets.environmentValues(principalId, environmentId) : undefined;
  }

  createEnvironment(principalId: string, projectId: string, name: string, expectedGeneration: 0): EnvironmentView | undefined {
    if (expectedGeneration !== 0) return undefined;
    return transaction(this.database, () => {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE principal_id = ? AND id = ? AND state = 'ACTIVE'").get(principalId, projectId)) return undefined;
      const environmentName = normalizedName(name);
      if (this.database.prepare('SELECT 1 FROM environments WHERE principal_id = ? AND project_id = ? AND name = ?').get(principalId, projectId, environmentName)) return undefined;
      const id = opaqueId('env');
      const now = Date.now();
      this.database.prepare(`INSERT INTO environments
        (id, principal_id, project_id, name, state, generation, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?, NULL)`).run(id, principalId, projectId, environmentName, now, now);
      appendAudit(this.database, principalId, 'environment.created', 'environment', id, 1, { projectId }, now);
      return this.environment(principalId, id)!;
    });
  }

  updateEnvironment(principalId: string, id: string, expectedGeneration: number, name: string): EnvironmentView | undefined {
    return transaction(this.database, () => {
      if (!this.activeEnvironment(principalId, id)) return undefined;
      const now = Date.now();
      const result = this.database.prepare(`UPDATE environments SET name = ?, generation = generation + 1, updated_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(normalizedName(name), now, principalId, id, expectedGeneration);
      if (result.changes !== 1) return undefined;
      const value = this.environment(principalId, id)!;
      appendAudit(this.database, principalId, 'environment.updated', 'environment', id, value.generation, {}, now);
      return value;
    });
  }

  deleteEnvironment(principalId: string, id: string, expectedGeneration: number): EnvironmentView | undefined {
    return transaction(this.database, () => {
      const current = this.activeEnvironment(principalId, id);
      if (!current || current.generation !== expectedGeneration) return undefined;
      const now = Date.now();
      this.removeEnvironmentRecords(principalId, id);
      const value: EnvironmentView = { ...current, state: 'DELETED', generation: current.generation + 1, updatedAt: now, deletedAt: now };
      appendAudit(this.database, principalId, 'environment.deleted', 'environment', id, value.generation, {}, now);
      return value;
    });
  }

  listAudit(principalId: string, limit = 50, cursor?: string): AuditView[] {
    const bounded = Math.max(1, Math.min(100, limit));
    if (!cursor) {
      const rows = this.database.prepare('SELECT * FROM audit_events WHERE principal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(principalId, bounded);
      return (rows as Parameters<typeof auditView>[0][]).map(auditView);
    }
    const boundary = this.database.prepare('SELECT created_at, id FROM audit_events WHERE principal_id = ? AND id = ?')
      .get(principalId, cursor) as { created_at: number; id: string } | undefined;
    if (!boundary) return [];
    const rows = this.database.prepare(`SELECT * FROM audit_events WHERE principal_id = ?
      AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(principalId, boundary.created_at, boundary.created_at, boundary.id, bounded);
    return (rows as Parameters<typeof auditView>[0][]).map(auditView);
  }

  recordAudit(principalId: string, action: string, subjectType: string, subjectId: string, generation: number, details: Record<string, string | number | boolean> = {}): void {
    transaction(this.database, () => appendAudit(this.database, principalId, action, subjectType, subjectId, generation, details, Date.now()));
  }

  recordAuditInTransaction(
    database: DatabaseSync,
    principalId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    generation: number,
    details: Record<string, string | number | boolean> = {}
  ): void {
    appendAudit(database, principalId, action, subjectType, subjectId, generation, details, Date.now());
  }

  close(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.database.close();
  }

  private project(principalId: string, id: string): ProjectView | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE principal_id = ? AND id = ?').get(principalId, id);
    return row ? projectView(row as Parameters<typeof projectView>[0]) : undefined;
  }

  private environment(principalId: string, id: string): EnvironmentView | undefined {
    const row = this.database.prepare('SELECT * FROM environments WHERE principal_id = ? AND id = ?').get(principalId, id);
    return row ? environmentView(row as Parameters<typeof environmentView>[0]) : undefined;
  }

  private activeEnvironment(principalId: string, id: string): EnvironmentView | undefined {
    const row = this.database.prepare(`SELECT env.* FROM environments env
      JOIN projects ON projects.principal_id = env.principal_id AND projects.id = env.project_id
      WHERE env.principal_id = ? AND env.id = ? AND env.state = 'ACTIVE' AND projects.state = 'ACTIVE'`)
      .get(principalId, id);
    return row ? environmentView(row as Parameters<typeof environmentView>[0]) : undefined;
  }

  private removeEnvironmentRecords(principalId: string, environmentId: string): void {
    this.database.prepare(`DELETE FROM secret_versions WHERE principal_id = ? AND secret_reference_id IN
      (SELECT id FROM secret_references WHERE principal_id = ? AND environment_id = ?)`)
      .run(principalId, principalId, environmentId);
    this.database.prepare('DELETE FROM secret_references WHERE principal_id = ? AND environment_id = ?')
      .run(principalId, environmentId);
    this.database.prepare('DELETE FROM environments WHERE principal_id = ? AND id = ?')
      .run(principalId, environmentId);
  }
}
