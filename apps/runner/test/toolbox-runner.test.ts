import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import { HarnessError } from '@cloud-harness/contracts';

/**
 * A fake Docker CLI behind `spawn`. It keeps a container table so the tests can assert the one property
 * that matters for cleanup: whatever happens to a call, no toolbox container is left behind.
 */
type FakeContainer = { started: boolean; exitCode: number; createdAt: number; attach?: FakeChild | undefined };
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { end: () => undefined };
  private closed = false;
  private ended = false;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.close(null, signal);
    return true;
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      this.ended = true;
      this.emit('close', code, signal);
    });
  }
  // Output queued before the close is delivered first, as a real pipe drains before the process closes, so a
  // close scheduled on a timer can never overtake output the fake already wrote.
  write(stream: 'stdout' | 'stderr', text: string): void {
    setImmediate(() => { if (!this.ended) this[stream].emit('data', Buffer.from(text)); });
  }
}
const daemon = vi.hoisted(() => ({
  containers: new Map<string, FakeContainer>(),
  calls: [] as string[][],
  createDelayMs: 0,
  createFailure: undefined as string | undefined,
  refuseStart: false,
  /** The command's output and when (if ever) it exits on its own. */
  run: { output: [] as string[], exitAfterMs: undefined as number | undefined, exitCode: 0 },
  /** Simulates a create the daemon finishes after the first removal: the name exists again once. */
  reappearAfterRemoval: false,
  /** Makes the post-run state inspect fail, as when the daemon is unreachable. */
  stateUnreadable: false,
  /** Containers Docker refuses to remove. */
  stuck: new Set<string>()
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn((_command: string, args: string[]) => fakeDocker(args))
}));

function fakeDocker(args: string[]): FakeChild {
  daemon.calls.push(args);
  const child = new FakeChild();
  const name = args.at(-1)!;
  switch (args[0]) {
    case 'create': {
      const created = args[args.indexOf('--name') + 1]!;
      setTimeout(() => {
        if (daemon.createFailure) {
          child.write('stderr', daemon.createFailure);
          setTimeout(() => child.close(125), 1);
          return;
        }
        daemon.containers.set(created, { started: false, exitCode: 0, createdAt: Date.now() });
        child.close(0);
      }, daemon.createDelayMs);
      break;
    }
    case 'start': {
      const container = daemon.containers.get(name);
      if (!container || daemon.refuseStart) {
        child.write('stderr', 'Error response from daemon: unable to find user nosuchuser');
        setTimeout(() => child.close(1), 1);
        break;
      }
      container.started = true;
      container.attach = child;
      for (const chunk of daemon.run.output) child.write('stdout', chunk);
      if (daemon.run.exitAfterMs !== undefined) {
        setTimeout(() => { container.exitCode = daemon.run.exitCode; container.attach = undefined; child.close(daemon.run.exitCode); }, daemon.run.exitAfterMs);
      }
      break;
    }
    case 'rm': {
      if (daemon.stuck.has(name)) {
        child.write('stderr', `Error response from daemon: removal of container ${name} is already in progress`);
        setTimeout(() => child.close(1), 1);
        break;
      }
      const container = daemon.containers.get(name);
      daemon.containers.delete(name);
      container?.attach?.close(137);
      if (daemon.reappearAfterRemoval) {
        daemon.reappearAfterRemoval = false;
        daemon.containers.set(name, { started: false, exitCode: 0, createdAt: Date.now() });
      }
      if (!container) child.write('stderr', `Error response from daemon: No such container: ${name}`);
      setTimeout(() => child.close(container ? 0 : 1), 1);
      break;
    }
    case 'inspect': {
      const format = args[args.indexOf('--format') + 1]!;
      if (format.includes('.Created')) {
        const names = args.slice(args.indexOf('--format') + 2);
        const lines = names.flatMap((entry) => {
          const container = daemon.containers.get(entry);
          return container ? [`/${entry}\t${new Date(container.createdAt).toISOString()}`] : [];
        });
        child.write('stdout', `${lines.join('\n')}\n`);
        setTimeout(() => child.close(lines.length === names.length ? 0 : 1), 1);
        break;
      }
      const container = daemon.containers.get(name);
      if (format.includes('StartedAt') && daemon.stateUnreadable) {
        child.write('stderr', 'Cannot connect to the Docker daemon');
        setTimeout(() => child.close(1), 1);
        break;
      }
      if (!container) {
        child.write('stderr', `error: no such object: ${name}`);
        setTimeout(() => child.close(1), 1);
        break;
      }
      child.write('stdout', format.includes('StartedAt')
        ? `${container.started ? '2026-10-13T09:00:00.1Z' : '0001-01-01T00:00:00Z'}\t${container.started ? container.exitCode : 128}\n`
        : 'container-id\n');
      setTimeout(() => child.close(0), 1);
      break;
    }
    case 'ps': {
      child.write('stdout', [...daemon.containers.keys()].map((entry) => `${entry}\n`).join(''));
      setTimeout(() => child.close(0), 1);
      break;
    }
    default:
      child.close(1);
  }
  return child;
}

import {
  EXECUTOR_HARDENING_ARGS, TOOLBOX_PATH, TOOLBOX_STALE_AFTER_MS, buildToolboxCreateArgs, reapStaleToolboxContainers, runToolboxCommand,
  toolboxContainerName, withManagedBins
} from '../src/toolbox-runner.js';

const instanceId = 'a'.repeat(36);

function argv(mounts?: Array<{ source: string; target: string }>) {
  return buildToolboxCreateArgs({
    name: 'chm-toolbox-0123456789abcdef',
    image: 'cloud-harness-executor:local',
    instanceId,
    command: 'node --version',
    ...(mounts ? { mounts } : {})
  }, 30_000);
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

  it('creates a labelled, hardened, no-network container with no mounts, secrets, or socket', () => {
    const args = argv();
    // Created, not run: the container exists by name before anything can decide to stop it.
    expect(args.slice(0, 5)).toEqual(['create', '--pull', 'never', '--name', 'chm-toolbox-0123456789abcdef']);
    expect(args).not.toContain('--rm');
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
    // A login shell like exec_run, under an in-container deadline that outlives the runner's own timer.
    expect(args.slice(-8)).toEqual(['cloud-harness-executor:local', '/usr/bin/timeout', '-k', '5s', '32s', '/bin/bash', '-lc', 'node --version']);
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
    expect(() => buildToolboxCreateArgs({ name: 'other', image: 'i', instanceId, command: 'true' }, 1_000)).toThrow();
    expect(() => buildToolboxCreateArgs({ name: toolboxContainerName(), image: 'i', instanceId: 'x\ny', command: 'true' }, 1_000)).toThrow();
  });
});

describe('managed release bin directories', () => {
  const release = { source: '/var/lib/cloud-harness/packages/releases/k/pkr_aaaaaaaaaaaaaaaaaaaa', target: '/opt/chm-packages/pkr_aaaaaaaaaaaaaaaaaaaa' };
  const other = { source: '/var/lib/cloud-harness/packages/releases/k/pkr_bbbbbbbbbbbbbbbbbbbb', target: '/opt/chm-packages/pkr_bbbbbbbbbbbbbbbbbbbb' };
  const pathOf = (args: string[]) => flagValues(args, '--env').find((entry) => entry.startsWith('PATH='))!.slice('PATH='.length);

  it('puts managed bins after the workspace-local and user-tool directories and before the image tools', () => {
    const args = buildToolboxCreateArgs({
      name: 'chm-toolbox-0123456789abcdef', image: 'cloud-harness-executor:local', instanceId, command: 'true',
      mounts: [release, other], binDirs: [`${release.target}/bin`, `${other.target}/bin`]
    }, 30_000);
    const entries = pathOf(args).split(':');
    const local = entries.indexOf('/tmp/cloud-harness-home/.local/bin');
    const sbin = entries.indexOf('/usr/local/sbin');
    expect(entries.slice(local + 1, sbin)).toEqual([`${release.target}/bin`, `${other.target}/bin`]);
    expect(entries.indexOf('/opt/user-tools/bin')).toBeLessThan(local);
    expect(entries.indexOf('/usr/local/bin')).toBeGreaterThan(sbin);
    // Releases stay read-only even when their bin directory is on PATH.
    expect(flagValues(args, '--mount').every((value) => value.endsWith(',readonly'))).toBe(true);
    // The login shell's /etc/profile resets PATH; the image's profile script restores these from this variable.
    expect(flagValues(args, '--env')).toContain(`CLOUD_HARNESS_MANAGED_PATH=${release.target}/bin:${other.target}/bin`);
  });

  it('keeps the toolbox PATH identical when there are no managed bins', () => {
    expect(pathOf(argv())).toBe(TOOLBOX_PATH);
    expect(flagValues(argv(), '--env').some((entry) => entry.startsWith('CLOUD_HARNESS_MANAGED_PATH='))).toBe(false);
    expect(pathOf(argv([release]))).toBe(TOOLBOX_PATH);
    expect(withManagedBins(TOOLBOX_PATH, [])).toBe(TOOLBOX_PATH);
  });

  it('inserts into an executor PATH that starts with the checkout-local bin', () => {
    const executorPath = `/workspace/node_modules/.bin:${TOOLBOX_PATH}`;
    expect(withManagedBins(executorPath, ['/opt/chm-packages/r/bin'])).toBe(
      executorPath.replace(':/usr/local/sbin:', ':/opt/chm-packages/r/bin:/usr/local/sbin:')
    );
  });

  it('refuses a bin directory that is not the bin directory of a provided mount', () => {
    const spec = (mounts: Array<{ source: string; target: string }>, binDirs: string[]) => () => buildToolboxCreateArgs({
      name: 'chm-toolbox-0123456789abcdef', image: 'i', instanceId, command: 'true', mounts, binDirs
    }, 1_000);
    expect(spec([], [`${release.target}/bin`])).toThrow(HarnessError);
    expect(spec([release], [release.target])).toThrow(HarnessError);
    expect(spec([release], [`${release.target}/bin/..`])).toThrow(HarnessError);
    expect(spec([release], ['/usr/bin'])).toThrow(HarnessError);
    expect(spec([release], [`${other.target}/bin`])).toThrow(HarnessError);
    expect(spec([release], [`${release.target}/bin`])).not.toThrow();
  });

  it('refuses entries that could split or escape a PATH entry, and a PATH without its anchor', () => {
    expect(() => withManagedBins(TOOLBOX_PATH, ['relative/bin'])).toThrow(HarnessError);
    expect(() => withManagedBins(TOOLBOX_PATH, ['/opt/a:/opt/b'])).toThrow(HarnessError);
    expect(() => withManagedBins(TOOLBOX_PATH, ['/opt/a/../../etc'])).toThrow(HarnessError);
    expect(() => withManagedBins(TOOLBOX_PATH, ['/opt/a\nb'])).toThrow(HarnessError);
    expect(() => withManagedBins('/usr/bin:/bin', ['/opt/a/bin'])).toThrow(HarnessError);
  });
});

describe('toolbox command lifecycle against a fake Docker CLI', () => {
  const spec = () => ({ name: toolboxContainerName(), image: 'cloud-harness-executor:local', instanceId, command: 'node --version' });
  const limits = { timeoutMs: 5_000, maxOutputBytes: 1_024 };
  const verbs = () => daemon.calls.map((args) => args[0]);

  beforeEach(() => {
    daemon.containers.clear();
    daemon.calls.length = 0;
    daemon.createDelayMs = 0;
    daemon.createFailure = undefined;
    daemon.refuseStart = false;
    daemon.run = { output: [], exitAfterMs: 5, exitCode: 0 };
    daemon.reappearAfterRemoval = false;
    daemon.stateUnreadable = false;
  });
  afterEach(() => {
    // The invariant every path must keep.
    expect([...daemon.containers.keys()]).toEqual([]);
  });

  it('creates, attaches, reads the exit code from the container state, and removes the container', async () => {
    daemon.run = { output: ['out\n', 'err\n'], exitAfterMs: 5, exitCode: 7 };
    const result = await runToolboxCommand(spec(), limits);
    expect(result).toEqual({ output: 'out\nerr\n', exitCode: 7, signal: null, truncated: false, timedOut: false });
    expect(verbs().slice(0, 3)).toEqual(['create', 'start', 'inspect']);
    expect(verbs()).toContain('rm');
  });

  it('starts nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runToolboxCommand(spec(), limits, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(daemon.calls).toEqual([]);
  });

  it('removes the container when the abort lands while it is being created', async () => {
    daemon.createDelayMs = 30;
    const controller = new AbortController();
    const pending = runToolboxCommand(spec(), limits, controller.signal);
    setTimeout(() => controller.abort(), 1);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(verbs()).not.toContain('start');
    expect(verbs()).toContain('rm');
  });

  it('removes the container when the abort lands while the command runs', async () => {
    daemon.run = { output: ['started\n'], exitAfterMs: undefined, exitCode: 0 };
    const controller = new AbortController();
    const pending = runToolboxCommand(spec(), limits, controller.signal);
    await vi.waitFor(() => expect(verbs()).toContain('start'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports a timeout during the run as stopped by SIGKILL with the partial output', async () => {
    daemon.run = { output: ['partial'], exitAfterMs: undefined, exitCode: 0 };
    const result = await runToolboxCommand(spec(), { timeoutMs: 40, maxOutputBytes: 1_024 });
    expect(result).toEqual({ output: 'partial', exitCode: null, signal: 'SIGKILL', truncated: false, timedOut: true });
  });

  it('reports a timeout during the create without starting the command', async () => {
    daemon.createDelayMs = 40;
    const result = await runToolboxCommand(spec(), { timeoutMs: 5, maxOutputBytes: 1_024 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true, output: '' });
    expect(verbs()).not.toContain('start');
  });

  it('stops the container once the output bound is reached and says so', async () => {
    daemon.run = { output: ['x'.repeat(800), 'y'.repeat(800)], exitAfterMs: undefined, exitCode: 0 };
    const result = await runToolboxCommand(spec(), limits);
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', truncated: true, timedOut: false });
    expect(Buffer.byteLength(result.output)).toBe(1_024);
  });

  it('maps a create the daemon refuses to UNAVAILABLE instead of an exit code', async () => {
    daemon.createFailure = 'Error response from daemon: No such image: cloud-harness-executor:local';
    const failure = runToolboxCommand(spec(), limits);
    await expect(failure).rejects.toBeInstanceOf(HarnessError);
    await expect(failure).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503, retryable: true, message: expect.stringMatching(/No such image/) });
    expect(verbs()).not.toContain('start');
  });

  it('maps a start the daemon refuses to UNAVAILABLE instead of an exit code', async () => {
    daemon.refuseStart = true;
    await expect(runToolboxCommand(spec(), limits)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503, retryable: true, message: expect.stringMatching(/unable to find user/) });
  });

  it('maps a run whose container state cannot be read to UNAVAILABLE instead of the CLI status', async () => {
    daemon.run = { output: ['partial\n'], exitAfterMs: 5, exitCode: 0 };
    daemon.stateUnreadable = true;
    await expect(runToolboxCommand(spec(), limits)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503, retryable: true });
  });

  it('retries the removal until Docker reports the container gone', async () => {
    daemon.reappearAfterRemoval = true;
    await runToolboxCommand(spec(), limits);
    expect(verbs().filter((verb) => verb === 'rm').length).toBeGreaterThanOrEqual(2);
  });
});

describe('stale toolbox container sweep', () => {
  beforeEach(() => {
    daemon.containers.clear();
    daemon.calls.length = 0;
  });

  it('removes only stale, untracked toolbox containers selected by the exact instance labels', async () => {
    const now = Date.now();
    const stale = toolboxContainerName();
    const recent = toolboxContainerName();
    const live = toolboxContainerName();
    daemon.containers.set(stale, { started: true, exitCode: 0, createdAt: now - TOOLBOX_STALE_AFTER_MS - 1 });
    daemon.containers.set(recent, { started: true, exitCode: 0, createdAt: now - 1_000 });
    daemon.containers.set(live, { started: true, exitCode: 0, createdAt: now - TOOLBOX_STALE_AFTER_MS - 1 });

    expect(await reapStaleToolboxContainers(instanceId, new Set([live]), now)).toEqual([stale]);

    expect([...daemon.containers.keys()].sort()).toEqual([live, recent].sort());
    expect(daemon.calls[0]).toEqual([
      'ps', '-a', '--filter', 'label=cloud-harness.role=toolbox', '--filter', 'label=cloud-harness.ephemeral=true',
      '--filter', `label=cloud-harness.instance=${instanceId}`, '--format', '{{.Names}}'
    ]);
  });

  it('keeps sweeping past a container Docker refuses to remove', async () => {
    const now = Date.now();
    const stuck = toolboxContainerName();
    const stale = toolboxContainerName();
    daemon.containers.set(stuck, { started: true, exitCode: 0, createdAt: now - TOOLBOX_STALE_AFTER_MS - 1 });
    daemon.containers.set(stale, { started: true, exitCode: 0, createdAt: now - TOOLBOX_STALE_AFTER_MS - 1 });
    daemon.stuck.add(stuck);
    try {
      expect(await reapStaleToolboxContainers(instanceId, new Set(), now)).toEqual([stale]);
      expect([...daemon.containers.keys()]).toEqual([stuck]);
    } finally {
      daemon.stuck.clear();
      daemon.containers.clear();
    }
  });
});
