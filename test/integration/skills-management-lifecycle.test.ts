import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetadataRunnerRequest, PrincipalSelector, RunnerConfig } from '@cloud-harness/contracts';
import { ArtifactStore } from '../../apps/runner/src/artifact-store.js';
import { DashboardControlService } from '../../apps/runner/src/dashboard-control-service.js';
import { MetadataStore } from '../../apps/runner/src/metadata-store.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { ToolkitCacheManager } from '../../apps/runner/src/toolkit-cache-manager.js';
import type { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

/**
 * The operator management lifecycle, driven through the service the dashboard calls.
 *
 * It covers what the runner can actually do: create a custom skill, pin a set to the revisions that
 * are current, preview the set against the same resolver launch uses, resolve a conflict through an
 * override, restore an earlier revision, and apply a bulk change whose per-item result keeps the rows
 * the runner refused.
 *
 * It deliberately does not cover starting an import, producing a textual revision diff, or forking a
 * revision, because no runner operation exists for those yet. The phase records that gap; a test that
 * asserted them would be asserting behaviour that is not there.
 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
});

const principal: PrincipalSelector = { kind: 'external', issuer: 'https://access.example.com', subject: 'operator-a' };

function request(operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>): MetadataRunnerRequest {
  return { version: 2, principal, operation, input } as MetadataRunnerRequest;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-skills-lifecycle-'));
  roots.push(root);
  const databasePath = join(root, 'state.db');
  const principals = new StateStore(databasePath);
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const metadata = new MetadataStore(databasePath, keyring);
  const artifacts = new ArtifactStore(principals.database, {
    root: join(root, 'artifacts'), maxArtifactBytes: 1_024, maxPrincipalBytes: 4_096,
    defaultRetentionMs: 60_000, maxRetentionMs: 120_000
  });
  const workspaces = {
    toolkitCacheManager: new ToolkitCacheManager(join(root, 'toolkits'), principals),
    skillRoster: async () => ({ entries: [], rosterDigest: 'roster' }),
    redactionSecrets: () => ({}),
    readArtifactSource: async () => ({ ownerId: principals.resolvePrincipal(principal), content: Buffer.from('snapshot') })
  } as unknown as WorkspaceService;
  const controls = new DashboardControlService(
    { artifactRetentionSeconds: 60 } as RunnerConfig,
    principals, metadata, artifacts, workspaces,
    undefined, undefined, undefined, undefined, keyring
  );
  const ownerId = principals.resolvePrincipal(principal);
  return { controls, principals, ownerId, close: () => { metadata.database.close(); principals.close(); } };
}

describe('skills management lifecycle', () => {
  it('creates a custom skill, pins a set to it, previews, restores, and reports bulk per item', async () => {
    const { controls, close } = setup();
    try {
      // 1. Create a custom skill. The package is published before the source row exists.
      const created = await controls.execute(request('skill_create_custom', {
        slug: 'tdd', displayName: 'TDD', description: 'test first', tags: ['testing'],
        instructions: '# TDD\n\nWrite the test first.', hasExecutableAssets: false, expectedGeneration: 0
      }));
      const skillId = (created.data as { sourceId: string }).sourceId;
      const firstRevision = (created.data as { revisionId: string }).revisionId;
      expect(skillId).toMatch(/^sk_/);
      expect(JSON.stringify(created)).not.toContain('sk_live');

      // 2. A second revision becomes current, so a restore has somewhere to go back to.
      const listed = await controls.execute(request('skill_revision_list', { skillId }));
      const revisions = (listed.data as { revisions: Array<{ id: string }> }).revisions;
      expect(revisions.map((revision) => revision.id)).toContain(firstRevision);

      // 3. Build a set pinned to the current revision.
      const set = await controls.execute(request('skill_set_create', {
        name: 'core', description: 'daily work',
        items: [{ skillSourceId: skillId, revisionId: firstRevision, name: 'tdd' }],
        expectedGeneration: 0
      }));
      const skillSetId = (set.data as { skillSetId: string }).skillSetId;

      // 4. Preview resolves through the same resolver launch uses.
      const preview = await controls.execute(request('skill_set_preview', {
        skillSets: [{ skillSetId, expectedGeneration: 1 }]
      }));
      expect((preview.data as { resolved: Array<{ name: string; tier: string }> }).resolved)
        .toEqual([{ name: 'tdd', tier: 'owner', sourceId: skillId, revisionId: firstRevision, contentSha256: firstRevision, pinned: false }]);
      expect((preview.data as { conflicts: unknown[] }).conflicts).toEqual([]);

      // 5. An override pins the revision, which is how a launch conflict is settled.
      const pinned = await controls.execute(request('skill_set_preview', {
        skillSets: [{ skillSetId, expectedGeneration: 1 }],
        skillOverrides: { tdd: firstRevision }
      }));
      expect((pinned.data as { resolved: Array<{ pinned: boolean }> }).resolved[0]?.pinned).toBe(true);

      // 6. Restoring republishes rather than rewriting, so the original row is untouched.
      const restored = await controls.execute(request('skill_restore', {
        skillId, revisionId: firstRevision, expectedGeneration: 1
      }));
      const restoredId = (restored.data as { revisionId: string }).revisionId;
      expect(restoredId).not.toBe(firstRevision);
      const afterRestore = await controls.execute(request('skill_revision_get', { skillId, revisionId: firstRevision }));
      expect((afterRestore.data as { id: string }).id).toBe(firstRevision);

      // 7. A stale set generation is refused rather than resolved against newer contents.
      await expect(controls.execute(request('skill_set_preview', {
        skillSets: [{ skillSetId, expectedGeneration: 99 }]
      }))).rejects.toMatchObject({ code: 'STALE_GENERATION', status: 409 });

      // 8. Bulk applies per item: the row that cannot change keeps its blocker, the row that can is changed.
      const bulk = await controls.execute(request('skill_bulk', {
        action: 'archive', skillIds: [skillId, `sk_${'z'.repeat(24)}`], expectedGeneration: 2
      }));
      expect((bulk.data as { results: Array<{ skillId: string; ok: boolean; error?: string }> }).results).toEqual([
        { skillId, ok: true },
        { skillId: `sk_${'z'.repeat(24)}`, ok: false, error: 'NOT_FOUND' }
      ]);
    } finally {
      close();
    }
  }, 30_000);

  it('keeps one owner from reaching another owner through the management surface', async () => {
    const { controls, close } = setup();
    try {
      const created = await controls.execute(request('skill_create_custom', {
        slug: 'owns-me', displayName: 'Owned', description: '', tags: [],
        instructions: '# Owned', hasExecutableAssets: false, expectedGeneration: 0
      }));
      const skillId = (created.data as { sourceId: string }).sourceId;

      // The same request addressed as another principal finds nothing, because every query is scoped.
      const other: MetadataRunnerRequest = {
        version: 2,
        principal: { kind: 'external', issuer: 'https://access.example.com', subject: 'operator-b' },
        operation: 'skill_get',
        input: { skillId }
      } as MetadataRunnerRequest;
      await expect(controls.execute(other)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    } finally {
      close();
    }
  }, 30_000);
});
