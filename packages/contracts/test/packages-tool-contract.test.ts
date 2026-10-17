import { describe, expect, it } from 'vitest';
import { RunnerOperationSchema, TOOL_SCHEMA_BY_NAME, TOOL_SPECS } from '../src/index.js';

const PACKAGE_TOOLS = ['packages_plan', 'packages_apply', 'packages_list', 'packages_status', 'packages_rollback', 'packages_remove'] as const;

describe('managed package tool contract', () => {
  it('registers every package tool as a runner operation with its annotations', () => {
    const expected = {
      packages_plan: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
      packages_apply: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
      packages_list: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      packages_status: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      packages_rollback: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
      packages_remove: { readOnly: false, destructive: true, idempotent: false, openWorld: false }
    };
    for (const name of PACKAGE_TOOLS) {
      expect(RunnerOperationSchema.options, name).toContain(name);
      const spec = TOOL_SPECS.find((candidate) => candidate.name === name);
      expect(spec, name).toMatchObject(expected[name]);
      expect(spec?.title, name).toBeTruthy();
      expect(spec?.description.length, name).toBeGreaterThan(40);
    }
  });

  it('refuses unknown fields on every package tool instead of ignoring them', () => {
    const valid: Record<typeof PACKAGE_TOOLS[number], Record<string, unknown>> = {
      packages_plan: { ecosystem: 'npm', name: 'chm-hello' },
      packages_apply: { planId: `pkp_${'a'.repeat(24)}`, planDigest: 'a'.repeat(64) },
      packages_list: {},
      packages_status: {},
      packages_rollback: { bindingId: `pkb_${'a'.repeat(24)}`, releaseId: `pkr_${'a'.repeat(24)}`, expectedGeneration: 1 },
      packages_remove: { bindingId: `pkb_${'a'.repeat(24)}`, expectedGeneration: 1 }
    };
    for (const name of PACKAGE_TOOLS) {
      expect(() => TOOL_SCHEMA_BY_NAME[name].parse(valid[name]), name).not.toThrow();
      expect(() => TOOL_SCHEMA_BY_NAME[name].parse({ ...valid[name], privileged: true }), name).toThrow();
    }
  });

  it('binds apply to a plan digest rather than a free-form package spec', () => {
    const apply = TOOL_SCHEMA_BY_NAME.packages_apply;
    expect(() => apply.parse({ planId: `pkp_${'a'.repeat(24)}` })).toThrow();
    expect(() => apply.parse({ planId: `pkp_${'a'.repeat(24)}`, planDigest: 'not-a-digest' })).toThrow();
    expect(() => apply.parse({ ecosystem: 'npm', name: 'chm-hello' })).toThrow();
  });

  it('accepts either an apply or a resolution in status, never both, and waits only on one of them', () => {
    const status = TOOL_SCHEMA_BY_NAME.packages_status;
    const applyId = `pka_${'a'.repeat(24)}`;
    const resolutionId = `pkq_${'a'.repeat(24)}`;
    expect(() => status.parse({ resolutionId, waitMs: 1_000 })).not.toThrow();
    expect(() => status.parse({ applyId, waitMs: 1_000 })).not.toThrow();
    expect(() => status.parse({ applyId, resolutionId })).toThrow();
    expect(() => status.parse({ waitMs: 1_000 })).toThrow();
    expect(() => status.parse({ resolutionId: 'pkq_short' })).toThrow();
  });
});
