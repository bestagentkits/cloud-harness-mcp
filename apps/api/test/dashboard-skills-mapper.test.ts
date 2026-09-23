import { describe, expect, it } from 'vitest';
import { mapDashboardData, type DashboardResponseOperation } from '../src/dashboard-response.js';

/** Every skills operation this phase exposes to the browser. */
const SKILL_OPERATIONS = [
  'skill_list', 'skill_get', 'skill_create_custom', 'skill_update', 'skill_archive', 'skill_restore', 'skill_bulk',
  'skill_usage', 'skill_search',
  'skill_import_start', 'skill_import_status', 'skill_import_cancel',
  'skill_revision_list', 'skill_revision_get', 'skill_revision_diff',
  'skill_set_list', 'skill_set_get', 'skill_set_create', 'skill_set_update', 'skill_set_delete', 'skill_set_preview',
  'toolkit_registry_list'
] as const satisfies readonly DashboardResponseOperation[];

/** One payload carrying every shape those operations can read, so each branch has something to project. */
const populated = {
  id: 'sk_1',
  name: 'tdd',
  slug: 'tdd',
  generation: 3,
  diff: 'a line of diff',
  skills: [{ id: 'sk_1', slug: 'tdd', state: 'enabled' }],
  revisions: [{ id: 'skrev_1', skillSourceId: 'sk_1' }],
  sets: [{ id: 'skset_1', name: 'core' }],
  items: [{ name: 'tdd', revisionId: 'skrev_1' }],
  results: [{ name: 'tdd', ok: true, skill: { id: 'sk_1' } }],
  local: [{ id: 'sk_1', slug: 'tdd' }],
  providers: [{ provider: 'skills-sh', status: 'ok' }],
  usages: [{ workspaceId: 'ws_1', name: 'tdd' }],
  resolved: [{ name: 'tdd', tier: 'owner', revisionId: 'skrev_1' }],
  excluded: [{ name: 'old', tier: 'owner', reason: 'disabled' }],
  conflicts: [{ name: 'dup', candidates: [] }],
  entries: [{ id: 'cat_1', provider: 'skills-sh', slug: 'tdd', displayName: 'TDD', description: 'catalog entry', fetchedAt: 1 }]
};

describe('skills dashboard mapping', () => {
  it('produces a non-empty projection for every exposed skills operation', () => {
    for (const operation of SKILL_OPERATIONS) {
      const mapped = mapDashboardData(operation, populated);
      expect(mapped, operation).toBeTruthy();
      expect(typeof mapped, operation).toBe('object');
      expect(Object.keys(mapped as Record<string, unknown>).length, operation).toBeGreaterThan(0);
    }
  });

  it('projects only allowlisted keys and drops owner identifiers', () => {
    const mapped = mapDashboardData('skill_get', {
      id: 'sk_1',
      slug: 'tdd',
      ownerId: 'own_secret',
      providerToken: 'leak',
      internalPath: '/var/lib/cloud-harness/cache'
    }) as Record<string, unknown>;

    expect(mapped.id).toBe('sk_1');
    expect(mapped.slug).toBe('tdd');
    expect(mapped.ownerId).toBeUndefined();
    expect(mapped.providerToken).toBeUndefined();
    expect(mapped.internalPath).toBeUndefined();
  });

  it('passes a declared skill version through and never invents one', () => {
    // The version lives on the revision and is joined into the source projection, so it has to survive
    // the allowlist. A dropped key would render an empty Version column rather than an error.
    const declared = mapDashboardData('skill_get', { id: 'sk_1', slug: 'tdd', version: '1.2.3' }) as Record<string, unknown>;
    expect(declared.version).toBe('1.2.3');

    // A skill that declares nothing must stay absent, so the UI shows its own empty state.
    const undeclared = mapDashboardData('skill_get', { id: 'sk_2', slug: 'plain' }) as Record<string, unknown>;
    expect(undeclared.version).toBeUndefined();

    const revisions = mapDashboardData('skill_revision_list', {
      revisions: [
        { id: 'skrev_one', origin: 'edit', version: '2.0.0' },
        { id: 'skrev_two', origin: 'import' }
      ]
    }) as { revisions?: Record<string, unknown>[] };
    expect(revisions.revisions?.[0]?.version).toBe('2.0.0');
    expect(revisions.revisions?.[1]?.version).toBeUndefined();
  });

  it('carries the registry fields a row is read for instead of dropping them at the API boundary', () => {
    const mapped = mapDashboardData('toolkit_registry_list', {
      entries: [{
        id: 'tkc_registry', provider: 'skills-sh', slug: 'anthropics/skills', displayName: 'anthropics/skills',
        description: '', fetchedAt: 1, cacheState: 'READY', pinnedCommit: 'a'.repeat(40), skillCount: 3,
        lockState: 'locked', ownerId: 'own_secret'
      }],
      presets: []
    }) as { entries: Array<Record<string, unknown>> };

    // The allowlist is what the browser can see, so a field missing here is a field the tab cannot render
    // even when the runner sends it, which is how the four registry fields were lost before.
    expect(mapped.entries[0]).toMatchObject({
      cacheState: 'READY',
      pinnedCommit: 'a'.repeat(40),
      skillCount: 3,
      lockState: 'locked'
    });
    expect(mapped.entries[0].ownerId).toBeUndefined();
  });

  it('carries both places a skill is in use instead of reading a key the reader never sends', () => {
    const mapped = mapDashboardData('skill_usage', {
      sets: [{ skillSetId: 'skset_1', name: 'Backend', ownerId: 'own_secret' }],
      liveWorkspaces: [{ workspaceId: 'ws_1', status: 'ACTIVE', name: 'fix-auth', revisionId: 'skrev_1', ownerId: 'own_secret' }]
    }) as Record<string, unknown>;

    expect(mapped.sets).toEqual([{ skillSetId: 'skset_1', name: 'Backend' }]);
    expect(mapped.liveWorkspaces).toEqual([
      { workspaceId: 'ws_1', status: 'ACTIVE', name: 'fix-auth', revisionId: 'skrev_1' }
    ]);
    // The reader answers with these two collections and has never produced a `usages` key, so a
    // projection that still read one would report every skill as unused.
    expect(mapped.usages).toBeUndefined();
  });

  it('passes a revision diff through only when the runner sent a string', () => {
    const withString = mapDashboardData('skill_revision_diff', { id: 'skrev_1', diff: 'line' }) as Record<string, unknown>;
    expect(withString.diff).toBe('line');

    const withObject = mapDashboardData('skill_revision_diff', { id: 'skrev_1', diff: { not: 'text' } }) as Record<string, unknown>;
    expect(withObject.diff).toBeUndefined();
  });

  it('reports per-item bulk outcomes without leaking the whole record', () => {
    const mapped = mapDashboardData('skill_bulk', {
      results: [
        { name: 'ok-skill', ok: true, skill: { id: 'sk_1', ownerId: 'own_secret' } },
        { name: 'bad-skill', ok: false, error: 'CONFLICT' }
      ]
    }) as { results: Record<string, unknown>[] };

    expect(mapped.results).toHaveLength(2);
    expect(mapped.results[0]).toEqual({ name: 'ok-skill', ok: true, skill: { id: 'sk_1' } });
    expect(mapped.results[1]).toEqual({ name: 'bad-skill', ok: false, error: 'CONFLICT' });
  });

  it('keeps search provider warnings so a degraded provider is visible instead of silent', () => {
    const mapped = mapDashboardData('skill_search', {
      local: [{ id: 'sk_1', slug: 'tdd' }],
      providers: [{ provider: 'skillx', status: 'timeout', warning: 'SkillX timed out', count: 0 }]
    }) as { local: unknown[]; providers: Record<string, unknown>[] };

    expect(mapped.local).toHaveLength(1);
    expect(mapped.providers[0]).toMatchObject({ provider: 'skillx', status: 'timeout', warning: 'SkillX timed out' });
  });

  it('always emits the three preview collections even when the runner sends nothing', () => {
    const mapped = mapDashboardData('skill_set_preview', { generation: 7 }) as Record<string, unknown>;
    expect(mapped).toMatchObject({ generation: 7, resolved: [], excluded: [], conflicts: [] });
  });
});
