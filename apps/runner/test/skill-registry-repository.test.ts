import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-skill-registry-${randomBytes(8).toString('hex')}.sqlite`);
const STAMP = 1_700_000_000_000;
const OWNER = 'p_owner';
const OTHER_OWNER = 'p_other';
const hash = (char: string) => char.repeat(64);

function openStore(): StateStore {
  const store = new StateStore(tempDbPath());
  const insertPrincipal = store.database.prepare(
    'INSERT OR IGNORE INTO principals (id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertPrincipal.run(OWNER, 'https://auth.example.com', OWNER, STAMP, STAMP);
  insertPrincipal.run(OTHER_OWNER, 'https://auth.example.com', OTHER_OWNER, STAMP, STAMP);
  return store;
}

function addWorkspace(store: StateStore, ownerId: string, id: string, status: string): void {
  store.database.prepare(`
    INSERT INTO workspaces (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path,
      status, network_profile, created_at, last_activity_at, expires_at, generation, error, hard_expires_at)
    VALUES (?, ?, ?, 'https://github.com/example/repository.git', 'main', NULL, '/tmp/workspace', ?, 'network-none', ?, ?, ?, 1, NULL, ?)
  `).run(id, ownerId, `idem-${id}`, status, STAMP, STAMP, STAMP + 3_600_000, STAMP + 14_400_000);
}

function createSource(store: StateStore, slug = 'tdd') {
  return store.createSkillSource({
    ownerId: OWNER,
    slug,
    displayName: 'TDD',
    kind: 'owner',
    provider: 'custom',
    tags: ['testing'],
    revision: { bundleSha256: hash('a'), contentSha256: hash('b'), hasExecutableAssets: true }
  });
}

describe('skill registry repository', () => {
  it('keeps one owner from reading or writing another owner\u2019s skills and sets', () => {
    const store = openStore();
    try {
      const { sourceId, revisionId } = createSource(store);
      const setId = store.createSkillSet({
        ownerId: OWNER,
        name: 'core',
        items: [{ skillSourceId: sourceId, revisionId, name: 'tdd' }]
      });

      // Reads. The assertion is on visibility rather than on the mechanism, so it holds whether a
      // cross-owner read throws or returns nothing.
      expect(store.listSkillSources(OWNER).filter((skill) => skill?.id === sourceId)).toHaveLength(1);
      expect(store.listSkillSources(OTHER_OWNER).filter((skill) => skill?.id === sourceId)).toEqual([]);
      expect(store.listSkillSets(OTHER_OWNER).filter((set) => set.id === setId)).toEqual([]);

      const crossOwnerSkill = (() => {
        try { return store.getSkillSource(OTHER_OWNER, sourceId); } catch { return undefined; }
      })();
      expect(crossOwnerSkill).toBeUndefined();

      const crossOwnerSet = (() => {
        try { return store.getSkillSet(OTHER_OWNER, setId); } catch { return undefined; }
      })();
      expect(crossOwnerSet).toBeUndefined();

      // Writes. A mutation addressed with the wrong owner must leave the real row untouched, whether
      // the guard refuses it or the scoped UPDATE simply matches nothing.
      try {
        store.updateSkillMetadata({ ownerId: OTHER_OWNER, id: sourceId, displayName: 'Hijacked', expectedGeneration: 1 });
      } catch { /* refusing is the expected path */ }
      try {
        store.setSkillState(OTHER_OWNER, sourceId, 'archived', 1);
      } catch { /* refusing is the expected path */ }
      try {
        store.deleteSkillSet(OTHER_OWNER, setId, 1);
      } catch { /* refusing is the expected path */ }

      const afterAttack = store.getSkillSource(OWNER, sourceId);
      expect(afterAttack?.displayName).toBe('TDD');
      expect(afterAttack?.state).toBe('enabled');
      expect(store.getSkillSet(OWNER, setId)?.name).toBe('core');
    } finally {
      store.close();
    }
  });
  it('creates a source with its first immutable revision and points the source at it', () => {
    const store = openStore();
    try {
      const { sourceId, revisionId } = createSource(store);
      const source = store.getSkillSource(OWNER, sourceId)!;
      expect(source.currentRevisionId).toBe(revisionId);
      expect(source.state).toBe('enabled');
      expect(source.generation).toBe(1);
      expect(source.tags).toEqual(['testing']);

      const revisions = store.listSkillRevisions(OWNER, sourceId);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.id).toBe(revisionId);
      expect(revisions[0]!.origin).toBe('import');
      expect(revisions[0]!.hasExecutableAssets).toBe(true);
      expect(revisions[0]!.parentRevisionId).toBeNull();
    } finally {
      store.close();
    }
  });

  it('appends a revision, bumps the generation, and repoints the current revision without mutating history', () => {
    const store = openStore();
    try {
      const { sourceId, revisionId } = createSource(store);
      const second = store.addSkillRevision({
        ownerId: OWNER,
        skillSourceId: sourceId,
        bundleSha256: hash('c'),
        contentSha256: hash('d'),
        hasExecutableAssets: false,
        origin: 'restore',
        parentRevisionId: revisionId,
        expectedGeneration: 1
      });
      const source = store.getSkillSource(OWNER, sourceId)!;
      expect(source.currentRevisionId).toBe(second);
      expect(source.generation).toBe(2);

      const revisions = store.listSkillRevisions(OWNER, sourceId);
      expect(revisions).toHaveLength(2);
      expect(revisions.find((revision) => revision.id === revisionId)!.contentSha256).toBe(hash('b'));
      expect(revisions.find((revision) => revision.id === second)!.parentRevisionId).toBe(revisionId);
    } finally {
      store.close();
    }
  });

  it('fences state changes and metadata edits on the expected generation and rejects illegal transitions', () => {
    const store = openStore();
    try {
      const { sourceId } = createSource(store);
      expect(store.setSkillState(OWNER, sourceId, 'disabled', 1)).toEqual({ state: 'disabled', generation: 2 });
      expect(() => store.setSkillState(OWNER, sourceId, 'enabled', 1)).toThrow(/expected 1/i);
      expect(store.setSkillState(OWNER, sourceId, 'enabled', 2)).toEqual({ state: 'enabled', generation: 3 });
      store.setSkillState(OWNER, sourceId, 'archived', 3);
      expect(() => store.setSkillState(OWNER, sourceId, 'enabled', 4)).toThrow(/cannot move skill/i);

      expect(() => store.updateSkillMetadata({ ownerId: OWNER, id: sourceId, expectedGeneration: 1, displayName: 'x' }))
        .toThrow(/expected 1/i);
      expect(store.updateSkillMetadata({ ownerId: OWNER, id: sourceId, expectedGeneration: 4, displayName: 'Renamed', tags: ['a', 'a', 'b'] }))
        .toEqual({ generation: 5 });
      const source = store.getSkillSource(OWNER, sourceId)!;
      expect(source.displayName).toBe('Renamed');
      expect(source.tags).toEqual(['a', 'b']);
    } finally {
      store.close();
    }
  });

  it('rejects tag payloads that are empty, over-long, or too numerous', () => {
    const store = openStore();
    try {
      const { sourceId } = createSource(store);
      expect(() => store.updateSkillMetadata({ ownerId: OWNER, id: sourceId, expectedGeneration: 1, tags: [''] })).toThrow(/1 to 32/);
      expect(() => store.updateSkillMetadata({ ownerId: OWNER, id: sourceId, expectedGeneration: 1, tags: ['x'.repeat(33)] })).toThrow(/1 to 32/);
      expect(() => store.updateSkillMetadata({
        ownerId: OWNER, id: sourceId, expectedGeneration: 1, tags: Array.from({ length: 17 }, (_, index) => `t${index}`)
      })).toThrow(/at most 16/);
    } finally {
      store.close();
    }
  });

  it('creates, version-fences, and deletes skill sets while a snapshot holds them', () => {
    const store = openStore();
    try {
      const { sourceId, revisionId } = createSource(store);
      const setId = store.createSkillSet({
        ownerId: OWNER,
        name: 'Core',
        items: [{ skillSourceId: sourceId, revisionId, name: 'tdd' }]
      });
      expect(store.getSkillSet(OWNER, setId)!.generation).toBe(1);

      expect(() => store.updateSkillSet({ ownerId: OWNER, id: setId, expectedGeneration: 9, name: 'x' })).toThrow(/expected 9/i);
      expect(store.updateSkillSet({
        ownerId: OWNER,
        id: setId,
        expectedGeneration: 1,
        items: [{ skillSourceId: sourceId, revisionId, name: 'tdd' }]
      })).toEqual({ generation: 2 });

      addWorkspace(store, OWNER, `ws_${'w'.repeat(24)}`, 'ACTIVE');
      store.recordWorkspaceSkillSelection({
        ownerId: OWNER,
        workspaceId: `ws_${'w'.repeat(24)}`,
        sets: [{ skillSetId: setId, skillSetGeneration: 2, snapshotSha256: hash('e') }],
        assignments: [{ name: 'tdd', skillSourceId: sourceId, revisionId, tier: 'owner', pinned: true }]
      });

      expect(() => store.deleteSkillSet(OWNER, setId, 2)).toThrow(/referenced by 1 workspace snapshot/i);
    } finally {
      store.close();
    }
  });

  it('reports which sets and live workspaces hold a skill, ignoring closed workspaces', () => {
    const store = openStore();
    try {
      const { sourceId, revisionId } = createSource(store);
      const setId = store.createSkillSet({
        ownerId: OWNER,
        name: 'Core',
        items: [{ skillSourceId: sourceId, revisionId, name: 'tdd' }]
      });
      const liveId = `ws_${'l'.repeat(24)}`;
      const closedId = `ws_${'c'.repeat(24)}`;
      addWorkspace(store, OWNER, liveId, 'ACTIVE');
      addWorkspace(store, OWNER, closedId, 'CLOSED');
      for (const workspaceId of [liveId, closedId]) {
        store.recordWorkspaceSkillSelection({
          ownerId: OWNER,
          workspaceId,
          sets: [],
          assignments: [{ name: 'tdd', skillSourceId: sourceId, revisionId, tier: 'owner', pinned: false }]
        });
      }

      const usage = store.listSkillUsage(OWNER, sourceId);
      expect(usage.sets).toEqual([{ skillSetId: setId, name: 'Core' }]);
      expect(usage.liveWorkspaces.map((entry) => entry.workspaceId)).toEqual([liveId]);
      expect(usage.liveWorkspaces[0]!.revisionId).toBe(revisionId);
    } finally {
      store.close();
    }
  });

  it('advances an import job to a terminal state exactly once and keeps it across a reopen', () => {
    const path = tempDbPath();
    const first = new StateStore(path);
    first.database.prepare('INSERT OR IGNORE INTO principals (id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(OWNER, 'https://auth.example.com', OWNER, STAMP, STAMP);
    const jobId = first.createSkillImportJob({ ownerId: OWNER, sourceKind: 'skills-sh', sourceRef: 'mattpocock/skills' });
    first.advanceSkillImportJob({ ownerId: OWNER, id: jobId, state: 'running', progressJson: '{"step":"fetch"}' });
    first.close();

    const second = new StateStore(path);
    try {
      expect(second.getSkillImportJob(OWNER, jobId)!.state).toBe('running');
      second.advanceSkillImportJob({ ownerId: OWNER, id: jobId, state: 'succeeded', resultJson: '{"count":1}' });
      expect(second.getSkillImportJob(OWNER, jobId)!.state).toBe('succeeded');
      expect(() => second.advanceSkillImportJob({ ownerId: OWNER, id: jobId, state: 'failed', errorCode: 'LATE' }))
        .toThrow(/terminal/i);
      expect(second.listSkillImportJobs(OWNER)).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('upserts catalog entries idempotently per provider slug and isolates owners', () => {
    const store = openStore();
    try {
      store.upsertSkillCatalogEntry({ ownerId: OWNER, provider: 'skills-sh', slug: 'mattpocock/skills', displayName: 'Skills' });
      store.upsertSkillCatalogEntry({ ownerId: OWNER, provider: 'skills-sh', slug: 'mattpocock/skills', displayName: 'Skills', description: 'updated' });
      const entries = store.listSkillCatalogEntries(OWNER, 'skills-sh');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe('updated');

      createSource(store, 'only-mine');
      expect(store.listSkillSources(OTHER_OWNER)).toHaveLength(0);
      expect(() => store.setSkillState(OTHER_OWNER, store.listSkillSources(OWNER)[0]!.id, 'disabled', 1))
        .toThrow(/not found for this owner/i);
    } finally {
      store.close();
    }
  });

  it('filters skill sources by state, kind, and provider', () => {
    const store = openStore();
    try {
      const { sourceId } = createSource(store, 'one');
      createSource(store, 'two');
      store.setSkillState(OWNER, sourceId, 'disabled', 1);
      expect(store.listSkillSources(OWNER, { state: 'disabled' }).map((source) => source.id)).toEqual([sourceId]);
      expect(store.listSkillSources(OWNER, { state: 'enabled' })).toHaveLength(1);
      expect(store.listSkillSources(OWNER, { provider: 'custom' })).toHaveLength(2);
      expect(store.listSkillSources(OWNER, { kind: 'registry' })).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
