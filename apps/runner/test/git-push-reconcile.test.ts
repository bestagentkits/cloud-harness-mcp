import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import type { GitHubBindingService } from '../src/github-binding-service.js';
import { InMemoryGitHubInstallationStore, type GitHubInstallationMutationAudit } from '../src/github-installation-store.js';
import type { MetadataStore } from '../src/metadata-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return { stdout: JSON.stringify({ ok: true, message: 'worker complete', data: { output: 'worker-ok' }, truncated: false }), stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/gh-helper.sh')) {
      return { stdout: '{"id":123,"title":"test"}', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: args[0] === 'exec' && args.includes('--show-current') ? 'main\n' : '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

const broker = vi.hoisted(() => ({
  mintRepositoryToken: vi.fn(async () => undefined),
  mintPrincipalRepositoryToken: vi.fn(),
  mintPrincipalRepositoryScopedToken: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/github-app-broker.js', () => broker);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-push-reconcile-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${'b'.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });

  const config = {
    authMode: 'cloudflare-access',
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), executorImage: 'executor',
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 0, maxWorkspaceBytes: 1_048_576, reaperIntervalSeconds: 30,
    githubApp: {
      appId: 123,
      privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      appSlug: 'cloud-harness-test'
    }
  } as RunnerConfig;

  const store = new StateStore(config.stateDb);
  const principalSelector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'user-a' };
  const principalId = store.resolveExternalPrincipal(principalSelector);

  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified(principalId, {
    appId: 123,
    installationId: 888,
    accountId: 789,
    accountLogin: 'bestagentkits',
    status: 'active',
    repositories: []
  }, 1_000);

  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId,
    ownerId: principalId,
    idempotencyKey: 'push-reconcile-test',
    repositoryUrl: 'https://github.com/bestagentkits/githatch.git',
    repositoryRef: null,
    containerName: 'executor-container',
    workspacePath,
    status: 'ACTIVE',
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 60_000,
    generation: 1,
    error: null
  };
  store.create(record);

  return { config, store, installations, record, workspaceId, principalId, principalSelector };
}

describe('git_push grant reconciliation', () => {
  it('reconciles repository grants on git_push when write token was not cached and succeeds with freshly minted token', async () => {
    const { config, store, installations, workspaceId, principalId, principalSelector } = fixture();
    const recordAuditInTransaction = vi.fn();
    const metadata = { recordAuditInTransaction } as unknown as MetadataStore;
    const reconcile = vi.fn(async (pid: string, audit?: GitHubInstallationMutationAudit) => {
      return installations.replaceVerified(pid, {
        appId: 123,
        installationId: 888,
        accountId: 789,
        accountLogin: 'bestagentkits',
        status: 'active',
        repositories: [{ owner: 'bestagentkits', repository: 'githatch', contents: 'write' }]
      }, 2_000, audit);
    });
    const binding = { reconcile } as unknown as GitHubBindingService;
    const service = new WorkspaceService(config, store, metadata, installations, binding);

    broker.mintPrincipalRepositoryToken
      .mockRejectedValueOnce(new HarnessError('FORBIDDEN', 'GitHub repository access is not authorized', 403))
      .mockResolvedValueOnce('fresh-write-token');
    try {
      const result = await service.execute(principalSelector, 'git_push', {
        workspaceId,
        remote: 'origin',
        refspec: 'HEAD:main',
        forceWithLease: false
      });

      expect(result.ok).toBe(true);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(principalId, expect.any(Function), '888');
      expect(recordAuditInTransaction).toHaveBeenCalledWith(
        store.database,
        principalId,
        'github.reconciled',
        'github_installation',
        '888',
        2,
        { status: 'active' }
      );
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(2);
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenNthCalledWith(1, expect.objectContaining({
        principalId,
        requiredPermission: 'write'
      }));
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenNthCalledWith(2, expect.objectContaining({
        principalId,
        requiredPermission: 'write'
      }));

      const pushCall = docker.runDocker.mock.calls.find(([, options]) => options?.stdin === 'fresh-write-token\n');
      expect(pushCall).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('fails git_push if principal has no matching GitHub App installation for repository owner', async () => {
    const { config, store, workspaceId, principalSelector } = fixture();
    const emptyInstallations = new InMemoryGitHubInstallationStore();
    const reconcile = vi.fn();
    const binding = { reconcile } as unknown as GitHubBindingService;
    const service = new WorkspaceService(config, store, undefined, emptyInstallations, binding);

    broker.mintPrincipalRepositoryToken.mockResolvedValueOnce(undefined);

    try {
      await expect(service.execute(principalSelector, 'git_push', {
        workspaceId,
        remote: 'origin',
        refspec: 'HEAD:main'
      })).rejects.toThrow('Git push requires a configured GitHub App with repository write access');
      expect(reconcile).not.toHaveBeenCalled();
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });


  it('reconciles and throws FORBIDDEN when refreshed installation only has read-only grant for repository', async () => {
    const { config, store, installations, workspaceId, principalId, principalSelector } = fixture();
    const reconcile = vi.fn(async (pid: string, audit?: GitHubInstallationMutationAudit) => {
      return installations.replaceVerified(pid, {
        appId: 123,
        installationId: 888,
        accountId: 789,
        accountLogin: 'bestagentkits',
        status: 'active',
        repositories: [{ owner: 'bestagentkits', repository: 'githatch', contents: 'read' }]
      }, 2_000, audit);
    });
    const binding = { reconcile } as unknown as GitHubBindingService;
    const service = new WorkspaceService(config, store, undefined, installations, binding);

    broker.mintPrincipalRepositoryToken
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('GitHub repository access is not authorized'));

    try {
      await expect(service.execute(principalSelector, 'git_push', {
        workspaceId,
        remote: 'origin',
        refspec: 'HEAD:main'
      })).rejects.toThrow('GitHub repository access is not authorized');
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(principalId, undefined, '888');
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it('uses cached write grant directly on fast path without triggering reconciliation', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const reconcile = vi.fn();
    const binding = { reconcile } as unknown as GitHubBindingService;
    const service = new WorkspaceService(config, store, undefined, installations, binding);

    broker.mintPrincipalRepositoryToken.mockResolvedValueOnce('cached-write-token');

    try {
      const result = await service.execute(principalSelector, 'git_push', {
        workspaceId,
        remote: 'origin',
        refspec: 'HEAD:main',
        forceWithLease: false
      });

      expect(result.ok).toBe(true);
      expect(reconcile).not.toHaveBeenCalled();
      expect(broker.mintPrincipalRepositoryToken).toHaveBeenCalledTimes(1);
      const pushCall = docker.runDocker.mock.calls.find(([, options]) => options?.stdin === 'cached-write-token\n');
      expect(pushCall).toBeDefined();
    } finally {
      store.close();
    }
  });
});
