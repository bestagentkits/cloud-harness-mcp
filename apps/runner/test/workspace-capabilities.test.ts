import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return { stdout: JSON.stringify({ ok: true, message: 'worker complete', data: { output: 'ok' }, truncated: false }), stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('branch') && args.includes('--show-current')) {
      return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/git-transfer-helper.sh')) {
      return { stdout: 'push-ok', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
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
const openStores: StateStore[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createFixture(options: { authMode?: 'owner-bearer' | 'cloudflare-access'; githubApp?: RunnerConfig['githubApp'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-cap-test-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${'c'.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });

  const config: RunnerConfig = {
    authMode: options.authMode ?? 'owner-bearer',
    host: '127.0.0.1',
    port: 3001,
    serviceToken: 'runner-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state.db'),
    executorImage: 'executor',
    allowedGitHosts: ['github.com'],
    networkProfile: 'network-none',
    wallTtlSeconds: 300,
    idleTtlSeconds: 180,
    maxOutputBytes: 262_144,
    minFreeBytes: 0,
    maxWorkspaceBytes: 1_048_576,
    reaperIntervalSeconds: 30,
    githubApp: options.githubApp
  };

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'principal_1' });
  const installations = new InMemoryGitHubInstallationStore();
  const service = new WorkspaceService(config, store, undefined, installations);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId,
    ownerId,
    idempotencyKey: 'idemp-1',
    repositoryUrl: 'https://github.com/test-org/test-repo.git',
    repositoryRef: 'main',
    containerName: 'cont_1',
    workspacePath,
    status: 'ACTIVE',
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 180_000,
    hardExpiresAt: now + 300_000,
    gitAuthorName: 'Test Dev',
    gitAuthorEmail: 'dev@test.org',
    mutationLockedUntil: null,
    generation: 1,
    error: null
  };
  store.create(record);

  return { config, store, installations, service, record, workspaceId, ownerId };
}

describe('Workspace Capabilities and Authorization Preflight', () => {
  it('computes full write capabilities in owner-bearer mode when githubApp installation is configured', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer',
      githubApp: {
        appId: 123,
        installationId: 456,
        privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        appSlug: 'test-app'
      }
    });

    const res = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.workspaceId).toBe(workspaceId);
    expect(data.repository).toBe('test-org/test-repo');

    const capabilities = data.capabilities as { repository: Record<string, boolean>; workspace: Record<string, unknown> };
    expect(capabilities.repository.read).toBe(true);
    expect(capabilities.repository.push).toBe(true);
    expect(capabilities.repository.issuesRead).toBe(true);
    expect(capabilities.repository.issuesWrite).toBe(true);
    expect(capabilities.repository.pullRequestsRead).toBe(true);
    expect(capabilities.repository.pullRequestsWrite).toBe(true);

    const permissions = data.permissions as { contents: { read: boolean; write: boolean }; issues: { read: boolean; write: boolean }; pullRequests: { read: boolean; write: boolean } };
    expect(permissions.contents.read).toBe(true);
    expect(permissions.contents.write).toBe(true);
    expect(permissions.issues.write).toBe(true);
    expect(permissions.pullRequests.write).toBe(true);

    const operations = data.operations as Record<string, boolean>;
    expect(operations.gitFetch).toBe(true);
    expect(operations.gitPush).toBe(true);
    expect(operations.issueCreate).toBe(true);
    expect(operations.pullRequestCreate).toBe(true);
  });

  it('computes read-only capabilities in owner-bearer mode when no githubApp installation is configured', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer'
    });

    const res = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;

    const capabilities = data.capabilities as { repository: Record<string, boolean> };
    expect(capabilities.repository.read).toBe(true);
    expect(capabilities.repository.push).toBe(false);
    expect(capabilities.repository.issuesRead).toBe(false);
    expect(capabilities.repository.issuesWrite).toBe(false);
    expect(capabilities.repository.pullRequestsRead).toBe(false);
    expect(capabilities.repository.pullRequestsWrite).toBe(false);

    const operations = data.operations as Record<string, boolean>;
    expect(operations.gitPush).toBe(false);
    expect(operations.issueCreate).toBe(false);
    expect(operations.pullRequestCreate).toBe(false);
  });

  it('enforces structured error when git_push is attempted without write authorization', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer'
    });

    try {
      await service.execute('principal_1', 'git_push', { workspaceId });
      expect.unreachable('git_push should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(HarnessError);
      const harnessErr = err as HarnessError;
      expect(harnessErr.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
      expect(harnessErr.operation).toBe('git_push');
      expect(harnessErr.repository).toBe('test-org/test-repo');
      expect(harnessErr.requiredCapability).toBe('repository.push');
    }
  });

  it('computes permissions accurately in cloudflare-access mode based on repository grants', async () => {
    const { service, installations, workspaceId, ownerId } = createFixture({
      authMode: 'cloudflare-access',
      githubApp: {
        appId: 100,
        privateKey: 'key',
        appSlug: 'test-app'
      }
    });

    // 1. Initial state: no grant
    const resNoGrant = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const dataNoGrant = resNoGrant.data as { capabilities: { repository: Record<string, boolean> } };
    expect(dataNoGrant.capabilities.repository.push).toBe(false);
    expect(dataNoGrant.capabilities.repository.issuesWrite).toBe(false);

    // 2. Add verified read-only grant
    installations.replaceVerified(ownerId, {
      appId: 100,
      installationId: 'inst_1',
      accountId: 'acc_1',
      accountLogin: 'test-org',
      status: 'active',
      repositories: [
        { owner: 'test-org', repository: 'test-repo', contents: 'read' }
      ]
    }, Date.now());

    const resReadGrant = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const dataReadGrant = resReadGrant.data as { capabilities: { repository: Record<string, boolean> } };
    expect(dataReadGrant.capabilities.repository.read).toBe(true);
    expect(dataReadGrant.capabilities.repository.push).toBe(false);
    expect(dataReadGrant.capabilities.repository.issuesRead).toBe(true);
    expect(dataReadGrant.capabilities.repository.issuesWrite).toBe(false);

    // 3. Update to write grant
    installations.replaceVerified(ownerId, {
      appId: 100,
      installationId: 'inst_1',
      accountId: 'acc_1',
      accountLogin: 'test-org',
      status: 'active',
      repositories: [
        { owner: 'test-org', repository: 'test-repo', contents: 'write' }
      ]
    }, Date.now());

    const resWriteGrant = await service.execute('principal_1', 'workspace_capabilities', { workspaceId });
    const dataWriteGrant = resWriteGrant.data as { capabilities: { repository: Record<string, boolean> } };
    expect(dataWriteGrant.capabilities.repository.read).toBe(true);
    expect(dataWriteGrant.capabilities.repository.push).toBe(true);
    expect(dataWriteGrant.capabilities.repository.issuesRead).toBe(true);
    expect(dataWriteGrant.capabilities.repository.issuesWrite).toBe(true);
    expect(dataWriteGrant.capabilities.repository.pullRequestsRead).toBe(true);
    expect(dataWriteGrant.capabilities.repository.pullRequestsWrite).toBe(true);
  });

  it('enriches workspace_status and workspace_context with capabilities', async () => {
    const { service, workspaceId } = createFixture({
      authMode: 'owner-bearer',
      githubApp: {
        appId: 123,
        installationId: 456,
        privateKey: 'key',
        appSlug: 'slug'
      }
    });

    const statusRes = await service.execute('principal_1', 'workspace_status', { workspaceId });
    expect(statusRes.ok).toBe(true);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(statusData.capabilities).toBeDefined();
    expect((statusData.capabilities as { repository: Record<string, boolean> }).repository.push).toBe(true);
    expect(statusData.permissions).toBeDefined();
    expect(statusData.operations).toBeDefined();

    const contextRes = await service.execute('principal_1', 'workspace_context', { workspaceId });
    expect(contextRes.ok).toBe(true);
    const contextData = contextRes.data as Record<string, unknown>;
    expect(contextData.capabilities).toBeDefined();
    expect((contextData.capabilities as { repository: Record<string, boolean> }).repository.push).toBe(true);
  });
});
