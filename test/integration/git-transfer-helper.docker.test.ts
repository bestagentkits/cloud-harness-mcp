import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let volumeName: string;

function git(args: string[], cwd = '/job/repo'): string {
  return execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001', '--volume', `${volumeName}:/job:rw`,
    '--entrypoint', 'git', 'cloud-harness-executor:local', '-C', cwd, ...args
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Runs the helper; throws when it fails, and answers what it printed. */
function helper(mode: string, repositoryUrl: string, repositoryPath: string, transferPath: string, argument = '', expectedRemoteOid = ''): { stdout: string; stderr: string } {
  const result = spawnSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '10001:10001',
    '--volume', `${volumeName}:/job:rw`, '--entrypoint', '/opt/harness/git-transfer-helper.sh',
    'cloud-harness-executor:local', mode, repositoryUrl, repositoryPath, transferPath, argument, expectedRemoteOid
  ], { input: '\n', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`helper ${mode} exited ${String(result.status)}: ${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function exists(path: string): boolean {
  return spawnSync('docker', [
    'run', '--rm', '--network', 'none', '--volume', `${volumeName}:/job:ro`, '--entrypoint', '/bin/sh',
    'cloud-harness-executor:local', '-c', `test -e ${path}`
  ]).status === 0;
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

  it('never runs a command the checkout configures for its alternates, and prints no graft hint', () => {
    git(['clone', '--no-local', '/job/remote.git', '/job/alternated'], '/job');
    // The checkout borrows objects through an alternates file and names a command Git runs to list the
    // alternate's refs whenever it negotiates a fetch into the checkout.
    git(['config', 'core.alternateRefsCommand', 'touch /job/pwned-altcmd; :'], '/job/alternated');
    execFileSync('docker', [
      'run', '--rm', '--network', 'none', '--user', '10001:10001', '--volume', `${volumeName}:/job:rw`, '--entrypoint', '/bin/sh',
      'cloud-harness-executor:local', '-c', 'echo /job/remote.git/objects > /job/alternated/.git/objects/info/alternates'
    ], { stdio: 'ignore' });

    const outputs = [
      helper('fetch', '/job/remote.git', '/job/alternated', '/job/alternated-fetch', 'refs/heads/main'),
      helper('import', '/job/remote.git', '/job/alternated', '/job/alternated-fetch', 'refs/heads/main'),
      helper('stage-push', '/job/remote.git', '/job/alternated', '/job/alternated-stage', 'isolated'),
      helper('inspect', '/job/remote.git', '/job/alternated', '/job/alternated-stage',
        git(['rev-parse', 'HEAD'], '/job/alternated'), git(['rev-parse', 'HEAD~1'], '/job/alternated'))
    ];

    expect(exists('/job/pwned-altcmd')).toBe(false);
    for (const output of outputs) expect(`${output.stdout}\n${output.stderr}`).not.toMatch(/graft/iu);
  });
});
