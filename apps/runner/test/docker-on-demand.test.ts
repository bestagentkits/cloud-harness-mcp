import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>>(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  inspectNetwork: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);

import { DockerAgentGatewayControl } from '../src/agent-gateway-control.js';
import { resolveDockerSocketPath } from '../src/docker-pty.js';
import { StateStore } from '../src/state-store.js';
import { TOOLBOX_STALE_AFTER_MS } from '../src/toolbox-runner.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  docker.runDocker.mockClear();
  docker.runDocker.mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }));
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* already removed */ }
  }
});

type ReaperHandle = { reapExpired: () => Promise<void>; liveToolboxContainers: Set<string> };

function createService(dockerOnDemand: boolean, clock: { now: number }): ReaperHandle {
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  const directory = mkdtempSync(join(tmpdir(), 'ch-docker-on-demand-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
    executorImage: 'cloud-harness-executor:local',
    idleTtlSeconds: 300,
    wallTtlSeconds: 900,
    reaperIntervalSeconds: 30,
    packagesEnabled: false,
    dockerOnDemand
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  openStores.push(store);
  return new WorkspaceService(config, store) as unknown as ReaperHandle;
}

const intervalMs = 30_000;

/** Runs `passes` reaper passes one interval apart and returns how many Docker commands they issued. */
async function runPasses(service: ReaperHandle, clock: { now: number }, passes: number): Promise<number> {
  docker.runDocker.mockClear();
  for (let pass = 0; pass < passes; pass += 1) {
    clock.now += intervalMs;
    await service.reapExpired();
  }
  return docker.runDocker.mock.calls.length;
}

describe('Docker on demand reaper', () => {
  it('sweeps Docker on every pass when DOCKER_ON_DEMAND is off', async () => {
    const clock = { now: 1_800_000_000_000 };
    const service = createService(false, clock);
    expect(await runPasses(service, clock, 5)).toBe(5);
  });

  it('stops calling Docker across many idle reaper passes after the closing and final sweeps', async () => {
    const clock = { now: 1_800_000_000_000 };
    const service = createService(true, clock);
    // The first idle pass after startup closes out whatever startup reconciliation touched.
    expect(await runPasses(service, clock, 1)).toBe(1);
    // Until a leftover toolbox container could be stale, idle passes leave the Docker host alone.
    const quietPasses = Math.floor(TOOLBOX_STALE_AFTER_MS / intervalMs) - 2;
    expect(await runPasses(service, clock, quietPasses)).toBe(0);
    // One final sweep once a container left by the last activity is old enough to remove.
    expect(await runPasses(service, clock, 3)).toBe(1);
    expect(await runPasses(service, clock, 200)).toBe(0);
    for (const [args] of docker.runDocker.mock.calls) expect(args[0]).toBe('ps');
  });

  it('sweeps while a toolbox container is live and owes the idle sweeps again once it ends', async () => {
    const clock = { now: 1_800_000_000_000 };
    const service = createService(true, clock);
    await runPasses(service, clock, 1);
    clock.now += TOOLBOX_STALE_AFTER_MS;
    await runPasses(service, clock, 1);
    expect(await runPasses(service, clock, 10)).toBe(0);

    service.liveToolboxContainers.add('chm-toolbox-live');
    expect(await runPasses(service, clock, 4)).toBe(4);
    service.liveToolboxContainers.delete('chm-toolbox-live');
    expect(await runPasses(service, clock, 1)).toBe(1);
    expect(await runPasses(service, clock, 3)).toBe(0);
    clock.now += TOOLBOX_STALE_AFTER_MS;
    expect(await runPasses(service, clock, 1)).toBe(1);
    expect(await runPasses(service, clock, 50)).toBe(0);
  });

  it('retries a failed idle sweep instead of going quiet with it unfinished', async () => {
    const clock = { now: 1_800_000_000_000 };
    const service = createService(true, clock);
    docker.runDocker.mockImplementation(async () => ({ stdout: '', stderr: 'daemon unavailable', exitCode: 1, truncated: false }));
    expect(await runPasses(service, clock, 3)).toBe(3);
    docker.runDocker.mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }));
    expect(await runPasses(service, clock, 1)).toBe(1);
    expect(await runPasses(service, clock, 5)).toBe(0);
  });
});

describe('remote Docker host wiring', () => {
  it('reads the terminal socket from the sidecar DOCKER_HOST', () => {
    expect(resolveDockerSocketPath('unix:///var/run/tose-docker/docker.sock')).toBe('/var/run/tose-docker/docker.sock');
  });

  it('addresses a pinned model gateway container without Compose label discovery', async () => {
    docker.runDocker.mockImplementation(async () => ({
      stdout: JSON.stringify({ ok: true, digest: { gatewayBootId: 'boot', snapshotDigest: 'digest', activeProfileCount: 0, activeCredentialCount: 0, activeLeaseCount: 0 } }),
      stderr: '', exitCode: 0, truncated: false
    }));
    await new DockerAgentGatewayControl('cloudharness-model-gateway').queryDigest();
    expect(docker.runDocker.mock.calls.map(([args]) => args.slice(0, 3))).toEqual([['exec', '-i', 'cloudharness-model-gateway']]);
  });
});
