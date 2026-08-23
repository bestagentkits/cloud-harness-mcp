import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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
});
