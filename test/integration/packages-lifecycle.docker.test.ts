import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HarnessError,
  PackageApplyResultSchema,
  PackagePlanResultSchema,
  PackagesListResultSchema,
  PackagesPlanOutputSchema,
  PackagesRemoveResultSchema,
  PackagesStatusResultSchema,
  type RunnerConfig
} from '@cloud-harness/contracts';
import { removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { PackageBuilder } from '../../apps/runner/src/package-builder.js';
import { PackageService } from '../../apps/runner/src/package-service.js';
import { PackageStore } from '../../apps/runner/src/package-store.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';
import { dockerPrerequisiteIssue, requireDockerPrerequisites } from '../agent-docker-test-support.js';
import { removeTreeAsRoot, startPackageRegistry, stopPackageRegistry, type PackageRegistryFixture } from './package-registry-fixture.js';

/**
 * Managed packages end to end through `WorkspaceService.execute`: plan, Dashboard approval, durable apply
 * with a real isolated builder against a hermetic registry, the toolbox running the release, conflicts,
 * a failed upgrade that keeps the binding, rollback, crash recovery, and garbage collection.
 */
const image = process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local';
const prerequisiteIssue = dockerPrerequisiteIssue([image]);
requireDockerPrerequisites(prerequisiteIssue);

const BUILD_TIMEOUT_MS = 300_000;

let registry: PackageRegistryFixture | undefined;
let directory: string;
let packagesRoot: string;
let instanceId: string;
let store: StateStore;
let config: RunnerConfig;
let service: WorkspaceService;
let packages: PackageService;
let ownerId: string;

function packageService(): PackageService {
  return new PackageService({
    database: store.database,
    config,
    builder: new PackageBuilder({
      executorImage: image,
      instanceId,
      packagesRoot,
      provisioningNetwork: 'cloud-harness-provisioning',
      network: registry!.network,
      proxy: undefined,
      planTimeoutMs: BUILD_TIMEOUT_MS,
      npmRegistry: registry!.npmRegistry,
      pypiIndex: registry!.pypiIndex,
      pythonMirror: registry!.pythonMirror
    }),
    instanceId
  });
}

function useService(next: PackageService): void {
  packages = next;
  (service as unknown as { packageService: PackageService }).packageService = next;
}

/** Plans, polling the resolution when it outlasts the inline wait, as an agent would. */
async function plan(name: string, version: string) {
  const result = PackagesPlanOutputSchema.parse((await service.execute(ownerId, 'packages_plan', { ecosystem: 'npm', name, version })).data);
  if (!('resolutionId' in result)) return PackagePlanResultSchema.parse(result);
  for (;;) {
    const status = PackagesStatusResultSchema.parse((await service.execute(ownerId, 'packages_status', { resolutionId: result.resolutionId, waitMs: 30_000 })).data);
    if (!('resolution' in status)) throw new Error('expected a resolution status');
    if (status.resolution.state === 'READY') return PackagePlanResultSchema.parse(status.resolution.plan);
    if (status.resolution.state === 'FAILED') throw new HarnessError(status.resolution.errorCode ?? 'INTERNAL_ERROR', status.resolution.errorMessage ?? 'resolution failed');
  }
}

/** The operator's Dashboard decision, bound to the digest it was shown. */
function approve(planned: { planId: string; planDigest: string }): void {
  new PackageStore(store.database).approvePlan({ ownerId, planId: planned.planId, planDigest: planned.planDigest, decidedBy: ownerId, now: Date.now() });
}

/** The `packages_apply` input for a plan: only its id and the digest the operator approved. */
function applyInput(planned: { planId: string; planDigest: string }) {
  return { planId: planned.planId, planDigest: planned.planDigest };
}

async function applyAndWait(planned: { planId: string; planDigest: string }) {
  const applied = PackageApplyResultSchema.parse((await service.execute(ownerId, 'packages_apply', applyInput(planned))).data);
  await packages.drain();
  const status = PackagesStatusResultSchema.parse((await service.execute(ownerId, 'packages_status', { applyId: applied.applyId })).data);
  if (!('apply' in status)) throw new Error('expected an apply status');
  return status.apply;
}

async function install(name: string, version: string) {
  const planned = await plan(name, version);
  approve(planned);
  return await applyAndWait(planned);
}

async function binding(name: string) {
  const listed = PackagesListResultSchema.parse((await service.execute(ownerId, 'packages_list', { includeHistory: true })).data);
  return listed.bindings.find((entry) => entry.name === name);
}

async function code(action: Promise<unknown>): Promise<string> {
  const error = await action.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HarnessError);
  return (error as HarnessError).code;
}

beforeAll(async () => {
  if (prerequisiteIssue) return;
  instanceId = `pkglife-${randomBytes(6).toString('hex')}`;
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-packages-lifecycle-'));
  packagesRoot = join(directory, 'packages');
  mkdirSync(join(directory, 'jobs'), { recursive: true });
  registry = await startPackageRegistry(image);
  config = {
    authMode: 'cloudflare-access',
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state.db'),
    executorImage: image,
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    maxOutputBytes: 262_144,
    maxWorkspaceBytes: 104_857_600,
    minFreeBytes: 0,
    toolboxMaxConcurrent: 2,
    packagesEnabled: true,
    packagesRoot,
    packagesEcosystems: ['npm', 'uv'],
    packagesApprovalMode: 'required',
    packagesNpmLifecycleScripts: 'deny',
    packagesMaxReleaseBytes: 536_870_912,
    packagesMaxOwnerBytes: 4_294_967_296,
    packagesMaxBindings: 32,
    packagesBuildTimeoutMs: BUILD_TIMEOUT_MS
  } as RunnerConfig;
  store = new StateStore(config.stateDb);
  ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'packages-lifecycle-owner' });
  service = new WorkspaceService(config, store);
  useService(packageService());
}, 120_000);

afterAll(async () => {
  await packages?.shutdown();
  store?.close();
  if (instanceId) {
    const leftovers = await runDocker(['ps', '-a', '--filter', `label=cloud-harness.instance=${instanceId}`, '--format', '{{.Names}}'], { timeoutMs: 15_000 })
      .catch(() => undefined);
    for (const name of leftovers?.stdout.split('\n').filter(Boolean) ?? []) await removeContainer(name).catch(() => undefined);
  }
  if (registry) stopPackageRegistry(registry);
  if (directory) removeTreeAsRoot(image, directory);
}, 180_000);

describe.skipIf(prerequisiteIssue !== undefined)('managed packages through the workspace service', { timeout: 900_000 }, () => {
  it('waits for approval, installs, and runs the release from the toolbox', async () => {
    const planned = await plan('chm-hello', '1.0.0');
    expect(planned).toMatchObject({ approval: 'required', package: { name: 'chm-hello', version: '1.0.0' }, binaries: ['chm-hello'] });
    expect(await code(service.execute(ownerId, 'packages_apply', applyInput(planned)))).toBe('PACKAGE_APPROVAL_REQUIRED');

    approve(planned);
    const apply = await applyAndWait(planned);
    expect(apply).toMatchObject({ state: 'SUCCEEDED' });

    const run = await service.execute(ownerId, 'bash', { target: 'toolbox', command: 'chm-hello' });
    expect(run.ok).toBe(true);
    expect((run.data as { output: string }).output).toContain('hello from chm-hello (chm-dep 1.0.0)');
  });

  it('refuses a package whose binary collides with an existing binding', async () => {
    const planned = await plan('chm-clash', '1.0.0');
    approve(planned);
    expect(await code(service.execute(ownerId, 'packages_apply', applyInput(planned)))).toBe('CONFLICT');
  });

  it('keeps the binding on its release when an upgrade fails verification, then rolls back', async () => {
    const first = await binding('chm-hello');
    expect(first?.release?.version).toBe('1.0.0');

    const failed = await install('chm-hello', '1.1.0');
    expect(failed).toMatchObject({ state: 'FAILED', errorCode: 'PACKAGE_VERIFICATION_FAILED' });
    expect((await binding('chm-hello'))?.release?.releaseId).toBe(first!.release!.releaseId);

    const reinstalled = await install('chm-hello', '1.0.0');
    expect(reinstalled.state).toBe('SUCCEEDED');
    const current = (await binding('chm-hello'))!;
    expect(current.release?.releaseId).toBe(reinstalled.releaseId);

    const rolled = await service.execute(ownerId, 'packages_rollback', {
      bindingId: current.bindingId, releaseId: first!.release!.releaseId, expectedGeneration: current.generation
    });
    expect(rolled.ok).toBe(true);
    expect((await binding('chm-hello'))?.release?.releaseId).toBe(first!.release!.releaseId);

    // Both releases stay in the binding's history, so garbage collection keeps their trees.
    const collected = await packages.collectGarbage(Date.now() + 7_200_000);
    expect(collected.collectedReleases).toBe(0);
    const releaseDirs = readdirSync(join(packagesRoot, 'releases')).flatMap((owner) => readdirSync(join(packagesRoot, 'releases', owner)));
    expect(releaseDirs).toEqual(expect.arrayContaining([first!.release!.releaseId, reinstalled.releaseId]));
  });

  it('fails an apply interrupted by a runner stop and leaves no staging behind after restart', async () => {
    const planned = await plan('chm-hello', '1.0.0');
    approve(planned);
    const applied = PackageApplyResultSchema.parse((await service.execute(ownerId, 'packages_apply', applyInput(planned))).data);
    await packages.shutdown();

    useService(packageService());
    await packages.reconcileStartup();

    const status = PackagesStatusResultSchema.parse((await service.execute(ownerId, 'packages_status', { applyId: applied.applyId })).data);
    expect(status).toMatchObject({ apply: { state: 'FAILED', errorCode: 'RUNNER_RESTARTED' } });
    const staging = join(packagesRoot, 'staging');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    const containers = await runDocker(['ps', '-a', '--filter', 'label=cloud-harness.role=package-builder', '--filter', `label=cloud-harness.instance=${instanceId}`, '--format', '{{.Names}}'], { timeoutMs: 15_000 });
    expect(containers.stdout.trim()).toBe('');
    // The fence is cleared, so the binding accepts a new apply.
    expect((await install('chm-hello', '1.0.0')).state).toBe('SUCCEEDED');
  });

  it('uninstalls the package so the toolbox no longer finds it', async () => {
    const current = (await binding('chm-hello'))!;
    const removed = PackagesRemoveResultSchema.parse((await service.execute(ownerId, 'packages_remove', {
      bindingId: current.bindingId, expectedGeneration: current.generation
    })).data);
    expect(removed).toMatchObject({ bindingId: current.bindingId, removed: true });
    expect(removed.collectedReleases).toBeGreaterThan(0);
    expect(await binding('chm-hello')).toBeUndefined();
    const run = await service.execute(ownerId, 'bash', { target: 'toolbox', command: 'command -v chm-hello || echo absent' });
    expect((run.data as { output: string }).output).toContain('absent');
  });
});
