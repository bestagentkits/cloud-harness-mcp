import { describe, expect, it } from 'vitest';
import { bindingFenced, bindingRisks, packageChangeCopy, packageChangeRequest, packagesOverviewOf, releaseHealth, workspaceCount } from './packages-model';

const BODY = {
  enabled: true,
  ecosystems: ['npm'],
  bindings: [{
    bindingId: 'pkb_1', name: 'tsx', scope: 'owner', generation: 3, affectedWorkspaces: ['ws_a', 'ws_b'],
    release: { releaseId: 'pkr_2', version: '4.1.0', status: 'VERIFIED', source: { registry: 'npm' } },
    history: [{ releaseId: 'pkr_1', version: '4.0.0', available: true }]
  }, { name: 'nameless binding' }],
  releases: [{ releaseId: 'pkr_2', version: '4.1.0', status: 'MISSING', lifecycleScripts: true }],
  inFlight: [{ applyId: 'pka_1', name: 'tsx', version: '4.1.0', state: 'BUILDING' }]
};

describe('packages model', () => {
  it('reads the overview and keeps only identified bindings', () => {
    const overview = packagesOverviewOf(BODY, 0);
    expect(overview.enabled).toBe(true);
    expect(overview.approvalMode).toBe('required');
    expect(overview.bindings).toHaveLength(1);
    expect(overview.bindings[0]).toMatchObject({ bindingId: 'pkb_1', affected: 2, generation: 3, release: { version: '4.1.0', source: 'npm' } });
    expect(overview.inFlight[0]).toMatchObject({ title: 'tsx@4.1.0', state: 'BUILDING' });
    expect(overview.pendingPlans).toBe(0);
  });

  it('labels release health and risks the way the classic page does', () => {
    const release = packagesOverviewOf(BODY, 0).releases[0] ?? null;
    expect(releaseHealth(release)).toEqual({ label: 'Missing on disk', tone: 'danger' });
    expect(releaseHealth(null).tone).toBe('danger');
    expect(bindingRisks(release)).toHaveLength(2);
    expect(workspaceCount(1)).toBe('1 workspace');
  });

  it('fences rollback and uninstall by the binding generation', () => {
    const binding = packagesOverviewOf(BODY, 0).bindings[0]!;
    expect(bindingFenced(binding)).toBe(true);
    if (!bindingFenced(binding)) return;
    const entry = binding.history[0]!;
    expect(packageChangeRequest({ kind: 'rollback', binding, entry })).toEqual({ path: '/packages/rollback', body: { bindingId: 'pkb_1', releaseId: 'pkr_1', expectedGeneration: 3 } });
    expect(packageChangeRequest({ kind: 'remove', binding })).toEqual({ path: '/packages/remove', body: { bindingId: 'pkb_1', expectedGeneration: 3 } });
    expect(packageChangeCopy({ kind: 'rollback', binding, entry }).title).toBe('Roll back tsx from 4.1.0 to 4.0.0?');
    expect(packageChangeCopy({ kind: 'remove', binding }).description).toContain('2 workspaces');
  });
});
