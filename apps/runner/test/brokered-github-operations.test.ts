import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/gh-helper.sh')) {
      const action = args[args.indexOf('/opt/harness/gh-helper.sh') + 2];
      return {
        stdout: JSON.stringify({ action, ok: true, output: `result-of-${action}` }),
        stderr: '',
        exitCode: 0,
        truncated: false
      };
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
  for (const store of openStores.splice(0)) store.close();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-gh-ops-'));
  temporaryDirectories.push(directory);
  const workspaceId = `ws_${'c'.repeat(24)}`;
  const workspacePath = join(directory, 'jobs', workspaceId);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });

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

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const principalSelector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'user-github-ops' };
  const principalId = store.resolveExternalPrincipal(principalSelector);

  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified(principalId, {
    appId: 123,
    installationId: 888,
    accountId: 789,
    accountLogin: 'bestagentkits',
    status: 'active',
    repositories: [{ owner: 'bestagentkits', repository: 'cloud-harness-mcp', contents: 'write' }]
  }, 1_000);

  const now = Date.now();
  const record: WorkspaceRecord = {
    id: workspaceId,
    ownerId: principalId,
    idempotencyKey: 'gh-ops-test',
    repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
    repositoryRef: null,
    containerName: 'executor-container',
    workspacePath,
    status: 'ACTIVE',
    networkMode: 'none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 60_000,
    generation: 1,
    error: null
  };
  store.create(record);

  return { config, store, installations, record, workspaceId, principalId, principalSelector };
}

describe('Brokered GitHub Issues and Pull Request Operations', () => {
  it('executes pr_create with draft flag and labels using pull_requests:write token scope', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('pr-scoped-write-token');

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_create',
      title: 'feat: add brokered github ops',
      body: 'PR body content',
      head: 'feat/gh-ops',
      base: 'main',
      draft: true,
      labels: ['enhancement', 'vibe']
    });

    expect(result.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({
      permissionScope: 'pull_requests',
      requiredPermission: 'write'
    }));

    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    expect(dockerCall).toBeDefined();
    const [args, opts] = dockerCall!;
    expect(opts?.stdin).toBe('pr-scoped-write-token\n');
    expect(args).toContain('pr_create');
    expect(args).toContain('feat: add brokered github ops');
    expect(args).toContain('PR body content');
    expect(args).toContain('feat/gh-ops');
    expect(args).toContain('main');
    expect(args).toContain('true');
    expect(args).toContain('enhancement,vibe');
  });

  it('executes pr_update with title, base, and state', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('pr-scoped-write-token');

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_update',
      prNumber: 42,
      title: 'Updated title',
      body: 'Updated body',
      base: 'develop',
      state: 'closed'
    });

    expect(result.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({
      permissionScope: 'pull_requests',
      requiredPermission: 'write'
    }));

    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    const [args] = dockerCall!;
    expect(args).toContain('pr_update');
    expect(args).toContain('42');
    expect(args).toContain('Updated title');
    expect(args).toContain('Updated body');
    expect(args).toContain('develop');
    expect(args).toContain('closed');
  });

  it('executes pr_comment with idempotency key caching', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('pr-scoped-write-token');

    const result1 = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_comment',
      prNumber: 42,
      body: 'Looks good to me!',
      idempotencyKey: 'idem_pr_comment_1'
    });

    expect(result1.ok).toBe(true);

    // Second call with same idempotency key and payload returns cached response without invoking docker
    docker.runDocker.mockClear();
    const result2 = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_comment',
      prNumber: 42,
      body: 'Looks good to me!',
      idempotencyKey: 'idem_pr_comment_1'
    });

    expect(result2.ok).toBe(true);
    const ghHelperCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    expect(ghHelperCall).toBeUndefined();

    // Call with reused idempotency key but different body throws CONFLICT
    await expect(service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_comment',
      prNumber: 42,
      body: 'Different body!',
      idempotencyKey: 'idem_pr_comment_1'
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('executes pr_list and pr_view using pull_requests:read token scope', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValue('pr-scoped-read-token');

    const listRes = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_list',
      limit: 10,
      state: 'open'
    });
    expect(listRes.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({
      permissionScope: 'pull_requests',
      requiredPermission: 'read'
    }));

    const viewRes = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_view',
      prNumber: 15
    });
    expect(viewRes.ok).toBe(true);
  });

  it('executes issue_create with labels and assignees using issues:write token scope', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('issue-scoped-write-token');

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'issue_create',
      title: 'Bug: fix needed',
      body: 'Detailed repro steps',
      labels: ['bug', 'triage'],
      assignees: ['octocat', 'coder']
    });

    expect(result.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({
      permissionScope: 'issues',
      requiredPermission: 'write'
    }));

    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    const [args] = dockerCall!;
    expect(args).toContain('issue_create');
    expect(args).toContain('Bug: fix needed');
    expect(args).toContain('Detailed repro steps');
    expect(args).toContain('bug,triage');
    expect(args).toContain('octocat,coder');
  });

  it('executes issue_update with stateReason mapped properly', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('issue-scoped-write-token');

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'issue_update',
      issueNumber: 99,
      state: 'closed',
      stateReason: 'not_planned'
    });

    expect(result.ok).toBe(true);
    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    const [args] = dockerCall!;
    expect(args).toContain('issue_update');
    expect(args).toContain('99');
    expect(args).toContain('closed');
    expect(args).toContain('not_planned');
  });

  it('throws FORBIDDEN when no GitHub App token can be minted for the workspace', async () => {
    const { config, store, workspaceId, principalSelector } = fixture();
    const emptyInstallations = new InMemoryGitHubInstallationStore();
    const service = new WorkspaceService(config, store, undefined, emptyInstallations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(undefined);

    await expect(service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_list'
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
