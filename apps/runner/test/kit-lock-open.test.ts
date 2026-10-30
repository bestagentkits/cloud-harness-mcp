import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false })),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({
  validateRepositoryUrl: vi.fn(async (value: string) => new URL(value))
}));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const kitLock = {
  schema: 'agentkit.skill-lock/v1',
  scope: 'global',
  generation: 1,
  packages: [{
    identity: '@agentkit/plan',
    version: '2.7.0',
    treeDigest: `sha256:${'a'.repeat(64)}`,
    aliases: ['ak-plan'],
    sources: [{ owner: 'kit:engineer', provider: 'kit', kit: 'engineer', kitVersion: '2.7.0', origin: 'remote-signed' }]
  }]
};

function openWith(enableKitLockInstall: boolean, idempotencyKey: string) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-kit-lock-open-'));
  temporaryDirectories.push(directory);
  const config = {
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 1_048_576, reaperIntervalSeconds: 30,
    enableKitLockInstall
  } as RunnerConfig;
  mkdirSync(config.jobsRoot, { recursive: true });
  const store = new StateStore(config.stateDb);
  const service = new WorkspaceService(config, store);
  const result = service.open('owner', {
    repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey, kitLocks: [kitLock]
  });
  return result.finally(() => store.close());
}

describe('workspace_open kitLocks', () => {
  it('refuses a lock before any work while the instance flag is off', async () => {
    await expect(openWith(false, 'kit-lock-disabled')).rejects.toThrow('ENABLE_KIT_LOCK_INSTALL');
    expect(docker.runDocker).not.toHaveBeenCalled();
  });

  it('turns the lock into a pinned agentkit toolkit once the flag is on', async () => {
    // No registry key is configured, so the expanded engineer selection reaches the AgentKit toolkit
    // resolver and fails closed there: proof that the lock became a toolkit selection.
    await expect(openWith(true, 'kit-lock-enabled')).rejects.toThrow('AgentKit kits are not configured on this instance');
  });
});
