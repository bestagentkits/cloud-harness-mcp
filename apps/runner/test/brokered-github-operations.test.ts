import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAnswer, RunnerConfig } from '@cloud-harness/contracts';
import { HarnessError } from '@cloud-harness/contracts';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import type * as GitHubAppBroker from '../src/github-app-broker.js';

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
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  mintRepositoryToken: broker.mintRepositoryToken,
  mintPrincipalRepositoryToken: broker.mintPrincipalRepositoryToken,
  mintPrincipalRepositoryScopedToken: broker.mintPrincipalRepositoryScopedToken
}));
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { WorkspaceService } from '../src/workspace-service.js';
import { DecisionPlane, type DecisionProvider } from '../src/decision-plane/decision-plane.js';
const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const openMetadataStores: MetadataStore[] = [];
const mintedToken = (token: string, permissions: Record<string, string>) => ({ token, permissions });
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
    allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 300, idleTtlSeconds: 180,
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
    networkProfile: 'network-none',
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
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-write-token', { pull_requests: 'write' }));

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

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-write-token', { pull_requests: 'write' }));

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
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-write-token', { pull_requests: 'write' }));

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

  describe('pull request review lifecycle', () => {
    const helperCall = () => docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    const writeToken = () => broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-write-token', { pull_requests: 'write', contents: 'write' }));
    const THREAD = 'PRRT_kwDOabcdef123456';

    it.each([
      ['COMMENT', 'Please rename this.'],
      ['REQUEST_CHANGES', 'Needs a test.'],
      ['APPROVE', '']
    ])('maps pr_review %s to the helper with pull_requests:write and audits it', async (event, body) => {
      const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, metadata, installations);
      writeToken();
      const result = await service.execute(principalSelector, 'github_action', {
        workspaceId, action: 'pr_review', prNumber: 12, event, ...(body ? { body } : {})
      });
      expect(result.ok).toBe(true);
      expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'pull_requests', requiredPermission: 'write' }));
      const [args, opts] = helperCall()!;
      expect(args.slice(args.indexOf('pr_review'))).toEqual(['pr_review', '12', event, body]);
      expect(opts?.stdin).toBe('pr-scoped-write-token\n');
      const audit = metadata.listAudit(principalId).find((a) => a.action === 'github_action.pr_review');
      expect(audit?.details).toMatchObject({ action: 'pr_review', prNumber: 12, reviewEvent: event, success: true });
      expect(JSON.stringify(audit)).not.toContain('pr-scoped-write-token');
    });

    it('rejects a COMMENT or REQUEST_CHANGES review without a body before any GitHub call', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      for (const event of ['COMMENT', 'REQUEST_CHANGES']) {
        await expect(service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_review', prNumber: 12, event })).rejects.toThrow();
      }
      expect(helperCall()).toBeUndefined();
    });

    it('replays pr_review for the same key and payload and conflicts on a different payload', async () => {
      const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, metadata, installations);
      writeToken();
      const input = { workspaceId, action: 'pr_review', prNumber: 12, event: 'APPROVE', idempotencyKey: 'idem_review_1' };
      expect((await service.execute(principalSelector, 'github_action', input)).ok).toBe(true);
      docker.runDocker.mockClear();
      expect((await service.execute(principalSelector, 'github_action', input)).ok).toBe(true);
      expect(helperCall()).toBeUndefined();
      expect(metadata.listAudit(principalId).filter((a) => a.action === 'github_action.pr_review')).toHaveLength(1);
      await expect(service.execute(principalSelector, 'github_action', { ...input, event: 'REQUEST_CHANGES', body: 'no' }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('maps pr_review_comment line, range, side, and commit arguments', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      writeToken();
      const commitId = 'a'.repeat(40);
      await service.execute(principalSelector, 'github_action', {
        workspaceId, action: 'pr_review_comment', prNumber: 12, body: 'Nit', path: 'src/a.ts', line: 20, startLine: 18, startSide: 'LEFT', side: 'RIGHT', commitId
      });
      const [args] = helperCall()!;
      expect(args.slice(args.indexOf('pr_review_comment'))).toEqual(['pr_review_comment', '12', 'Nit', 'src/a.ts', '20', '18', 'RIGHT', 'LEFT', commitId]);
    });

    it('rejects an invalid inline comment range before any GitHub call', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      await expect(service.execute(principalSelector, 'github_action', {
        workspaceId, action: 'pr_review_comment', prNumber: 12, body: 'x', path: 'a.ts', line: 5, startLine: 9
      })).rejects.toThrow();
      expect(helperCall()).toBeUndefined();
    });

    it('lists review threads with the read scope through github_read', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-read-token', { pull_requests: 'read' }));
      const result = await service.execute(principalSelector, 'github_read', { workspaceId, action: 'pr_review_threads', prNumber: 12 });
      expect(result.ok).toBe(true);
      expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'pull_requests', requiredPermission: 'read' }));
      const [args] = helperCall()!;
      expect(args.slice(args.indexOf('pr_review_threads'))).toEqual(['pr_review_threads', '12', '50']);
    });

    it.each([
      ['pr_review_reply', { threadId: THREAD, body: 'Fixed.' }, ['pr_review_reply', THREAD, 'Fixed.']],
      ['pr_review_thread_resolve', { threadId: THREAD }, ['pr_review_thread_resolve', THREAD]],
      ['pr_review_thread_unresolve', { threadId: THREAD }, ['pr_review_thread_unresolve', THREAD]],
      ['pr_reviewers_request', { prNumber: 12, reviewers: ['octocat', 'hubot'], teamReviewers: ['core'] }, ['pr_reviewers_request', '12', 'octocat,hubot', 'core']],
      ['pr_reviewers_remove', { prNumber: 12, reviewers: ['octocat'] }, ['pr_reviewers_remove', '12', 'octocat', '']],
      ['pr_ready', { prNumber: 12 }, ['pr_ready', '12']],
      ['pr_convert_to_draft', { prNumber: 12 }, ['pr_convert_to_draft', '12']],
      ['pr_auto_merge_disable', { prNumber: 12 }, ['pr_auto_merge_disable', '12']]
    ])('maps %s to the helper and audits it', async (action, input, expected) => {
      const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, metadata, installations);
      writeToken();
      const result = await service.execute(principalSelector, 'github_action', { workspaceId, action, ...input });
      expect(result.ok).toBe(true);
      const [args] = helperCall()!;
      expect(args.slice(args.indexOf(action))).toEqual(expected);
      expect(metadata.listAudit(principalId).some((a) => a.action === `github_action.${action}`)).toBe(true);
    });

    it('requires a reviewer for reviewer management', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      await expect(service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_reviewers_request', prNumber: 1 })).rejects.toThrow();
      await expect(service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_reviewers_remove', prNumber: 1, reviewers: [] })).rejects.toThrow();
    });

    it.each(['merge', 'squash', 'rebase'])('maps pr_merge with the %s method', async (method) => {
      const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, metadata, installations);
      writeToken();
      const sha = 'b'.repeat(40);
      const message = method === 'rebase' ? {} : { commitTitle: 'feat: title', commitBody: 'body' };
      const result = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_merge', prNumber: 12, method, matchHeadCommit: sha, ...message });
      expect(result.ok).toBe(true);
      expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({ permissionScope: 'pull_requests', requiredPermission: 'write', contentsPermission: 'write' }));
      const [args] = helperCall()!;
      expect(args.join(' ')).not.toContain('/repo:/workspace');
      expect(args).toContain('/tmp');
      expect(args.slice(args.indexOf('pr_merge'))).toEqual(['pr_merge', '12', method, message.commitTitle ?? '', message.commitBody ?? '', sha]);
      expect(metadata.listAudit(principalId).find((a) => a.action === 'github_action.pr_merge')?.details).toMatchObject({ mergeMethod: method, success: true });
    });

    it('rejects a rebase merge that carries a commit message', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      await expect(service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_merge', prNumber: 12, method: 'rebase', commitTitle: 'x' })).rejects.toThrow();
    });

    it('maps pr_auto_merge_enable and replays it idempotently', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      writeToken();
      const input = { workspaceId, action: 'pr_auto_merge_enable', prNumber: 12, method: 'squash', idempotencyKey: 'idem_auto_1' };
      await service.execute(principalSelector, 'github_action', input);
      const [args] = helperCall()!;
      expect(args.slice(args.indexOf('pr_auto_merge_enable'))).toEqual(['pr_auto_merge_enable', '12', 'squash', '', '']);
      docker.runDocker.mockClear();
      await service.execute(principalSelector, 'github_action', input);
      expect(helperCall()).toBeUndefined();
    });

    it('rejects review actions through github_read', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      await expect(service.execute(principalSelector, 'github_read', { workspaceId, action: 'pr_merge', prNumber: 12, method: 'squash' })).rejects.toThrow();
      expect(helperCall()).toBeUndefined();
    });

    it('refuses to merge when the App token lacks contents:write and no fallback exists', async () => {
      const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, metadata, installations);
      broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-only-token', { pull_requests: 'write', contents: 'read' }));
      await expect(service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_merge', prNumber: 12, method: 'squash' }))
        .rejects.toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', message: expect.stringContaining('pull_requests:write and contents:write') });
      expect(helperCall()).toBeUndefined();
      expect(metadata.listAudit(principalId).find((a) => a.action === 'github_action.pr_merge')?.details).toMatchObject({ success: false, errorCode: 'GITHUB_PERMISSION_MISSING' });
    });

    it('does not require contents:write to approve a review', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-only-token', { pull_requests: 'write' }));
      const result = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_review', prNumber: 12, event: 'APPROVE' });
      expect(result.ok).toBe(true);
    });

    it('surfaces a typed merge failure without raw token material', async () => {
      const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, metadata, installations);
      writeToken();
      docker.ghResult = { stdout: '', stderr: 'X Pull request #12 is not mergeable: the base branch policy prohibits the merge.', exitCode: 1, truncated: false };
      const result = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_merge', prNumber: 12, method: 'squash' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'GITHUB_MERGE_BLOCKED', retryable: false });
      expect(JSON.stringify(result)).not.toContain('pr-scoped-write-token');
      expect(metadata.listAudit(principalId).find((a) => a.action === 'github_action.pr_merge')?.details).toMatchObject({ success: false, errorCode: 'GITHUB_MERGE_BLOCKED' });
    });

    it('never passes the token through helper arguments', async () => {
      const { config, store, installations, workspaceId, principalSelector } = fixture();
      const service = new WorkspaceService(config, store, undefined, installations);
      writeToken();
      await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_review', prNumber: 12, event: 'APPROVE' });
      const [args] = helperCall()!;
      expect(args.join(' ')).not.toContain('pr-scoped-write-token');
      expect(args.join(' ')).toContain('/repo:/workspace:ro');
    });

    it('redacts both a workspace GH_TOKEN and a different fallback token', () => {
      const { config, store, metadata, installations, workspaceId } = fixture();
      const fallback = 'fallback-runner-token-0123456789';
      const injected = 'workspace-injected-token-9876543210';
      const service = new WorkspaceService({ ...config, authMode: 'owner-bearer', githubToken: fallback } as RunnerConfig, store, metadata, installations);
      vi.spyOn(store, 'getSecretSnapshot').mockReturnValue({
        initialized: true,
        secrets: [{ name: 'GH_TOKEN', version: 1, environmentId: 'env_test', envelope: {} as never }]
      });
      vi.spyOn(metadata, 'decryptEnvelope').mockReturnValue(injected);
      const values = Object.values(service.redactionSecrets(workspaceId));
      expect(values).toContain(injected);
      expect(values).toContain(fallback);
    });

    describe('advisory failure diagnosis', () => {
      const answers: Record<string, DecisionAnswer> = {
        failure_type: { kind: 'choice', value: 'transient_network', confidence: 0.9, probabilities: { transient_network: 0.9, unknown: 0.1 } },
        retry_succeeds: { kind: 'boolean', probability: 0.8 }, credential_refresh: { kind: 'boolean', probability: 0.1 },
        workspace_recreate: { kind: 'boolean', probability: 0.05 }, agent_needed: { kind: 'boolean', probability: 0.1 }, human_needed: { kind: 'boolean', probability: 0.1 }
      };
      const attach = (service: WorkspaceService, evaluate: DecisionProvider['evaluate']) => {
        const provider = { name: 'stub', evaluate: vi.fn(evaluate) };
        service.useDecisionPlane(new DecisionPlane({ purposes: ['failure-classification'], providerFor: () => provider }));
        return provider;
      };
      const unnamed = 'error connecting to api.github.com: dial tcp: lookup api.github.com on 10.0.0.2:53: i/o timeout';

      it('adds a diagnosis only to the generic fallback and keeps the deterministic code and retryability', async () => {
        const { config, store, installations, workspaceId, principalSelector } = fixture();
        const service = new WorkspaceService(config, store, undefined, installations);
        const provider = attach(service, async () => ({ ok: true, model: 'stub', answers, inputTokens: 0, outputTokens: 0, inputBytes: 0, redactionCount: 0 }));
        writeToken();
        docker.ghResult = { stdout: '', stderr: unnamed, exitCode: 1, truncated: false };
        const result = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_review', prNumber: 12, event: 'APPROVE' });
        expect(result.error).toMatchObject({ code: 'GITHUB_ACTION_FAILED' });
        expect((result.data as { diagnosis?: unknown }).diagnosis).toMatchObject({ advisory: true, failureType: 'transient_network' });
        expect(provider.evaluate).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(provider.evaluate.mock.calls[0]?.[0])).not.toContain('pr-scoped-write-token');

        writeToken();
        docker.ghResult = { stdout: '', stderr: 'X Pull request #12 is not mergeable: the base branch policy prohibits the merge.', exitCode: 1, truncated: false };
        const known = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_merge', prNumber: 12, method: 'squash' });
        expect(known.error).toMatchObject({ code: 'GITHUB_MERGE_BLOCKED', retryable: false });
        expect((known.data as { diagnosis?: unknown }).diagnosis).toBeUndefined();
        expect(provider.evaluate).toHaveBeenCalledTimes(1);
      });

      it('returns the deterministic failure unchanged when the provider rejects', async () => {
        const { config, store, installations, workspaceId, principalSelector } = fixture();
        const service = new WorkspaceService(config, store, undefined, installations);
        const without = await (async () => {
          writeToken();
          docker.ghResult = { stdout: '', stderr: unnamed, exitCode: 1, truncated: false };
          return service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_review', prNumber: 12, event: 'APPROVE' });
        })();
        attach(service, async () => { throw new Error('provider exploded'); });
        writeToken();
        const result = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'pr_review', prNumber: 12, event: 'APPROVE' });
        expect(result.ok).toBe(false);
        expect(result.error).toEqual(without.error);
        expect((result.data as { diagnosis?: unknown }).diagnosis).toBeUndefined();
      });
    });
  });

  it('executes pr_list and pr_view using pull_requests:read token scope', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValue(mintedToken('pr-scoped-read-token', { pull_requests: 'read' }));

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

  it('serves read-only actions through github_read with contents:read for history and without write audit', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValue(mintedToken('contents-read-token', { contents: 'read' }));

    const commits = await service.execute(principalSelector, 'github_read', {
      workspaceId,
      action: 'commit_list',
      limit: 50,
      sha: 'main',
      path: 'apps/runner',
      since: '2026-09-01'
    });
    expect(commits.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({
      permissionScope: 'contents',
      requiredPermission: 'read'
    }));
    const commitCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'))?.[0] as string[];
    expect(commitCall.slice(commitCall.indexOf('commit_list'))).toEqual(['commit_list', '50', 'main', 'apps/runner', '2026-09-01', '']);

    docker.runDocker.mockClear();
    const compared = await service.execute(principalSelector, 'github_read', {
      workspaceId,
      action: 'compare',
      base: 'v0.56.0',
      head: 'main'
    });
    expect(compared.ok).toBe(true);
    const compareCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'))?.[0] as string[];
    expect(compareCall.slice(compareCall.indexOf('compare'))).toEqual(['compare', 'v0.56.0', 'main', '100']);

    expect(metadata.listAudit(principalId).filter((event) => event.action.startsWith('github_action.'))).toHaveLength(0);
  });

  it('rejects mutating actions on github_read before any credential is minted', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);
    await expect(service.execute(principalSelector, 'github_read', {
      workspaceId,
      action: 'pr_create',
      title: 'nope',
      head: 'feature'
    })).rejects.toThrow();
    expect(broker.mintPrincipalRepositoryScopedToken).not.toHaveBeenCalled();
  });

  it('keeps accepting the new history actions on github_action for compatibility', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValue(mintedToken('contents-read-token', { contents: 'read' }));
    const tags = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'tag_list', limit: 5 });
    expect(tags.ok).toBe(true);
    const releases = await service.execute(principalSelector, 'github_action', { workspaceId, action: 'release_list' });
    expect(releases.ok).toBe(true);
  });

  it('executes issue_create with labels and assignees using issues:write token scope', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('issue-scoped-write-token', { issues: 'write' }));

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

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('issue-scoped-write-token', { issues: 'write' }));

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

  it('falls back to the configured GitHub credential when no App token can be minted', async () => {
    const { config, store, workspaceId, principalSelector } = fixture();
    const emptyInstallations = new InMemoryGitHubInstallationStore();
    const fallbackToken = `ghp_${'f'.repeat(36)}`;
    config.authMode = 'owner-bearer';
    config.githubToken = fallbackToken;
    const service = new WorkspaceService(config, store, undefined, emptyInstallations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(undefined);

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'pr_list'
    });

    expect(result.ok).toBe(true);
    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    expect(dockerCall).toBeDefined();
    const [args, opts] = dockerCall!;
    // The fallback credential reaches the ephemeral helper over stdin only.
    expect(opts?.stdin).toBe(`${fallbackToken}\n`);
    expect(args).toContain('pr_list');
    expect(args.join(' ')).not.toContain(fallbackToken);
    expect(JSON.stringify(result)).not.toContain(fallbackToken);
  });

  it('returns structured GITHUB_RATE_LIMITED error when GitHub CLI is rate limited and records failure audit', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-write-token', { pull_requests: 'write' }));
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

    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('pr-scoped-write-token', { pull_requests: 'write' }));
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

  it('uses the operator credential when the minted App token is short of the required permission', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const fallbackToken = `ghp_${'a'.repeat(36)}`;
    config.authMode = 'owner-bearer';
    config.githubToken = fallbackToken;
    const service = new WorkspaceService(config, store, metadata, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('app-token-without-issue-write', { issues: 'read' }));

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'issue_create',
      title: 'Bug: fix needed'
    });

    expect(result.ok).toBe(true);
    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    const [, opts] = dockerCall!;
    expect(opts?.stdin).toBe(`${fallbackToken}\n`);
    const audit = metadata.listAudit(principalId).find((a) => a.action === 'github_action.issue_create');
    // The owner-bearer environment credential is operator-wide; the audit must not
    // label it as if it were the principal's own secret.
    expect(audit!.details).toMatchObject({ success: true, credentialSource: 'runner-environment' });
    expect(JSON.stringify(audit)).not.toContain(fallbackToken);
  });

  it('names the missing permission when no credential can satisfy the action', async () => {
    const { config, store, metadata, installations, workspaceId, principalId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, metadata, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('app-token-without-issue-write', { issues: 'read' }));

    const failure = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'issue_create',
      title: 'Bug: fix needed'
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessError);
    expect(failure).toMatchObject({
      code: 'GITHUB_PERMISSION_MISSING',
      status: 403,
      retryable: false,
      operation: 'github_action.issue_create',
      requiredCapability: 'repository.issuesWrite'
    });
    expect((failure as Error).message).toContain('issues:write');
    expect((failure as Error).message).toContain('GH_TOKEN');
    expect(JSON.stringify(failure)).not.toContain('app-token-without-issue-write');
    const audit = metadata.listAudit(principalId).find((a) => a.action === 'github_action.issue_create');
    expect(audit!.details).toMatchObject({ success: false, errorCode: 'GITHUB_PERMISSION_MISSING' });
  });

  it('falls back after a grant-denied mint and reports the missing permission without one', async () => {
    const granted = fixture();
    const grantedFallback = `ghp_${'b'.repeat(36)}`;
    granted.config.authMode = 'owner-bearer';
    granted.config.githubToken = grantedFallback;
    const grantedService = new WorkspaceService(granted.config, granted.store, undefined, granted.installations);
    broker.mintPrincipalRepositoryScopedToken.mockRejectedValueOnce(
      new HarnessError('FORBIDDEN', 'GitHub App installation cannot grant the requested permissions', 403, false, { reason: 'permission_not_granted' })
    );
    const allowed = await grantedService.execute(granted.principalSelector, 'github_action', {
      workspaceId: granted.workspaceId,
      action: 'label_create',
      name: 'triage',
      color: '0E8A16'
    });
    expect(allowed.ok).toBe(true);
    const dockerCall = docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'));
    expect(dockerCall![1]?.stdin).toBe(`${grantedFallback}\n`);

    broker.mintPrincipalRepositoryScopedToken.mockRejectedValueOnce(
      new HarnessError('FORBIDDEN', 'GitHub App installation cannot grant the requested permissions', 403, false, { reason: 'permission_not_granted' })
    );
    const denied = fixture();
    const deniedService = new WorkspaceService(denied.config, denied.store, undefined, denied.installations);
    await expect(deniedService.execute(denied.principalSelector, 'github_action', {
      workspaceId: denied.workspaceId,
      action: 'label_create',
      name: 'triage'
    })).rejects.toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', status: 403 });
  });

  it('never falls back on a non-permission mint failure', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    config.authMode = 'owner-bearer';
    config.githubToken = `ghp_${'c'.repeat(36)}`;
    const service = new WorkspaceService(config, store, undefined, installations);
    broker.mintPrincipalRepositoryScopedToken.mockRejectedValueOnce(
      new HarnessError('UNAVAILABLE', 'GitHub App could not mint an installation token with issues permission', 502, true)
    );

    await expect(service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'issue_create',
      title: 'Bug: fix needed'
    })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(docker.runDocker.mock.calls.find(([args]) => args.includes('/opt/harness/gh-helper.sh'))).toBeUndefined();
  });
  it('asks for pull_requests beside issues so an issue action reaches a pull request number', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('issue-and-pr-token', { issues: 'write', pull_requests: 'write' }));
    docker.ghResult = { stdout: 'https://github.com/bestagentkits/cloud-harness-mcp/pull/1379#issuecomment-1\n', stderr: '', exitCode: 0, truncated: false };

    const result = await service.execute(principalSelector, 'github_action', {
      workspaceId,
      action: 'issue_comment',
      issueNumber: 1379,
      body: 'Looks good'
    });

    expect(result.ok).toBe(true);
    expect(broker.mintPrincipalRepositoryScopedToken).toHaveBeenCalledWith(expect.objectContaining({
      permissionScope: 'issues',
      requiredPermission: 'write',
      optionalScope: 'pull_requests'
    }));
  });

  it('names the pull request permission when an issue action on a pull request number is refused', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('issues-only-token', { issues: 'read', contents: 'read' }));
    docker.ghResult = { stdout: '', stderr: 'GraphQL: Resource not accessible by integration (repository.issue)\n', exitCode: 1, truncated: false };

    const result = await service.execute(principalSelector, 'github_read', {
      workspaceId,
      action: 'issue_view',
      issueNumber: 1379
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', retryable: false });
    expect(result.error!.message).toContain('pull_requests:read');
    expect(result.error!.message).toContain('pr_view');
    expect(result.error!.message).toContain('Resource not accessible by integration');
    expect(JSON.stringify(result)).not.toContain('issues-only-token');
  });

  it('keeps the generic permission remedy when the token already reaches pull requests', async () => {
    const { config, store, installations, workspaceId, principalSelector } = fixture();
    const service = new WorkspaceService(config, store, undefined, installations);
    broker.mintPrincipalRepositoryScopedToken.mockResolvedValueOnce(mintedToken('issue-and-pr-token', { issues: 'read', pull_requests: 'write', contents: 'read' }));
    docker.ghResult = { stdout: '', stderr: 'GraphQL: Resource not accessible by integration (repository.issue)\n', exitCode: 1, truncated: false };

    const result = await service.execute(principalSelector, 'github_read', {
      workspaceId,
      action: 'issue_view',
      issueNumber: 7
    });

    expect(result.error).toMatchObject({ code: 'GITHUB_PERMISSION_MISSING' });
    expect(result.error!.message).not.toContain('most likely names a pull request');
  });
});
