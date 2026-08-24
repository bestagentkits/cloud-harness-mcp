import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import type { GitHubBindingService } from '../src/github-binding-service.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

const broker = vi.hoisted(() => ({
  mintRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryToken: vi.fn(),
  mintPrincipalRepositoryScopedToken: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/github-app-broker.js', () => broker);

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-private-clone-'));
  temporaryDirectories.push(directory);
  const config = {
    authMode: 'cloudflare-access',
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkMode: 'none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 1_048_576, reaperIntervalSeconds: 30,
    githubApp: {
      appId: 123,
      privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      appSlug: 'cloud-harness-test'
    }
  } as RunnerConfig;
  mkdirSync(config.jobsRoot, { recursive: true });
  const store = new StateStore(config.stateDb);
  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified('principal-a', {
    appId: 123,
    installationId: 777,
    accountId: 789,
    accountLogin: 'bestagentkits',
    status: 'active',
    repositories: []
  }, 1_000);
  const record: WorkspaceRecord = {
    id: `ws_${'a'.repeat(24)}`,
    ownerId: 'principal-a',
    idempotencyKey: 'private-clone-test',
    repositoryUrl: 'https://github.com/bestagentkits/agentkit',
    repositoryRef: null,
    containerName: null,
    workspacePath: join(config.jobsRoot, `ws_${'a'.repeat(24)}`),
    status: 'CREATING',
    networkMode: 'none',
    createdAt: 1_000,
    lastActivityAt: 1_000,
    expiresAt: 60_000,
    generation: 1,
    error: null
  };
  return { config, store, installations, record };
}

type CloneMethod = (record: WorkspaceRecord, repositoryUrl: URL, ref?: string) => Promise<string>;

describe('private repository clone reconciliation', () => {
  it('reconciles stale Access grants and retries clone once with a freshly minted token', async () => {
    const { config, store, installations, record } = fixture();
    const reconcile = vi.fn(async (principalId: string) => {
      return installations.replaceVerified(principalId, {
        appId: 123,
        installationId: 777,
        accountId: 789,
        accountLogin: 'bestagentkits',
        status: 'active',
        repositories: [{ owner: 'bestagentkits', repository: 'agentkit', contents: 'read' }]
      }, 2_000);
    });
    const binding = { reconcile } as unknown as GitHubBindingService;
    const service = new WorkspaceService(config, store, undefined, installations, binding);
    broker.mintPrincipalRepositoryToken
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('fresh-repository-token');
    docker.runDocker
      .mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", truncated: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', truncated: false });

    try {
      const clone = (service as unknown as { clone: CloneMethod }).clone.bind(service);
      await expect(clone(record, new URL(record.repositoryUrl))).resolves.toBe(join(record.workspacePath, 'repo'));
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith('principal-a', undefined, '777');
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(2);
      expect(docker.runDocker).toHaveBeenCalledTimes(2);
      expect(docker.runDocker.mock.calls[0]?.[1]?.stdin).toBe('\n');
      expect(docker.runDocker.mock.calls[1]?.[1]?.stdin).toBe('fresh-repository-token\n');
      expect(docker.removeContainer).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it('keeps successful public anonymous clones on the fast path without reconciliation', async () => {
    const { config, store, installations, record } = fixture();
    record.repositoryUrl = 'https://github.com/bestagentkits/orchestrate';
    const reconcile = vi.fn();
    const binding = { reconcile } as unknown as GitHubBindingService;
    const service = new WorkspaceService(config, store, undefined, installations, binding);
    broker.mintPrincipalRepositoryToken.mockResolvedValueOnce(undefined);
    docker.runDocker.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', truncated: false });

    try {
      const clone = (service as unknown as { clone: CloneMethod }).clone.bind(service);
      await expect(clone(record, new URL(record.repositoryUrl))).resolves.toBe(join(record.workspacePath, 'repo'));
      expect(reconcile).not.toHaveBeenCalled();
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(1);
      expect(docker.runDocker).toHaveBeenCalledTimes(1);
      expect(docker.runDocker.mock.calls[0]?.[1]?.stdin).toBe('\n');
    } finally {
      store.close();
    }
  });
});
