import { describe, expect, it } from 'vitest';
import {
  PackagePlanApproveInputSchema,
  PackagePlanRejectInputSchema,
  PackageRollbackInputSchema,
  PackagesApplyInputSchema,
  PackagesListInputSchema,
  PackagesPlanInputSchema,
  PackagesRollbackInputSchema,
  PackagesStatusInputSchema,
  PackageBinaryNameSchema,
  PackagesStatusResultSchema,
  RunnerConfigSchema,
  packageNameIssue,
  packageVersionSpecIssue
} from '../src/index.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const planId = `pkp_${'b'.repeat(32)}`;
const digest = 'c'.repeat(64);

describe('managed toolbox package schemas', () => {
  it('accepts npm, uv, and scoped npm names within their limits', () => {
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'npm', name: 'prettier' })).toMatchObject({ scope: 'owner' });
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'npm', name: '@biomejs/biome', version: '^1.9.0' }).name).toBe('@biomejs/biome');
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'uv', name: 'Ruff', version: '>=0.6,<0.7', python: '3.12' }).python).toBe('3.12');
    expect(packageNameIssue('npm', `a${'b'.repeat(213)}`)).toBeUndefined();
    expect(packageNameIssue('npm', `a${'b'.repeat(214)}`)).toBeDefined();
    expect(packageNameIssue('uv', `a${'b'.repeat(127)}`)).toBeUndefined();
    expect(packageNameIssue('uv', `a${'b'.repeat(128)}`)).toBeDefined();
  });

  it('refuses names that are not plain registry names', () => {
    for (const name of ['Prettier', '../evil', '@scope', '@scope/', '-flag', '.hidden', 'git+https', 'a b', 'name@1.0.0']) {
      expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name }).success, name).toBe(false);
    }
    for (const name of ['-ruff', 'ruff-', 'ruff/cli', 'ruff==1.0', 'ruff[extra]', '.ruff']) {
      expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'uv', name }).success, name).toBe(false);
    }
  });

  it('refuses URL, git, file, alias, marker, and option-like version specs', () => {
    for (const version of [
      'https://example.com/x.tgz', 'git+ssh://git@github.com/a/b', 'file:../x', 'npm:other@1', 'github:a/b',
      '1.0; python_version<"3"', '--registry=http://evil', '-1', '  -x', ' ', '1.0\n2.0', 'v$(id)', 'a'.repeat(129)
    ]) {
      expect(packageVersionSpecIssue(version), version).toBeDefined();
      expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'prettier', version }).success, version).toBe(false);
    }
    for (const version of ['latest', 'next', '3.3.3', '^3.0.0', '>=1.2.3 <2', '1.x || 2.x', '~=1.4', '==1.0.*', '!=1.5,>=1.0', '1.0.0-rc.1+build']) {
      expect(packageVersionSpecIssue(version), version).toBeUndefined();
    }
  });

  it('requires workspaceId exactly for the workspace scope', () => {
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'npm', name: 'tsx', scope: 'workspace', workspaceId }).workspaceId).toBe(workspaceId);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', scope: 'workspace' }).success).toBe(false);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', workspaceId }).success).toBe(false);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', scope: 'owner', workspaceId }).success).toBe(false);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', scope: 'workspace', workspaceId: 'ws_short' }).success).toBe(false);
  });

  it('refuses the instance scope and unknown keys', () => {
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', scope: 'instance' }).success).toBe(false);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', registry: 'https://evil' }).success).toBe(false);
    expect(PackagesListInputSchema.safeParse({ scope: 'instance' }).success).toBe(false);
  });

  it('accepts apt only so the runner can answer NOT_SUPPORTED', () => {
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'apt', name: 'libssl-dev' }).ecosystem).toBe('apt');
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'apt', name: 'Bad Name' }).success).toBe(false);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'pip', name: 'ruff' }).success).toBe(false);
  });

  it('keeps python to uv and lifecycle scripts to npm', () => {
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'npm', name: 'tsx', python: '3.12' }).success).toBe(false);
    expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'uv', name: 'ruff', lifecycleScripts: true }).success).toBe(false);
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'npm', name: 'esbuild', lifecycleScripts: true }).lifecycleScripts).toBe(true);
    for (const python of ['3', '2.7', '3.12.4.1', '3.123', 'latest']) {
      expect(PackagesPlanInputSchema.safeParse({ ecosystem: 'uv', name: 'ruff', python }).success, python).toBe(false);
    }
    expect(PackagesPlanInputSchema.parse({ ecosystem: 'uv', name: 'ruff', python: '3.12.4' }).python).toBe('3.12.4');
  });

  it('binds apply and approval to a plan identifier and a lowercase hex digest', () => {
    expect(PackagesApplyInputSchema.parse({ planId, planDigest: digest })).toEqual({ planId, planDigest: digest });
    expect(PackagePlanApproveInputSchema.parse({ planId, planDigest: digest })).toEqual({ planId, planDigest: digest });
    for (const planDigest of ['C'.repeat(64), 'c'.repeat(63), `${'c'.repeat(63)}g`]) {
      expect(PackagesApplyInputSchema.safeParse({ planId, planDigest }).success).toBe(false);
      expect(PackagePlanApproveInputSchema.safeParse({ planId, planDigest }).success).toBe(false);
    }
    expect(PackagesApplyInputSchema.safeParse({ planId: `pka_${'b'.repeat(32)}`, planDigest: digest }).success).toBe(false);
    expect(PackagePlanRejectInputSchema.parse({ planId })).toEqual({ planId });
    expect(PackagePlanRejectInputSchema.safeParse({ planId, planDigest: digest }).success).toBe(false);
  });

  it('validates list, status, and rollback inputs', () => {
    expect(PackagesListInputSchema.parse({})).toEqual({ includeHistory: false });
    expect(PackagesListInputSchema.parse({ workspaceId })).toMatchObject({ workspaceId });
    expect(PackagesListInputSchema.safeParse({ scope: 'workspace' }).success).toBe(false);
    expect(PackagesListInputSchema.safeParse({ scope: 'owner', workspaceId }).success).toBe(false);

    expect(PackagesStatusInputSchema.parse({})).toEqual({ waitMs: 0 });
    expect(PackagesStatusInputSchema.parse({ applyId: `pka_${'d'.repeat(32)}`, waitMs: 30_000 }).waitMs).toBe(30_000);
    expect(PackagesStatusInputSchema.safeParse({ applyId: `pka_${'d'.repeat(32)}`, waitMs: 30_001 }).success).toBe(false);
    expect(PackagesStatusInputSchema.safeParse({ waitMs: 1_000 }).success).toBe(false);

    const rollback = { bindingId: `pkb_${'e'.repeat(32)}`, releaseId: `pkr_${'f'.repeat(32)}`, expectedGeneration: 2 };
    expect(PackagesRollbackInputSchema.parse(rollback)).toEqual(rollback);
    expect(PackageRollbackInputSchema.parse(rollback)).toEqual(rollback);
    expect(PackagesRollbackInputSchema.safeParse({ ...rollback, expectedGeneration: -1 }).success).toBe(false);
    expect(PackagesRollbackInputSchema.safeParse({ ...rollback, releaseId: rollback.bindingId }).success).toBe(false);
  });

  it('restricts binary names to plain file names', () => {
    for (const name of ['prettier', 'tsc', 'g++', 'ruff.exe', 'node_modules']) expect(PackageBinaryNameSchema.safeParse(name).success, name).toBe(true);
    for (const name of ['', '../x', 'a/b', 'a b', 'x'.repeat(65)]) expect(PackageBinaryNameSchema.safeParse(name).success, name).toBe(false);
  });

  it('describes the status result as either one apply or the owner overview', () => {
    expect(PackagesStatusResultSchema.safeParse({ inFlight: [], pendingPlans: [], missingReleases: [], workspacesPendingRecreate: [] }).success).toBe(true);
    expect(PackagesStatusResultSchema.safeParse({ inFlight: [] }).success).toBe(false);
  });
});

describe('managed toolbox runner configuration', () => {
  const runner = {
    serviceToken: 'runner-token-that-is-longer-than-32-characters', jobsRoot: '/jobs', stateDb: '/state/state.db',
    executorImage: 'executor:latest', allowedGitHosts: ['github.com']
  };

  it('ships conservative defaults', () => {
    const config = RunnerConfigSchema.parse(runner);
    expect(config).toMatchObject({
      packagesEnabled: false,
      packagesRoot: '/var/lib/cloud-harness/packages',
      packagesEcosystems: ['npm', 'uv'],
      packagesApprovalMode: 'required',
      packagesNpmLifecycleScripts: 'deny',
      packagesMaxReleaseBytes: 536_870_912,
      packagesMaxOwnerBytes: 4_294_967_296,
      packagesMaxBindings: 32,
      packagesBuildTimeoutMs: 600_000
    });
  });

  it('enforces bounds and enumerations', () => {
    const accepts = (patch: Record<string, unknown>) => RunnerConfigSchema.safeParse({ ...runner, ...patch }).success;
    expect(accepts({ packagesRoot: '/srv/packages' })).toBe(true);
    expect(accepts({ packagesRoot: 'relative/packages' })).toBe(false);
    expect(accepts({ packagesRoot: '/' })).toBe(false);
    expect(accepts({ packagesRoot: '/srv/../etc' })).toBe(false);
    expect(accepts({ packagesEcosystems: ['npm'] })).toBe(true);
    expect(accepts({ packagesEcosystems: ['apt'] })).toBe(false);
    expect(accepts({ packagesEcosystems: [] })).toBe(false);
    expect(accepts({ packagesEcosystems: ['npm', 'npm'] })).toBe(false);
    expect(accepts({ packagesApprovalMode: 'none' })).toBe(true);
    expect(accepts({ packagesApprovalMode: 'auto' })).toBe(false);
    expect(accepts({ packagesNpmLifecycleScripts: 'allow' })).toBe(true);
    expect(accepts({ packagesNpmLifecycleScripts: 'yes' })).toBe(false);
    expect(accepts({ packagesMaxReleaseBytes: '16777216' })).toBe(true);
    expect(accepts({ packagesMaxReleaseBytes: '16777215' })).toBe(false);
    expect(accepts({ packagesMaxReleaseBytes: 4_294_967_297, packagesMaxOwnerBytes: 68_719_476_736 })).toBe(false);
    expect(accepts({ packagesMaxOwnerBytes: 67_108_863 })).toBe(false);
    expect(accepts({ packagesMaxOwnerBytes: 68_719_476_737 })).toBe(false);
    expect(accepts({ packagesMaxBindings: 0 })).toBe(false);
    expect(accepts({ packagesMaxBindings: 257 })).toBe(false);
    expect(accepts({ packagesBuildTimeoutMs: 59_999 })).toBe(false);
    expect(accepts({ packagesBuildTimeoutMs: 1_800_001 })).toBe(false);
  });

  it('refuses a release limit larger than the owner limit', () => {
    const result = RunnerConfigSchema.safeParse({ ...runner, packagesMaxReleaseBytes: 134_217_728, packagesMaxOwnerBytes: 67_108_864 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join('.') === 'packagesMaxReleaseBytes')).toBe(true);
  });
});
