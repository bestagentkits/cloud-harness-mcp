import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(keyVersion = 1, additionalKeys: { version: number; key: Buffer }[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-metadata-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'state.db');
  const state = new StateStore(path);
  const owner = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
  const foreign = state.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'foreign' });
  state.close();
  const keys = [{ version: keyVersion, key: Buffer.alloc(32, keyVersion) }, ...additionalKeys];
  const keyring = new SecretKeyring(keyVersion, keys);
  const store = new MetadataStore(path, keyring);
  return { directory, path, owner, foreign, keyring, store };
}

function projectEnvironment(store: MetadataStore, owner: string) {
  const project = store.createProject(owner, 'Harness', 0)!;
  const environment = store.createEnvironment(owner, project.id, 'Production', 0)!;
  return { project, environment };
}

describe('MetadataStore', () => {
  it('migrates once, survives restart, and enforces owner-qualified foreign keys', () => {
    const { path, owner, foreign, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    expect((store.database.prepare('SELECT version FROM metadata_schema_meta').get() as { version: number }).version).toBe(1);
    expect(() => store.database.prepare(`INSERT INTO environments
      (id, principal_id, project_id, name, state, generation, created_at, updated_at)
      VALUES (?, ?, ?, 'Foreign', 'ACTIVE', 1, 1, 1)`).run(`env_${'x'.repeat(24)}`, foreign, project.id)).toThrow();
    store.close();
    keyring.close();

    const reopenedKeyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 1) }]);
    const reopened = new MetadataStore(path, reopenedKeyring);
    expect(reopened.listProjects(owner)).toEqual([project]);
    expect(reopened.listEnvironments(owner, project.id)).toEqual([environment]);
    reopened.close();
    reopenedKeyring.close();
  });

  it('uses generation fences and makes foreign and missing mutations indistinguishable', () => {
    const { owner, foreign, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    const missingProject = `prj_${'x'.repeat(24)}`;
    expect(store.updateProject(foreign, project.id, project.generation, 'Stolen')).toEqual(
      store.updateProject(foreign, missingProject, project.generation, 'Stolen')
    );
    expect(store.updateProject(owner, project.id, project.generation + 1, 'Stale')).toBeUndefined();
    const updated = store.updateProject(owner, project.id, project.generation, 'Harness 2')!;
    expect(updated.generation).toBe(project.generation + 1);
    expect(store.deleteProject(owner, project.id, project.generation)).toBeUndefined();
    expect(store.updateEnvironment(foreign, environment.id, environment.generation, 'Stolen')).toBeUndefined();
    expect(store.deleteEnvironment(owner, environment.id, environment.generation)?.state).toBe('DELETED');
    store.close();
    keyring.close();
  });

  it('deletes project aggregates transactionally, retains audit, and permits name reuse', () => {
    const { owner, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    const secret = store.secrets.create(owner, environment.id, 'API_TOKEN', 'value', 0)!;
    const auditBefore = store.listAudit(owner, 100);

    const deleted = store.deleteProject(owner, project.id, project.generation)!;
    expect(deleted).toMatchObject({ id: project.id, state: 'DELETED', generation: 2 });
    expect(store.listProjects(owner)).toEqual([]);
    expect(store.listEnvironments(owner, project.id)).toEqual([]);
    expect(store.listSecretReferences(owner, environment.id)).toEqual([]);
    expect(store.database.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id)).toBeUndefined();
    expect(store.database.prepare('SELECT 1 FROM environments WHERE id = ?').get(environment.id)).toBeUndefined();
    expect(store.database.prepare('SELECT 1 FROM secret_references WHERE id = ?').get(secret.id)).toBeUndefined();
    expect(store.database.prepare('SELECT 1 FROM secret_versions WHERE secret_reference_id = ?').get(secret.id)).toBeUndefined();
    expect(store.listAudit(owner, 100)).toEqual(expect.arrayContaining(auditBefore));
    expect(store.listAudit(owner, 100).map((event) => event.action)).toContain('project.deleted');

    const recreatedProject = store.createProject(owner, project.name, 0)!;
    const recreatedEnvironment = store.createEnvironment(owner, recreatedProject.id, environment.name, 0)!;
    expect(store.secrets.create(owner, recreatedEnvironment.id, 'API_TOKEN', 'next', 0)).toBeDefined();
    store.close();
    keyring.close();
  });

  it('rolls an aggregate deletion back when its audit append fails', () => {
    const { owner, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    const secret = store.secrets.create(owner, environment.id, 'API_TOKEN', 'value', 0)!;
    store.database.exec(`CREATE TRIGGER reject_project_delete_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'project.deleted' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);

    expect(() => store.deleteProject(owner, project.id, project.generation)).toThrow('audit unavailable');
    expect(store.listProjects(owner)).toEqual([project]);
    expect(store.listEnvironments(owner, project.id)).toEqual([environment]);
    expect(store.listSecretReferences(owner, environment.id)).toEqual([secret]);
    expect(store.database.prepare('SELECT 1 FROM secret_versions WHERE secret_reference_id = ?').get(secret.id)).toBeDefined();
    store.close();
    keyring.close();
  });

  it('deletes environment secrets and secret versions while retaining the project', () => {
    const { owner, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    const secret = store.secrets.create(owner, environment.id, 'API_TOKEN', 'value', 0)!;

    expect(store.deleteEnvironment(owner, environment.id, environment.generation)).toMatchObject({ state: 'DELETED' });
    expect(store.listProjects(owner)).toHaveLength(1);
    expect(store.listEnvironments(owner, project.id)).toEqual([]);
    expect(store.database.prepare('SELECT 1 FROM secret_references WHERE id = ?').get(secret.id)).toBeUndefined();
    expect(store.database.prepare('SELECT 1 FROM secret_versions WHERE secret_reference_id = ?').get(secret.id)).toBeUndefined();
    const recreated = store.createEnvironment(owner, project.id, environment.name, 0)!;
    expect(store.secrets.create(owner, recreated.id, 'API_TOKEN', 'next', 0)).toBeDefined();
    store.close();
    keyring.close();
  });

  it('requires an active environment under an active project for every secret mutation', () => {
    const { owner, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    const secret = store.secrets.create(owner, environment.id, 'API_TOKEN', 'value', 0)!;
    store.database.prepare("UPDATE projects SET state = 'DELETED', deleted_at = 1 WHERE id = ?").run(project.id);

    expect(store.secrets.create(owner, environment.id, 'OTHER_TOKEN', 'value', 0)).toBeUndefined();
    expect(store.secrets.rotate(owner, environment.id, secret.name, 'next', secret.generation)).toBeUndefined();
    expect(store.secrets.delete(owner, environment.id, secret.name, secret.generation)).toBeUndefined();
    expect(store.listSecretReferences(owner, environment.id)).toEqual([]);
    expect(store.environmentValues(owner, environment.id)).toBeUndefined();
    expect(store.secrets.environmentValues(owner, environment.id)).toEqual({});
    store.close();
    keyring.close();
  });

  it('validates active owner-qualified and project-consistent artifact provenance', () => {
    const { owner, foreign, store, keyring } = fixture();
    const { project, environment } = projectEnvironment(store, owner);
    const otherProject = store.createProject(owner, 'Other', 0)!;
    const missing = `prj_${'x'.repeat(24)}`;

    expect(store.validateArtifactProvenance(owner, {})).toBe(true);
    expect(store.validateArtifactProvenance(owner, { projectId: project.id })).toBe(true);
    expect(store.validateArtifactProvenance(owner, { environmentId: environment.id })).toBe(true);
    expect(store.validateArtifactProvenance(owner, { projectId: project.id, environmentId: environment.id })).toBe(true);
    expect(store.validateArtifactProvenance(owner, { projectId: otherProject.id, environmentId: environment.id })).toBe(false);
    expect(store.validateArtifactProvenance(owner, { projectId: missing })).toBe(false);
    expect(store.validateArtifactProvenance(foreign, { projectId: project.id })).toBe(false);
    store.database.prepare("UPDATE projects SET state = 'DELETED', deleted_at = 1 WHERE id = ?").run(project.id);
    expect(store.validateArtifactProvenance(owner, { projectId: project.id })).toBe(false);
    expect(store.validateArtifactProvenance(owner, { environmentId: environment.id })).toBe(false);
    store.close();
    keyring.close();
  });

  it('rolls a mutation back when its audit append fails', () => {
    const { owner, store, keyring } = fixture();
    const project = store.createProject(owner, 'Harness', 0)!;
    store.database.exec(`CREATE TRIGGER reject_project_update_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'project.updated' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect(() => store.updateProject(owner, project.id, project.generation, 'Should Roll Back')).toThrow('audit unavailable');
    expect(store.listProjects(owner)).toEqual([project]);
    store.close();
    keyring.close();
  });

  it('paginates audit events with principal-qualified opaque cursors', () => {
    const { owner, foreign, store, keyring } = fixture();
    const { project } = projectEnvironment(store, owner);
    store.updateProject(owner, project.id, project.generation, 'Harness 2');
    const all = store.listAudit(owner, 100);
    const first = store.listAudit(owner, 2);
    const rest = store.listAudit(owner, 100, first.at(-1)!.id);
    expect([...first, ...rest]).toEqual(all);
    expect(store.listAudit(foreign, 100, first.at(-1)!.id)).toEqual([]);
    expect(store.listAudit(owner, 100, `aud_${'x'.repeat(24)}`)).toEqual([]);
    store.close();
    keyring.close();
  });

  it('keeps non-secret recovery reads available without an active keyring', () => {
    const first = fixture();
    const { project, environment } = projectEnvironment(first.store, first.owner);
    const secret = first.store.secrets.create(first.owner, environment.id, 'API_TOKEN', 'value', 0)!;
    first.store.close();
    first.keyring.close();
    const recovery = new MetadataStore(first.path);
    expect(recovery.secretReadiness()).toEqual({ ready: false, error: 'secret keyring is unavailable' });
    expect(recovery.listProjects(first.owner)).toEqual([project]);
    expect(recovery.listSecretReferences(first.owner, environment.id)).toEqual([secret]);
    expect(recovery.listAudit(first.owner)).toHaveLength(3);
    expect(() => recovery.secrets).toThrow('secret keyring is unavailable');
    recovery.close();
  });

  it('accepts a sanitized keyring construction error while keeping reference reads available', () => {
    const first = fixture();
    const { environment } = projectEnvironment(first.store, first.owner);
    const secret = first.store.secrets.create(first.owner, environment.id, 'API_TOKEN', 'value', 0)!;
    first.store.close();
    first.keyring.close();

    const recovery = new MetadataStore(first.path, undefined, 'secret configuration is invalid');
    expect(recovery.secretReadiness()).toEqual({ ready: false, error: 'secret configuration is invalid' });
    expect(recovery.listSecretReferences(first.owner, environment.id)).toEqual([secret]);
    expect(() => recovery.secrets).toThrow('secret configuration is invalid');
    recovery.close();
  });

  it('keeps secret values write-only, encrypted at rest, and out of redacted audits', () => {
    const secret = 'plaintext-must-never-persist-7f64b75d';
    const rotated = 'rotated-plaintext-must-never-persist-2b9a';
    const { directory, owner, foreign, store, keyring } = fixture();
    const { environment } = projectEnvironment(store, owner);
    const created = store.secrets.create(owner, environment.id, 'API_TOKEN', secret, 0)!;
    expect(created).not.toHaveProperty('value');
    expect(store.secrets.create(foreign, environment.id, 'API_TOKEN', secret, 0)).toBeUndefined();
    expect(store.secrets.rotate(foreign, environment.id, 'API_TOKEN', rotated, created.generation)).toBeUndefined();
    const next = store.secrets.rotate(owner, environment.id, 'API_TOKEN', rotated, created.generation)!;
    expect(next).not.toHaveProperty('value');
    expect(next.version).toBe(2);
    expect(store.secrets.rotate(owner, environment.id, 'API_TOKEN', 'stale', created.generation)).toBeUndefined();
    const audit = store.listAudit(owner, 100);
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(['secret.created', 'secret.rotated']));
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(rotated);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store.secrets))).not.toContain('read');
    expect(store.secrets.delete(owner, environment.id, 'API_TOKEN', next.generation)).toMatchObject({ state: 'DELETED' });
    expect(store.listSecretReferences(owner, environment.id)).toEqual([]);
    expect(store.secrets.create(owner, environment.id, 'API_TOKEN', 'recreated', 0)).toBeDefined();
    store.close();
    keyring.close();
    const persisted = readdirSync(directory).filter((name) => name.startsWith('state.db') && existsSync(join(directory, name)))
      .map((name) => readFileSync(join(directory, name))).reduce((all, value) => Buffer.concat([all, value]), Buffer.alloc(0));
    expect(persisted.includes(Buffer.from(secret))).toBe(false);
    expect(persisted.includes(Buffer.from(rotated))).toBe(false);
  });

  it('supports retained-key restart, interruptible re-encryption, and unknown-key fail-closed startup', async () => {
    const first = fixture();
    const { environment } = projectEnvironment(first.store, first.owner);
    first.store.secrets.create(first.owner, environment.id, 'FIRST_TOKEN', 'first', 0);
    first.store.secrets.create(first.owner, environment.id, 'SECOND_TOKEN', 'second', 0);
    first.store.close();
    first.keyring.close();

    const mixed = new SecretKeyring(2, [
      { version: 1, key: Buffer.alloc(32, 1) }, { version: 2, key: Buffer.alloc(32, 2) }
    ]);
    const reopened = new MetadataStore(first.path, mixed);
    const stopped = new AbortController();
    stopped.abort();
    expect(await reopened.secrets.reencrypt(stopped.signal)).toBe(0);
    expect((reopened.database.prepare('SELECT DISTINCT key_version FROM secret_versions').all() as { key_version: number }[]).map((row) => row.key_version)).toEqual([1]);
    expect(await reopened.secrets.reencrypt()).toBe(2);
    expect((reopened.database.prepare('SELECT DISTINCT key_version FROM secret_versions').all() as { key_version: number }[]).map((row) => row.key_version)).toEqual([2]);
    expect(reopened.listAudit(first.owner, 100).filter((event) => event.action === 'secret.reencrypted')).toHaveLength(2);
    reopened.close();
    mixed.close();

    const missing = new SecretKeyring(3, [{ version: 3, key: Buffer.alloc(32, 3) }]);
    const unavailable = new MetadataStore(first.path, missing);
    expect(unavailable.secretReadiness()).toEqual({ ready: false, error: 'unknown secret key version 2' });
    expect(unavailable.listProjects(first.owner)).toHaveLength(1);
    expect(unavailable.listSecretReferences(first.owner, environment.id)).toHaveLength(2);
    expect(unavailable.listAudit(first.owner, 100).length).toBeGreaterThan(0);
    expect(() => unavailable.secrets).toThrow('unknown secret key version 2');
    unavailable.close();
    missing.close();
  });
});
