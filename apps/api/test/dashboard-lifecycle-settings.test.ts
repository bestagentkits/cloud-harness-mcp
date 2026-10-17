import { describe, expect, it } from 'vitest';
import { workspaceLifecycleResetInput, workspaceLifecycleSummary, workspaceLifecycleUpdateInput } from '../dashboard/dashboard.js';

const setting = (value: number, runnerValue: number, min: number, max: number) => ({ value, source: 'default', runnerValue, min, max });
const view = (overrides: Record<string, ReturnType<typeof setting>> = {}) => ({
  revision: 7, updatedAt: null, reaperIntervalSeconds: 60,
  settings: {
    maxActiveWorkspacesPerOwner: setting(3, 3, 1, 64),
    idleTtlSeconds: setting(300, 300, 60, 43_200),
    wallTtlSeconds: setting(900, 900, 60, 86_400),
    recoverableGraceSeconds: setting(3_600, 3_600, 0, 86_400),
    ...overrides
  },
  usage: { counted: 1, limit: 3, recoverable: 0, autoCloseDeferred: 0 },
  executorCeilings: { memoryBytes: 1_073_741_824, cpus: 1, pids: 256 }
});
const unchanged = { maxActiveWorkspacesPerOwner: '3', idleTtlSeconds: '5', wallTtlSeconds: '15', recoverableGraceSeconds: '60' };

describe('workspace lifecycle settings input', () => {
  it('sends only the changed fields, in seconds, with the loaded revision', () => {
    expect(workspaceLifecycleUpdateInput(view(), { ...unchanged, maxActiveWorkspacesPerOwner: '8', idleTtlSeconds: '10' }, false))
      .toEqual({ errors: {}, body: { expectedRevision: 7, maxActiveWorkspacesPerOwner: 8, idleTtlSeconds: 600 } });
    // A value equal to the effective one is not a change, however it is written.
    expect(workspaceLifecycleUpdateInput(view(), { ...unchanged, wallTtlSeconds: '15.0' }, false)).toEqual({ errors: {}, body: undefined });
    expect(workspaceLifecycleUpdateInput(view(), unchanged, false)).toEqual({ errors: {}, body: undefined });
  });

  it('keeps a runner value that is not a whole minute unless the operator edits it', () => {
    const odd = view({ idleTtlSeconds: setting(90, 90, 60, 43_200) });
    expect(workspaceLifecycleUpdateInput(odd, { ...unchanged, idleTtlSeconds: '1.5', maxActiveWorkspacesPerOwner: '4' }, false))
      .toEqual({ errors: {}, body: { expectedRevision: 7, maxActiveWorkspacesPerOwner: 4 } });
  });

  it('rejects fractional, empty, and out-of-range values inline', () => {
    for (const [name, raw] of [
      ['maxActiveWorkspacesPerOwner', '0'], ['maxActiveWorkspacesPerOwner', '65'], ['maxActiveWorkspacesPerOwner', '2.5'],
      ['idleTtlSeconds', '0'], ['idleTtlSeconds', '721'], ['idleTtlSeconds', '1.5'], ['idleTtlSeconds', ''],
      ['wallTtlSeconds', '1441'], ['recoverableGraceSeconds', '-1'], ['recoverableGraceSeconds', '1441'], ['recoverableGraceSeconds', 'abc']
    ] as const) {
      const result = workspaceLifecycleUpdateInput(view(), { ...unchanged, [name]: raw }, true);
      expect(result.body, `${name}=${raw}`).toBeUndefined();
      expect(result.errors[name], `${name}=${raw}`).toMatch(/^Enter /);
    }
  });

  it('refuses an idle timeout longer than the lifetime, on the field the operator changed', () => {
    const longerIdle = workspaceLifecycleUpdateInput(view(), { ...unchanged, idleTtlSeconds: '20' }, false);
    expect(longerIdle.body).toBeUndefined();
    expect(longerIdle.errors.idleTtlSeconds).toBe('The idle timeout (20 min) cannot exceed the maximum lifetime (15 min).');
    const shorterWall = workspaceLifecycleUpdateInput(view(), { ...unchanged, wallTtlSeconds: '4' }, false);
    expect(shorterWall.errors.wallTtlSeconds).toMatch(/cannot exceed the maximum lifetime \(4 min\)/);
    expect(workspaceLifecycleUpdateInput(view(), { ...unchanged, idleTtlSeconds: '20', wallTtlSeconds: '20' }, false).body)
      .toEqual({ expectedRevision: 7, idleTtlSeconds: 1_200, wallTtlSeconds: 1_200 });
  });

  it('requires an explicit acknowledgement for a grace of 0', () => {
    const blocked = workspaceLifecycleUpdateInput(view(), { ...unchanged, recoverableGraceSeconds: '0' }, false);
    expect(blocked.body).toBeUndefined();
    expect(blocked.errors.acknowledgeImmediateClose).toMatch(/grace of 0/);
    expect(workspaceLifecycleUpdateInput(view(), { ...unchanged, recoverableGraceSeconds: '0' }, true).body)
      .toEqual({ expectedRevision: 7, recoverableGraceSeconds: 0, acknowledgeImmediateClose: true });
    // An unchanged stored grace of 0 is not re-sent, so it needs no acknowledgement.
    const stored = view({ recoverableGraceSeconds: setting(0, 3_600, 0, 86_400) });
    expect(workspaceLifecycleUpdateInput(stored, { ...unchanged, recoverableGraceSeconds: '0', maxActiveWorkspacesPerOwner: '4' }, false))
      .toEqual({ errors: {}, body: { expectedRevision: 7, maxActiveWorkspacesPerOwner: 4 } });
  });

  it('resets every field to the runner value with the loaded revision, unless the runner values conflict', () => {
    expect(workspaceLifecycleResetInput(view())).toEqual({ body: {
      expectedRevision: 7, maxActiveWorkspacesPerOwner: null, idleTtlSeconds: null, wallTtlSeconds: null, recoverableGraceSeconds: null
    } });
    const conflicting = view({ idleTtlSeconds: setting(300, 1_200, 60, 43_200) });
    expect(workspaceLifecycleResetInput(conflicting).error).toMatch(/runner idle timeout \(20 min\) exceeds its maximum lifetime \(15 min\)/);
  });

  it('summarises the read-back for the status line', () => {
    expect(workspaceLifecycleSummary(view())).toBe('Effective: up to 3 active per principal, idle 5 min, lifetime 15 min, grace 60 min.');
    expect(workspaceLifecycleSummary(undefined)).toBe('');
  });
});
