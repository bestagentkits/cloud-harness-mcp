import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig, type RunnerResponse } from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import type { OperationManager } from '../src/operation-manager.js';
import { StateStore } from '../src/state-store.js';

const CLEAN_CHECKOUT = { uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 };

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: { uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 }, truncated: false } as Record<string, unknown>,
  workerResults: new Map<string, Record<string, unknown>>(),
  failCloneAlias: undefined as string | undefined,
  onClone: undefined as ((destination: string) => void) | undefined,
  onWorker: undefined as ((operation: string, root: string) => void) | undefined,
  runDocker: vi.fn(async (args: string[], options?: { stdin?: string }) => {
    if (args.includes('/opt/harness/clone-helper.sh')) {
      // The host side of `<host>:/job` may itself contain a drive colon.
      const volume = args[args.indexOf('--volume') + 1]!;
      const jobMount = volume.slice(0, volume.lastIndexOf(':/job'));
      const destination = args[args.indexOf('/opt/harness/clone-helper.sh') + 3]!;
      const checkout = join(jobMount, destination.replace(/^\/job\//, ''));
      if (docker.failCloneAlias && destination.endsWith(`/${docker.failCloneAlias}`)) {
        // A clone that fails midway leaves a partial checkout behind for the rollback to remove.
        mkdirSync(join(checkout, '.git'), { recursive: true });
        return { stdout: '', stderr: 'fatal: repository not found', exitCode: 128, truncated: false };
      }
      mkdirSync(join(checkout, '.git'), { recursive: true });
      docker.onClone?.(destination);
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('branch') && args.includes('--show-current')) return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('/opt/harness/worker-runner.sh')) {
      const root = args.find((value) => value.startsWith('CH_WORKSPACE_ROOT='))?.slice('CH_WORKSPACE_ROOT='.length) ?? '/workspace';
      const operation = (JSON.parse(options?.stdin ?? '{}') as { operation?: string }).operation ?? '';
      docker.onWorker?.(operation, root);
      const result = docker.workerResults.get(`${operation}:${root}`) ?? docker.workerResult;
      return { stdout: JSON.stringify(result), stderr: '', exitCode: 0, truncated: false };
    }
    if (args[0] === 'create') return { stdout: 'container-created\n', stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({
  validateRepositoryUrl: vi.fn(async (value: string) => {
    const url = new URL(value);
    if (url.hostname !== 'github.com') throw Object.assign(new Error('repository host is not allowed'), { code: 'FORBIDDEN' });
    return url;
  })
}));
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  mintRepositoryToken: vi.fn(async () => 'mock-token'),
  mintPrincipalRepositoryToken: vi.fn(async () => 'mock-token')
}));

import type * as GitHubAppBroker from '../src/github-app-broker.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const principal = { kind: 'owner' as const, ownerId: 'dynamic-owner' };

type PublicEntry = { repositoryId: string; alias: string; path: string; access: string; primary: boolean };

function fixture(overrides: Partial<RunnerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-dynamic-repo-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  const artifactRoot = join(directory, 'artifacts');
  mkdirSync(jobsRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
    artifactRoot,
    maxArtifactBytes: 1024 * 1024,
    maxPrincipalArtifactBytes: 16 * 1024 * 1024,
    artifactRetentionSeconds: 86400,
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    maxOutputBytes: 262144,
    maxWorkspaceBytes: 104857600,
    minFreeBytes: 0,
    maxActiveWorkspacesPerOwner: 3,
    networkProfile: 'network-none',
    allowedGitHosts: ['github.com'],
    executorImage: 'cloud-harness-executor:test',
    ...overrides
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const artifacts = new ArtifactStore(store.database, {
    root: artifactRoot,
    maxArtifactBytes: config.maxArtifactBytes,
    maxPrincipalBytes: config.maxPrincipalArtifactBytes,
    defaultRetentionMs: config.artifactRetentionSeconds * 1000,
    maxRetentionMs: 86400 * 1000 * 30
  });
  const service = new WorkspaceService(config, store, undefined, undefined, undefined, artifacts);
  return { config, store, jobsRoot, service };
}

async function openMulti(service: WorkspaceService) {
  const result = await service.execute(principal, 'workspace_open', {
    idempotencyKey: 'dynamic-open-1',
    repositories: [
      { url: 'https://github.com/acme/api.git', alias: 'api' },
      { url: 'https://github.com/acme/web.git', alias: 'web' }
    ],
    primaryRepositoryAlias: 'api'
  });
  return result.data as { workspaceId: string; repositories: PublicEntry[] };
}

function checkout(jobsRoot: string, workspaceId: string, alias: string): string {
  return join(jobsRoot, workspaceId, 'repo', 'repos', alias);
}

function clones() {
  return docker.runDocker.mock.calls.filter((call) => call[0].includes('/opt/harness/clone-helper.sh'));
}

function workerCalls() {
  return docker.runDocker.mock.calls.filter((call) => call[0].includes('/opt/harness/worker-runner.sh'));
}

function bumpGeneration(store: StateStore, workspaceId: string): void {
  store.database.prepare('UPDATE workspaces SET generation = generation + 1 WHERE id = ?').run(workspaceId);
}

function operationsOf(service: WorkspaceService): OperationManager {
  return (service as unknown as { operations: OperationManager }).operations;
}

const addDocs = (workspaceId: string, idempotencyKey = 'add-docs-1') => ({
  workspaceId, url: 'https://github.com/acme/docs.git', alias: 'docs', ref: 'main', idempotencyKey
});

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: { ...CLEAN_CHECKOUT }, truncated: false };
  docker.workerResults.clear();
  docker.failCloneAlias = undefined;
  docker.onClone = undefined;
  docker.onWorker = undefined;
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('workspace_repo_add', () => {
  it('clones into repos/<alias> through the constrained helper and registers the checkout after the clone', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const result = await service.execute(principal, 'workspace_repo_add', addDocs(workspaceId));

    expect(result.ok).toBe(true);
    const data = result.data as { repository: PublicEntry; repositories: PublicEntry[] };
    expect(data.repository).toMatchObject({ alias: 'docs', path: 'repos/docs', access: 'read-write', primary: false });
    expect(data.repositories.map((entry) => entry.alias)).toEqual(['api', 'web', 'docs']);
    expect(existsSync(checkout(jobsRoot, workspaceId, 'docs'))).toBe(true);

    const clone = clones().at(-1)![0];
    expect(clone.slice(-5, -3)).toEqual(['https://github.com/acme/docs.git', '/job/repo/repos/docs']);
    expect(clone.at(-3)).toBe('main');
    expect(clone.join(' ')).not.toContain('mock-token');

    const rows = store.workspaceRepositories(workspaceId);
    expect(rows.map((row) => [row.alias, row.position, row.primary])).toEqual([['api', 0, true], ['web', 1, false], ['docs', 2, false]]);
    expect(rows[2]!.id).toBe(data.repository.repositoryId);

    // The new checkout is addressable by every scoped tool at once.
    await service.execute(principal, 'git_status', { workspaceId, repositoryId: 'docs' });
    expect(workerCalls().at(-1)![0]).toContain('CH_WORKSPACE_ROOT=/workspace/repos/docs');
  });

  it('replays the first result for the same key and refuses the key with different parameters', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    const first = await service.execute(principal, 'workspace_repo_add', addDocs(workspaceId));
    const cloneCount = clones().length;

    const replay = await service.execute(principal, 'workspace_repo_add', addDocs(workspaceId));
    expect(replay).toEqual(first);
    expect(clones()).toHaveLength(cloneCount);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(3);

    await expect(service.execute(principal, 'workspace_repo_add', { ...addDocs(workspaceId), alias: 'manual' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Idempotency key reused') });
  });

  it('refuses a single-repository workspace', async () => {
    const { service } = fixture();
    const opened = await service.execute(principal, 'workspace_open', { idempotencyKey: 'single-1', repositoryUrl: 'https://github.com/acme/api.git' });
    const { workspaceId } = opened.data as { workspaceId: string };
    const before = clones().length;
    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('multi-repository') });
    expect(clones()).toHaveLength(before);
  });

  it('enforces the repository limit before cloning', async () => {
    const { service, store } = fixture({ maxWorkspaceRepositories: 2 } as Partial<RunnerConfig>);
    const { workspaceId } = await openMulti(service);
    const before = clones().length;
    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', message: expect.stringContaining('at most 2') });
    expect(clones()).toHaveLength(before);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('rejects a duplicate alias or URL the way open does', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    await expect(service.execute(principal, 'workspace_repo_add', { ...addDocs(workspaceId), alias: 'web' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('duplicate repository alias') });
    await expect(service.execute(principal, 'workspace_repo_add', { ...addDocs(workspaceId, 'add-dup-url'), url: 'https://GitHub.com/acme/web' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('duplicate repository URL') });
  });

  it('validates the URL with the repository policy before cloning', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    const before = clones().length;
    await expect(service.execute(principal, 'workspace_repo_add', { ...addDocs(workspaceId), url: 'https://gitlab.example.com/acme/docs.git' }))
      .rejects.toThrow('repository host is not allowed');
    expect(clones()).toHaveLength(before);
  });

  it('removes only the partial checkout and registers nothing when the clone fails', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    writeFileSync(join(checkout(jobsRoot, workspaceId, 'api'), 'keep.txt'), 'untouched');
    docker.failCloneAlias = 'docs';

    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('repository docs: ') });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'docs'))).toBe(false);
    expect(readFileSync(join(checkout(jobsRoot, workspaceId, 'api'), 'keep.txt'), 'utf8')).toBe('untouched');
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(true);
    expect(store.workspaceRepositories(workspaceId).map((row) => row.alias)).toEqual(['api', 'web']);

    // A failure records no replay, so the same key succeeds once the clone does.
    docker.failCloneAlias = undefined;
    const retried = await service.execute(principal, 'workspace_repo_add', addDocs(workspaceId));
    expect(retried.ok).toBe(true);
  });

  it('is fenced by the workspace generation and rolls back the checkout when the fence is lost', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.onClone = () => bumpGeneration(store, workspaceId);

    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'EXPIRED' });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'docs'))).toBe(false);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('refuses when the checkout path already holds the caller\'s data, and leaves it in place', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    mkdirSync(checkout(jobsRoot, workspaceId, 'docs'));
    writeFileSync(join(checkout(jobsRoot, workspaceId, 'docs'), 'draft.md'), 'mine');
    const before = clones().length;

    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('repos/docs already exists') });
    expect(clones()).toHaveLength(before);
    expect(readFileSync(join(checkout(jobsRoot, workspaceId, 'docs'), 'draft.md'), 'utf8')).toBe('mine');
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });
});

describe('workspace_repo_remove', () => {
  it('removes a clean checkout, then its directory, and replays the result', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const result = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-web-key' });

    expect(result.data).toMatchObject({ removed: { alias: 'web' }, checkoutRemoved: true });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(false);
    expect(existsSync(checkout(jobsRoot, workspaceId, 'api'))).toBe(true);
    expect(store.workspaceRepositories(workspaceId).map((row) => row.alias)).toEqual(['api']);

    const replay = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-web-key' });
    expect(replay).toEqual(result);
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'api', idempotencyKey: 'rm-web-key' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Idempotency key reused') });
  });

  it.each([
    ['uncommitted changes', { uncommittedPaths: 2, stashes: 0, unpushedCommits: 0 }, '2 uncommitted or untracked path(s)'],
    ['untracked files', { uncommittedPaths: 1, stashes: 0, unpushedCommits: 0 }, '1 uncommitted or untracked path(s)'],
    ['stashes', { uncommittedPaths: 0, stashes: 1, unpushedCommits: 0 }, '1 stash(es)'],
    ['unpushed commits', { uncommittedPaths: 0, stashes: 0, unpushedCommits: 3 }, '3 commit(s) not on any remote']
  ])('refuses to remove a checkout with %s', async (_kind, counts, reason) => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.workerResults.set('workspace_recover:/workspace/repos/web', { ok: true, message: 'ok', data: counts, truncated: false });

    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-dirty' }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: false, message: expect.stringContaining(reason) });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(true);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('refuses to remove a checkout with a linked worktree, even a clean one', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    mkdirSync(join(checkout(jobsRoot, workspaceId, 'web'), '.git', 'worktrees', 'feature'), { recursive: true });

    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-worktree' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('1 linked worktree(s)') });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('refuses when the unsaved-work check cannot run', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.workerResults.set('workspace_recover:/workspace/repos/web', { ok: false, message: 'failed', error: { code: 'INTERNAL_ERROR', message: 'failed', retryable: false }, truncated: false });
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-unknown' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('could not run') });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('refuses while an operation runs inside the checkout and allows one in a sibling with a similar name', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    const ownerId = store.resolvePrincipal(principal);
    const operations = operationsOf(service);
    operations.registerGenericOperation({ id: 'op_sibling', workspaceId, ownerId, kind: 'exec_run', cwd: 'repos/webapp' });
    const inside = operations.registerGenericOperation({ id: 'op_inside', workspaceId, ownerId, kind: 'exec_run', cwd: 'repos/web/src' });

    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-busy-key' }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: true, message: expect.stringContaining('operation op_inside') });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);

    inside.status = 'completed';
    const removed = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-busy-key' });
    expect(removed.ok).toBe(true);
  });

  it('refuses while an agent runs in the workspace', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    (service as unknown as { agentManager: { hasActiveAgents(ownerId: string, workspaceId: string): boolean } }).agentManager = {
      hasActiveAgents: () => true
    };
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-agent' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('agents running in the workspace') });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('refuses the last repository and a single-repository workspace', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-web-key' });
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'api', idempotencyKey: 'rm-api-key' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('last repository') });

    const single = await service.execute(principal, 'workspace_open', { idempotencyKey: 'single-2', repositoryUrl: 'https://github.com/acme/solo.git' });
    const singleId = (single.data as { workspaceId: string }).workspaceId;
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId: singleId, repositoryId: 'solo', idempotencyKey: 'rm-solo-key' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('multi-repository') });
  });

  it('promotes the next repository when the primary is removed', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    const result = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'api', idempotencyKey: 'rm-primary' });

    expect((result.data as { repositories: PublicEntry[] }).repositories).toEqual([expect.objectContaining({ alias: 'web', primary: true })]);
    expect(store.workspaceRepositories(workspaceId).map((row) => [row.alias, row.primary])).toEqual([['web', true]]);
    expect(store.byId(workspaceId)!.repositoryUrl).toBe('https://github.com/acme/web.git');
  });

  it('is fenced by the workspace generation and keeps the checkout when the fence is lost', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.onWorker = (operation, root) => {
      if (operation === 'workspace_recover' && root === '/workspace/repos/web') bumpGeneration(store, workspaceId);
    };
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-fenced' }))
      .rejects.toMatchObject({ code: 'EXPIRED' });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(true);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('unregisters a checkout whose directory is already gone', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    rmSync(checkout(jobsRoot, workspaceId, 'web'), { recursive: true });
    const result = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-gone-key' });
    expect(result.data).toMatchObject({ checkoutRemoved: true });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(1);
  });
});

describe('scope "all" search', () => {
  it('searches each checkout and attributes results with checkout-relative paths', async () => {
    const { service } = fixture();
    const { workspaceId, repositories } = await openMulti(service);
    docker.workerResults.set('grep_search:/workspace/repos/api', { ok: true, message: 'ok', data: { matches: ['/workspace/repos/api/src/a.ts:3:5:needle'] }, truncated: false });
    docker.workerResults.set('grep_search:/workspace/repos/web', { ok: true, message: 'ok', data: { matches: ['/workspace/repos/web/b.ts:1:1:needle'] }, truncated: false });

    const result = await service.execute(principal, 'grep_search', { workspaceId, pattern: 'needle', scope: 'all' });
    expect(result.data).toEqual({
      scope: 'all',
      matches: [
        { repositoryId: repositories[0]!.repositoryId, alias: 'api', match: 'src/a.ts:3:5:needle' },
        { repositoryId: repositories[1]!.repositoryId, alias: 'web', match: 'b.ts:1:1:needle' }
      ],
      repositories: [
        { repositoryId: repositories[0]!.repositoryId, alias: 'api', results: 1, truncated: false },
        { repositoryId: repositories[1]!.repositoryId, alias: 'web', results: 1, truncated: false }
      ]
    });
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty('cursor');
    const inputs = workerCalls().slice(-2).map((call) => JSON.parse(call[1]!.stdin!).input as Record<string, unknown>);
    expect(inputs.every((input) => !('scope' in input) && !('cursor' in input))).toBe(true);
  });

  it('bounds the results by maxResults and continues with a cursor naming the next repository', async () => {
    const { service } = fixture();
    const { workspaceId, repositories } = await openMulti(service);
    docker.workerResults.set('symbols_references:/workspace/repos/api', { ok: true, message: 'ok', data: { references: ['/workspace/repos/api/a.ts:1:1:x'] }, truncated: false });
    docker.workerResults.set('symbols_references:/workspace/repos/web', { ok: true, message: 'ok', data: { references: ['/workspace/repos/web/b.ts:2:2:x'] }, truncated: false });

    const first = await service.execute(principal, 'symbols_references', { workspaceId, symbol: 'x', scope: 'all', maxResults: 1 });
    expect((first.data as { references: unknown[] }).references).toEqual([{ repositoryId: repositories[0]!.repositoryId, alias: 'api', reference: 'a.ts:1:1:x' }]);
    expect(first.truncated).toBe(true);
    expect((first as RunnerResponse & { cursor?: string }).cursor).toBe(repositories[1]!.repositoryId);

    const second = await service.execute(principal, 'symbols_references', { workspaceId, symbol: 'x', scope: 'all', maxResults: 1, cursor: repositories[1]!.repositoryId });
    expect((second.data as { references: unknown[] }).references).toEqual([{ repositoryId: repositories[1]!.repositoryId, alias: 'web', reference: 'b.ts:2:2:x' }]);
    expect(second.truncated).toBe(false);
    expect(second).not.toHaveProperty('cursor');

    await expect(service.execute(principal, 'symbols_references', { workspaceId, symbol: 'x', scope: 'all', cursor: 'repo_unknown' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('cursor') });
  });

  it('attributes symbols and reports a failing checkout beside the others', async () => {
    const { service } = fixture();
    const { workspaceId, repositories } = await openMulti(service);
    docker.workerResults.set('symbols_search:/workspace/repos/api', { ok: true, message: 'ok', data: { symbols: [{ name: 'run', path: 'src/run.ts', line: 4 }] }, truncated: false });
    docker.workerResults.set('symbols_search:/workspace/repos/web', { ok: false, message: 'symbol indexing failed', error: { code: 'INTERNAL_ERROR', message: 'symbol indexing failed', retryable: false }, truncated: false });

    const result = await service.execute(principal, 'symbols_search', { workspaceId, query: 'run', scope: 'all' });
    const data = result.data as { symbols: unknown[]; repositories: Array<Record<string, unknown>> };
    expect(data.symbols).toEqual([{ name: 'run', path: 'src/run.ts', line: 4, repositoryId: repositories[0]!.repositoryId, alias: 'api' }]);
    expect(data.repositories[1]).toEqual({ repositoryId: repositories[1]!.repositoryId, alias: 'web', error: 'symbol indexing failed' });
  });

  it('rejects scope "all" together with repositoryId and leaves the default search unchanged', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    await expect(service.execute(principal, 'grep_search', { workspaceId, pattern: 'x', scope: 'all', repositoryId: 'api' }))
      .rejects.toThrow(/mutually exclusive/);

    docker.workerResult = { ok: true, message: 'ok', data: { matches: ['/workspace/a.ts:1:1:x'] }, truncated: false };
    const plain = await service.execute(principal, 'grep_search', { workspaceId, pattern: 'x', cursor: 'ignored' });
    expect(plain.data).toMatchObject({ matches: ['/workspace/a.ts:1:1:x'] });
    expect(plain.data).not.toHaveProperty('repositories');
    expect(plain).not.toHaveProperty('cursor');
    const input = JSON.parse(workerCalls().at(-1)![1]!.stdin!).input as Record<string, unknown>;
    expect(input).not.toHaveProperty('cursor');
    expect(input).not.toHaveProperty('scope');
  });

  it('attributes a single-repository workspace search to its synthesized entry', async () => {
    const { service } = fixture();
    const opened = await service.execute(principal, 'workspace_open', { idempotencyKey: 'single-search', repositoryUrl: 'https://github.com/acme/api.git' });
    const { workspaceId } = opened.data as { workspaceId: string };
    docker.workerResult = { ok: true, message: 'ok', data: { matches: ['/workspace/src/a.ts:1:1:x'] }, truncated: false };
    const result = await service.execute(principal, 'grep_search', { workspaceId, pattern: 'x', scope: 'all' });
    expect((result.data as { matches: unknown[] }).matches).toEqual([{ repositoryId: expect.stringMatching(/^repo_/), alias: 'api', match: 'src/a.ts:1:1:x' }]);
  });
});

describe('artifacts in a selected checkout', () => {
  it('records the source repository as provenance and surfaces it in list and read', async () => {
    const { service, jobsRoot } = fixture();
    const { workspaceId, repositories } = await openMulti(service);
    writeFileSync(join(checkout(jobsRoot, workspaceId, 'web'), 'notes.md'), 'web notes');
    writeFileSync(join(jobsRoot, workspaceId, 'repo', 'notes.md'), 'root notes');

    const scoped = await service.execute(principal, 'artifacts_snapshot', { workspaceId, repositoryId: 'web', path: 'notes.md', logicalName: 'web-notes.md' });
    expect(scoped.data).toMatchObject({ repositoryId: repositories[1]!.repositoryId, repositoryAlias: 'web', sizeBytes: Buffer.byteLength('web notes') });
    const root = await service.execute(principal, 'artifacts_snapshot', { workspaceId, path: 'notes.md', logicalName: 'root-notes.md' });
    expect(root.data).not.toHaveProperty('repositoryId');
    expect((root.data as { sizeBytes: number }).sizeBytes).toBe(Buffer.byteLength('root notes'));

    const { artifactId } = scoped.data as { artifactId: string };
    const listed = await service.execute(principal, 'artifacts_list', {});
    expect((listed.data as { artifacts: Array<Record<string, unknown>> }).artifacts.find((entry) => entry.artifactId === artifactId))
      .toMatchObject({ repositoryId: repositories[1]!.repositoryId, repositoryAlias: 'web' });
    const read = await service.execute(principal, 'artifacts_read', { artifactId });
    expect(read.data).toMatchObject({ repositoryId: repositories[1]!.repositoryId, repositoryAlias: 'web' });
    expect(Buffer.from((read.data as { content: string }).content, 'base64').toString()).toBe('web notes');

    await expect(service.execute(principal, 'artifacts_snapshot', { workspaceId, repositoryId: 'docs', path: 'notes.md', logicalName: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('restores into the selected checkout and into the tree root without a selector', async () => {
    const { service, jobsRoot } = fixture();
    const { workspaceId, repositories } = await openMulti(service);
    writeFileSync(join(checkout(jobsRoot, workspaceId, 'web'), 'notes.md'), 'web notes');
    const snapshot = await service.execute(principal, 'artifacts_snapshot', { workspaceId, repositoryId: 'web', path: 'notes.md', logicalName: 'notes.md' });
    const { artifactId } = snapshot.data as { artifactId: string };

    const scoped = await service.execute(principal, 'artifacts_restore', { artifactId, workspaceId, repositoryId: 'api', path: 'restored.md' });
    expect(workerCalls().at(-1)![0]).toContain('CH_WORKSPACE_ROOT=/workspace/repos/api');
    expect(scoped.data).toMatchObject({ repositoryId: repositories[0]!.repositoryId, alias: 'api', path: 'restored.md' });

    const unscoped = await service.execute(principal, 'artifacts_restore', { artifactId, workspaceId, path: 'restored.md' });
    expect(workerCalls().at(-1)![0].some((value) => value.startsWith('CH_WORKSPACE_ROOT='))).toBe(false);
    expect(unscoped.data).not.toHaveProperty('repositoryId');
  });
});
