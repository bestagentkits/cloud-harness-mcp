import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { StateStore } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async () => { throw new HarnessError('TIMEOUT', 'clone timed out', 504, true); }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({
  validateRepositoryUrl: vi.fn(async (value: string) => new URL(value))
}));
vi.mock('../src/github-app-broker.js', () => ({ mintRepositoryToken: vi.fn(async () => undefined) }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('clone helper cleanup', () => {
  it('force-removes the exact helper when the foreground Docker call times out', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-clone-cleanup-'));
    temporaryDirectories.push(directory);
    const config: RunnerConfig = {
      host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
      jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
      allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
      maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 1_048_576, reaperIntervalSeconds: 30
    };
    mkdirSync(config.jobsRoot, { recursive: true });
    const store = new StateStore(config.stateDb);
    const service = new WorkspaceService(config, store);
    try {
      await expect(service.open('owner', {
        repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey: 'clone-timeout'
      })).rejects.toThrow('clone timed out');
      expect(docker.removeContainer).toHaveBeenCalledTimes(1);
      expect(docker.removeContainer.mock.calls[0]?.[0]).toMatch(/^chm-clone-/);
    } finally {
      store.close();
    }
  });
});
