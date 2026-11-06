import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('brokered GitHub helper', () => {
  it('reads token from stdin and rejects unsupported actions', () => {
    const result = spawnSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      'cloud-harness-executor:local',
      'forbidden_action'
    ], { input: 'dummy_token\n', encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported or forbidden GitHub action: forbidden_action');
  });

  it('rejects invocation without an action', () => {
    const result = spawnSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      'cloud-harness-executor:local'
    ], { input: 'dummy_token\n', encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GitHub action required');
  });

  it('rejects pr_view when pull request number is missing', () => {
    const result = spawnSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      'cloud-harness-executor:local',
      'pr_view'
    ], { input: 'dummy_token\n', encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Pull request number required');
  });

  it('rejects issue_create when title is missing', () => {
    const result = spawnSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      'cloud-harness-executor:local',
      'issue_create'
    ], { input: 'dummy_token\n', encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Title required for issue creation');
  });

  it('rejects pr_update when pull request number is missing', () => {
    const result = spawnSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      'cloud-harness-executor:local',
      'pr_update'
    ], { input: 'dummy_token\n', encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Pull request number required');
  });

  it('rejects pr_comment when pull request number or body is missing', () => {
    const result = spawnSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001',
      '--entrypoint', '/opt/harness/gh-helper.sh',
      'cloud-harness-executor:local',
      'pr_comment'
    ], { input: 'dummy_token\n', encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Pull request number and comment body required');
  });
});

describe('brokered GitHub helper Git trust boundary', () => {
  // A checkout written by repository-controlled code (same uid as the helper) whose config runs a
  // marker command. `gh` is replaced by a stand-in that drives Git the way any gh release might and
  // then prints what ran, so the test covers the helper's environment rather than one gh version.
  // Everything lives in a Docker volume so host file ownership and permissions play no part.
  const volumeName = `cloud-harness-gh-helper-${randomBytes(8).toString('hex')}`;
  const standIn = [
    '#!/bin/sh',
    'git status --short >/dev/null 2>&1',
    'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill >/dev/null 2>&1',
    'echo gh-stand-in-ran',
    'cat /tmp/hit 2>/dev/null',
    'true'
  ].join('\n');

  beforeAll(() => {
    execFileSync('docker', ['volume', 'create', volumeName], { stdio: 'ignore' });
    execFileSync('docker', [
      'run', '--rm', '--user', '0:0', '--volume', `${volumeName}:/job:rw`, '--entrypoint', '/bin/sh',
      'cloud-harness-executor:local', '-c', 'chown 10001:10001 /job'
    ], { stdio: 'ignore' });
    execFileSync('docker', [
      'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001', '--volume', `${volumeName}:/job:rw`,
      '--env', 'HOME=/tmp', '--entrypoint', '/bin/sh', 'cloud-harness-executor:local', '-c',
      'set -e; mkdir /job/bin; cat > /job/bin/gh; chmod 755 /job/bin/gh;'
      + ' printf \'#!/bin/sh\\necho "hook $*" >> /tmp/hit\\n\' > /job/hook.sh; chmod 755 /job/hook.sh;'
      + ' git init -q /job/repo; git -C /job/repo config core.fsmonitor /job/hook.sh;'
      + ' git -C /job/repo config credential.helper "!/job/hook.sh"'
    ], { input: standIn, stdio: ['pipe', 'ignore', 'pipe'] });
  });

  afterAll(() => {
    execFileSync('docker', ['volume', 'rm', '--force', volumeName], { stdio: 'ignore' });
  });

  const runInCheckout = (entrypoint: string, args: string[]) => spawnSync('docker', [
    'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=16m',
    '--volume', `${volumeName}:/job:ro`, '--workdir', '/job/repo',
    '--env', 'HOME=/tmp/home', '--env', 'GH_REPO=owner/repo',
    '--env', 'PATH=/job/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--entrypoint', entrypoint, 'cloud-harness-executor:local', ...args
  ], { input: 'dummy_token\n', encoding: 'utf8' });

  it('runs the hostile config for plain Git outside the helper (control)', () => {
    const control = runInCheckout('gh', []);
    expect(control.stdout).toContain('gh-stand-in-ran');
    expect(control.stdout).toMatch(/^hook 2 /m);
    expect(control.stdout).toMatch(/^hook get$/m);
  });

  it('runs no repository-configured command while it holds the token, even inside the checkout', () => {
    const result = runInCheckout('/opt/harness/gh-helper.sh', ['pr_list']);
    expect(result.stdout).toContain('gh-stand-in-ran');
    expect(result.stdout).not.toMatch(/^hook /m);
  });
});
