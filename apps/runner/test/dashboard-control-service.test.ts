import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetadataRunnerRequest, RunnerConfig } from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(withKeyring = true) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-controls-')); roots.push(root);
  const databasePath = join(root, 'state.db'); const principals = new StateStore(databasePath);
  const keyring = withKeyring ? new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]) : undefined;
  const metadata = new MetadataStore(databasePath, keyring);
  const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const workspaces = { readArtifactSource: async (principal: any) => ({ ownerId: principals.resolvePrincipal(principal), content: Buffer.from('snapshot') }) } as WorkspaceService;
  const controls = new DashboardControlService({ artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, workspaces);
  return { controls, principals, metadata, artifacts, keyring, workspaces };
}

const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
const request = (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, selected = principal) => ({ version: 2 as const, principal: selected, operation, input }) as MetadataRunnerRequest;

describe('dashboard control service', () => {
  it('keeps secret values write-only and records redacted audit events', async () => {
    const { controls, metadata } = setup();
    const project = await controls.execute(request('project_create', { name: 'Control plane', expectedGeneration: 0 }));
    const projectId = (project.data as { id: string }).id;
    const environment = await controls.execute(request('environment_create', { projectId, name: 'Production', expectedGeneration: 0 }));
    const environmentId = (environment.data as { id: string }).id;
    const created = await controls.execute(request('secret_create', { environmentId, name: 'APP_TOKEN', value: 'plaintext-never-returned', expectedGeneration: 0 }));
    expect(JSON.stringify(created)).not.toContain('plaintext-never-returned');
    expect(metadata.listAudit((metadata.database.prepare('SELECT id FROM principals LIMIT 1').get() as { id: string }).id).map((event) => event.action))
      .toEqual(expect.arrayContaining(['project.created', 'environment.created', 'secret.created']));
  });

  it('keeps secret references readable and fails mutations closed when the keyring is unavailable', async () => {
    const { controls } = setup(false);
    const project = await controls.execute(request('project_create', { name: 'Control plane', expectedGeneration: 0 }));
    const environment = await controls.execute(request('environment_create', {
      projectId: (project.data as { id: string }).id, name: 'Recovery', expectedGeneration: 0
    }));
    const environmentId = (environment.data as { id: string }).id;
    const listed = await controls.execute(request('secret_list', { environmentId }));
    expect(listed.data).toEqual({ secrets: [], readiness: { ready: false, error: 'secret keyring is unavailable' } });
    await expect(controls.execute(request('secret_create', {
      environmentId, name: 'APP_TOKEN', value: 'not-persisted', expectedGeneration: 0
    }))).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  });

  it('snapshots bounded workspace content and does not expose storage paths', async () => {
    const { controls } = setup();
    const result = await controls.execute(request('artifact_snapshot', {
      workspaceId: `ws_${'a'.repeat(24)}`, path: 'report.txt', logicalName: 'report.txt', expectedGeneration: 0
    }));
    expect(result).toMatchObject({ ok: true, data: { logicalName: 'report.txt', sizeBytes: 8 } });
    expect(JSON.stringify(result)).not.toContain('relativePath');
    const audit = await controls.execute(request('audit_list', { limit: 50 }));
    expect(JSON.stringify(audit)).toContain('artifact.created');
  });

  it('rolls an artifact mutation back when its audit append fails', async () => {
    const { controls, principals, metadata, artifacts } = setup();
    const principalId = principals.resolvePrincipal(principal);
    metadata.database.exec(`CREATE TRIGGER reject_artifact_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'artifact.created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    await expect(controls.execute(request('artifact_snapshot', {
      workspaceId: `ws_${'a'.repeat(24)}`, path: 'report.txt', logicalName: 'report.txt', expectedGeneration: 0
    }))).rejects.toThrow('audit unavailable');
    expect(artifacts.list(principalId, { limit: 10 }).artifacts).toEqual([]);
  });

  it('requires active owner-qualified artifact provenance', async () => {
    const { controls } = setup();
    const missing = request('artifact_snapshot', {
      workspaceId: `ws_${'a'.repeat(24)}`, path: 'report.txt', logicalName: 'report.txt',
      projectId: `prj_${'x'.repeat(24)}`, expectedGeneration: 0
    });
    await expect(controls.execute(missing)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(controls.execute(request(missing.operation, missing.input, { ...principal, subject: 'operator-b' })))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('revalidates artifact provenance after workspace file I/O and before commit', async () => {
    const { controls, metadata, workspaces, artifacts, principals } = setup();
    const project = await controls.execute(request('project_create', { name: 'Transient', expectedGeneration: 0 }));
    const projectId = (project.data as { id: string }).id;
    const generation = (project.data as { generation: number }).generation;
    workspaces.readArtifactSource = async (selected) => {
      const principalId = principals.resolvePrincipal(selected);
      metadata.deleteProject(principalId, projectId, generation);
      return { ownerId: principalId, content: Buffer.from('snapshot') };
    };
    await expect(controls.execute(request('artifact_snapshot', {
      workspaceId: `ws_${'a'.repeat(24)}`, path: 'report.txt', logicalName: 'report.txt',
      projectId, expectedGeneration: 0
    }))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(artifacts.list(principals.resolvePrincipal(principal), { limit: 10 }).artifacts).toEqual([]);
  });

  it('returns the same conflict for foreign, unknown, and stale metadata mutations', async () => {
    const { controls } = setup();
    for (const selected of [principal, { ...principal, subject: 'operator-b' }]) {
      await expect(controls.execute(request('project_update', {
        projectId: `prj_${'x'.repeat(24)}`, name: 'Nope', expectedGeneration: 1
      }, selected))).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    }
  });
});
