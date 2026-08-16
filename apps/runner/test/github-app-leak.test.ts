import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore } from '../src/state-store.js';

const secretToken = 'configured-repository-secret-token';
const dockerMocks = vi.hoisted(() => ({
  runDocker: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
  inspectContainer: vi.fn(async () => undefined),
  removeContainer: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => dockerMocks);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: async (value: string) => new URL(value) }));
vi.mock('../src/github-app-broker.js', () => ({ mintRepositoryToken: async () => secretToken }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('private clone credential boundary', () => {
  it('passes a minted token only over clone-helper stdin and never Docker arguments or executor configuration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-github-app-'));
    temporaryDirectories.push(directory);
    const config: RunnerConfig = {
      host: '127.0.0.1', port: 3001, serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
      jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'cloud-harness-executor:local',
      allowedGitHosts: ['github.com'], networkMode: 'none', wallTtlSeconds: 300, idleTtlSeconds: 180,
      maxOutputBytes: 262_144, minFreeBytes: 104_857_600, maxWorkspaceBytes: 536_870_912, reaperIntervalSeconds: 30,
      githubApp: { appId: 123, installationId: 456, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' }
    };
    const store = new StateStore(config.stateDb);
    const service = new WorkspaceService(config, store);
    await service.start();
    try {
      const opened = await service.open('owner', {
        repositoryUrl: 'https://github.com/example/private-repo.git',
        idempotencyKey: 'private-clone-test'
      });
      expect(opened.ok).toBe(true);
      const calls = dockerMocks.runDocker.mock.calls;
      expect(JSON.stringify(calls.map(([args]) => args))).not.toContain(secretToken);
      expect(calls.filter(([, options]) => options?.stdin === `${secretToken}\n`)).toHaveLength(1);
      expect(JSON.stringify(calls.find(([args]) => args[0] === 'create')?.[0])).not.toMatch(/TOKEN|SECRET|AUTHORIZATION/i);
    } finally {
      await service.stop();
      store.close();
    }
  });
});
