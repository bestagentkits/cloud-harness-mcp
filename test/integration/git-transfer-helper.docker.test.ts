import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitTransferRepositoryPath, gitTransferVolumes } from '../../apps/runner/src/workspace-service.js';

let volumeName: string;

function git(args: string[], cwd = '/job/repo'): string {
  return execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--volume', `${volumeName}:/job:rw`,
    '--entrypoint', 'git', 'cloud-harness-executor:local', '-C', cwd, ...args
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function helper(mode: string, repositoryUrl: string, repositoryPath: string, transferPath: string, argument = '', expectedRemoteOid = ''): void {
  execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001',
    '--volume', `${volumeName}:/job:rw`, '--entrypoint', '/opt/harness/git-transfer-helper.sh',
    'cloud-harness-executor:local', mode, repositoryUrl, repositoryPath, transferPath, argument, expectedRemoteOid
  ], { input: '\n', stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeAll(() => {
  volumeName = `cloud-harness-git-helper-${randomBytes(8).toString('hex')}`;
  execFileSync('docker', ['volume', 'create', volumeName], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '--rm', '--user', '0:0', '--volume', `${volumeName}:/job:rw`, '--entrypoint', '/bin/sh',
    'cloud-harness-executor:local', '-c', 'chown 10001:10001 /job'
  ], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--volume', `${volumeName}:/job:rw`,
    '--entrypoint', '/bin/bash', 'cloud-harness-executor:local', '-lc',
    'set -e; git init --initial-branch=main /job/repo; git -C /job/repo config user.name "Harness Test"; git -C /job/repo config user.email harness@example.invalid; printf "transfer helper test\\n" > /job/repo/README.md; git -C /job/repo add README.md; git -C /job/repo commit -m "test: seed transfer helper"; git init --bare --initial-branch=main /job/remote.git; git -C /job/repo remote add origin /job/remote.git; git -C /job/repo push origin main; git init --initial-branch=main /job/target'
  ], { stdio: 'ignore' });
});

afterAll(() => {
  if (volumeName?.startsWith('cloud-harness-git-helper-')) execFileSync('docker', ['volume', 'rm', '--force', volumeName], { stdio: 'ignore' });
});

describe('credential-isolated Git transfer helper', () => {
  it('stages and pushes through a clean bare transfer repository', () => {
    helper('stage-push', '/job/remote.git', '/job/repo', '/job/push-transfer');
    helper('push', '/job/remote.git', '/job/repo', '/job/push-transfer', 'main:refs/heads/main');

    const source = git(['rev-parse', 'HEAD']);
    const remote = git(['--git-dir=/job/remote.git', 'rev-parse', 'refs/heads/main'], '/job');
    expect(remote).toBe(source);
  });

  it('fetches remotely before importing without credentials or network', () => {
    helper('fetch', '/job/remote.git', '/job/target', '/job/fetch-transfer', 'refs/heads/main');
    helper('import', '/job/remote.git', '/job/target', '/job/fetch-transfer', 'refs/heads/main');

    const fetched = git(['rev-parse', 'FETCH_HEAD'], '/job/target');
    const tracking = git(['rev-parse', 'refs/remotes/origin/main'], '/job/target');
    const remote = git(['--git-dir=/job/remote.git', 'rev-parse', 'refs/heads/main'], '/job');
    expect(fetched).toBe(remote);
    expect(tracking).toBe(remote);
  });

  it('rejects a leased force push after a competing remote update', () => {
    const expectedRemoteOid = git(['--git-dir=/job/remote.git', 'rev-parse', 'refs/heads/main'], '/job');
    git(['clone', '/job/remote.git', '/job/competitor'], '/job');
    git(['config', 'user.name', 'Competing Writer'], '/job/competitor');
    git(['config', 'user.email', 'competitor@example.invalid'], '/job/competitor');
    git(['commit', '--allow-empty', '-m', 'test: competing update'], '/job/competitor');
    git(['push', 'origin', 'main'], '/job/competitor');
    const competingOid = git(['--git-dir=/job/remote.git', 'rev-parse', 'refs/heads/main'], '/job');

    git(['commit', '--allow-empty', '-m', 'test: local force candidate']);
    helper('stage-push', '/job/remote.git', '/job/repo', '/job/lease-transfer');
    expect(() => helper(
      'push', '/job/remote.git', '/job/repo', '/job/lease-transfer',
      'main:refs/heads/main', expectedRemoteOid
    )).toThrow();

    expect(git(['--git-dir=/job/remote.git', 'rev-parse', 'refs/heads/main'], '/job')).toBe(competingOid);
  });
});

describe('transfer repository isolation', () => {
  const image = 'cloud-harness-executor:local';
  let root: string;

  const asOwner = (script: string) => execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--volume', `${root}:/job:rw`,
    '--entrypoint', '/bin/bash', image, '-c', script
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  // Creates the transfer directory on the host the way the runner does before the helper starts: owned by
  // another UID, so the repository the helper creates inside it must still be accepted by Git.
  const transferDirectory = (name: string) => {
    execFileSync('docker', ['run', '--rm', '--user', '0:0', '--volume', `${root}:/job:rw`, '--entrypoint', '/bin/sh', image, '-c', `mkdir /job/${name} && chmod 0777 /job/${name}`], { stdio: 'ignore' });
  };
  const repositoryOf = (name: string) => gitTransferRepositoryPath(name);

  const transfer = (mode: 'fetch' | 'import' | 'stage-push' | 'push', name: string, argument = '', extraVolumes: string[] = []) => execFileSync('docker', [
    'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m',
    ...gitTransferVolumes(mode, root, name), ...extraVolumes,
    '--entrypoint', '/opt/harness/git-transfer-helper.sh', image, mode, '/job/remote.git', '/job/repo', repositoryOf(name), argument, ''
  ], { input: '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  // Stands in for any command the repository configures and Git runs during the transfer: it runs with
  // exactly the mounts the helper gets and tries to rewrite every other transfer repository it can see.
  const tamper = (volumes: string[]) => execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only', ...volumes, '--entrypoint', '/bin/bash', image, '-c',
    'for d in /job/git-transfer-*/repository.git; do [ -d "$d" ] || continue; git --git-dir="$d" update-ref refs/heads/main "$(git --git-dir="$d" rev-parse refs/heads/main^)" 2>/dev/null && echo "tampered $d"; done; true'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cloud-harness-transfer-isolation-'));
    execFileSync('docker', ['run', '--rm', '--user', '0:0', '--volume', `${root}:/job:rw`, '--entrypoint', '/bin/sh', image, '-c', 'chown 10001:10001 /job && chmod 0700 /job'], { stdio: 'ignore' });
    asOwner([
      'set -e', 'git init -q --initial-branch=main /job/repo', 'cd /job/repo',
      'git config user.name "Harness Test"', 'git config user.email harness@example.invalid',
      'git commit -q --allow-empty -m "test: base"', 'git commit -q --allow-empty -m "test: inspected"',
      'git init -q --bare --initial-branch=main /job/remote.git'
    ].join('; '));
  });

  afterAll(() => {
    if (root) {
      execFileSync('docker', ['run', '--rm', '--user', '0:0', '--volume', `${root}:/job:rw`, '--entrypoint', '/bin/sh', image, '-c', `find /job -mindepth 1 -delete && chown ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /job`], { stdio: 'ignore' });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a staged push clone out of reach of a concurrent import and pushes exactly what was staged', () => {
    // The control: with the whole workspace mounted, as before, the same command rewrites a staged clone.
    const decoy = `git-transfer-${randomBytes(12).toString('hex')}`;
    transferDirectory(decoy);
    transfer('stage-push', decoy);
    expect(tamper(['--volume', `${root}:/job:rw`])).toContain(`tampered ${repositoryOf(decoy)}`);
    asOwner(`rm -rf /job/${decoy}`);

    const staged = `git-transfer-${randomBytes(12).toString('hex')}`;
    const fetched = `git-transfer-${randomBytes(12).toString('hex')}`;
    transferDirectory(staged);
    transferDirectory(fetched);
    transfer('stage-push', staged);
    const stagedHead = asOwner(`git --git-dir=${repositoryOf(staged)} rev-parse refs/heads/main`);
    expect(stagedHead).toBe(asOwner('git -C /job/repo rev-parse HEAD'));

    // A concurrent fetch and import, and a second push's stage, see only their own transfer repositories.
    const remote = ['--volume', `${join(root, 'remote.git')}:/job/remote.git:ro`];
    expect(tamper(gitTransferVolumes('import', root, fetched))).toBe('');
    expect(tamper(gitTransferVolumes('stage-push', root, fetched))).toBe('');
    expect(tamper(gitTransferVolumes('fetch', root, fetched))).toBe('');
    expect(asOwner(`git --git-dir=${repositoryOf(staged)} rev-parse refs/heads/main`)).toBe(stagedHead);

    // The narrowed mounts still carry a real transfer: the push sends the staged commit, and a fetch then
    // imports it into the checkout through a read-only transfer repository.
    transfer('push', staged, 'main:refs/heads/main', ['--volume', `${join(root, 'remote.git')}:/job/remote.git:rw`]);
    expect(asOwner('git --git-dir=/job/remote.git rev-parse refs/heads/main')).toBe(stagedHead);
    transfer('fetch', fetched, 'refs/heads/main', remote);
    transfer('import', fetched, 'refs/heads/main');
    expect(asOwner('git -C /job/repo rev-parse refs/remotes/origin/main')).toBe(stagedHead);
  });
});
