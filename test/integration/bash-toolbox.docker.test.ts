import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

/**
 * The `bash` toolbox target against a real executor image: one disposable container per command with the
 * executor hardening, no network, no checkout, and removal by exact name whether it exits or times out.
 */
const image = process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local';
const resultData = z.object({ output: z.string(), exitCode: z.number().int().nullable(), target: z.literal('toolbox') });

let directory: string;
let store: StateStore;
let service: WorkspaceService;
let instanceLabel: string;

async function toolboxContainers(): Promise<string[]> {
  const listed = await runDocker(['ps', '-a', '--filter', instanceLabel, '--format', '{{.Names}}'], { timeoutMs: 15_000 });
  expect(listed.exitCode).toBe(0);
  return listed.stdout.split('\n').filter(Boolean);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-bash-toolbox-'));
  mkdirSync(join(directory, 'jobs'));
  const config = {
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: image,
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 104_857_600, maxWorkspaceBytes: 104_857_600, reaperIntervalSeconds: 30,
    packagesEnabled: true
  } as RunnerConfig;
  store = new StateStore(config.stateDb);
  service = new WorkspaceService(config, store);
  instanceLabel = `label=cloud-harness.instance=${store.instanceId()}`;
});

afterAll(async () => {
  if (instanceLabel) for (const name of await toolboxContainers().catch(() => [])) await removeContainer(name).catch(() => undefined);
  store?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 60_000);

describe('bash toolbox target in a real executor image', () => {
  it('runs as uid 10001 with no network, no workspace, a read-only root, and no Docker socket', async () => {
    const script = [
      'echo "uid=$(id -u):$(id -g)"',
      'echo "ifaces=$(ls /sys/class/net | tr "\\n" " ")"',
      'if grep -qs " /workspace " /proc/mounts; then echo workspace=mounted; else echo workspace=unmounted; fi',
      'echo "workspace-entries=$(ls -A /workspace 2>/dev/null | wc -l)"',
      'if touch /etc/toolbox-probe 2>/dev/null; then echo rootfs=writable; else echo rootfs=readonly; fi',
      'if test -e /var/run/docker.sock; then echo socket=present; else echo socket=absent; fi',
      'if timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/53" 2>/dev/null; then echo egress=open; else echo egress=blocked; fi',
      'echo "path=$PATH"'
    ].join('; ');

    const result = await service.execute('owner', 'bash', { target: 'toolbox', command: script, timeoutMs: 30_000 });

    expect(result.ok).toBe(true);
    const data = resultData.parse(result.data);
    expect(data.exitCode).toBe(0);
    expect(data.output).toContain('uid=10001:10001');
    expect(data.output).toContain('ifaces=lo ');
    expect(data.output).toContain('workspace=unmounted');
    expect(data.output).toContain('workspace-entries=0');
    expect(data.output).toContain('rootfs=readonly');
    expect(data.output).toContain('socket=absent');
    expect(data.output).toContain('egress=blocked');
    expect(data.output).toMatch(/path=[^\n]*\/opt\/user-tools\/bin/);
    expect(await toolboxContainers()).toEqual([]);
  }, 90_000);

  it('reports the exit code and bounds the output', async () => {
    const failed = await service.execute('owner', 'bash', { target: 'toolbox', command: 'echo out; echo err >&2; exit 7', timeoutMs: 30_000 });
    const failedData = resultData.parse(failed.data);
    expect(failedData.exitCode).toBe(7);
    expect(failedData.output).toContain('out');
    expect(failedData.output).toContain('err');

    const flood = await service.execute('owner', 'bash', { target: 'toolbox', command: 'yes toolbox', timeoutMs: 30_000, maxOutputBytes: 1_024 });
    expect(flood.truncated).toBe(true);
    expect(Buffer.byteLength(resultData.parse(flood.data).output)).toBeLessThanOrEqual(1_024);
    expect(await toolboxContainers()).toEqual([]);
  }, 90_000);

  it('stops and removes the container when the command times out', async () => {
    const pending = service.execute('owner', 'bash', { target: 'toolbox', command: 'echo started; sleep 120', timeoutMs: 3_000 });
    await expect.poll(toolboxContainers, { timeout: 10_000, interval: 200 }).toHaveLength(1);

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
    expect(resultData.parse(result.data)).toMatchObject({ exitCode: null });
    expect(await toolboxContainers()).toEqual([]);
  }, 90_000);

  it('stops and removes the container when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = service.execute('owner', 'bash', { target: 'toolbox', command: 'sleep 120', timeoutMs: 60_000 }, controller.signal);
    await expect.poll(toolboxContainers, { timeout: 10_000, interval: 200 }).toHaveLength(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await toolboxContainers()).toEqual([]);
  }, 90_000);
});
