import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HarnessError } from '@cloud-harness/contracts';
import {
  admitNpmLockfile,
  installContainerName,
  LockfileInstallExecutor,
  NPM_LOCKFILE_INSTALL_SCRIPT,
  npmInstallContainerArgs
} from '../src/agent-governance/install-executor.js';

const REGISTRY = 'https://registry.npmjs.org/';
const integrity = (seed: string) => `sha512-${createHash('sha512').update(seed).digest('base64')}`;

function lockfile(packages: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', dependencies: {} }, ...packages }, ...extra });
}

const entry = (name: string, version = '1.0.0') => ({
  version, resolved: `${REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: integrity(name)
});

describe('npm lockfile admission', () => {
  it('admits registry tarballs pinned with sha512 integrity', () => {
    const admitted = admitNpmLockfile(lockfile({
      'node_modules/left-pad': entry('left-pad'),
      'node_modules/@scope/util': entry('@scope/util', '2.1.0'),
      'node_modules/left-pad/node_modules/bundled': { version: '1.0.0', inBundle: true }
    }), [REGISTRY]);
    expect(admitted).toEqual({
      ok: true,
      packages: [
        { name: 'left-pad', version: '1.0.0', registryHost: 'registry.npmjs.org' },
        { name: '@scope/util', version: '2.1.0', registryHost: 'registry.npmjs.org' }
      ]
    });
  });

  it.each([
    ['a git dependency', { 'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/x.git#abc', integrity: integrity('x') } }],
    ['a file dependency', { 'node_modules/x': { version: '1.0.0', resolved: 'file:../x', integrity: integrity('x') } }],
    ['a link', { 'node_modules/x': { link: true, resolved: 'packages/x' } }],
    ['another registry', { 'node_modules/x': { ...entry('x'), resolved: 'https://evil.example.com/x/-/x-1.0.0.tgz' } }],
    ['credentials in the URL', { 'node_modules/x': { ...entry('x'), resolved: 'https://user:pw@registry.npmjs.org/x/-/x-1.0.0.tgz' } }],
    ['a sha1 integrity', { 'node_modules/x': { ...entry('x'), integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }],
    ['a missing integrity', { 'node_modules/x': { version: '1.0.0', resolved: `${REGISTRY}x/-/x-1.0.0.tgz` } }],
    ['an unpinned entry', { 'node_modules/x': {} }],
    ['a workspace package', { 'packages/x': { version: '1.0.0' } }],
    ['an invalid name', { 'node_modules/X Y': entry('x') }]
  ])('refuses %s', (_label, packages) => {
    expect(admitNpmLockfile(lockfile(packages), [REGISTRY]).ok).toBe(false);
  });

  it('refuses lockfile v1, workspaces and malformed input', () => {
    expect(admitNpmLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }), [REGISTRY]).ok).toBe(false);
    expect(admitNpmLockfile(lockfile({}, {}).replace('"dependencies":{}', '"workspaces":["packages/*"]'), [REGISTRY]).ok).toBe(false);
    expect(admitNpmLockfile('{', [REGISTRY]).ok).toBe(false);
    expect(admitNpmLockfile('[]', [REGISTRY]).ok).toBe(false);
    expect(admitNpmLockfile(' '.repeat(1_048_577), [REGISTRY]).ok).toBe(false);
  });
});

describe('install container', () => {
  const spec = {
    name: installContainerName(), image: 'executor:test', instanceId: 'instance-1', workspaceId: 'ws_abc',
    workspacePath: '/var/lib/cloud-harness/jobs/ws_abc', registry: REGISTRY,
    networkArgs: ['--network', 'cloud-harness-dependency-access', '--dns', '8.8.8.8']
  };

  it('mounts only the checkout and runs a frozen, script-free install under the executor hardening', () => {
    const args = npmInstallContainerArgs(spec);
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args.filter((arg) => arg === '--mount' || arg === '--volume' || arg === '-v')).toEqual(['--mount']);
    expect(args).toContain(`type=bind,source=${spec.workspacePath}/repo,target=/workspace`);
    expect(joined).toContain('--network cloud-harness-dependency-access');
    for (const hardening of ['--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 10001:10001', '--pids-limit 256', '--memory 1g']) {
      expect(joined).toContain(hardening);
    }
    expect(joined).not.toMatch(/docker\.sock|--privileged|--env-file|TOKEN|SECRET|--cap-add/u);
    expect(args).toContain('npm_config_ignore_scripts=true');
    expect(NPM_LOCKFILE_INSTALL_SCRIPT).toContain('npm ci --ignore-scripts');
    expect(NPM_LOCKFILE_INSTALL_SCRIPT).toContain('/node_modules/');
    // The registry is a positional argument to a fixed script, never part of the script text.
    expect(args.slice(-4)).toEqual(['-c', NPM_LOCKFILE_INSTALL_SCRIPT, 'coding-install', REGISTRY]);
  });

  it('rejects identities and paths that could inject options', () => {
    expect(() => npmInstallContainerArgs({ ...spec, name: 'other' })).toThrow(HarnessError);
    expect(() => npmInstallContainerArgs({ ...spec, workspaceId: 'ws_a,b' })).toThrow(HarnessError);
    expect(() => npmInstallContainerArgs({ ...spec, workspacePath: 'relative/path' })).toThrow(HarnessError);
    expect(() => npmInstallContainerArgs({ ...spec, workspacePath: '/jobs/a,readonly=false' })).toThrow(HarnessError);
    expect(() => npmInstallContainerArgs({ ...spec, registry: 'https://user:pw@registry.npmjs.org/' })).toThrow(HarnessError);
  });
});

describe('LockfileInstallExecutor', () => {
  const target = { workspaceId: 'ws_abc', workspacePath: '/var/lib/cloud-harness/jobs/ws_abc' };

  it('attests dependency-access first and fails closed when it is unavailable', async () => {
    const run = vi.fn();
    const executor = new LockfileInstallExecutor({
      image: 'executor:test', instanceId: 'i', registry: REGISTRY, run, remove: vi.fn(async () => undefined),
      network: {
        ensureProfileReady: async () => { throw new HarnessError('DEPENDENCY_EGRESS_UNAVAILABLE', 'no attestation', 503, false); },
        dockerLaunchArgs: () => ['--network', 'none']
      }
    });
    await expect(executor.install(target)).rejects.toMatchObject({ code: 'DEPENDENCY_EGRESS_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one container on the dependency-access profile and removes it by name', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: 'npm ERR! integrity', exitCode: 1, truncated: false }));
    const remove = vi.fn(async () => undefined);
    const profiles: string[] = [];
    const executor = new LockfileInstallExecutor({
      image: 'executor:test', instanceId: 'i', registry: REGISTRY, run, remove,
      network: {
        ensureProfileReady: async (profile) => { profiles.push(profile); },
        dockerLaunchArgs: (profile) => { profiles.push(profile); return ['--network', 'deps']; }
      }
    });
    expect(await executor.install(target)).toMatchObject({ ok: false, code: 'CODING_INSTALL_FAILED', exitCode: 1 });
    expect(profiles).toEqual(['dependency-access', 'dependency-access']);
    const args = run.mock.calls[0]?.[0] as string[];
    expect(remove).toHaveBeenCalledWith(args[args.indexOf('--name') + 1]);
  });
});
