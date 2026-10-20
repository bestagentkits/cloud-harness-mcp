import { describe, expect, it } from 'vitest';
import { type LifecycleSetting, type LifecycleView, lifecycleDefaults, lifecycleResetInput, lifecycleSchema, lifecycleSummary, lifecycleUpdateInput, readLifecycleView } from './lifecycle-model';

const setting = (value: number, runnerValue: number, min: number, max: number) => ({ value, source: 'default', runnerValue, min, max });
const raw = (overrides: Record<string, ReturnType<typeof setting>> = {}) => ({
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
const view = (overrides: Record<string, ReturnType<typeof setting>> = {}): LifecycleView => readLifecycleView(raw(overrides))!;
const unchanged = { maxActiveWorkspacesPerOwner: '3', idleTtlSeconds: '5', wallTtlSeconds: '15', recoverableGraceSeconds: '60', acknowledgeImmediateClose: false };

describe('workspace lifecycle settings input', () => {
  it('reads only a complete view and ignores unknown fields', () => {
    expect(readLifecycleView(undefined)).toBeUndefined();
    expect(readLifecycleView({ revision: 1, settings: {} })).toBeUndefined();
    expect(readLifecycleView({ ...raw(), revision: 'x' })).toBeUndefined();
    const read = readLifecycleView({ ...raw(), secret: 'nope' });
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty('secret');
    expect((read!.settings.idleTtlSeconds as LifecycleSetting).source).toBe('default');
    expect(lifecycleDefaults(read!)).toEqual(unchanged);
  });

  it('sends only the changed fields, in seconds, with the loaded revision', () => {
    expect(lifecycleUpdateInput(view(), { ...unchanged, maxActiveWorkspacesPerOwner: '8', idleTtlSeconds: '10' }, false))
      .toEqual({ errors: {}, body: { expectedRevision: 7, maxActiveWorkspacesPerOwner: 8, idleTtlSeconds: 600 } });
    expect(lifecycleUpdateInput(view(), { ...unchanged, wallTtlSeconds: '15.0' }, false)).toEqual({ errors: {}, body: undefined });
    expect(lifecycleUpdateInput(view(), unchanged, false)).toEqual({ errors: {}, body: undefined });
  });

  it('keeps a runner value that is not a whole minute unless the operator edits it', () => {
    const odd = view({ idleTtlSeconds: setting(90, 90, 60, 43_200) });
    expect(lifecycleUpdateInput(odd, { ...unchanged, idleTtlSeconds: '1.5', maxActiveWorkspacesPerOwner: '4' }, false))
      .toEqual({ errors: {}, body: { expectedRevision: 7, maxActiveWorkspacesPerOwner: 4 } });
  });

  it('rejects fractional, empty, and out-of-range values inline', () => {
    for (const [name, value] of [
      ['maxActiveWorkspacesPerOwner', '0'], ['maxActiveWorkspacesPerOwner', '65'], ['maxActiveWorkspacesPerOwner', '2.5'],
      ['idleTtlSeconds', '0'], ['idleTtlSeconds', '721'], ['idleTtlSeconds', '1.5'], ['idleTtlSeconds', ''],
      ['wallTtlSeconds', '1441'], ['recoverableGraceSeconds', '-1'], ['recoverableGraceSeconds', '1441'], ['recoverableGraceSeconds', 'abc']
    ] as const) {
      const result = lifecycleUpdateInput(view(), { ...unchanged, [name]: value }, true);
      expect(result.body, `${name}=${value}`).toBeUndefined();
      expect(result.errors[name], `${name}=${value}`).toMatch(/^Enter /);
    }
  });

  it('refuses an idle timeout longer than the lifetime, on the field the operator changed', () => {
    const longerIdle = lifecycleUpdateInput(view(), { ...unchanged, idleTtlSeconds: '20' }, false);
    expect(longerIdle.body).toBeUndefined();
    expect(longerIdle.errors.idleTtlSeconds).toBe('The idle timeout (20 min) cannot exceed the maximum lifetime (15 min).');
    expect(lifecycleUpdateInput(view(), { ...unchanged, wallTtlSeconds: '4' }, false).errors.wallTtlSeconds).toMatch(/cannot exceed the maximum lifetime \(4 min\)/);
    expect(lifecycleUpdateInput(view(), { ...unchanged, idleTtlSeconds: '20', wallTtlSeconds: '20' }, false).body)
      .toEqual({ expectedRevision: 7, idleTtlSeconds: 1_200, wallTtlSeconds: 1_200 });
  });

  it('requires an explicit acknowledgement for a grace of 0', () => {
    const blocked = lifecycleUpdateInput(view(), { ...unchanged, recoverableGraceSeconds: '0' }, false);
    expect(blocked.body).toBeUndefined();
    expect(blocked.errors.acknowledgeImmediateClose).toMatch(/grace of 0/);
    expect(lifecycleUpdateInput(view(), { ...unchanged, recoverableGraceSeconds: '0' }, true).body)
      .toEqual({ expectedRevision: 7, recoverableGraceSeconds: 0, acknowledgeImmediateClose: true });
    const stored = view({ recoverableGraceSeconds: setting(0, 3_600, 0, 86_400) });
    expect(lifecycleUpdateInput(stored, { ...unchanged, recoverableGraceSeconds: '0', maxActiveWorkspacesPerOwner: '4' }, false))
      .toEqual({ errors: {}, body: { expectedRevision: 7, maxActiveWorkspacesPerOwner: 4 } });
  });

  it('validates while typing without asking for the acknowledgement yet', () => {
    const schema = lifecycleSchema(view());
    expect(schema.safeParse({ ...unchanged, recoverableGraceSeconds: '0' }).success).toBe(true);
    const invalid = schema.safeParse({ ...unchanged, idleTtlSeconds: '721' });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]?.path).toEqual(['idleTtlSeconds']);
  });

  it('resets every field to the runner value with the loaded revision, unless the runner values conflict', () => {
    expect(lifecycleResetInput(view())).toEqual({ body: {
      expectedRevision: 7, maxActiveWorkspacesPerOwner: null, idleTtlSeconds: null, wallTtlSeconds: null, recoverableGraceSeconds: null
    } });
    expect(lifecycleResetInput(view({ idleTtlSeconds: setting(300, 1_200, 60, 43_200) })).error).toMatch(/runner idle timeout \(20 min\) exceeds its maximum lifetime \(15 min\)/);
  });

  it('summarises the read-back for the status line', () => {
    expect(lifecycleSummary(view())).toBe('Effective: up to 3 active per principal, idle 5 min, lifetime 15 min, grace 60 min.');
    expect(lifecycleSummary(undefined)).toBe('');
  });
});
