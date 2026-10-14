import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import { HarnessError } from '@cloud-harness/contracts';

/**
 * A fake Docker CLI behind `spawn`. Builder `run`s produce scripted output (and, for an apply, can write the
 * staged tree the real builder would), toolbox `create`/`start` produce a scripted launch-check exit status,
 * and the container table lets every test assert that nothing is left behind.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { end: () => undefined };
  private closed = false;
  kill(): boolean {
    this.close(137);
    return true;
  }
  close(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit('close', code, null));
  }
}

type BuilderScript = { stdout: string; stderr: string; exitCode: number; hang: boolean; stage?: (stagingDir: string) => void };
const daemon = vi.hoisted(() => ({
  containers: new Map<string, { attach?: unknown; started: boolean; exitCode: number }>(),
  calls: [] as string[][],
  builder: { stdout: '', stderr: '', exitCode: 0, hang: false } as BuilderScript,
  launchExit: 0,
  imageId: `sha256:${'a'.repeat(64)}`
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn((_command: string, args: string[]) => fakeDocker(args))
}));

/** Output is always delivered before the close, whatever event-loop phase the fake was called from. */
function finish(child: FakeChild, code: number, stdout = '', stderr = ''): void {
  setTimeout(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.close(code);
  }, 1);
}

function fakeDocker(args: string[]): FakeChild {
  daemon.calls.push(args);
  const child = new FakeChild();
  const name = args.includes('--name') ? args[args.indexOf('--name') + 1]! : args.at(-1)!;
  if (args[0] === 'image') {
    finish(child, 0, `${daemon.imageId}\n`);
  } else if (args[0] === 'run' && name.startsWith('chm-pkgbuild-')) {
    const container = { attach: child, started: true, exitCode: 0 };
    daemon.containers.set(name, container);
    const staging = args.find((value) => value.startsWith('type=bind,') && value.includes('target=/opt/chm-packages/'));
    const script = daemon.builder;
    if (script.stage && staging) script.stage(/source=([^,]+)/.exec(staging)![1]!);
    setTimeout(() => {
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
      if (!script.hang) {
        daemon.containers.delete(name);
        child.close(script.exitCode);
      }
    }, 1);
  } else if (args[0] === 'run') {
    finish(child, 0);
  } else if (args[0] === 'create') {
    daemon.containers.set(name, { started: false, exitCode: 0 });
    finish(child, 0);
  } else if (args[0] === 'start') {
    const container = daemon.containers.get(name)!;
    container.started = true;
    container.exitCode = daemon.launchExit;
    finish(child, daemon.launchExit, 'chm-hello 1.0.0\n');
  } else if (args[0] === 'rm') {
    const container = daemon.containers.get(name);
    daemon.containers.delete(name);
    (container?.attach as FakeChild | undefined)?.close(137);
    finish(child, container ? 0 : 1, '', container ? '' : `Error response from daemon: No such container: ${name}`);
  } else if (args[0] === 'inspect') {
    const container = daemon.containers.get(name);
    const format = args[args.indexOf('--format') + 1] ?? '';
    if (!container) finish(child, 1, '', `error: no such object: ${name}`);
    else finish(child, 0, format.includes('StartedAt') ? `2026-10-13T09:00:00Z\t${container.exitCode}\n` : 'id\n');
  } else {
    finish(child, 1);
  }
  return child;
}

import {
  NPM_APPLY_SCRIPT, NPM_PLAN_SCRIPT, PACKAGE_BUILDER_MAX_OUTPUT_BYTES, PackageBuilder, UV_PLAN_SCRIPT, buildPackageBuilderArgs,
  launchCheckCommand, parseApplyRuntime, parseNpmPlanOutput, parseUvLock, parseUvPlanOutput, probeHost, uvRequirement, verifyReleaseTree,
  type PackageBuilderRunSpec
} from '../src/package-builder.js';
import { EXECUTOR_HARDENING_ARGS } from '../src/toolbox-runner.js';

const instanceId = 'b'.repeat(36);
const releaseId = 'pkr_abcdefghijklmnopqrstuv';
const registry = 'https://registry.npmjs.org/';
const sha512 = (seed: string) => `sha512-${Buffer.from(seed.padEnd(64, seed)).toString('base64')}`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]!] : []));
}

function runSpec(overrides: Partial<PackageBuilderRunSpec> = {}): PackageBuilderRunSpec {
  return {
    name: 'chm-pkgbuild-0123456789abcdef',
    image: 'cloud-harness-executor:local',
    instanceId,
    network: 'cloud-harness-mcp_provisioning',
    proxy: 'http://provisioning-proxy:3128',
    npmRegistry: registry,
    pypiIndex: 'https://pypi.org/simple',
    pythonMirror: undefined,
    scratchDir: '/var/lib/cloud-harness/packages/scratch/pkp_abcdefghijklmnopqrstuv',
    script: NPM_PLAN_SCRIPT,
    args: ['chm-hello', '1.0.0'],
    ...overrides
  };
}

function npmLock(overrides: Record<string, Record<string, unknown>> = {}): string {
  return JSON.stringify({
    name: 'chm-release',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'chm-release', dependencies: { 'chm-hello': '1.0.0' } },
      'node_modules/chm-hello': {
        version: '1.0.0', resolved: `${registry}chm-hello/-/chm-hello-1.0.0.tgz`, integrity: sha512('h'),
        bin: { 'chm-hello': 'bin/chm-hello.mjs' }, dependencies: { 'chm-dep': '^1.0.0' }
      },
      'node_modules/chm-dep': { version: '1.0.0', resolved: `${registry}chm-dep/-/chm-dep-1.0.0.tgz`, integrity: sha512('d') },
      'node_modules/chm-devtool': { version: '2.0.0', dev: true },
      ...overrides
    }
  });
}

function npmPlanOutput(lock = npmLock(), view: unknown = { 'dist.unpackedSize': 4_096, bin: { 'chm-hello': 'bin/chm-hello.mjs' } }): string {
  return JSON.stringify({ packageJson: '{"name":"chm-release","private":true,"dependencies":{"chm-hello":"1.0.0"}}', lock, view, node: '24.11.0', npm: '11.6.1' });
}

const uvLockText = [
  'chm-dep==2.0.0 \\',
  `    --hash=sha256:${hash('d')}`,
  '    # via chm-hello',
  'chm-hello==1.0.0 \\',
  `    --hash=sha256:${hash('a')} \\`,
  `    --hash=sha256:${hash('b')}`,
  '    # via -r requirements.in',
  ''
].join('\n');

describe('builder container argv', () => {
  it('runs a labelled, hardened builder with only scratch mounted and no socket, env file, or credentials', () => {
    const args = buildPackageBuilderArgs(runSpec());
    expect(args.slice(0, 6)).toEqual(['run', '--rm', '--pull', 'never', '--name', 'chm-pkgbuild-0123456789abcdef']);
    expect(args.join('\n')).toContain(EXECUTOR_HARDENING_ARGS.join('\n'));
    expect(flagValues(args, '--label')).toEqual([
      'cloud-harness.role=package-builder', 'cloud-harness.ephemeral=true', `cloud-harness.instance=${instanceId}`
    ]);
    expect(flagValues(args, '--network')).toEqual(['cloud-harness-mcp_provisioning']);
    expect(flagValues(args, '--mount')).toEqual(['type=bind,source=/var/lib/cloud-harness/packages/scratch/pkp_abcdefghijklmnopqrstuv,target=/work']);
    expect(flagValues(args, '--env')).toEqual([
      'HTTP_PROXY=http://provisioning-proxy:3128', 'HTTPS_PROXY=http://provisioning-proxy:3128', 'NO_PROXY=localhost,127.0.0.1',
      'npm_config_proxy=http://provisioning-proxy:3128', 'npm_config_https_proxy=http://provisioning-proxy:3128',
      'HOME=/work/home', 'npm_config_cache=/work/npm-cache', `npm_config_registry=${registry}`, 'npm_config_update_notifier=false',
      'UV_CACHE_DIR=/work/uv-cache', 'UV_PYTHON_PREFERENCE=only-managed', 'UV_INDEX_URL=https://pypi.org/simple', 'UV_LINK_MODE=copy'
    ]);
    expect(flagValues(args, '--workdir')).toEqual(['/work']);
    for (const forbidden of ['--env-file', '--volume', '-v', '--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns', '--entrypoint']) {
      expect(args, forbidden).not.toContain(forbidden);
    }
    expect(args.join('\n')).not.toMatch(/docker\.sock|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|_authToken|SERVICE_TOKEN/);
    expect(args.slice(-7)).toEqual(['cloud-harness-executor:local', '/bin/bash', '-c', NPM_PLAN_SCRIPT, 'package-builder', 'chm-hello', '1.0.0']);
  });

  it('mounts staging at the final release path for an apply, and adds the Python mirror only when configured', () => {
    const args = buildPackageBuilderArgs(runSpec({
      staging: { source: `/var/lib/cloud-harness/packages/staging/${releaseId}`, releaseId },
      script: NPM_APPLY_SCRIPT, args: [releaseId, 'deny', 'chm-hello'], proxy: undefined, pythonMirror: 'http://fake-registry:4873/python'
    }));
    expect(flagValues(args, '--mount')).toEqual([
      'type=bind,source=/var/lib/cloud-harness/packages/scratch/pkp_abcdefghijklmnopqrstuv,target=/work',
      `type=bind,source=/var/lib/cloud-harness/packages/staging/${releaseId},target=/opt/chm-packages/${releaseId}`
    ]);
    const env = flagValues(args, '--env');
    expect(env.some((entry) => /PROXY|proxy=/.test(entry))).toBe(false);
    expect(env).toContain('UV_PYTHON_INSTALL_MIRROR=http://fake-registry:4873/python');
  });

  it('passes user values only as positional arguments after the fixed script', () => {
    const hostile = ['chm-hello', '>=1 <2 $(touch /tmp/x) `id`'];
    const args = buildPackageBuilderArgs(runSpec({ args: hostile }));
    const scriptIndex = args.indexOf('-c') + 1;
    expect(args[scriptIndex]).toBe(NPM_PLAN_SCRIPT);
    expect(args.slice(scriptIndex + 1)).toEqual(['package-builder', ...hostile]);
    // Every script reads its inputs from quoted positional parameters only.
    for (const script of [NPM_PLAN_SCRIPT, NPM_APPLY_SCRIPT, UV_PLAN_SCRIPT]) {
      expect(script).not.toContain('eval');
      expect(script.startsWith('set -euo pipefail\n')).toBe(true);
    }
    expect(NPM_PLAN_SCRIPT).toContain('-- "$name@$spec"');
  });

  it('refuses names, networks, mounts, URLs, and arguments that could widen the container', () => {
    expect(() => buildPackageBuilderArgs(runSpec({ name: 'other' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ network: 'host' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ instanceId: 'a\nb' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ scratchDir: '/srv/a,readonly=false' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ scratchDir: 'relative' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ staging: { source: '/srv/s', releaseId: '../etc' } }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ npmRegistry: 'https://user:secret@registry.example/' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ proxy: 'https://proxy:3128' }))).toThrow(HarnessError);
    expect(() => buildPackageBuilderArgs(runSpec({ args: ['a\0b'] }))).toThrow(HarnessError);
  });

  it('builds launch-check commands only from validated release ids and binary names', () => {
    expect(launchCheckCommand(releaseId, 'chm-hello')).toBe(`B=/opt/chm-packages/${releaseId}/bin/chm-hello; "$B" --version || "$B" --help`);
    expect(() => launchCheckCommand(releaseId, 'a;b')).toThrow(HarnessError);
    expect(() => launchCheckCommand('pkr_short', 'a')).toThrow(HarnessError);
  });

  it('maps uv specifiers to requirements', () => {
    expect(uvRequirement('ruff', '')).toBe('ruff');
    expect(uvRequirement('ruff', 'latest')).toBe('ruff');
    expect(uvRequirement('ruff', '0.6.1')).toBe('ruff==0.6.1');
    expect(uvRequirement('ruff', '>=0.6,<0.7')).toBe('ruff>=0.6,<0.7');
  });
});

describe('builder output parsers', () => {
  it('reads an npm plan from the lock: pinned version, root binaries, transitive count, and size', () => {
    const plan = parseNpmPlanOutput(npmPlanOutput(), 'chm-hello', registry);
    expect(plan).toMatchObject({
      version: '1.0.0',
      source: { registry, resolved: `${registry}chm-hello/-/chm-hello-1.0.0.tgz` },
      integrity: sha512('h'),
      dependencyCount: 1,
      sizeEstimateBytes: 4_096,
      binaries: ['chm-hello'],
      runtime: { node: '24.11.0', npm: '11.6.1', uv: null, python: null }
    });
    expect(plan.lockSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(plan.lockText)).toEqual({ packageJson: expect.any(String), lock: npmLock() });
    // `npm view` prints a bare value when it has only one of the requested fields.
    expect(parseNpmPlanOutput(npmPlanOutput(npmLock(), 77), 'chm-hello', registry).sizeEstimateBytes).toBe(77);
  });

  it('refuses tarballs from any host other than the registry', () => {
    const foreign = npmLock({ 'node_modules/chm-dep': { version: '1.0.0', resolved: 'https://evil.example/chm-dep.tgz', integrity: sha512('d') } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(foreign), 'chm-hello', registry)).toThrow(/evil\.example/);
    const downgraded = npmLock({ 'node_modules/chm-dep': { version: '1.0.0', resolved: 'http://registry.npmjs.org/chm-dep.tgz', integrity: sha512('d') } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(downgraded), 'chm-hello', registry)).toThrow(HarnessError);
    const git = npmLock({ 'node_modules/chm-dep': { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/b.git', integrity: sha512('d') } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(git), 'chm-hello', registry)).toThrow(HarnessError);
    const linked = npmLock({ 'node_modules/chm-dep': { resolved: '../chm-dep', link: true } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(linked), 'chm-hello', registry)).toThrow(/links/);
    const unhashed = npmLock({ 'node_modules/chm-dep': { version: '1.0.0', resolved: `${registry}chm-dep.tgz`, integrity: 'sha1-abc=' } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(unhashed), 'chm-hello', registry)).toThrow(/sha512/);
  });

  it('refuses a package with no or unsupported binaries', () => {
    const noBin = npmLock({ 'node_modules/chm-hello': { version: '1.0.0', resolved: `${registry}x.tgz`, integrity: sha512('h') } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(noBin), 'chm-hello', registry)).toThrow(/no binaries/);
    const badBin = npmLock({ 'node_modules/chm-hello': { version: '1.0.0', resolved: `${registry}x.tgz`, integrity: sha512('h'), bin: { '../x': 'x.js' } } });
    expect(() => parseNpmPlanOutput(npmPlanOutput(badBin), 'chm-hello', registry)).toThrow(/unsupported binary name/);
  });

  it('refuses oversized, malformed, and unexpected builder output', () => {
    const failure = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error;
      }
      throw new Error('expected a failure');
    };
    expect(failure(() => parseNpmPlanOutput('x'.repeat(PACKAGE_BUILDER_MAX_OUTPUT_BYTES + 1), 'chm-hello', registry))).toMatchObject({ code: 'PACKAGE_BUILD_FAILED', message: expect.stringMatching(/exceeds/) });
    expect(failure(() => parseNpmPlanOutput('{"packageJson":', 'chm-hello', registry))).toMatchObject({ code: 'PACKAGE_BUILD_FAILED', message: expect.stringMatching(/not valid JSON/) });
    expect(failure(() => parseNpmPlanOutput(JSON.stringify({ ...JSON.parse(npmPlanOutput()), extra: 1 }), 'chm-hello', registry))).toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });
    expect(failure(() => parseNpmPlanOutput(npmPlanOutput('{"lockfileVersion":1,"packages":{}}'), 'chm-hello', registry))).toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });
    expect(failure(() => parseApplyRuntime('{"node":"24.11.0"}', 'npm'))).toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });
    expect(parseApplyRuntime('{"uv":"uv 0.9.5 (abc 2025-10-01)","python":"3.12.12"}', 'uv')).toEqual({ node: null, npm: null, uv: '0.9.5', python: '3.12.12' });
  });

  it('accepts only hash-pinned uv locks', () => {
    expect(parseUvLock(uvLockText, 'CHM_Hello')).toEqual({
      version: '1.0.0', dependencyCount: 1, sbom: [{ name: 'chm-dep', version: '2.0.0' }, { name: 'chm-hello', version: '1.0.0' }]
    });
    expect(() => parseUvLock('chm-hello==1.0.0\n', 'chm-hello')).toThrow(/hash-pin/);
    expect(() => parseUvLock(`--index-url https://evil.example/simple\n${uvLockText}`, 'chm-hello')).toThrow(/unexpected line/);
    expect(() => parseUvLock(`-e ./local\n${uvLockText}`, 'chm-hello')).toThrow(/unexpected line/);
    expect(() => parseUvLock(`chm-hello @ https://evil.example/x.whl \\\n    --hash=sha256:${hash('a')}\n`, 'chm-hello')).toThrow(/unexpected line/);
    expect(() => parseUvLock(uvLockText, 'other')).toThrow(/does not pin/);
  });

  it('reads a uv plan with its console scripts and runtime', () => {
    const output = JSON.stringify({ lock: uvLockText, pythonVersion: '3.12.12', uvVersion: 'uv 0.9.5 (abc 2025-10-01)', scripts: ['chm-hello-py', 'chm-hello-py'], sizeBytes: 9_000 });
    expect(parseUvPlanOutput(output, 'chm-hello', 'https://pypi.org/simple')).toMatchObject({
      version: '1.0.0', integrity: null, dependencyCount: 1, sizeEstimateBytes: 9_000, binaries: ['chm-hello-py'],
      source: { registry: 'https://pypi.org/simple', resolved: 'https://pypi.org/simple/chm-hello/' },
      runtime: { node: null, npm: null, uv: '0.9.5', python: '3.12.12' }
    });
    const badScript = JSON.stringify({ ...JSON.parse(output), scripts: ['a b'] });
    expect(() => parseUvPlanOutput(badScript, 'chm-hello', 'https://pypi.org/simple')).toThrow(/unsupported binary name/);
  });
});

describe('release tree verification', () => {
  let root: string;
  let staging: string;
  const mount = `/opt/chm-packages/${releaseId}`;

  /** A valid npm-shaped release: bin -> .bin -> package script, plus an absolute link inside the release. */
  function stageValidRelease(): void {
    mkdirSync(join(staging, 'npm/node_modules/.bin'), { recursive: true });
    mkdirSync(join(staging, 'npm/node_modules/chm-hello'), { recursive: true });
    mkdirSync(join(staging, 'bin'));
    writeFileSync(join(staging, 'npm/node_modules/chm-hello/cli.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
    symlinkSync('../chm-hello/cli.mjs', join(staging, 'npm/node_modules/.bin/chm-hello'));
    symlinkSync('../npm/node_modules/.bin/chm-hello', join(staging, 'bin/chm-hello'));
    symlinkSync(`${mount}/npm/node_modules/chm-hello`, join(staging, 'npm/absolute-inside'));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'package-builder-tree-'));
    staging = join(root, releaseId);
    mkdirSync(staging);
    stageValidRelease();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const verify = (binaries = ['chm-hello'], max = 1_048_576) => verifyReleaseTree(staging, releaseId, binaries, max);

  it('accepts a contained release and returns a stable digest', async () => {
    const first = await verify();
    expect(first).toMatchObject({ fileCount: 4, treeDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await verify()).toEqual(first);
  });

  it('refuses symlinks that resolve outside the release', async () => {
    for (const [path, target] of [
      ['npm/up', '../../..'],
      ['npm/etc', '/etc/passwd'],
      ['npm/sibling', `/opt/chm-packages/pkr_otherreleaseidentifier/bin`],
      ['npm/prefix-trick', `${mount}-evil/bin`]
    ] as const) {
      symlinkSync(target, join(staging, path));
      await expect(verify(), path).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/outside the release/) });
      rmSync(join(staging, path));
    }
  });

  it('follows symlink components the way the kernel does, not lexically', async () => {
    // `deep/a/b/root` points at the release root, so `deep/a/b/root/..` is the parent of the release even though
    // the text `deep/a/b/root/..` normalizes to a path inside it.
    mkdirSync(join(staging, 'deep/a/b'), { recursive: true });
    symlinkSync(mount, join(staging, 'deep/a/b/root'));
    symlinkSync('deep/a/b/root/..', join(staging, 'escape'));
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED' });
    rmSync(join(staging, 'escape'));
    symlinkSync('loop', join(staging, 'loop'));
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED' });
  });

  it('refuses special files and setuid, setgid, or sticky bits', async () => {
    const { execFileSync } = await vi.importActual<typeof ChildProcess>('node:child_process');
    execFileSync('mkfifo', [join(staging, 'npm/fifo')]);
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/special file/) });
    rmSync(join(staging, 'npm/fifo'));

    chmodSync(join(staging, 'npm/node_modules/chm-hello/cli.mjs'), 0o4755);
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/setuid/) });
    chmodSync(join(staging, 'npm/node_modules/chm-hello/cli.mjs'), 0o755);

    chmodSync(join(staging, 'npm'), 0o1777);
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/sticky/) });
  });

  it('refuses a bin directory that differs from the plan or does not reach an executable', async () => {
    await expect(verify(['chm-hello', 'other'])).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/planned binaries/) });
    chmodSync(join(staging, 'npm/node_modules/chm-hello/cli.mjs'), 0o644);
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/executable/) });
    rmSync(join(staging, 'bin'), { recursive: true });
    await expect(verify()).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/no bin directory/) });
  });

  it('reports an oversized release as LIMIT_EXCEEDED', async () => {
    writeFileSync(join(staging, 'npm/blob'), Buffer.alloc(4_096));
    await expect(verify(['chm-hello'], 1_024)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('provisioning proxy probe', () => {
  let server: Server;
  let port: number;
  const statusFor = new Map<string, string>([
    ['registry.npmjs.org', 'HTTP/1.1 200 Connection Established\r\n\r\n'],
    ['pypi.org', 'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden\r\n'],
    ['bad.example', 'HTTP/1.1 502 Bad Gateway\r\n\r\n']
  ]);
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = chunk.toString('latin1');
        requests.push(request);
        const host = /^CONNECT ([^:]+):443 /.exec(request)?.[1] ?? '';
        socket.end(statusFor.get(host) ?? 'garbage');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  it('passes on 200 and sends a bare CONNECT to port 443', async () => {
    await expect(probeHost(`http://127.0.0.1:${port}`, 'registry.npmjs.org')).resolves.toBeUndefined();
    expect(requests.at(-1)).toBe('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
  });

  it('maps 403 to UNAVAILABLE naming the host and PACKAGES_PROXY_HOSTS', async () => {
    await expect(probeHost(`http://127.0.0.1:${port}`, 'pypi.org')).rejects.toMatchObject({
      code: 'UNAVAILABLE', message: 'provisioning proxy refuses pypi.org: the operator must add pypi.org to PACKAGES_PROXY_HOSTS'
    });
  });

  it('maps other statuses, garbage, and an unreachable proxy to UNAVAILABLE', async () => {
    await expect(probeHost(`http://127.0.0.1:${port}`, 'bad.example')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringMatching(/status 502/) });
    await expect(probeHost(`http://127.0.0.1:${port}`, 'unknown.example')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));
    await expect(probeHost(`http://127.0.0.1:${closedPort}`, 'registry.npmjs.org')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringMatching(/unreachable/) });
  });

  it('refuses hosts that could inject into the request', async () => {
    await expect(probeHost(`http://127.0.0.1:${port}`, 'a.example\r\nX: y')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(probeHost(`https://127.0.0.1:${port}`, 'a.example')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('PackageBuilder against a fake Docker CLI', () => {
  let root: string;
  const builderCalls = () => daemon.calls.filter((args) => args[0] === 'run' && args[args.indexOf('--name') + 1]!.startsWith('chm-pkgbuild-'));
  const builder = (overrides: Partial<ConstructorParameters<typeof PackageBuilder>[0]> = {}) => new PackageBuilder({
    executorImage: 'cloud-harness-executor:local', instanceId, packagesRoot: root, provisioningNetwork: 'cloud-harness-mcp_provisioning',
    proxy: 'http://provisioning-proxy:3128', planTimeoutMs: 5_000, ...overrides
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'package-builder-root-'));
    daemon.containers.clear();
    daemon.calls.length = 0;
    daemon.builder = { stdout: '', stderr: '', exitCode: 0, hang: false };
    daemon.launchExit = 0;
  });
  afterEach(() => {
    expect([...daemon.containers.keys()]).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an npm plan in a builder pinned to the image id, then confirms the container is gone', async () => {
    daemon.builder = { stdout: npmPlanOutput(), stderr: 'added 2 packages\n', exitCode: 0, hang: false };
    const plan = await builder().resolvePlan({ scratchId: 'pkp_abcdefghijklmnopqrstuv', ecosystem: 'npm', name: 'chm-hello', requestedSpec: 'latest', lifecycleScripts: false });
    expect(plan).toMatchObject({ version: '1.0.0', binaries: ['chm-hello'], runtime: { imageId: daemon.imageId, node: '24.11.0', npm: '11.6.1', uv: null, python: null } });
    const [run] = builderCalls();
    expect(run!.slice(-4)).toEqual([NPM_PLAN_SCRIPT, 'package-builder', 'chm-hello', 'latest']);
    expect(run).toContain(daemon.imageId);
    expect(flagValues(run!, '--mount')).toEqual([`type=bind,source=${join(root, 'scratch', 'pkp_abcdefghijklmnopqrstuv')},target=/work`]);
    const name = run![run!.indexOf('--name') + 1]!;
    expect(daemon.calls.some((args) => args[0] === 'inspect' && args.at(-1) === name)).toBe(true);
  });

  it('passes an empty uv specifier as a bare requirement', async () => {
    daemon.builder = {
      stdout: JSON.stringify({ lock: uvLockText, pythonVersion: '3.12.12', uvVersion: 'uv 0.9.5', scripts: ['chm-hello-py'], sizeBytes: 1 }),
      stderr: '', exitCode: 0, hang: false
    };
    const plan = await builder().resolvePlan({ scratchId: 'pkp_abcdefghijklmnopqrstuv', ecosystem: 'uv', name: 'chm-hello', requestedSpec: '', lifecycleScripts: false });
    expect(plan.runtime).toEqual({ imageId: daemon.imageId, node: null, npm: null, uv: '0.9.5', python: '3.12.12' });
    expect(builderCalls()[0]!.slice(-4)).toEqual(['package-builder', 'chm-hello', 'chm-hello', '']);
  });

  it('maps a failing script to PACKAGE_BUILD_FAILED with its output tail, and a Docker failure to UNAVAILABLE', async () => {
    daemon.builder = { stdout: '', stderr: 'npm error 404 Not Found - GET https://registry.npmjs.org/nope\n', exitCode: 1, hang: false };
    const spec = { scratchId: 'pkp_abcdefghijklmnopqrstuv', ecosystem: 'npm' as const, name: 'nope', requestedSpec: 'latest', lifecycleScripts: false };
    await expect(builder().resolvePlan(spec)).rejects.toMatchObject({ code: 'PACKAGE_BUILD_FAILED', message: expect.stringMatching(/404 Not Found/) });
    daemon.builder = { stdout: '', stderr: 'docker: Error response from daemon: network not found.\n', exitCode: 125, hang: false };
    await expect(builder().resolvePlan(spec)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('stops and removes a builder that outlives its timeout or is aborted', async () => {
    daemon.builder = { stdout: '', stderr: 'resolving\n', exitCode: 0, hang: true };
    const spec = { scratchId: 'pkp_abcdefghijklmnopqrstuv', ecosystem: 'npm' as const, name: 'chm-hello', requestedSpec: 'latest', lifecycleScripts: false };
    await expect(builder({ planTimeoutMs: 30 }).resolvePlan(spec)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController();
    const pending = builder().resolvePlan({ ...spec, signal: controller.signal });
    await vi.waitFor(() => expect(builderCalls()).toHaveLength(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses invalid plan input before any container starts', async () => {
    const spec = { scratchId: 'pkp_abcdefghijklmnopqrstuv', ecosystem: 'npm' as const, name: 'chm-hello', requestedSpec: 'latest', lifecycleScripts: false };
    await expect(builder().resolvePlan({ ...spec, requestedSpec: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(builder().resolvePlan({ ...spec, requestedSpec: 'git+https://x/y' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(builder().resolvePlan({ ...spec, name: '-rf' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(builder().resolvePlan({ ...spec, python: '3.12' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(builder().resolvePlan({ ...spec, scratchId: '../x' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(daemon.calls).toEqual([]);
  });

  it('probes the registry hosts through the proxy, and skips the probe without a proxy', async () => {
    expect(builder().registryHosts('npm')).toEqual(['registry.npmjs.org']);
    expect(builder().registryHosts('uv')).toEqual(['pypi.org', 'files.pythonhosted.org', 'github.com', 'release-assets.githubusercontent.com']);
    expect(builder({ pypiIndex: 'http://fake-registry:4873/simple', pythonMirror: 'http://fake-registry:4873/python' }).registryHosts('uv')).toEqual(['fake-registry']);
    await expect(builder({ proxy: undefined }).probeRegistries('npm')).resolves.toBeUndefined();
  });

  describe('apply builds', () => {
    const lockText = JSON.stringify({ packageJson: '{"name":"chm-release","private":true,"dependencies":{"chm-hello":"1.0.0"}}', lock: npmLock() });
    const job = (overrides: Record<string, unknown> = {}) => ({
      applyId: 'pka_abcdefghijklmnopqrstuv', releaseId, ecosystem: 'npm' as const, name: 'chm-hello', version: '1.0.0', lockText,
      binaries: ['chm-hello'], lifecycleScripts: false, stagingDir: join(root, 'staging', releaseId), maxReleaseBytes: 1_048_576,
      timeoutMs: 5_000, ...overrides
    });
    const stage = (stagingDir: string) => {
      mkdirSync(join(stagingDir, 'npm/node_modules/.bin'), { recursive: true });
      mkdirSync(join(stagingDir, 'npm/node_modules/chm-hello'), { recursive: true });
      mkdirSync(join(stagingDir, 'bin'), { recursive: true });
      writeFileSync(join(stagingDir, 'npm/node_modules/chm-hello/cli.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
      symlinkSync('../chm-hello/cli.mjs', join(stagingDir, 'npm/node_modules/.bin/chm-hello'));
      symlinkSync('../npm/node_modules/.bin/chm-hello', join(stagingDir, 'bin/chm-hello'));
    };

    beforeEach(() => mkdirSync(join(root, 'staging', releaseId), { recursive: true }));

    it('builds, verifies, and launch-checks without network from the read-only final path', async () => {
      daemon.builder = { stdout: '{"node":"24.11.0","npm":"11.6.1"}', stderr: 'added 2 packages\n', exitCode: 0, hang: false, stage };
      const phases: string[] = [];
      const output: string[] = [];
      const result = await builder().build({ ...job(), onPhase: (phase) => { phases.push(phase); }, onOutput: (chunk) => output.push(chunk) });

      expect(phases).toEqual(['BUILDING', 'VERIFYING']);
      expect(output.join('')).toContain('added 2 packages');
      expect(result).toMatchObject({
        fileCount: 3,
        runtime: { imageId: daemon.imageId, node: '24.11.0', npm: '11.6.1', uv: null, python: null },
        launchChecks: { 'chm-hello': launchCheckCommand(releaseId, 'chm-hello') },
        provenance: { registry, builderImageId: daemon.imageId, lifecycleScripts: false, resolved: `${registry}chm-hello/-/chm-hello-1.0.0.tgz` }
      });
      expect(result.sbom.map((entry) => entry.name)).toEqual(['chm-dep', 'chm-hello']);

      const run = builderCalls()[0]!;
      expect(run.slice(-5)).toEqual([NPM_APPLY_SCRIPT, 'package-builder', releaseId, 'deny', 'chm-hello']);
      expect(flagValues(run, '--mount')).toContain(`type=bind,source=${join(root, 'staging', releaseId)},target=/opt/chm-packages/${releaseId}`);
      const create = daemon.calls.find((args) => args[0] === 'create')!;
      expect(flagValues(create, '--network')).toEqual(['none']);
      expect(flagValues(create, '--mount')).toEqual([`type=bind,source=${join(root, 'staging', releaseId)},target=/opt/chm-packages/${releaseId},readonly`]);
      expect(create.at(-1)).toBe(launchCheckCommand(releaseId, 'chm-hello'));
      // The builder was confirmed gone before the tree was read and the launch check began.
      const name = run[run.indexOf('--name') + 1]!;
      const inspected = daemon.calls.findIndex((args) => args[0] === 'inspect' && args.at(-1) === name);
      expect(inspected).toBeGreaterThan(-1);
      expect(inspected).toBeLessThan(daemon.calls.indexOf(create));
    });

    it('fails verification when a binary does not launch', async () => {
      daemon.builder = { stdout: '{"node":"24.11.0","npm":"11.6.1"}', stderr: '', exitCode: 0, hang: false, stage };
      daemon.launchExit = 1;
      await expect(builder().build(job())).rejects.toMatchObject({ code: 'PACKAGE_VERIFICATION_FAILED', message: expect.stringMatching(/launch check/) });
    });

    it('re-checks the approved lock and refuses a staging path outside the release layout', async () => {
      await expect(builder().build(job({ version: '2.0.0' }))).rejects.toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });
      await expect(builder({ npmRegistry: 'https://registry.example/' }).build(job())).rejects.toMatchObject({ code: 'PACKAGE_BUILD_FAILED' });
      await expect(builder().build(job({ stagingDir: join(root, 'elsewhere') }))).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(builderCalls()).toEqual([]);
    });

    it('passes lifecycle permission only when the plan asked for it', async () => {
      daemon.builder = { stdout: '{"node":"24.11.0","npm":"11.6.1"}', stderr: '', exitCode: 0, hang: false, stage };
      await builder().build(job({ lifecycleScripts: true }));
      expect(builderCalls()[0]!.slice(-3)).toEqual([releaseId, 'allow', 'chm-hello']);
    });
  });
});
