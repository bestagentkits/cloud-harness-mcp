import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore } from '../src/state-store.js';

type DockerResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };
const dockerMocks = vi.hoisted(() => ({
  runDocker: vi.fn<(args: string[], options?: unknown) => Promise<DockerResult>>(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
  inspectContainer: vi.fn<(name: string) => Promise<Record<string, unknown> | undefined>>(async () => undefined),
  removeContainer: vi.fn<(name: string) => Promise<undefined>>(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => dockerMocks);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: async (value: string) => new URL(value) }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  dockerMocks.runDocker.mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }));
  dockerMocks.inspectContainer.mockImplementation(async () => undefined);
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runnerConfig(directory: string): RunnerConfig {
  return {
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'cloud-harness-executor:local',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 3_600, idleTtlSeconds: 1_800,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 536_870_912, reaperIntervalSeconds: 3_600
  };
}

/** Opens two retained workspaces with one runner, then hands back a fresh runner over the same state. */
async function retainedWorkspaces(options: { keepStuckCheckout?: boolean } = {}): Promise<{ config: RunnerConfig; stuck: { id: string; container: string }; healthy: { id: string; container: string } }> {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-startup-reconcile-'));
  temporaryDirectories.push(directory);
  const config = runnerConfig(directory);
  const store = new StateStore(config.stateDb);
  const service = new WorkspaceService(config, store);
  await service.start();
  const ids: string[] = [];
  try {
    for (const key of ['stuck', 'healthy']) {
      const opened = await service.open('owner', { repositoryUrl: `https://github.com/example/${key}.git`, idempotencyKey: `startup-${key}` });
      expect(opened.ok).toBe(true);
      ids.push((opened.data as { workspaceId: string }).workspaceId);
    }
  } finally {
    await service.stop();
  }
  const [stuck, healthy] = ids.map((id, index) => {
    const record = store.byId(id)!;
    // The mocked clone writes nothing, so give each checkout the directory a rebuild requires.
    if (index > 0 || options.keepStuckCheckout !== false) mkdirSync(join(record.workspacePath, 'repo'), { recursive: true });
    return { id, container: record.containerName! };
  });
  store.close();
  dockerMocks.runDocker.mockClear();
  dockerMocks.removeContainer.mockClear();
  dockerMocks.inspectContainer.mockImplementation(async () => ({ HostConfig: { NetworkMode: 'none' }, State: { Running: true } }));
  return { config, stuck: stuck!, healthy: healthy! };
}

function failing(match: (args: string[]) => boolean): void {
  dockerMocks.runDocker.mockImplementation(async (args: string[]) => (
    match(args)
      ? { stdout: '', stderr: 'Error response from daemon: cannot restart container', exitCode: 1, truncated: false }
      : { stdout: '', stderr: '', exitCode: 0, truncated: false }
  ));
}

describe('startup executor reconciliation', () => {
  it('rebuilds an executor that will not restart and keeps reconciling the other workspaces', async () => {
    const { config, stuck, healthy } = await retainedWorkspaces();
    failing((args) => args[0] === 'restart' && args[1] === stuck.container);
    const store = new StateStore(config.stateDb);
    const service = new WorkspaceService(config, store);
    try {
      await expect(service.start()).resolves.toEqual([]);
      const calls = dockerMocks.runDocker.mock.calls.map(([args]) => args);
      expect(calls).toContainEqual(['restart', healthy.container]);
      expect(dockerMocks.removeContainer).toHaveBeenCalledWith(stuck.container);
      const created = calls.filter((args) => args[0] === 'create');
      expect(created).toHaveLength(1);
      expect(created[0]).toContain(stuck.container);
      expect(created[0]).not.toContain(healthy.container);
      const rebuilt = store.byId(stuck.id)!;
      expect(rebuilt.status).toBe('ACTIVE');
      expect(rebuilt.containerName).toBeTruthy();
      expect(store.byId(healthy.id)!).toMatchObject({ status: 'ACTIVE', containerName: healthy.container });
    } finally {
      await service.stop();
      store.close();
    }
  });

  it('holds a workspace for recovery when its executor can be neither restarted nor rebuilt', async () => {
    const { config, stuck, healthy } = await retainedWorkspaces();
    failing((args) => (args[0] === 'restart' && args[1] === stuck.container) || args[0] === 'create');
    const store = new StateStore(config.stateDb);
    const service = new WorkspaceService(config, store);
    try {
      await expect(service.start()).resolves.toEqual([{ workspaceId: stuck.id, reason: expect.any(String) }]);
      const held = store.byId(stuck.id)!;
      expect(held.status).toBe('EXPIRED_RECOVERABLE');
      expect(held.containerName).toBeNull();
      expect(held.recoverableUntil).toBeGreaterThan(Date.now());
      expect(held.error).toMatch(/^executor reconciliation failed during startup: /);
      expect(store.byId(healthy.id)!).toMatchObject({ status: 'ACTIVE', containerName: healthy.container });
      expect(dockerMocks.runDocker.mock.calls.map(([args]) => args)).toContainEqual(['restart', healthy.container]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it('closes a workspace whose checkout is gone instead of holding it for a recovery that cannot succeed', async () => {
    const { config, stuck, healthy } = await retainedWorkspaces({ keepStuckCheckout: false });
    failing((args) => args[0] === 'restart' && args[1] === stuck.container);
    const store = new StateStore(config.stateDb);
    const service = new WorkspaceService(config, store);
    try {
      const failures = await service.start();
      expect(failures).toEqual([{ workspaceId: stuck.id, reason: expect.stringMatching(/no longer retained on disk/) }]);
      expect(store.byId(stuck.id)!.status).toBe('CLOSED');
      expect(store.byId(healthy.id)!).toMatchObject({ status: 'ACTIVE', containerName: healthy.container });
      expect(dockerMocks.runDocker.mock.calls.filter(([args]) => args[0] === 'create')).toHaveLength(0);
    } finally {
      await service.stop();
      store.close();
    }
  });
});
