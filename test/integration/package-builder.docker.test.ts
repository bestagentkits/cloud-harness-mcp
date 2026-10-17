import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildablePackageEcosystem } from '@cloud-harness/contracts';
import { computeFullTreeDigest } from '../../apps/runner/src/adapters/mattpocock-adapter.js';
import { removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { PackageBuilder, packageMountPath } from '../../apps/runner/src/package-builder.js';
import type { PackageBuildJob, ResolvedPackagePlan } from '../../apps/runner/src/package-builder-port.js';
import { runToolboxCommand, toolboxContainerName } from '../../apps/runner/src/toolbox-runner.js';
import { dockerPrerequisiteIssue, requireDockerPrerequisites } from '../agent-docker-test-support.js';
import {
  pythonArchivePrerequisiteIssue,
  removeTreeAsRoot,
  startPackageRegistry,
  stopPackageRegistry,
  type PackageRegistryFixture
} from './package-registry-fixture.js';

/**
 * The isolated package builder against a real executor image and a hermetic registry: resolve, build, tree
 * verification, and the no-network launch check, plus the failures that must stop a release from publishing.
 */
const image = process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local';
const dockerIssue = dockerPrerequisiteIssue([image]);
const prerequisiteIssue = dockerIssue ?? pythonArchivePrerequisiteIssue(image);
requireDockerPrerequisites(prerequisiteIssue);

const BUILD_TIMEOUT_MS = 300_000;
const MAX_RELEASE_BYTES = 1_073_741_824;

let registry: PackageRegistryFixture | undefined;
let packagesRoot: string;
let builder: PackageBuilder;
let instanceId: string;

const storeId = (prefix: 'pkp' | 'pka' | 'pkr') => `${prefix}_${randomBytes(18).toString('base64url')}`;

function stagingFor(releaseId: string): string {
  const stagingDir = join(packagesRoot, 'staging', releaseId);
  mkdirSync(stagingDir, { recursive: true });
  return stagingDir;
}

function plan(ecosystem: BuildablePackageEcosystem, name: string, requestedSpec: string, python?: string): Promise<ResolvedPackagePlan> {
  return builder.resolvePlan({ scratchId: storeId('pkp'), ecosystem, name, requestedSpec, lifecycleScripts: false, ...(python ? { python } : {}) });
}

function jobFor(resolved: ResolvedPackagePlan, ecosystem: BuildablePackageEcosystem, name: string, overrides: Partial<PackageBuildJob> = {}): PackageBuildJob {
  const releaseId = storeId('pkr');
  return {
    applyId: storeId('pka'),
    releaseId,
    ecosystem,
    name,
    version: resolved.version,
    lockText: resolved.lockText,
    binaries: resolved.binaries,
    lifecycleScripts: false,
    ...(resolved.runtime.python ? { python: resolved.runtime.python } : {}),
    stagingDir: stagingFor(releaseId),
    maxReleaseBytes: MAX_RELEASE_BYTES,
    timeoutMs: BUILD_TIMEOUT_MS,
    ...overrides
  };
}

async function builderContainers(): Promise<string[]> {
  const listed = await runDocker([
    'ps', '-a', '--filter', 'label=cloud-harness.role=package-builder', '--filter', `label=cloud-harness.instance=${instanceId}`,
    '--format', '{{.Names}}'
  ], { timeoutMs: 15_000 });
  expect(listed.exitCode).toBe(0);
  return listed.stdout.split('\n').filter(Boolean);
}

beforeAll(async () => {
  if (prerequisiteIssue) return;
  instanceId = `pkgtest-${randomBytes(6).toString('hex')}`;
  packagesRoot = mkdtempSync(join(tmpdir(), 'cloud-harness-package-builder-'));
  registry = await startPackageRegistry(image);
  builder = new PackageBuilder({
    executorImage: image,
    instanceId,
    packagesRoot,
    provisioningNetwork: 'cloud-harness-provisioning',
    network: registry.network,
    proxy: undefined,
    planTimeoutMs: BUILD_TIMEOUT_MS,
    npmRegistry: registry.npmRegistry,
    pypiIndex: registry.pypiIndex,
    pythonMirror: registry.pythonMirror
  });
}, 120_000);

afterAll(async () => {
  if (instanceId) {
    const leftovers = await runDocker(['ps', '-a', '--filter', `label=cloud-harness.instance=${instanceId}`, '--format', '{{.Names}}'], { timeoutMs: 15_000 })
      .catch(() => undefined);
    for (const name of leftovers?.stdout.split('\n').filter(Boolean) ?? []) await removeContainer(name).catch(() => undefined);
  }
  if (registry) stopPackageRegistry(registry);
  if (packagesRoot) removeTreeAsRoot(image, packagesRoot);
}, 180_000);

describe.skipIf(prerequisiteIssue !== undefined)('package builder in a real executor image', { timeout: 600_000 }, () => {
  it('resolves, builds, verifies, and launch-checks an npm package without running its lifecycle scripts', async () => {
    const resolved = await plan('npm', 'chm-hello', '1.0.0');
    expect(resolved).toMatchObject({ version: '1.0.0', binaries: ['chm-hello'], dependencyCount: 1 });
    expect(resolved.integrity).toMatch(/^sha512-/);

    const job = jobFor(resolved, 'npm', 'chm-hello');
    const phases: string[] = [];
    const result = await builder.build({ ...job, onPhase: (phase) => { phases.push(phase); } });

    expect(phases).toEqual(['BUILDING', 'VERIFYING']);
    expect(result.launchChecks).toHaveProperty('chm-hello');
    expect(result.runtime.imageId).toMatch(/^sha256:/);
    expect(result.sbom.map((entry) => entry.name).sort()).toEqual(['chm-dep', 'chm-hello']);
    // Lifecycle scripts are denied unless the approved plan allows them.
    expect(existsSync(join(job.stagingDir, 'npm', 'node_modules', 'chm-hello', 'postinstall-ran'))).toBe(false);
    // The release links resolve relative to its final mount path, never to the host staging path.
    expect(readlinkSync(join(job.stagingDir, 'bin', 'chm-hello'))).toBe('../npm/node_modules/.bin/chm-hello');
    // The digest is a pure function of the tree: two reads agree with the published value.
    expect(computeFullTreeDigest(job.stagingDir).bundleSha256).toBe(result.treeDigest);
    expect(computeFullTreeDigest(job.stagingDir).bundleSha256).toBe(result.treeDigest);

    // The shebang and dependency resolve from the read-only release with no network.
    const target = packageMountPath(job.releaseId);
    const run = await runToolboxCommand({
      name: toolboxContainerName(), image, instanceId, command: 'chm-hello',
      mounts: [{ source: job.stagingDir, target }], binDirs: [`${target}/bin`]
    }, { timeoutMs: 30_000, maxOutputBytes: 65_536 });
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('hello from chm-hello (chm-dep 1.0.0)');
  });

  it('refuses a release whose binary fails the launch check', async () => {
    const resolved = await plan('npm', 'chm-hello', '1.1.0');
    await expect(builder.build(jobFor(resolved, 'npm', 'chm-hello'))).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED' });
  });

  it('refuses a release larger than the size limit', async () => {
    const resolved = await plan('npm', 'chm-hello', '1.0.0');
    await expect(builder.build(jobFor(resolved, 'npm', 'chm-hello', { maxReleaseBytes: 1 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('builds a uv package with a managed Python that runs from a read-only mount without network', async () => {
    const resolved = await plan('uv', 'chm-hello', '', '3.12');
    expect(resolved).toMatchObject({ version: '1.0.0', binaries: ['chm-hello-py'], dependencyCount: 0 });
    expect(resolved.runtime.python).toMatch(/^3\.12\.\d+$/);

    const job = jobFor(resolved, 'uv', 'chm-hello');
    const result = await builder.build(job);
    expect(result.runtime.python).toBe(resolved.runtime.python);

    const target = packageMountPath(job.releaseId);
    const run = await runToolboxCommand({
      name: toolboxContainerName(), image, instanceId, command: 'chm-hello-py --version',
      mounts: [{ source: job.stagingDir, target }], binDirs: [`${target}/bin`]
    }, { timeoutMs: 30_000, maxOutputBytes: 65_536 });
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('chm-hello-py 1.0.0');
  });

  it('leaves no package builder containers behind', async () => {
    expect(await builderContainers()).toEqual([]);
  });
});
