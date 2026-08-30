import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  ghResult: {
    stdout: '{"ok":true,"output":"result"}',
    stderr: '',
    exitCode: 0,
    truncated: false
  },
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/gh-helper.sh')) {
      return docker.ghResult;
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
const openMetadataStores: MetadataStore[] = [];
afterEach(() => {
  docker.ghResult = {
    stdout: '{"ok":true,"output":"result"}',
    stderr: '',
    exitCode: 0,
    truncated: false
  };
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) store.close();
  for (const metadata of openMetadataStores.splice(0)) metadata.database.close();
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
  const metadata = new MetadataStore(config.stateDb);
  openMetadataStores.push(metadata);

  return { config, store, metadata, installations, record, workspaceId, principalId, principalSelector };
}

describe('Brokered GitHub Issues and Pull Request Operations', () => {
  it('executes pr_create with draft flag and labels using pull_requests:write token scope and records audit', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);

    docker.ghResult = {
      stdout: 'https://github.com/bestagentkits/cloud-harness-mcp/pull/99\n',
      stderr: '',
      exitCode: 0,
      truncated: false
    };
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
    expect(args).toContain('enhancement,vibe');

    // Assert audit event recorded
    const audits = metadata.listAudit(principalId);
    const prAudit = audits.find((a) => a.action === 'github_action.pr_create');
    expect(prAudit).toBeDefined();
    expect(prAudit!.subjectType).toBe('workspace');
    expect(prAudit!.subjectId).toBe(workspaceId);
    expect(prAudit!.details).toMatchObject({
      action: 'pr_create',
      draft: true,
      createdPrNumber: 99,
      success: true
    });
    expect(JSON.stringify(prAudit)).not.toContain('pr-scoped-write-token');
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

  it('executes pr_comment with idempotency key caching and records single audit', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);
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

    // Idempotent replay must not create duplicate audit rows
    const audits = metadata.listAudit(principalId).filter((a) => a.action === 'github_action.pr_comment');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({
      action: 'pr_comment',
      prNumber: 42,
      idempotencyKey: 'idem_pr_comment_1',
      success: true
    });

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

  it('throws REPOSITORY_OPERATION_NOT_AUTHORIZED when no GitHub App token can be minted for the workspace', async () => {
    const { config, store, workspaceId, principalSelector } = fixture();
    const emptyInstallations = new InMemoryGitHubInstallationStore();
    const service = new WorkspaceService(config, store, undefined, emptyInstallations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(undefined);

    await expect(service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_list'
    })).rejects.toMatchObject({
      code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED',
      operation: 'github_action.pr_list',
      requiredCapability: 'repository.pullRequestsRead'
    });
  });

  it('returns structured GITHUB_RATE_LIMITED error when GitHub CLI is rate limited and records failure audit', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('pr-scoped-write-token');
    docker.ghResult = {
      stdout: '',
      stderr: 'gh: API rate limit exceeded for installation ID 888. (HTTP 403)',
      exitCode: 1,
      truncated: false
    };

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_create',
      title: 'feat: add feature',
      head: 'feat/test',
      base: 'main'
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'GITHUB_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 60_000
    });

    const audits = metadata.listAudit(principalId).filter((a) => a.action === 'github_action.pr_create');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({
      action: 'pr_create',
      success: false,
      errorCode: 'GITHUB_RATE_LIMITED'
    });
  });

  it('returns structured INVALID_PULL_REQUEST_BASE error when base branch has no commits', async () => {
    const { config, store, metadata, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce('pr-scoped-write-token');
    docker.ghResult = {
      stdout: '',
      stderr: 'GraphQL: No commits between main and feat/branch (createPullRequest)',
      exitCode: 1,
      truncated: false
    };

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_create',
      title: 'feat: add feature',
      head: 'feat/branch',
      base: 'main'
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'INVALID_PULL_REQUEST_BASE',
      retryable: false
    });
  });

  it('records audit event when token minting is denied for write action', async () => {
    const { config, store, metadata, workspaceId, principalId, principalSelector } = fixture();
    const emptyInstallations = new InMemoryGitHubInstallationStore();
    const service = new WorkspaceService(config, store, metadata, emptyInstallations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(undefined);

    await expect(service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_create',
      title: 'feat: test',
      head: 'feat/test',
      base: 'main'
    })).rejects.toMatchObject({ code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED' });

    const audits = metadata.listAudit(principalId).filter((a) => a.action === 'github_action.pr_create');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({
      action: 'pr_create',
      success: false,
      errorCode: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'
    });
  });
});
