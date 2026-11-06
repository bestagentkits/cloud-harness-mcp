import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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
  // A checkout written by repository-controlled code (same uid as the helper) that turns every
  // command-running Git setting into a marker. `gh` is replaced by a stand-in that drives Git the
  // way any gh version might, so the test covers the helper's environment, not one gh release.
  const root = mkdtempSync(join(tmpdir(), 'gh-helper-git-'));
  const marker = join(root, 'marker');
  mkdirSync(join(root, 'repo'));
  mkdirSync(marker);
  mkdirSync(join(root, 'bin'));
  chmodSync(join(root, 'repo'), 0o777);
  chmodSync(marker, 0o777);
  writeFileSync(join(root, 'hook.sh'), '#!/bin/sh\necho "$0 $*" >> /marker/hit\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'gh'), [
    '#!/bin/sh',
    'git status --short >/dev/null 2>&1',
    'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill >/dev/null 2>&1',
    'echo gh-stand-in-ran',
    ''
  ].join('\n'), { mode: 0o755 });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const docker = (args: string[], input = 'dummy_token\n') => spawnSync('docker', [
    'run', '-i', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=16m',
    '--volume', `${join(root, 'hook.sh')}:/opt/hook.sh:ro`,
    '--volume', `${join(root, 'bin')}:/opt/stand-in:ro`,
    '--volume', `${marker}:/marker`,
    '--env', 'HOME=/tmp/home', '--env', 'GH_REPO=owner/repo',
    '--env', 'PATH=/opt/stand-in:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...args
  ], { input, encoding: 'utf8' });

  const hitFile = join(marker, 'hit');

  it('prepares a hostile checkout whose config runs commands for plain Git', () => {
    const setup = docker(['--volume', `${join(root, 'repo')}:/workspace`, '--workdir', '/workspace', '--entrypoint', 'sh',
      'cloud-harness-executor:local', '-c',
      'git init -q && git config core.fsmonitor /opt/hook.sh && git config credential.helper "!/opt/hook.sh"'], '');
    expect(setup.status).toBe(0);

    // Control: the same stand-in outside the helper executes the repository's commands.
    const control = docker(['--volume', `${join(root, 'repo')}:/workspace:ro`, '--workdir', '/workspace',
      '--entrypoint', 'gh', 'cloud-harness-executor:local']);
    expect(control.stdout).toContain('gh-stand-in-ran');
    expect(readFileSync(hitFile, 'utf8')).toMatch(/\/opt\/hook\.sh 2 .*\n\/opt\/hook\.sh get/);
    rmSync(hitFile);
  });

  it('runs no repository-configured command while it holds the token, even inside the checkout', () => {
    const result = docker(['--volume', `${join(root, 'repo')}:/workspace:ro`, '--workdir', '/workspace',
      '--entrypoint', '/opt/harness/gh-helper.sh', 'cloud-harness-executor:local', 'pr_list']);
    expect(result.stdout).toContain('gh-stand-in-ran');
    expect(existsSync(hitFile)).toBe(false);
  });
});
