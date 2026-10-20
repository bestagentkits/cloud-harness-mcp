import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HarnessError, ModelProfileValidateResultSchema,
  type AgentModelProfileMetadata, type MetadataRunnerRequest, type ModelConnectionVerifyResult, type ModelProfileValidateResult, type RunnerConfig
} from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { GitHubBindingService, GitHubSetupStateStore } from '../src/github-binding-service.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import type { ProviderHttpClient } from '../src/model-provider-http.js';
import { PackageStore } from '../src/package-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
import { ToolkitCacheManager } from '../src/toolkit-cache-manager.js';
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

/** The executor image the stubbed workspace service reports to the package overview. */
let currentPackageImageId: string | undefined = 'sha256:executor-image';

function setup(withKeyring = true, config: Partial<RunnerConfig> | ((root: string) => Partial<RunnerConfig>) = {}) {
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
    packages: { currentImageId: async () => currentPackageImageId },
    toolkitCacheManager: new ToolkitCacheManager(join(root, 'toolkits'), principals),
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
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60, ...(typeof config === 'function' ? config(root) : config) } as RunnerConfig,
    principals, metadata, artifacts, workspaces,
    undefined, undefined, undefined, undefined, keyring
  );
  return { controls, principals, metadata, artifacts, keyring, workspaces, root };
}

describe('skill revisions', () => {
  it('diffs two revisions of one skill and forks one into a new source', async () => {
    const { controls, principals, workspaces } = setup();
    const ownerId = principals.resolvePrincipal(principal);

    // Two bundles with different content, so the diff has something real to compare.
    const first = await workspaces.toolkitCacheManager.publishLocalBundle(ownerId, {
      'skills/tdd/SKILL.md': '# TDD\n\nWrite the test first.\n'
    });
    const second = await workspaces.toolkitCacheManager.publishLocalBundle(ownerId, {
      'skills/tdd/SKILL.md': '# TDD\n\nWrite the test first, then the code.\n'
    });
    const created = principals.createSkillSource({
      ownerId, slug: 'tdd', displayName: 'TDD', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: first.bundleSha256, contentSha256: first.bundleSha256, hasExecutableAssets: false }
    });
    const secondRevision = principals.addSkillRevision({
      ownerId, skillSourceId: created.sourceId, bundleSha256: second.bundleSha256,
      contentSha256: second.bundleSha256, hasExecutableAssets: false, origin: 'edit', parentRevisionId: created.revisionId
    });

    const diff = await controls.execute(request('skill_revision_diff', {
      skillId: created.sourceId, fromRevisionId: created.revisionId, toRevisionId: secondRevision
    }));
    const data = diff.data as { changed: boolean; added: number; removed: number; diff: string };
    expect(data.changed).toBe(true);
    expect(data.added).toBe(1);
    expect(data.removed).toBe(1);
    expect(data.diff).toContain('-Write the test first.');
    expect(data.diff).toContain('+Write the test first, then the code.');

    // A fork starts from the bytes the chosen revision pinned, in a source of its own.
    const forked = await controls.execute(request('skill_revision_fork', {
      skillId: created.sourceId, revisionId: created.revisionId, slug: 'tdd-fork', displayName: 'TDD fork', expectedGeneration: 0
    }));
    const forkedSourceId = (forked.data as { sourceId: string }).sourceId;
    expect(forkedSourceId).not.toBe(created.sourceId);
    const forkedRevision = principals.getSkillRevision(ownerId, forkedSourceId, (forked.data as { revisionId: string }).revisionId);
    expect(forkedRevision?.origin).toBe('fork');
    expect(forkedRevision?.bundleSha256).toBe(first.bundleSha256);

    // The source it came from is untouched: a fork is a copy, not a move.
    expect(principals.getSkillSource(ownerId, created.sourceId)?.currentRevisionId).toBe(secondRevision);
  });

  it('turns edited instructions into a new revision and keeps the previous one resolvable', async () => {
    const { controls, principals, workspaces } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const first = await workspaces.toolkitCacheManager.publishLocalBundle(ownerId, {
      'skills/tdd/SKILL.md': '# TDD\n\nWrite the test first.\n'
    });
    const created = principals.createSkillSource({
      ownerId, slug: 'tdd', displayName: 'TDD', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: first.bundleSha256, contentSha256: first.bundleSha256, hasExecutableAssets: false }
    });
    const source = principals.getSkillSource(ownerId, created.sourceId)!;

    const edited = await controls.execute(request('skill_revision_create', {
      skillId: created.sourceId,
      instructions: '# TDD\n\nWrite the test first, then the code.\n',
      expectedGeneration: source.generation
    }));
    const revisionId = (edited.data as { revisionId: string }).revisionId;

    const revision = principals.getSkillRevision(ownerId, created.sourceId, revisionId);
    expect(revision?.origin).toBe('edit');
    // Edited instructions carry no scripts, so the new revision reports that honestly instead of
    // inheriting the previous revision's claim about executable assets.
    expect(revision?.hasExecutableAssets).toBe(false);
    // The revision it replaced is still resolvable, which is what a launch that pinned it depends on.
    expect(principals.getSkillRevision(ownerId, created.sourceId, created.revisionId)?.bundleSha256).toBe(first.bundleSha256);
    expect(principals.getSkillSource(ownerId, created.sourceId)?.currentRevisionId).toBe(revisionId);
  });

  it('cancels a queued import job and refuses to cancel a job that already finished', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const jobId = principals.createSkillImportJob({ ownerId, sourceKind: 'skillx', sourceRef: 'davila7-pdf-processing' });

    const read = await controls.execute(request('skill_import_status', { jobId }));
    expect(read.data).toMatchObject({ id: jobId, state: 'queued', generation: 1, progress: {}, result: null });
    expect(read.data).not.toHaveProperty('progressJson');

    const cancelled = await controls.execute(request('skill_import_cancel', { jobId, expectedGeneration: 1 }));
    expect(cancelled.data).toMatchObject({ state: 'cancelled', generation: 3 });
    // The state is on the row rather than only in the response, because the row is what survives a restart.
    expect(principals.getSkillImportJob(ownerId, jobId)?.state).toBe('cancelled');

    // A job that already reached a terminal state is a conflict, not a silent rewrite of its history.
    await expect(controls.execute(request('skill_import_cancel', { jobId, expectedGeneration: 3 })))
      .rejects.toThrow(/cannot be cancelled/);
  });

  it('refuses a cancel fenced on a generation the job has already moved past', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const jobId = principals.createSkillImportJob({ ownerId, sourceKind: 'skillx', sourceRef: 'davila7-pdf-processing' });
    principals.advanceSkillImportJob({ ownerId, id: jobId, state: 'running', progressJson: '{"phase":"acquiring"}' });

    // The operator read the queued job; it has since started, so the cancel is stale rather than applied.
    const stale = controls.execute(request('skill_import_cancel', { jobId, expectedGeneration: 1 }));
    await expect(stale).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    await expect(stale).rejects.toThrow(/generation 2, not 1/);
    expect(principals.getSkillImportJob(ownerId, jobId)?.state).toBe('running');

    const current = await controls.execute(request('skill_import_cancel', { jobId, expectedGeneration: 2 }));
    expect(current.data).toMatchObject({ state: 'cancelled', progress: { phase: 'acquiring' } });
  });

  it('stops a running import that was cancelled without publishing or failing the cancelled row', async () => {
    const { controls, principals, workspaces } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { release = resolve; });
    let importCalls = 0;
    (workspaces as unknown as { toolkitService: unknown }).toolkitService = {
      importSkillPackage: async () => {
        importCalls += 1;
        await acquired;
        return {
          bundleSha256: 'a'.repeat(64), resolvedRevision: 'r1', hasExecutableAssets: false,
          skills: [{ name: 'pdf-processing', contentSha256: 'b'.repeat(64) }]
        };
      }
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const started = await controls.execute(request('skill_import_start', { sourceKind: 'skillx', sourceRef: 'davila7-pdf-processing', expectedGeneration: 0 }));
      const jobId = (started.data as { id: string }).id;
      await vi.waitFor(() => expect(importCalls).toBe(1));
      expect(principals.getSkillImportJob(ownerId, jobId)?.generation).toBe(2);

      await controls.execute(request('skill_import_cancel', { jobId, expectedGeneration: 2 }));
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The worker noticed the cancel at its next step: nothing was published and the row kept its state.
      const job = principals.getSkillImportJob(ownerId, jobId);
      expect(job).toMatchObject({ state: 'cancelled', errorCode: null, skillRevisionId: null });
      expect(principals.listSkillSources(ownerId, { limit: 10 })).toHaveLength(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports an unknown import job instead of an empty success', async () => {
    const { controls } = setup();
    // A well-formed id that was never issued, so the request reaches the handler rather than failing the
    // identifier shape first, which is a different fact from the record being absent.
    const missingJobId = `skjob_${'0'.repeat(32)}`;

    await expect(controls.execute(request('skill_import_cancel', { jobId: missingJobId, expectedGeneration: 1 })))
      .rejects.toThrow(/was not found/);
    await expect(controls.execute(request('skill_import_status', { jobId: missingJobId })))
      .rejects.toThrow(/was not found/);
  });

  it('reports a revision whose content is missing rather than an empty diff', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const created = principals.createSkillSource({
      ownerId, slug: 'ghost', displayName: 'Ghost', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: 'f'.repeat(64), contentSha256: 'f'.repeat(64), hasExecutableAssets: false }
    });

    await expect(controls.execute(request('skill_revision_diff', {
      skillId: created.sourceId, fromRevisionId: created.revisionId, toRevisionId: created.revisionId
    }))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('integration credentials and typesafe', () => {
  it('stores a credential write-only and reports configured without ever carrying the key', async () => {
    const { controls } = setup();
    const secret = 'ts_live_do_not_log_this_value';

    const before = await controls.execute(request('typesafe_status', {}));
    expect(before.data).toMatchObject({ configured: false, enabled: true });

    const created = await controls.execute(request('integration_credential_create', {
      integration: 'typesafe', label: 'TypeSafe', value: secret, expectedGeneration: 0
    }));
    expect(JSON.stringify(created)).not.toContain(secret);
    const credentialId = (created.data as { id: string }).id;

    // Status and list are the two read paths a caller can reach, and neither returns a value.
    const after = await controls.execute(request('typesafe_status', {}));
    expect(after.data).toMatchObject({ configured: true });
    expect(JSON.stringify(after)).not.toContain(secret);

    const listed = await controls.execute(request('integration_credential_list', {}));
    expect((listed.data as { credentials: unknown[] }).credentials).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(secret);

    const rotated = await controls.execute(request('integration_credential_rotate', {
      credentialId, value: 'ts_live_rotated', expectedGeneration: 1
    }));
    expect((rotated.data as { generation: number }).generation).toBe(2);
    expect(JSON.stringify(rotated)).not.toContain('ts_live_rotated');

    const deleted = await controls.execute(request('integration_credential_delete', { credentialId, expectedGeneration: 2 }));
    expect(deleted.data).toMatchObject({ deleted: true });
  });

  it('answers 409 for a stale generation or a second create, and 404 for a key already removed', async () => {
    const { controls } = setup();
    const created = await controls.execute(request('integration_credential_create', {
      integration: 'typesafe', label: 'TypeSafe', value: 'ts_live_first', expectedGeneration: 0
    }));
    const credentialId = (created.data as { id: string }).id;

    await expect(controls.execute(request('integration_credential_create', {
      integration: 'typesafe', label: 'TypeSafe', value: 'ts_live_second', expectedGeneration: 0
    }))).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await expect(controls.execute(request('integration_credential_rotate', {
      credentialId, value: 'ts_live_stale', expectedGeneration: 7
    }))).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await controls.execute(request('integration_credential_delete', { credentialId, expectedGeneration: 1 }));
    await expect(controls.execute(request('integration_credential_delete', { credentialId, expectedGeneration: 1 })))
      .rejects.toMatchObject({ status: 404 });
  });

  it('reports an empty roster rather than calling out when a key exists but no workspace was named', async () => {
    const { controls } = setup();
    await controls.execute(request('integration_credential_create', {
      integration: 'typesafe', label: 'TypeSafe', value: 'ts_live_key', expectedGeneration: 0
    }));

    const result = await controls.execute(request('skill_suggest', { prompt: 'Please refactor the authentication middleware.' }));

    expect(result.data).toMatchObject({ suggested: null, reason: 'empty_roster', outboundCalls: 0 });
  });

  it('reports egress as disabled when the operator turned TYPESAFE_EGRESS off', async () => {
    const { controls } = setup(true, { typesafeEgress: 'off' });
    await controls.execute(request('integration_credential_create', {
      integration: 'typesafe', label: 'TypeSafe', value: 'ts_live_key', expectedGeneration: 0
    }));

    const status = await controls.execute(request('typesafe_status', {}));

    expect(status.data).toMatchObject({ configured: true, enabled: false });
  });

  it('answers not_configured with zero outbound work when the owner has no key', async () => {
    const { controls } = setup();

    const result = await controls.execute(request('skill_suggest', { prompt: 'Please refactor the authentication middleware.' }));

    expect(result.data).toMatchObject({ suggested: null, reason: 'not_configured', outboundCalls: 0 });
  });

  it('refuses a credential write when the runner has no keyring', async () => {
    const { controls } = setup(false);

    await expect(controls.execute(request('integration_credential_create', {
      integration: 'typesafe', label: 'TypeSafe', value: 'ts_live_key', expectedGeneration: 0
    }))).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  });
});

const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
const request = (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, selected = principal) => ({ version: 2 as const, principal: selected, operation, input }) as MetadataRunnerRequest;

describe('dashboard control service', () => {
  it('serves the registry catalogue and records an entry an operator acts on', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);

    // The route test uses a mocked runner, which answers anything, so it cannot tell a real handler from a
    // missing one. These calls go through the service itself.
    const listed = await controls.execute(request('toolkit_registry_list', {}));
    expect(Array.isArray((listed.data as { entries: unknown[] }).entries)).toBe(true);
    expect((listed.data as { entries: unknown[] }).entries).toEqual([]);

    const filtered = await controls.execute(request('toolkit_registry_list', { provider: 'skillx' }));
    expect((filtered.data as { entries: unknown[] }).entries).toEqual([]);

    // An update records the catalogue entry an operator acted on. The registry listing reports cached
    // toolkits rather than catalogue rows, so the record is asserted where it is actually written.
    await controls.execute(request('toolkit_registry_update', {
      provider: 'skills-sh', slug: 'anthropics/skills/pdf', action: 'install', expectedGeneration: 0
    }));
    expect(principals.listSkillCatalogEntries(ownerId, 'skills-sh').map((entry) => entry.slug))
      .toEqual(['anthropics/skills/pdf']);

    // Every metadata operation now has a handler, so a refresh reports the catalogue this owner has recorded
    // instead of claiming a fetch it did not perform.
    const refreshed = await controls.execute(request('toolkit_registry_refresh', { provider: 'skills-sh' }));
    expect((refreshed.data as { entries: unknown[] }).entries).toHaveLength(1);
  });
  it('reads the registry fields from the cache entry and the lock rows, not from the catalogue', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    // Seeded from the record that holds these fields, so a projection reading the catalogue table would
    // report placeholders here instead of passing. The catalogue is asserted empty below for that reason.
    principals.upsertToolkitCacheEntry({
      cacheKey: 'tkc_registry',
      ownerId,
      sourceIdentity: 'registry:skills-sh:anthropics/skills',
      resolvedRevision: 'a'.repeat(40),
      adapterVersion: 1,
      bundleSha256: 'b'.repeat(64),
      status: 'READY',
      byteCount: 1_024,
      fileCount: 3,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      errorSummary: null
    });

    const listed = await controls.execute(request('toolkit_registry_list', {}));
    const entries = (listed.data as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries).toHaveLength(1);
    // Each field is asserted against the record that holds it, so a placeholder value cannot satisfy this.
    expect(entries[0]).toMatchObject({
      cacheState: 'READY',
      pinnedCommit: 'a'.repeat(40),
      skillCount: 0,
      lockState: 'unlocked',
      provider: 'skills-sh',
      slug: 'anthropics/skills'
    });
    expect(principals.listSkillCatalogEntries(ownerId)).toEqual([]);
  });

  it('creates a custom skill by publishing its content before the source row exists', async () => {
    const { controls, principals, workspaces } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const instructions = '# Custom skill\n\nDo the thing.';

    const created = await controls.execute(request('skill_create_custom', {
      slug: 'custom-skill', displayName: 'Custom Skill', description: 'authored here', tags: ['custom'],
      instructions, hasExecutableAssets: false, expectedGeneration: 0
    }));
    const { sourceId, revisionId, bundleSha256 } = created.data as { sourceId: string; revisionId: string; bundleSha256: string };

    // The recorded digests and the published bytes have to agree. If they did not, the skill would
    // resolve in the inventory and then fail at launch, which is what publishing first prevents.
    const revision = principals.getSkillRevision(ownerId, sourceId, revisionId);
    expect(revision?.bundleSha256).toBe(bundleSha256);
    expect(revision?.contentSha256).toBe(createHash('sha256').update(instructions).digest('hex'));
    expect(readFileSync(join(workspaces.toolkitCacheManager.bundlePath(ownerId, bundleSha256), 'skills/custom-skill/SKILL.md'), 'utf8')).toBe(instructions);

    expect(principals.getSkillSource(ownerId, sourceId)).toMatchObject({
      slug: 'custom-skill', kind: 'owner', provider: 'custom', currentRevisionId: revisionId, state: 'enabled'
    });
  });
  it('restores a previous revision by publishing a new one instead of rewriting history', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const { sourceId, revisionId } = principals.createSkillSource({
      ownerId, slug: 'tdd', displayName: 'TDD', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), hasExecutableAssets: false }
    });
    const second = principals.addSkillRevision({
      ownerId, skillSourceId: sourceId, bundleSha256: 'c'.repeat(64), contentSha256: 'd'.repeat(64),
      hasExecutableAssets: false, origin: 'edit', parentRevisionId: revisionId
    });
    const originalBefore = principals.listSkillRevisions(ownerId, sourceId, 50).find((entry) => entry?.id === revisionId);
    const generation = principals.getSkillSource(ownerId, sourceId)?.generation ?? 1;

    const restored = await controls.execute(request('skill_restore', { skillId: sourceId, revisionId, expectedGeneration: generation }));
    const restoredId = (restored.data as { revisionId: string }).revisionId;
    expect(restoredId).not.toBe(revisionId);
    expect(restoredId).not.toBe(second);

    const revisions = principals.listSkillRevisions(ownerId, sourceId, 50);
    const created = revisions.find((entry) => entry?.id === restoredId);
    expect(created?.origin).toBe('restore');
    expect(created?.parentRevisionId).toBe(revisionId);
    expect(created?.contentSha256).toBe('b'.repeat(64));
    expect(principals.getSkillSource(ownerId, sourceId)?.currentRevisionId).toBe(restoredId);

    // History stays append-only: the revision that was restored is byte-for-byte what it was.
    expect(revisions.find((entry) => entry?.id === revisionId)).toEqual(originalBefore);
  });
  it('previews a skill set through the resolver and refuses a set that moved', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const { sourceId, revisionId } = principals.createSkillSource({
      ownerId, slug: 'tdd', displayName: 'TDD', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), hasExecutableAssets: false }
    });
    const setId = principals.createSkillSet({
      ownerId, name: 'core', items: [{ skillSourceId: sourceId, revisionId, name: 'tdd' }]
    });

    const preview = await controls.execute(request('skill_set_preview', {
      skillSets: [{ skillSetId: setId, expectedGeneration: 1 }]
    }));
    const data = preview.data as { resolved: unknown[]; conflicts: unknown[]; generation: number };
    expect(data.generation).toBe(1);
    expect(data.conflicts).toEqual([]);
    expect(data.resolved).toEqual([{ name: 'tdd', tier: 'owner', sourceId, revisionId, contentSha256: revisionId, pinned: false }]);

    // An override pins the revision, so the preview shows what launch would actually resolve.
    const pinned = await controls.execute(request('skill_set_preview', {
      skillSets: [{ skillSetId: setId, expectedGeneration: 1 }],
      skillOverrides: { tdd: revisionId }
    }));
    expect((pinned.data as { resolved: Array<{ pinned: boolean }> }).resolved[0]?.pinned).toBe(true);

    await expect(controls.execute(request('skill_set_preview', {
      skillSets: [{ skillSetId: setId, expectedGeneration: 99 }]
    }))).rejects.toMatchObject({ code: 'STALE_GENERATION', status: 409 });

    await expect(controls.execute(request('skill_set_preview', {
      skillSets: [{ skillSetId: `skset_${'z'.repeat(24)}`, expectedGeneration: 1 }]
    }))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
  it('reports a bulk state change per item instead of failing the whole batch', async () => {
    const { controls, principals } = setup();
    const ownerId = principals.resolvePrincipal(principal);
    const { sourceId } = principals.createSkillSource({
      ownerId, slug: 'tdd', displayName: 'TDD', kind: 'owner', provider: 'custom',
      revision: { bundleSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), hasExecutableAssets: false }
    });
    const missing = `sk_${'c'.repeat(24)}`;

    // One stale item must not discard the work already applied to the rest of the batch.
    const result = await controls.execute(request('skill_bulk', {
      action: 'archive', skillIds: [sourceId, missing], expectedGeneration: 1
    }));
    expect((result.data as { results: unknown[] }).results).toEqual([
      { skillId: sourceId, ok: true },
      { skillId: missing, ok: false, error: 'NOT_FOUND' }
    ]);
    expect(principals.getSkillSource(ownerId, sourceId)?.state).toBe('archived');
  });
  it('answers a stale skill set generation with a conflict instead of an unhandled error', async () => {
    const { controls } = setup();
    const created = await controls.execute(request('skill_set_create', { name: 'core', expectedGeneration: 0 }));
    const skillSetId = (created.data as { skillSetId: string }).skillSetId;

    // The store raises SkillRegistryError on purpose to stay free of HTTP concerns. This assertion
    // only holds because the service translates it, which is why a stale write is a conflict the
    // control plane can map rather than an error that escapes unhandled.
    await expect(controls.execute(request('skill_set_update', { skillSetId, name: 'renamed', expectedGeneration: 99 })))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await expect(controls.execute(request('skill_set_delete', { skillSetId, expectedGeneration: 99 })))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    // The same requests at the current generation succeed, so the guard rejects stale writes only.
    const updated = await controls.execute(request('skill_set_update', { skillSetId, name: 'renamed', expectedGeneration: 1 }));
    expect(updated.ok).toBe(true);
    const read = await controls.execute(request('skill_set_get', { skillSetId }));
    expect((read.data as { name: string }).name).toBe('renamed');

    await expect(controls.execute(request('skill_set_delete', { skillSetId, expectedGeneration: 2 })))
      .resolves.toMatchObject({ ok: true });
  });

  it('reports a missing skill as not found rather than as an internal error', async () => {
    const { controls } = setup();
    await expect(controls.execute(request('skill_get', { skillId: `sk_${'a'.repeat(24)}` })))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(controls.execute(request('skill_import_status', { jobId: `skjob_${'a'.repeat(24)}` })))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
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

    const globalListed = await controls.execute(request('global_secret_list', {}));
    expect(globalListed.data).toEqual({ secrets: [], readiness: { ready: false, error: 'secret keyring is unavailable' } });
    await expect(controls.execute(request('global_secret_create', {
      name: 'GLOBAL_TOKEN', value: 'not-persisted', expectedGeneration: 0
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
    const verifier = { verifyInstallation: async (id: string) => ({ appId: '1', installationId: id, accountId: id, accountLogin: `org-${id}`, issues: null, pullRequests: null, status: 'active' as const, repositories: [] }) };
    const binding = new GitHubBindingService(new GitHubSetupStateStore(principals.database), store, verifier);
    const githubControls = new DashboardControlService(
      { artifactRetentionSeconds: 60, githubApp: { appSlug: 'test-app', appId: 1 } } as RunnerConfig,
      principals, metadata, artifacts, workspaces, store, binding
    );

    const principalId = principals.resolvePrincipal(principal);
    store.replaceVerified(principalId, {
      appId: 1, installationId: 101, accountId: 201, accountLogin: 'org-one', issues: null, pullRequests: null, status: 'active',
      repositories: [{ owner: 'org-one', repository: 'repo1', contents: 'write' }]
    }, 100);
    store.replaceVerified(principalId, {
      appId: 1, installationId: 102, accountId: 202, accountLogin: 'org-two', issues: null, pullRequests: null, status: 'active',
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

describe('dashboard managed packages', () => {
  const packageLimits = { maxBindings: 32, maxOwnerBytes: 4_294_967_296, maxReleaseBytes: 536_870_912, minFreeBytes: 0 };
  const runtime = { imageId: 'sha256:executor-image', node: 'v24.11.0', npm: '11.6.0', uv: null, python: null };

  function packagesSetup() {
    const context = setup(true, (root) => ({
      authMode: 'cloudflare-access', packagesEnabled: true, packagesApprovalMode: 'required', packagesEcosystems: ['npm', 'uv'],
      packagesNpmLifecycleScripts: 'deny', packagesMaxReleaseBytes: 536_870_912, packagesMaxOwnerBytes: 4_294_967_296,
      packagesMaxBindings: 32, packagesRoot: join(root, 'packages')
    }));
    const packagesRoot = join(context.root, 'packages');
    const store = new PackageStore(context.principals.database, (...args) => context.metadata.recordAuditInTransaction(...args));
    const ownerId = context.principals.resolvePrincipal(principal);
    const plan = (owner: string, version: string, approvalMode: 'required' | 'none' = 'required', now = Date.now(), lifecycleScripts = false) => store.createPlan({
      ownerId: owner, scope: 'owner', workspaceId: null, ecosystem: 'npm', packageName: 'chm-hello', version,
      requestedSpec: version, lockText: '{"lockfileVersion":3}', approvalMode, now,
      content: {
        source: { registry: 'https://registry.npmjs.org/', resolved: `https://registry.npmjs.org/chm-hello/-/chm-hello-${version}.tgz` },
        integrity: 'sha512-abc', dependencyCount: 2, sizeEstimateBytes: 8_192, binaries: ['hello'], conflicts: [],
        lifecycleScripts, runtime
      }
    });
    /** Drives a plan through a successful apply and puts its release tree on disk. */
    const install = (version: string) => {
      const approved = plan(ownerId, version, 'none');
      const { apply } = store.startApply({ ownerId, planId: approved.id, planDigest: approved.digest, now: Date.now(), limits: packageLimits });
      for (const step of ['BUILDING', 'VERIFYING', 'PUBLISHING'] as const) store.advanceApply(apply.id, step, { now: Date.now() });
      const published = store.publish(apply.id, {
        treeDigest: createHash('sha256').update(approved.id).digest('hex'), sizeBytes: 2_048, fileCount: 4, binaries: ['hello'],
        runtime, provenance: { registry: 'https://registry.npmjs.org/' }, sbom: [{ name: 'chm-hello', version }]
      }, { now: Date.now() });
      mkdirSync(join(packagesRoot, published.release.relPath), { recursive: true });
      return published;
    };
    return { ...context, store, ownerId, plan, install, packagesRoot };
  }

  it('answers an empty overview and refuses every decision while the feature is off', async () => {
    const { controls, metadata, principals } = setup(true, { packagesEnabled: false, packagesApprovalMode: 'required' });
    const overview = await controls.execute(request('package_overview', {}));
    expect(overview.data).toMatchObject({ enabled: false, bindings: [], releases: [], inFlight: [], recentApplies: [], pendingPlans: [] });
    const plans = await controls.execute(request('package_plan_list', {}));
    expect(plans.data).toMatchObject({ enabled: false, plans: [] });
    const planId = `pkp_${'a'.repeat(24)}`;
    for (const [operation, input] of [
      ['package_plan_approve', { planId, planDigest: 'a'.repeat(64) }],
      ['package_plan_reject', { planId }],
      ['package_rollback', { bindingId: `pkb_${'a'.repeat(24)}`, releaseId: `pkr_${'a'.repeat(24)}`, expectedGeneration: 1 }]
    ] as const) {
      await expect(controls.execute(request(operation, input))).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('PACKAGES_ENABLED=true') });
    }
    expect(metadata.listAudit(principals.resolvePrincipal(principal)).filter((event) => event.action.startsWith('package'))).toEqual([]);
  });

  it('approves only the digest the operator saw and records the dashboard decision', async () => {
    const { controls, plan, ownerId, metadata, store } = packagesSetup();
    const pending = plan(ownerId, '1.0.0', 'required', Date.now(), true);

    const listed = await controls.execute(request('package_plan_list', {}));
    const listedPlan = (listed.data as { plans: Record<string, unknown>[] }).plans[0];
    expect(listedPlan).toMatchObject({
      planId: pending.id, planDigest: pending.digest, status: 'PENDING_APPROVAL', lifecycleScripts: true,
      dependencyCount: 2, binaries: ['hello'], currentRelease: null, stale: false
    });
    expect(listedPlan).not.toHaveProperty('ownerId');
    expect(JSON.stringify(listed.data)).not.toContain(ownerId);

    await expect(controls.execute(request('package_plan_approve', { planId: pending.id, planDigest: 'f'.repeat(64) })))
      .rejects.toMatchObject({ code: 'STALE_GENERATION' });
    expect(store.getPlan(ownerId, pending.id)?.status).toBe('PENDING_APPROVAL');

    const approved = await controls.execute(request('package_plan_approve', { planId: pending.id, planDigest: pending.digest }));
    expect(approved.data).toMatchObject({ plan: { planId: pending.id, status: 'APPROVED', decidedBy: 'dashboard' } });
    expect(store.getPlan(ownerId, pending.id)).toMatchObject({ status: 'APPROVED', decidedBy: ownerId });
    expect(metadata.listAudit(ownerId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'package_plan.approved', subjectType: 'package_plan', subjectId: pending.id })
    ]));
  });

  it('hides a plan owned by another principal and refuses an expired plan', async () => {
    const { controls, plan, principals, store, ownerId } = packagesSetup();
    const foreignOwner = principals.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'operator-b' });
    const foreign = plan(foreignOwner, '1.0.0');
    await expect(controls.execute(request('package_plan_approve', { planId: foreign.id, planDigest: foreign.digest })))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(controls.execute(request('package_plan_reject', { planId: foreign.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.getPlan(foreignOwner, foreign.id)?.status).toBe('PENDING_APPROVAL');

    const expired = plan(ownerId, '1.0.0', 'required', Date.now() - 60 * 60_000);
    const listed = await controls.execute(request('package_plan_list', {}));
    expect((listed.data as { plans: { planId: string; status: string }[] }).plans.find((entry) => entry.planId === expired.id)?.status).toBe('EXPIRED');
    await expect(controls.execute(request('package_plan_approve', { planId: expired.id, planDigest: expired.digest })))
      .rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('rejects a pending plan with an audit row', async () => {
    const { controls, plan, ownerId, metadata, store } = packagesSetup();
    const pending = plan(ownerId, '1.0.0');
    const rejected = await controls.execute(request('package_plan_reject', { planId: pending.id }));
    expect(rejected.data).toMatchObject({ plan: { planId: pending.id, status: 'REJECTED', decidedBy: 'dashboard' } });
    expect(store.getPlan(ownerId, pending.id)?.status).toBe('REJECTED');
    expect(metadata.listAudit(ownerId).some((event) => event.action === 'package_plan.rejected' && event.subjectId === pending.id)).toBe(true);
  });

  it('summarizes installed releases, history, applies, quotas, and pending plans', async () => {
    const { controls, install, plan, ownerId } = packagesSetup();
    install('1.0.0');
    const second = install('1.1.0');
    const pending = plan(ownerId, '1.2.0');

    const overview = await controls.execute(request('package_overview', {}));
    const data = overview.data as {
      bindings: { history: { version: string; available: boolean }[] }[];
      releases: unknown[]; recentApplies: { state: string; name: string }[];
    };
    expect(overview.data).toMatchObject({
      enabled: true, approvalMode: 'required', ecosystems: ['npm', 'uv'], quotas: { maxBindings: 32 },
      usage: { ownerBytes: 4_096, bindings: 1 },
      bindings: [{ bindingId: second.binding.id, generation: 2, release: { version: '1.1.0', status: 'VERIFIED' } }],
      pendingPlans: [{ planId: pending.id, currentRelease: { version: '1.1.0' } }]
    });
    expect(data.bindings[0].history.map((entry) => [entry.version, entry.available])).toEqual([['1.1.0', true], ['1.0.0', true]]);
    expect(data.releases).toHaveLength(2);
    expect(data.recentApplies.map((apply) => [apply.state, apply.name])).toEqual([['SUCCEEDED', 'chm-hello'], ['SUCCEEDED', 'chm-hello']]);
    expect(JSON.stringify(overview.data)).not.toContain(ownerId);
    expect(JSON.stringify(overview.data)).not.toContain('releases/');
    expect((overview.data as { releases: { stale: boolean }[] }).releases.map((release) => release.stale)).toEqual([false, false]);

    currentPackageImageId = 'sha256:newer-executor-image';
    const afterRedeploy = await controls.execute(request('package_overview', {}));
    expect((afterRedeploy.data as { releases: { stale: boolean }[] }).releases.map((release) => release.stale)).toEqual([true, true]);
    currentPackageImageId = 'sha256:executor-image';
  });

  it('rolls back from the dashboard and refuses a stale generation or a release that left the disk', async () => {
    const { controls, install, ownerId, metadata, store, packagesRoot } = packagesSetup();
    const first = install('1.0.0');
    const second = install('1.1.0');
    const bindingId = second.binding.id;

    await expect(controls.execute(request('package_rollback', { bindingId, releaseId: first.release.id, expectedGeneration: 1 })))
      .rejects.toMatchObject({ code: 'STALE_GENERATION' });
    await expect(controls.execute(request('package_rollback', { bindingId, releaseId: second.release.id, expectedGeneration: 2 })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(controls.execute(request('package_rollback', { bindingId: `pkb_${'z'.repeat(24)}`, releaseId: first.release.id, expectedGeneration: 2 })))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    rmSync(join(packagesRoot, first.release.relPath), { recursive: true, force: true });
    await expect(controls.execute(request('package_rollback', { bindingId, releaseId: first.release.id, expectedGeneration: 2 })))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('no longer available') });
    mkdirSync(join(packagesRoot, first.release.relPath), { recursive: true });

    const rolled = await controls.execute(request('package_rollback', { bindingId, releaseId: first.release.id, expectedGeneration: 2 }));
    expect(rolled.data).toMatchObject({ binding: { bindingId, generation: 3, releaseId: first.release.id }, replayed: false });
    expect(store.history(ownerId, bindingId)[0]).toMatchObject({ reason: 'rollback', actor: 'dashboard', releaseId: first.release.id });
    expect(metadata.listAudit(ownerId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'package.rollback', subjectId: bindingId, subjectGeneration: 3 })
    ]));
  });
});

function omitKeys<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

describe('dashboard model profile validation and audit', () => {
  const SENTINEL_KEY = 'sk-sentinel-profile-key-0123456789abcdef';
  const CATALOG_MODEL = 'vendor/catalog-model';
  const sse = (events: unknown[]) => [...events.map((event) => `data: ${JSON.stringify(event)}`), 'data: [DONE]', ''].join('\n\n');

  function modelSetup() {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-model-controls-')); roots.push(root);
    const databasePath = join(root, 'state.db');
    const principals = new StateStore(databasePath);
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const metadata = new MetadataStore(databasePath, keyring);
    cleanups.push(() => { metadata.database.close(); principals.close(); });
    const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
    const repo = new ModelProfileStateRepository(principals.database, keyring);
    const requests: string[] = [];
    const http: ProviderHttpClient = {
      async request(request) {
        requests.push(request.url);
        const reply = (body: string) => {
          if (request.onLine) for (const line of body.split('\n')) request.onLine(line);
          return { status: 200, headers: {}, body, truncated: false };
        };
        if (request.url === 'https://openrouter.ai/api/v1/models') {
          return reply(JSON.stringify({ data: [{ id: CATALOG_MODEL, name: 'Catalog model', pricing: { prompt: '0.000003', completion: '0.000015' } }] }));
        }
        if (request.url.endsWith('/v1/models')) return reply(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
        return reply(sse([
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }
        ]));
      }
    };
    const controls = new DashboardControlService(
      { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
      undefined, undefined, repo, undefined, keyring, undefined, http
    );
    const ownerA = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
    const ownerB = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-b' };
    const call = async <T>(operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>, principal = ownerA) =>
      (await controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest)).data as T;
    const validate = async (input: Record<string, unknown>, principal = ownerA) =>
      ModelProfileValidateResultSchema.parse(await call<ModelProfileValidateResult>('model_profile_validate', input, principal));
    const principalA = principals.resolvePrincipal(ownerA);
    const profileAudit = () => metadata.listAudit(principalA, 100).filter((event) => event.action.startsWith('model_'));
    const rows = () => ({
      profiles: (principals.database.prepare('SELECT count(*) AS count FROM agent_model_profiles').get() as { count: number }).count,
      revisions: (principals.database.prepare('SELECT count(*) AS count FROM agent_model_profile_revisions').get() as { count: number }).count,
      audit: (principals.database.prepare('SELECT count(*) AS count FROM audit_events').get() as { count: number }).count
    });
    const credential = async (provider: 'openai' | 'openrouter' | 'custom', principal = ownerA) =>
      (await call<{ id: string }>('model_credential_create', { label: provider, provider, apiKey: SENTINEL_KEY }, principal)).id;
    return { call, validate, profileAudit, rows, credential, requests, ownerB };
  }

  const LIMITS = { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 };
  const body = (credentialId: string, profileId = 'coding', extra: Record<string, unknown> = {}) => ({
    profileId, displayName: 'Coding', credentialId, model: 'gpt-test', apiMode: 'chat-completions',
    pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 },
    limits: LIMITS, maxProxyOperations: ['files_read'], ...extra
  });

  it('dry-runs a create without writing, auditing, or calling a provider', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('openai');
    const before = ctx.rows();
    const result = await ctx.validate({ action: 'create', ...body(credentialId) });
    expect(result).toMatchObject({
      valid: true, action: 'create', profileId: 'coding', issues: [], escalations: [], ownerApprovalRequiredOverMcp: false,
      statusAfterSaveOverMcp: 'DISABLED', currentGeneration: null, verificationAttachable: false,
      revision: {
        credentialId, provider: 'openai', model: 'gpt-test', apiMode: 'chat-completions', upstreamUrl: 'https://api.openai.com/v1/chat/completions',
        limits: LIMITS, maxProxyOperations: ['files_read'], priceProvenance: { source: 'user', isOverride: true }
      },
      pricingReview: { state: 'unknown' }
    });
    expect(ctx.rows()).toEqual(before);
    expect(ctx.requests).toEqual([]);
  });

  it('reports the revision the save then writes, and reviews an update against the cached catalog', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('openrouter');
    await ctx.call('model_catalog_search', { provider: 'openrouter', query: 'catalog' });
    const catalogPricing = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 };
    const input = body(credentialId, 'catalog', { model: CATALOG_MODEL, pricing: catalogPricing, catalogPriceRef: { sourceModelId: CATALOG_MODEL } });
    const planned = await ctx.validate({ action: 'create', ...input });
    const saved = await ctx.call<AgentModelProfileMetadata>('model_profile_create', input);
    const written = omitKeys(saved.activeRevision!, ['id', 'profileId', 'principalId', 'downstreamPath', 'digest', 'createdAt']);
    expect({ ...written, provider: 'openrouter' }).toEqual(planned.revision);
    expect(planned.revision?.priceProvenance).toMatchObject({ source: 'openrouter', isOverride: false });

    const requestsBefore = ctx.requests.length;
    const update = await ctx.validate({ action: 'update', profileId: 'catalog', expectedGeneration: saved.generation, limits: { ...LIMITS, maxCostMicros: 500_000 } });
    expect(update).toMatchObject({ valid: true, statusAfterSaveOverMcp: 'unchanged', currentGeneration: 1, escalations: [], pricingReview: { state: 'current', isOverride: false } });
    expect(ctx.requests).toHaveLength(requestsBefore);
  });

  it('reports refusals as issues', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('openai');
    await ctx.call('model_profile_create', body(credentialId));

    const unknownCredential = await ctx.validate({ action: 'create', ...body('cred_00000000000000000000000000000000', 'other') });
    expect(unknownCredential).toMatchObject({ valid: false, revision: null, pricingReview: null, issues: [{ code: 'NOT_FOUND', message: 'referenced credential was not found' }] });
    const stale = await ctx.validate({ action: 'update', profileId: 'coding', expectedGeneration: 5, model: 'gpt-other' });
    expect(stale).toMatchObject({ valid: false, action: 'update', issues: [{ code: 'CONFLICT' }] });
    const customUrl = await ctx.validate({ action: 'create', ...body(credentialId, 'other', { customUpstreamUrl: 'https://llm.example.org/v1/chat/completions' }) });
    expect(customUrl.issues).toEqual([{ code: 'INVALID_INPUT', message: 'customUpstreamUrl applies only to the custom provider' }]);
    const taken = await ctx.validate({ action: 'create', ...body(credentialId) });
    expect(taken.issues[0]?.code).toBe('CONFLICT');

    // Another principal cannot see that the profile exists.
    await ctx.credential('openai', ctx.ownerB);
    const foreign = await ctx.validate({ action: 'update', profileId: 'coding', expectedGeneration: 1 }, ctx.ownerB);
    expect(foreign.issues).toEqual([{ code: 'NOT_FOUND', message: 'model profile was not found' }]);

    // A body the schema refuses is still an operation error, not an issue.
    await expect(ctx.call('model_profile_validate', { action: 'create', ...body(credentialId, 'x'), unknownField: true })).rejects.toThrow();
    await expect(ctx.call('model_profile_validate', { action: 'delete', profileId: 'coding' })).rejects.toThrow();
  });

  it('reports escalations to every caller, and the Dashboard still saves them', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('openai');
    const saved = await ctx.call<AgentModelProfileMetadata>('model_profile_create', body(credentialId));
    const change = {
      action: 'update', profileId: 'coding', expectedGeneration: saved.generation, model: 'gpt-other',
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { ...LIMITS, maxCostMicros: LIMITS.maxCostMicros + 1 }, maxProxyOperations: ['files_read', 'grep_search']
    };
    const result = await ctx.validate(change);
    expect(result.escalations).toEqual(['limits_raised', 'price_lowered', 'price_unverified_for_new_route', 'proxy_operations_widened']);
    expect(result.ownerApprovalRequiredOverMcp).toBe(true);
    const updated = await ctx.call<AgentModelProfileMetadata>('model_profile_update', omitKeys(change, ['action']));
    expect(updated.generation).toBe(2);

    const customId = await ctx.credential('custom');
    const unbound = await ctx.validate({ action: 'create', ...body(customId, 'custom', { customUpstreamUrl: 'https://llm.example.org/v1/chat/completions' }) });
    expect(unbound.escalations).toEqual(['custom_upstream_unbound']);
  });

  it('peeks at a draft check so the save that follows still keeps it', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('openai');
    const draft = await ctx.call<ModelConnectionVerifyResult>('model_connection_verify', { credentialId, model: 'gpt-test' });
    const input = body(credentialId, 'coding', { verificationRef: draft.verificationRef });
    expect((await ctx.validate({ action: 'create', ...input })).verificationAttachable).toBe(true);
    expect((await ctx.validate({ action: 'create', ...input, model: 'gpt-other' })).verificationAttachable).toBe(false);
    const saved = await ctx.call<AgentModelProfileMetadata>('model_profile_create', input);
    expect(saved.lastVerification).toMatchObject({ outcome: 'verified', revisionId: saved.activeRevisionId });
  });

  it('audits each Dashboard profile change once with the actor, and never a key', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('custom');
    const customUrl = `https://llm.example.org/v1/${SENTINEL_KEY.slice(3, 12)}/chat/completions`;
    const created = await ctx.call<AgentModelProfileMetadata>('model_profile_create', body(credentialId, 'coding', { customUpstreamUrl: customUrl }));
    const updated = await ctx.call<AgentModelProfileMetadata>('model_profile_update', { profileId: 'coding', expectedGeneration: created.generation, limits: { ...LIMITS, maxCostMicros: 2_000_000 } });
    const disabled = await ctx.call<AgentModelProfileMetadata>('model_profile_disable', { profileId: 'coding', expectedGeneration: updated.generation });
    const activated = await ctx.call<AgentModelProfileMetadata>('model_profile_activate', { profileId: 'coding', expectedGeneration: disabled.generation });
    await ctx.call('model_profile_delete', { profileId: 'coding', expectedGeneration: activated.generation });
    // A validation is a read and records nothing.
    await ctx.validate({ action: 'create', ...body(credentialId, 'unsaved', { customUpstreamUrl: customUrl }) });
    // A refused save records nothing either.
    await expect(ctx.call('model_profile_update', { profileId: 'coding', expectedGeneration: 1 })).rejects.toThrow();

    const events = ctx.profileAudit().filter((event) => event.action.startsWith('model_profile.')).reverse();
    expect(events.map((event) => [event.action, event.subjectId, event.subjectGeneration])).toEqual([
      ['model_profile.created', 'coding', 1],
      ['model_profile.updated', 'coding', 2],
      ['model_profile.disabled', 'coding', 3],
      ['model_profile.activated', 'coding', 4],
      ['model_profile.deleted', 'coding', 4]
    ]);
    for (const event of events) {
      expect(event.details).toMatchObject({ actor: 'dashboard', credentialId, provider: 'custom', upstreamHost: 'llm.example.org', apiMode: 'chat-completions' });
    }
    expect(events[1]?.details).toMatchObject({ maxCostMicros: 2_000_000, priceSource: 'user', isOverride: true, revisionId: updated.activeRevisionId });
    const serialized = JSON.stringify(ctx.profileAudit());
    expect(serialized).not.toContain(SENTINEL_KEY);
    expect(serialized).not.toContain(SENTINEL_KEY.slice(3, 12));
    expect(serialized).not.toContain('3000000');
  });

  it('names the Dashboard as the actor of a connection check', async () => {
    const ctx = modelSetup();
    const credentialId = await ctx.credential('openai');
    await ctx.call('model_connection_verify', { credentialId, model: 'gpt-test' });
    const [event] = ctx.profileAudit().filter((entry) => entry.action === 'model_connection.verified');
    expect(event?.details).toMatchObject({ actor: 'dashboard', target: 'draft' });
    expect(JSON.stringify(event)).not.toContain(SENTINEL_KEY);
  });
});
