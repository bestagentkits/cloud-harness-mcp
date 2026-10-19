import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutorNetworkProfile } from '@cloud-harness/contracts';
import { admitNpmLockfile, LockfileInstallExecutor, NPM_LOCKFILE } from '../../apps/runner/src/agent-governance/install-executor.js';
import { runDocker } from '../../apps/runner/src/docker-engine.js';
import { dockerPrerequisiteIssue, requireDockerPrerequisites } from '../agent-docker-test-support.js';
import { removeTreeAsRoot, startPackageRegistry, stopPackageRegistry, type PackageRegistryFixture } from './package-registry-fixture.js';

/**
 * The coding lockfile install in a real executor image against the hermetic npm registry: the lockfile is
 * admitted, `npm ci` installs exactly what it pins with lifecycle scripts off, a tampered integrity hash
 * fails the install, and the one-shot container is gone afterwards. The registry's internal network stands
 * in for the dependency-access network, so the install can reach the fixtures and nothing else.
 */
const image = process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local';
const prerequisiteIssue = dockerPrerequisiteIssue([image]);
requireDockerPrerequisites(prerequisiteIssue);

let registry: PackageRegistryFixture | undefined;
let root: string | undefined;
let instanceId: string;
let lockText: string;
const attested: ExecutorNetworkProfile[] = [];

/** A workspace job directory holding a checkout with the fixture manifest and, optionally, a lockfile. */
function workspace(lockfile?: string): { workspaceId: string; workspacePath: string; repo: string } {
  const workspaceId = `ws_${randomBytes(12).toString('hex')}`;
  const workspacePath = join(root!, workspaceId);
  const repo = join(workspacePath, 'repo');
  mkdirSync(repo, { recursive: true });
  // The install container runs as the executor user, which must be able to write the checkout.
  chmodSync(repo, 0o777);
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'coding-fixture', version: '1.0.0', private: true, dependencies: { 'chm-hello': '1.0.0' } }, null, 2)}\n`);
  if (lockfile !== undefined) writeFileSync(join(repo, NPM_LOCKFILE), lockfile);
  return { workspaceId, workspacePath, repo };
}

function executor(): LockfileInstallExecutor {
  return new LockfileInstallExecutor({
    image,
    instanceId,
    registry: registry!.npmRegistry,
    network: {
      ensureProfileReady: async (profile) => { attested.push(profile); },
      dockerLaunchArgs: () => ['--network', registry!.network]
    }
  });
}

async function installContainers(): Promise<string[]> {
  const listed = await runDocker(['ps', '-a', '--filter', `label=cloud-harness.instance=${instanceId}`, '--format', '{{.Names}}'], { timeoutMs: 15_000 });
  expect(listed.exitCode).toBe(0);
  return listed.stdout.split('\n').filter(Boolean);
}

beforeAll(async () => {
  if (prerequisiteIssue) return;
  instanceId = `installtest-${randomBytes(6).toString('hex')}`;
  root = mkdtempSync(join(tmpdir(), 'cloud-harness-coding-install-'));
  registry = await startPackageRegistry(image);
  // The lockfile a developer would commit, resolved against the fixture registry without running anything.
  const { repo } = workspace();
  const resolved = spawnSync('docker', [
    'run', '--rm', '--pull', 'never', '--network', registry.network, '--user', '10001:10001', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${repo},target=/workspace`, '--workdir', '/workspace',
    '--env', 'HOME=/tmp/home', '--env', 'npm_config_cache=/tmp/npm-cache',
    '--entrypoint', 'npm', image,
    'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry.npmRegistry
  ], { encoding: 'utf8', timeout: 120_000 });
  if (resolved.status !== 0) throw new Error(`could not resolve the fixture lockfile: ${`${resolved.stdout}${resolved.stderr}`.slice(-2_000)}`);
  lockText = readFileSync(join(repo, NPM_LOCKFILE), 'utf8');
}, 180_000);

afterAll(async () => {
  if (registry) stopPackageRegistry(registry);
  if (root) removeTreeAsRoot(image, root);
}, 180_000);

describe.skipIf(prerequisiteIssue !== undefined)('coding lockfile install in a real executor image', { timeout: 300_000 }, () => {
  it('admits the lockfile and installs exactly what it pins without running lifecycle scripts', async () => {
    const admission = admitNpmLockfile(lockText, [registry!.npmRegistry]);
    expect(admission).toEqual({
      ok: true,
      packages: expect.arrayContaining([
        { name: 'chm-hello', version: '1.0.0', registryHost: 'fake-registry' },
        { name: 'chm-dep', version: '1.0.0', registryHost: 'fake-registry' }
      ])
    });

    const target = workspace(lockText);
    attested.length = 0;
    const result = await executor().install(target);
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(attested).toEqual(['dependency-access']);

    const installed = JSON.parse(readFileSync(join(target.repo, 'node_modules', 'chm-hello', 'package.json'), 'utf8')) as { version: string };
    expect(installed.version).toBe('1.0.0');
    expect(existsSync(join(target.repo, 'node_modules', 'chm-dep', 'package.json'))).toBe(true);
    // The package's postinstall would have written this marker.
    expect(existsSync(join(target.repo, 'node_modules', 'chm-hello', 'postinstall-ran'))).toBe(false);
    // The installed tree never reaches the commit the runner makes later.
    expect(readFileSync(join(target.repo, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('/node_modules/');
    // The lockfile is frozen: the install did not rewrite it.
    expect(readFileSync(join(target.repo, NPM_LOCKFILE), 'utf8')).toBe(lockText);
    expect(await installContainers()).toEqual([]);
  });

  it('fails the install when a tarball does not match its pinned integrity', async () => {
    const lock = JSON.parse(lockText) as { packages: Record<string, { integrity?: string }> };
    const entry = lock.packages['node_modules/chm-dep'];
    expect(entry?.integrity).toMatch(/^sha512-/u);
    entry!.integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    const tampered = `${JSON.stringify(lock, null, 2)}\n`;
    // Still a well-formed, registry-pinned lockfile: admission cannot tell, and npm's integrity check must.
    expect(admitNpmLockfile(tampered, [registry!.npmRegistry]).ok).toBe(true);

    const target = workspace(tampered);
    const result = await executor().install(target);
    expect(result).toMatchObject({ ok: false, code: 'CODING_INSTALL_FAILED' });
    expect(result.ok ? '' : result.output).toMatch(/EINTEGRITY|integrity/iu);
    expect(existsSync(join(target.repo, 'node_modules', 'chm-dep', 'package.json'))).toBe(false);
    expect(await installContainers()).toEqual([]);
  });

  it('refuses a lockfile that pins a source outside the allowed registry before any container starts', async () => {
    const lock = JSON.parse(lockText) as { packages: Record<string, { resolved?: string }> };
    lock.packages['node_modules/chm-dep']!.resolved = 'https://registry.example.invalid/chm-dep/-/chm-dep-1.0.0.tgz';
    expect(admitNpmLockfile(JSON.stringify(lock), [registry!.npmRegistry])).toEqual({ ok: false, reason: 'chm-dep is not from an allowed registry' });
  });
});
