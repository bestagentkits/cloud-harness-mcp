import { describe, expect, it } from 'vitest';
import { EXECUTOR_HARDENING_ARGS, buildToolboxRunArgs, toolboxContainerName } from '../src/toolbox-runner.js';

const instanceId = 'a'.repeat(36);

function argv(mounts?: Array<{ source: string; target: string }>) {
  return buildToolboxRunArgs({
    name: 'chm-toolbox-0123456789abcdef',
    image: 'cloud-harness-executor:local',
    instanceId,
    command: 'node --version',
    ...(mounts ? { mounts } : {})
  });
}

function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1]!] : []));
}

describe('toolbox container argv', () => {
  it('pins the executor hardening the workspace executor uses', () => {
    expect(EXECUTOR_HARDENING_ARGS).toEqual([
      '--user', '10001:10001', '--read-only',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024'
    ]);
    expect(Object.isFrozen(EXECUTOR_HARDENING_ARGS)).toBe(true);
  });

  it('runs a disposable, labelled, hardened, no-network container with no mounts, secrets, or socket', () => {
    const args = argv();
    expect(args.slice(0, 6)).toEqual(['run', '--rm', '--pull', 'never', '--name', 'chm-toolbox-0123456789abcdef']);
    const joined = args.join('\n');
    expect(joined).toContain(EXECUTOR_HARDENING_ARGS.join('\n'));
    expect(flagValues(args, '--network')).toEqual(['none']);
    expect(flagValues(args, '--label')).toEqual([
      'cloud-harness.role=toolbox', 'cloud-harness.ephemeral=true', `cloud-harness.instance=${instanceId}`
    ]);
    for (const forbidden of ['--volume', '-v', '--mount', '--env-file', '--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns']) {
      expect(args, forbidden).not.toContain(forbidden);
    }
    expect(joined).not.toMatch(/docker\.sock|\/workspace|GH_TOKEN|GITHUB_TOKEN/);
    const env = flagValues(args, '--env');
    expect(env).toContain('HOME=/tmp/cloud-harness-home');
    expect(env.find((entry) => entry.startsWith('PATH='))).toMatch(/^PATH=\/opt\/user-tools\/bin:/);
    expect(args.slice(-4)).toEqual(['cloud-harness-executor:local', '/bin/bash', '-c', 'node --version']);
  });

  it('adds only read-only mounts through the extension point', () => {
    const args = argv([{ source: '/var/lib/cloud-harness/packages/r1', target: '/opt/cloud-harness/packages/r1' }]);
    expect(flagValues(args, '--mount')).toEqual([
      'type=bind,source=/var/lib/cloud-harness/packages/r1,target=/opt/cloud-harness/packages/r1,readonly'
    ]);
  });

  it('refuses mount paths that could inject options or shadow scratch space', () => {
    for (const mount of [
      { source: 'relative/path', target: '/opt/x' },
      { source: '/srv/a,readonly=false', target: '/opt/x' },
      { source: '/srv/a', target: '/opt/x,bind-propagation=shared' },
      { source: '/srv/../etc', target: '/opt/x' },
      { source: '/srv/a', target: '/' },
      { source: '/srv/a', target: '/tmp/x' }
    ]) {
      expect(() => argv([mount]), JSON.stringify(mount)).toThrow();
    }
  });

  it('accepts only generated container names and safe instance labels', () => {
    expect(toolboxContainerName()).toMatch(/^chm-toolbox-[a-f0-9]{16}$/);
    expect(toolboxContainerName()).not.toBe(toolboxContainerName());
    expect(() => buildToolboxRunArgs({ name: 'other', image: 'i', instanceId, command: 'true' })).toThrow();
    expect(() => buildToolboxRunArgs({ name: toolboxContainerName(), image: 'i', instanceId: 'x\ny', command: 'true' })).toThrow();
  });
});
