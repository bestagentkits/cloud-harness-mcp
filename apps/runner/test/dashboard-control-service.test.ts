import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessError, type MetadataRunnerRequest, type RunnerConfig } from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { GitHubBindingService, GitHubSetupStateStore } from '../src/github-binding-service.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';
const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup(); } catch { /* ignore cleanup error */ }
  }
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
});

function setup(withKeyring = true) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-controls-')); roots.push(root);
  const databasePath = join(root, 'state.db'); const principals = new StateStore(databasePath);
  const keyring = withKeyring ? new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]) : undefined;
  const metadata = new MetadataStore(databasePath, keyring);
  cleanups.push(() => {
    try { metadata.database.close(); } catch { /* ignore */ }
    try { principals.close(); } catch { /* ignore */ }
  });
  const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
  const workspaces = {
    readArtifactSource: async (p: PrincipalSelector) => ({ ownerId: principals.resolvePrincipal(p), content: Buffer.from('snapshot') }),
    snapshotArtifact: async (p: PrincipalSelector, input: { workspaceId?: string; path: string; logicalName: string; retentionSeconds?: number; projectId?: string; environmentId?: string }) => {
      const ownerId = principals.resolvePrincipal(p);
      const provenance = {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {})
      };
      if (provenance.projectId || provenance.environmentId) {
        if (!metadata.validateArtifactProvenance(ownerId, provenance)) {
          throw new HarnessError('NOT_FOUND', 'artifact provenance is unavailable', 404, false);
        }
      }
      return artifacts.create(ownerId, {
        logicalName: input.logicalName,
        content: Buffer.from('snapshot'),
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.retentionSeconds ? { retentionMs: input.retentionSeconds * 1_000 } : {})
      }, (database, _owner, artifact) => {
        if (provenance.projectId || provenance.environmentId) {
          if (!metadata.validateArtifactProvenance(ownerId, provenance)) {
            throw new HarnessError('NOT_FOUND', 'artifact provenance is unavailable', 404, false);
          }
        }
        metadata.recordAuditInTransaction(
          database, ownerId, 'artifact.created', 'artifact', artifact.artifactId,
          artifact.generation, { sizeBytes: artifact.sizeBytes }
        );
      });
    },
    restoreArtifact: async (p: PrincipalSelector, input: { artifactId: string; workspaceId?: string; path: string; overwrite?: boolean; expectedSha256?: string }) => {
      const ownerId = principals.resolvePrincipal(p);
      const { metadata: artifactMeta } = artifacts.readPayload(ownerId, input.artifactId);
      metadata.recordAudit(
        ownerId, 'artifact.restored', 'artifact', artifactMeta.artifactId, artifactMeta.generation,
        { sourceWorkspaceId: artifactMeta.workspaceId ?? '', destinationWorkspaceId: input.workspaceId ?? '', destinationPath: input.path, sha256: artifactMeta.sha256, sizeBytes: artifactMeta.sizeBytes }
      );
      return {
        artifactId: artifactMeta.artifactId,
        workspaceId: input.workspaceId ?? '',
        path: input.path,
        sizeBytes: artifactMeta.sizeBytes,
        sha256: artifactMeta.sha256
      };
    }
  } as unknown as WorkspaceService;
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

  it('returns multiple GitHub installations and handles disconnect with audit logging', async () => {
    const { principals, metadata, artifacts, workspaces } = setup();
    const store = new InMemoryGitHubInstallationStore();
    const verifier = { verifyInstallation: async (id: string) => ({ appId: '1', installationId: id, accountId: id, accountLogin: `org-${id}`, status: 'active' as const, repositories: [] }) };
    const binding = new GitHubBindingService(new GitHubSetupStateStore(principals.database), store, verifier);
    const githubControls = new DashboardControlService(
      { artifactRetentionSeconds: 60, githubApp: { appSlug: 'test-app', appId: 1 } } as RunnerConfig,
      principals, metadata, artifacts, workspaces, store, binding
    );

    const principalId = principals.resolvePrincipal(principal);
    store.replaceVerified(principalId, {
      appId: 1, installationId: 101, accountId: 201, accountLogin: 'org-one', status: 'active',
      repositories: [{ owner: 'org-one', repository: 'repo1', contents: 'write' }]
    }, 100);
    store.replaceVerified(principalId, {
      appId: 1, installationId: 102, accountId: 202, accountLogin: 'org-two', status: 'active',
      repositories: [{ owner: 'org-two', repository: 'repo2', contents: 'read' }]
    }, 110);

    // Status returns both installations
    const statusResult = await githubControls.execute(request('github_status', {}));
    expect(statusResult.data).toMatchObject({
      configured: true,
      installations: expect.arrayContaining([
        expect.objectContaining({ installationId: '101', accountLogin: 'org-one' }),
        expect.objectContaining({ installationId: '102', accountLogin: 'org-two' })
      ]),
      repositories: expect.arrayContaining([
        expect.objectContaining({ repository: 'repo1', installationId: '101' }),
        expect.objectContaining({ repository: 'repo2', installationId: '102' })
      ])
    });

    // Disconnect installation 101
    const disconnectResult = await githubControls.execute(request('github_disconnect', { installationId: '101' }));
    expect(disconnectResult.data).toMatchObject({
      installations: [expect.objectContaining({ installationId: '102' })]
    });

    const audits = metadata.listAudit(principalId, 10);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'github.disconnected', subjectId: '101' })
    ]));
  });

  it('lists, approves, and rejects privilege grants with operator authorization and audit logging', async () => {
    const { controls, principals, metadata } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const workspaceId = `ws_${'b'.repeat(24)}`;
    const grant = principals.createPrivilegeGrant({
      ownerId,
      workspaceId,
      command: 'apt-get update',
      ttlMs: 60_000
    });

    const listResult = await controls.execute(request('privilege_grant_list', { workspaceId }));
    expect(listResult.ok).toBe(true);
    const listData = listResult.data as { grants: { id: string }[] };
    expect(listData.grants).toHaveLength(1);
    expect(listData.grants[0].id).toBe(grant.id);
    const approveResult = await controls.execute(request('privilege_grant_approve', { grantId: grant.id }));
    expect(approveResult.ok).toBe(true);
    expect(principals.getPrivilegeGrant(grant.id)?.status).toBe('APPROVED');

    const auditEvents = metadata.listAudit(ownerId);
    expect(auditEvents.some((e) => e.action === 'privilege_grant.approved')).toBe(true);

    // Creating a second grant to test rejection
    const grant2 = principals.createPrivilegeGrant({
      ownerId,
      workspaceId,
      command: 'apt-get install -y cowsay',
      ttlMs: 60_000
    });
    const rejectResult = await controls.execute(request('privilege_grant_reject', { grantId: grant2.id }));
    expect(rejectResult.ok).toBe(true);
    expect(principals.getPrivilegeGrant(grant2.id)?.status).toBe('REJECTED');
    expect(metadata.listAudit(ownerId).some((e) => e.action === 'privilege_grant.rejected')).toBe(true);
  });

  it('Issue #109 and #110: reads bounded artifact chunks and restores artifact into workspace', async () => {
    const { controls } = setup();
    const snapResult = await controls.execute(request('artifact_snapshot', {
      workspaceId: `ws_${'a'.repeat(24)}`, path: 'report.txt', logicalName: 'report.txt', expectedGeneration: 0
    }));
    expect(snapResult.ok).toBe(true);
    const artifactId = (snapResult.data as { artifactId: string }).artifactId;

    // Read artifact via dashboard control service
    const readResult = await controls.execute(request('artifact_read', {
      artifactId, offset: 0, limit: 100
    }));
    expect(readResult.ok).toBe(true);
    const readData = readResult.data as { logicalName: string; sizeBytes?: number; totalBytes: number; bytesReturned: number; sha256: string; content: string; eof: boolean };
    expect(readData.logicalName).toBe('report.txt');
    expect(readData.totalBytes).toBe(8);
    expect(readData.bytesReturned).toBe(8);
    expect(readData.eof).toBe(true);
    expect(Buffer.from(readData.content, 'base64').toString('utf8')).toBe('snapshot');

    // Restore artifact via dashboard control service
    const restoreResult = await controls.execute(request('artifact_restore', {
      artifactId, workspaceId: `ws_${'b'.repeat(24)}`, path: 'context/restored.txt', overwrite: true
    }));
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.data).toMatchObject({
      artifactId,
      workspaceId: `ws_${'b'.repeat(24)}`,
      path: 'context/restored.txt',
      sizeBytes: 8
    });

    const audit = await controls.execute(request('audit_list', { limit: 50 }));
    expect(JSON.stringify(audit)).toContain('artifact.restored');
  });
});
