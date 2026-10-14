import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, PackageApplyResultSchema, PackagePlanResultSchema, type RunnerConfig } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import type { PackageBuildJob, PackageBuildResult, PackageBuilderPort, ResolvePackagePlanSpec, ResolvedPackagePlan } from '../src/package-builder-port.js';
import { PACKAGE_OPERATIONS, PackageService } from '../src/package-service.js';
import { PackageStore } from '../src/package-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>>(
    async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })
  ),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));
const toolbox = vi.hoisted(() => ({
  runToolboxCommand: vi.fn(async () => ({ output: 'ok\n', exitCode: 0, signal: null, truncated: false, timedOut: false }))
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/toolbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ToolboxRunner>()),
  runToolboxCommand: toolbox.runToolboxCommand
}));
import type * as ToolboxRunner from '../src/toolbox-runner.js';
import { WorkspaceService } from '../src/workspace-service.js';

const IMAGE = 'sha256:' + 'a'.repeat(64);
const directories: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Resolves every package to 1.0.0 exposing `hello`, and stages a one-binary release. */
class FakeBuilder implements PackageBuilderPort {
  imageId(): Promise<string> { return Promise.resolve(IMAGE); }
  probeRegistries(): Promise<void> { return Promise.resolve(); }
  resolvePlan(spec: ResolvePackagePlanSpec): Promise<ResolvedPackagePlan> {
    const lockText = JSON.stringify({ name: spec.name, version: '1.0.0' });
    return Promise.resolve({
      version: '1.0.0',
      source: { registry: 'https://registry.npmjs.org/', resolved: `https://registry.npmjs.org/${spec.name}/-/${spec.name}-1.0.0.tgz` },
      integrity: 'sha512-abc',
      lockText,
      lockSha256: createHash('sha256').update(lockText).digest('hex'),
      dependencyCount: 0,
      sizeEstimateBytes: 1_024,
      binaries: ['hello'],
      runtime: { imageId: IMAGE, node: 'v24.11.0', npm: '11.6.0', uv: null, python: null }
    });
  }
  async build(job: PackageBuildJob): Promise<PackageBuildResult> {
    mkdirSync(join(job.stagingDir, 'bin'), { recursive: true });
    writeFileSync(join(job.stagingDir, 'bin', 'hello'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    await job.onPhase?.('VERIFYING');
    return {
      treeDigest: createHash('sha256').update(job.releaseId).digest('hex'),
      sizeBytes: 64,
      fileCount: 1,
      sbom: [{ name: job.name, version: job.version, integrity: 'sha512-abc' }],
      runtime: { imageId: IMAGE, node: 'v24.11.0', npm: '11.6.0', uv: null, python: null },
      provenance: {},
      launchChecks: { hello: '--version' }
    };
  }
}

function setup(packagesEnabled: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-packages-dispatch-'));
  directories.push(directory);
  mkdirSync(join(directory, 'jobs'), { recursive: true });
  const config = {
    authMode: 'cloudflare-access',
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state.db'),
    executorImage: 'cloud-harness-executor:test',
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    maxOutputBytes: 262_144,
    maxWorkspaceBytes: 104_857_600,
    minFreeBytes: 0,
    packagesEnabled,
    packagesRoot: join(directory, 'packages'),
    packagesEcosystems: ['npm', 'uv'],
    packagesApprovalMode: 'none',
    packagesNpmLifecycleScripts: 'deny',
    packagesMaxReleaseBytes: 16_777_216,
    packagesMaxOwnerBytes: 4_294_967_296,
    packagesMaxBindings: 32,
    packagesBuildTimeoutMs: 600_000
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  cleanups.push(() => store.close());
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'packages-owner' });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'c'.repeat(24)}`,
    ownerId,
    idempotencyKey: 'packages-key-1234',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'chm-packages-container',
    workspacePath: join(directory, 'ws'),
    status: 'ACTIVE',
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 3_600_000,
    hardExpiresAt: now + 14_400_000,
    gitAuthorName: null,
    gitAuthorEmail: null,
    generation: 1,
    error: null
  };
  store.create(record);
  const service = new WorkspaceService(config, store);
  const packages = new PackageService({
    database: store.database,
    config,
    builder: new FakeBuilder(),
    instanceId: 'instance-test',
    setExecutorOwnership: () => Promise.resolve()
  });
  (service as unknown as { packageService: PackageService }).packageService = packages;
  cleanups.push(() => packages.shutdown());
  return { service, store, ownerId, record, packages, config };
}

async function install(f: ReturnType<typeof setup>) {
  const planned = await f.service.execute(f.ownerId, 'packages_plan', { ecosystem: 'npm', name: 'chm-hello' });
  expect(planned).toMatchObject({ ok: true, truncated: false });
  const plan = PackagePlanResultSchema.parse(planned.data);
  const applied = await f.service.execute(f.ownerId, 'packages_apply', { planId: plan.planId, planDigest: plan.planDigest });
  const apply = PackageApplyResultSchema.parse(applied.data);
  await f.packages.drain();
  return apply.releaseId;
}

describe('managed package dispatch', () => {
  it('refuses every package tool while the feature is off and starts no container', async () => {
    const f = setup(false);
    const inputs: Record<string, Record<string, unknown>> = {
      packages_plan: { ecosystem: 'npm', name: 'chm-hello' },
      packages_apply: { planId: `pkp_${'a'.repeat(24)}`, planDigest: 'a'.repeat(64) },
      packages_list: {},
      packages_status: {},
      packages_rollback: { bindingId: `pkb_${'a'.repeat(24)}`, releaseId: `pkr_${'a'.repeat(24)}`, expectedGeneration: 1 },
      packages_remove: { bindingId: `pkb_${'a'.repeat(24)}`, expectedGeneration: 1 }
    };
    for (const operation of PACKAGE_OPERATIONS) {
      const error = await f.service.execute(f.ownerId, operation, inputs[operation]!).then(() => undefined, (caught: unknown) => caught);
      expect(error, operation).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code, operation).toBe('FORBIDDEN');
    }
    expect(docker.runDocker).not.toHaveBeenCalled();
    expect(toolbox.runToolboxCommand).not.toHaveBeenCalled();
  });

  it('runs package tools without a workspace mutation lock and wraps results in the tool envelope', async () => {
    const f = setup(true);
    const releaseId = await install(f);

    expect(f.store.byId(f.record.id)?.mutationLockedUntil ?? null).toBeNull();
    const listed = await f.service.execute(f.ownerId, 'packages_list', {});
    expect(listed).toMatchObject({ ok: true, message: '1 package bindings', truncated: false });
    expect(JSON.stringify(listed.data)).toContain(releaseId);
  });

  it('mounts bound releases read-only into a new executor, puts their bin on PATH, and records the profile', async () => {
    const f = setup(true);
    const releaseId = await install(f);

    await (f.service as unknown as { createExecutor: (record: WorkspaceRecord, path: string) => Promise<string> })
      .createExecutor(f.record, join(f.record.workspacePath, 'repo'));

    const create = docker.runDocker.mock.calls.map(([args]) => args).find((args) => args[0] === 'create')!;
    const target = `/opt/chm-packages/${releaseId}`;
    const volumeIndex = create.findIndex((arg) => arg.endsWith(`:${target}:ro`));
    expect(create[volumeIndex - 1]).toBe('--volume');
    expect(create[volumeIndex]!.startsWith(`${join(f.config.packagesRoot, 'releases')}/`)).toBe(true);
    const path = create.find((arg) => arg.startsWith('PATH='))!.slice('PATH='.length).split(':');
    expect(path.indexOf(`${target}/bin`)).toBeGreaterThan(path.indexOf('/tmp/cloud-harness-home/.local/bin'));
    expect(path.indexOf(`${target}/bin`)).toBeLessThan(path.indexOf('/usr/local/sbin'));
    expect(new PackageStore(f.store.database).getProfile(f.record.id)?.releaseIds).toEqual([releaseId]);
  });

  it('gives the toolbox the owner releases as read-only mounts and bin directories', async () => {
    const f = setup(true);
    const releaseId = await install(f);

    const result = await f.service.execute(f.ownerId, 'bash', { target: 'toolbox', command: 'hello' });

    expect(result.ok).toBe(true);
    expect(toolbox.runToolboxCommand).toHaveBeenCalledTimes(1);
    const spec = (toolbox.runToolboxCommand.mock.calls[0] as unknown as [{ mounts: { target: string }[]; binDirs: string[] }])[0];
    expect(spec.mounts.map((mount) => mount.target)).toEqual([`/opt/chm-packages/${releaseId}`]);
    expect(spec.binDirs).toEqual([`/opt/chm-packages/${releaseId}/bin`]);
  });
});
