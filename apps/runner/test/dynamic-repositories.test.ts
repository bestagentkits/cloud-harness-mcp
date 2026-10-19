import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  workerHandler: undefined as ((operation: string, root: string, input: Record<string, unknown>) => Record<string, unknown> | undefined) | undefined,
  onCommand: undefined as ((args: string[]) => void) | undefined,
  failPause: false,
  timeoutPause: false,
  failUnpause: false,
  psOutput: '',
  runDocker: vi.fn(async (args: string[], options?: { stdin?: string }) => {
    docker.onCommand?.(args);
    if (args[0] === 'pause' && docker.failPause) return { stdout: '', stderr: 'cannot pause', exitCode: 1, truncated: false };
    if (args[0] === 'pause' && docker.timeoutPause) throw Object.assign(new Error('Docker operation timed out'), { code: 'TIMEOUT' });
    if (args[0] === 'unpause' && docker.failUnpause) return { stdout: '', stderr: 'cannot unpause', exitCode: 1, truncated: false };
    if (args[0] === 'ps') return { stdout: docker.psOutput, stderr: '', exitCode: 0, truncated: false };
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
      const request = JSON.parse(options?.stdin ?? '{}') as { operation?: string; input?: Record<string, unknown> };
      const operation = request.operation ?? '';
      docker.onWorker?.(operation, root);
      const result = docker.workerHandler?.(operation, root, request.input ?? {}) ?? docker.workerResults.get(`${operation}:${root}`) ?? docker.workerResult;
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

function stagingDirectories(jobsRoot: string, workspaceId: string): string[] {
  return readdirSync(join(jobsRoot, workspaceId)).filter((name) => name.startsWith('repository-add-'));
}

function dockerVerbs(): string[] {
  return docker.runDocker.mock.calls.map((call) => (call[0].includes('/opt/harness/worker-runner.sh') ? `${call[0][0]}:worker` : call[0][0]!));
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
  docker.workerHandler = undefined;
  docker.onCommand = undefined;
  docker.failPause = false;
  docker.timeoutPause = false;
  docker.failUnpause = false;
  docker.psOutput = '';
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

    // The clone lands in a staging directory outside the executor's mount, which is gone afterwards.
    const clone = clones().at(-1)![0];
    expect(clone.at(-5)).toBe('https://github.com/acme/docs.git');
    expect(clone.at(-4)).toMatch(/^\/job\/repository-add-[0-9a-f]{24}\/docs$/);
    expect(clone.at(-3)).toBe('main');
    expect(clone.join(' ')).not.toContain('mock-token');
    expect(stagingDirectories(jobsRoot, workspaceId)).toEqual([]);

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

  it('refuses a link placed at the new checkout path during the clone and leaves it and its target alone', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const api = checkout(jobsRoot, workspaceId, 'api');
    writeFileSync(join(api, 'keep.txt'), 'untouched');
    docker.onClone = () => symlinkSync(api, checkout(jobsRoot, workspaceId, 'docs'), 'junction');

    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('repos/docs already exists') });
    expect(lstatSync(checkout(jobsRoot, workspaceId, 'docs')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(api, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
    expect(stagingDirectories(jobsRoot, workspaceId)).toEqual([]);
  });

  it('never removes a directory the executor created at the checkout path while the clone ran', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.onClone = () => {
      mkdirSync(checkout(jobsRoot, workspaceId, 'docs'));
      writeFileSync(join(checkout(jobsRoot, workspaceId, 'docs'), 'draft.md'), 'mine');
    };

    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId)))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('repos/docs already exists') });
    expect(readFileSync(join(checkout(jobsRoot, workspaceId, 'docs'), 'draft.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(checkout(jobsRoot, workspaceId, 'docs'), '.git'))).toBe(false);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
    expect(stagingDirectories(jobsRoot, workspaceId)).toEqual([]);
  });

  it('rolls back only the directory it placed, not one that replaced it', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const docs = checkout(jobsRoot, workspaceId, 'docs');
    vi.spyOn(store, 'addWorkspaceRepository').mockImplementationOnce(() => {
      renameSync(docs, `${docs}-placed`);
      mkdirSync(docs);
      writeFileSync(join(docs, 'draft.md'), 'mine');
      throw new Error('registry write failed');
    });

    await expect(service.execute(principal, 'workspace_repo_add', addDocs(workspaceId))).rejects.toThrow('registry write failed');
    expect(readFileSync(join(docs, 'draft.md'), 'utf8')).toBe('mine');
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('places the checkout with the executor paused and refuses when it cannot be paused', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.onCommand = (args) => {
      if (args[0] === 'pause') expect(existsSync(checkout(jobsRoot, workspaceId, 'docs'))).toBe(false);
      if (args[0] === 'unpause') expect(store.workspaceRepositories(workspaceId)).toHaveLength(3);
    };
    await service.execute(principal, 'workspace_repo_add', addDocs(workspaceId));
    const verbs = dockerVerbs();
    expect(verbs.indexOf('pause')).toBeGreaterThan(verbs.lastIndexOf('run'));
    expect(verbs.at(-1)).toBe('unpause');

    docker.onCommand = undefined;
    docker.failPause = true;
    await expect(service.execute(principal, 'workspace_repo_add', { ...addDocs(workspaceId, 'add-notes-1'), alias: 'notes', url: 'https://github.com/acme/notes.git' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('could not be paused') });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'notes'))).toBe(false);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(3);
    expect(stagingDirectories(jobsRoot, workspaceId)).toEqual([]);
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

  it('keeps the executor paused from the unsaved-work check until the directory is gone', async () => {
    const { service, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.onCommand = (args) => {
      if (args[0] === 'unpause') expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(false);
    };
    const before = docker.runDocker.mock.calls.length;
    await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-frozen' });

    const calls = docker.runDocker.mock.calls.slice(before).map((call) => call[0]);
    const verbs = calls.map((args) => args[0]);
    expect(verbs[0]).toBe('pause');
    expect(verbs.at(-1)).toBe('unpause');
    // A paused executor takes no exec, so the check runs in a read-only helper inside the frozen window.
    const check = calls.find((args) => args.includes('/opt/harness/worker-runner.sh'))!;
    expect(check[0]).toBe('run');
    expect(check).toContain(`${join(jobsRoot, workspaceId)}/repo:/workspace:ro`);
    expect(calls.some((args) => args[0] === 'exec')).toBe(false);
  });

  it('refuses, and changes nothing, when the executor cannot be paused or another container uses the tree', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.failPause = true;
    const checksBefore = workerCalls().length;
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-unpaused' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('could not be paused') });
    expect(workerCalls()).toHaveLength(checksBefore);

    docker.failPause = false;
    docker.psOutput = 'chm-priv-other\t\n';
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-busy-tree' }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: true, message: expect.stringContaining('chm-priv-other') });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(true);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
    expect(dockerVerbs().at(-1)).toBe('unpause');

    // Agent containers mount no workspace tree, so they do not hold the change back.
    docker.psOutput = 'chm-agent-1\ttrue\n';
    const removed = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-busy-tree' });
    expect(removed.data).toMatchObject({ checkoutRemoved: true });
  });

  it('refuses while a privileged helper writes to the tree, and no helper starts while it is frozen', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    const writers = service as unknown as { claimTreeWriter(record: { id: string }): () => void };
    const release = writers.claimTreeWriter({ id: workspaceId });
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-writer' }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: true, message: expect.stringContaining('privileged command') });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
    release();

    let startedWhileFrozen: unknown;
    docker.onWorker = (operation) => {
      if (operation !== 'workspace_recover') return;
      try { writers.claimTreeWriter({ id: workspaceId })(); } catch (error) { startedWhileFrozen = error; }
    };
    await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-writer' });
    expect(startedWhileFrozen).toMatchObject({ code: 'CONFLICT', retryable: true });
    expect(() => writers.claimTreeWriter({ id: workspaceId })()).not.toThrow();
  });

  it('refuses, and deletes nothing outside, when a link replaces the checkout after its path was verified', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const web = checkout(jobsRoot, workspaceId, 'web');
    const outside = join(jobsRoot, '..', 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'state.db'), 'precious');
    docker.onWorker = (operation, root) => {
      if (operation !== 'workspace_recover' || root !== '/workspace/repos/web') return;
      renameSync(web, `${web}-moved`);
      symlinkSync(outside, web, 'junction');
    };

    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-swapped' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readFileSync(join(outside, 'state.db'), 'utf8')).toBe('precious');
    expect(lstatSync(web).isSymbolicLink()).toBe(true);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('unlinks a link inside the checkout without following it out of the workspace', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const web = checkout(jobsRoot, workspaceId, 'web');
    mkdirSync(join(web, 'src'));
    const outside = join(jobsRoot, '..', 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'state.db'), 'precious');
    docker.onWorker = (operation, root) => {
      if (operation !== 'workspace_recover' || root !== '/workspace/repos/web') return;
      rmSync(join(web, 'src'), { recursive: true });
      symlinkSync(outside, join(web, 'src'), 'junction');
    };

    const result = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-inner-link' });
    expect(result.data).toMatchObject({ checkoutRemoved: true });
    expect(existsSync(web)).toBe(false);
    expect(readFileSync(join(outside, 'state.db'), 'utf8')).toBe('precious');
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(1);
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

describe('executor pause and resume', () => {
  type PauseInternals = {
    instanceId: string;
    withPausedExecutor<T>(record: unknown, action: () => Promise<T>): Promise<T>;
    auditWorkspaceMutation(...args: unknown[]): void;
  };
  const internals = (service: WorkspaceService) => service as unknown as PauseInternals;
  const managedLabels = (service: WorkspaceService, workspaceId: string) => ({
    'cloud-harness.managed': 'true', 'cloud-harness.instance': internals(service).instanceId, 'cloud-harness.workspace': workspaceId
  });

  it('keeps a committed removal, audits it, and resumes the executor on the next recover when the resume fails', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const audit = vi.spyOn(internals(service), 'auditWorkspaceMutation');
    docker.failUnpause = true;
    const before = docker.runDocker.mock.calls.length;

    const removed = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-stuck' });
    expect(removed.ok).toBe(true);
    expect(removed.message).toContain('could not be resumed');
    expect(removed.data).toMatchObject({ checkoutRemoved: true, executorResumed: false });
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(false);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.any(String), 'workspace.repository_removed', expect.anything(), expect.objectContaining({ checkoutRemoved: true }));
    // The resume is retried with a backoff before the result reports the executor still paused.
    const verbs = docker.runDocker.mock.calls.slice(before).map((call) => call[0][0]);
    expect(verbs.filter((verb) => verb === 'unpause')).toHaveLength(3);

    // The replay agrees with what was committed.
    const replay = await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-stuck' });
    expect(replay.data).toMatchObject({ checkoutRemoved: true });

    docker.failUnpause = false;
    const containerName = store.byId(workspaceId)!.containerName!;
    docker.inspectContainer.mockResolvedValueOnce({ State: { Running: true, Paused: true }, Config: { Labels: managedLabels(service, workspaceId) } } as never);
    const beforeRecover = docker.runDocker.mock.calls.length;
    const recovered = await service.execute(principal, 'workspace_recover', { workspaceId, mode: 'resume' });
    expect(recovered.ok).toBe(true);
    expect(docker.runDocker.mock.calls.slice(beforeRecover).map((call) => call[0])).toContainEqual(['unpause', containerName]);
    expect(store.byId(workspaceId)!.containerName).toBe(containerName);
  }, 10_000);

  it('reports a committed add whose resume failed instead of failing it', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    const audit = vi.spyOn(internals(service), 'auditWorkspaceMutation');
    docker.failUnpause = true;
    const added = await service.execute(principal, 'workspace_repo_add', addDocs(workspaceId));
    expect(added.data).toMatchObject({ repository: { alias: 'docs' }, executorResumed: false });
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(3);
    expect(audit).toHaveBeenCalledWith(expect.any(String), 'workspace.repository_added', expect.anything(), expect.anything());
  }, 10_000);

  it('undoes a pause that timed out before refusing the change', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.timeoutPause = true;
    const before = docker.runDocker.mock.calls.length;
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-pause-timeout' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('could not be paused') });
    const verbs = docker.runDocker.mock.calls.slice(before).map((call) => call[0][0]);
    expect(verbs).toEqual(['pause', 'unpause']);
    expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(true);
    expect(store.workspaceRepositories(workspaceId)).toHaveLength(2);
  });

  it('never resumes a pause it does not own', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    // While one pause is held, a second pause and a recover are refused without unpausing the executor.
    let nested: Promise<unknown> | undefined;
    let recoverDuringFreeze: Promise<unknown> | undefined;
    docker.onWorker = (operation) => {
      if (operation !== 'workspace_recover' || nested) return;
      nested = internals(service).withPausedExecutor(store.byId(workspaceId), async () => undefined).catch((error: unknown) => error);
      docker.inspectContainer.mockResolvedValueOnce({ State: { Running: true, Paused: true }, Config: { Labels: managedLabels(service, workspaceId) } } as never);
      recoverDuringFreeze = service.execute(principal, 'workspace_recover', { workspaceId, mode: 'resume' }).catch((error: unknown) => error);
    };
    const before = docker.runDocker.mock.calls.length;
    await service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'web', idempotencyKey: 'rm-nested' });
    expect(await nested).toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('paused for another change') });
    expect(await recoverDuringFreeze).toMatchObject({ code: 'CONFLICT', retryable: true });
    const verbs = docker.runDocker.mock.calls.slice(before).map((call) => call[0][0]);
    expect(verbs.filter((verb) => verb === 'pause')).toHaveLength(1);
    expect(verbs.filter((verb) => verb === 'unpause')).toHaveLength(1);
    expect(verbs.at(-1)).toBe('unpause');

    // A paused container without this workspace's managed labels is left alone.
    docker.inspectContainer.mockResolvedValueOnce({ State: { Running: true, Paused: true }, Config: { Labels: { 'cloud-harness.workspace': 'ws_other' } } } as never);
    const afterRemove = docker.runDocker.mock.calls.length;
    await service.execute(principal, 'workspace_recover', { workspaceId, mode: 'resume' });
    expect(docker.runDocker.mock.calls.slice(afterRemove).some((call) => call[0][0] === 'unpause')).toBe(false);
  });

  it('resumes a paused executor and sweeps leftover staging directories at startup', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const containerName = store.byId(workspaceId)!.containerName!;
    const workspaceDirectory = join(jobsRoot, workspaceId);
    const stale = 'a'.repeat(24);
    mkdirSync(join(workspaceDirectory, `repository-add-${stale}`, 'docs', '.git'), { recursive: true });
    mkdirSync(join(workspaceDirectory, `git-transfer-${stale}`));
    mkdirSync(join(workspaceDirectory, 'repository-add-notes'));
    writeFileSync(join(workspaceDirectory, `git-transfer-${'b'.repeat(24)}`), 'not a directory');
    const outside = join(jobsRoot, '..', 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'state.db'), 'precious');
    symlinkSync(outside, join(workspaceDirectory, `repository-add-${'c'.repeat(24)}`), 'junction');

    const paused = { State: { Running: true, Paused: true }, HostConfig: { NetworkMode: 'none' }, Config: { Labels: managedLabels(service, workspaceId) } };
    docker.inspectContainer.mockResolvedValueOnce(paused as never).mockResolvedValueOnce(paused as never);
    const before = docker.runDocker.mock.calls.length;
    await service.start();
    try {
      const calls = docker.runDocker.mock.calls.slice(before).map((call) => call[0]);
      const unpause = calls.findIndex((args) => args[0] === 'unpause' && args[1] === containerName);
      expect(unpause).toBeGreaterThanOrEqual(0);
      expect(calls.findIndex((args) => args[0] === 'restart' && args[1] === containerName)).toBeGreaterThan(unpause);

      const remaining = readdirSync(workspaceDirectory);
      expect(remaining).not.toContain(`repository-add-${stale}`);
      expect(remaining).not.toContain(`git-transfer-${stale}`);
      expect(remaining).toEqual(expect.arrayContaining(['repo', 'repository-add-notes', `git-transfer-${'b'.repeat(24)}`, `repository-add-${'c'.repeat(24)}`]));
      expect(readFileSync(join(outside, 'state.db'), 'utf8')).toBe('precious');
      expect(existsSync(checkout(jobsRoot, workspaceId, 'web'))).toBe(true);
    } finally {
      await service.stop();
    }
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

  it('reports a grep cut by the budget as truncated although the worker cuts silently', async () => {
    const { service } = fixture();
    const { workspaceId, repositories } = await openMulti(service);
    const [api, web] = repositories.map((entry) => entry.repositoryId);
    const lines: Record<string, number> = { '/workspace/repos/api': 2, '/workspace/repos/web': 5 };
    // Like the real worker: slice to maxResults and report truncation only for the byte cap.
    docker.workerHandler = (operation, root, input) => operation === 'grep_search'
      ? {
          ok: true,
          message: 'Search complete',
          data: { matches: Array.from({ length: lines[root] ?? 0 }, (_, index) => `${root}/f.ts:${index + 1}:1:x`).slice(0, input.maxResults as number) },
          truncated: false
        }
      : undefined;

    const first = await service.execute(principal, 'grep_search', { workspaceId, pattern: 'x', scope: 'all', maxResults: 4 });
    expect((first.data as { matches: unknown[] }).matches).toHaveLength(4);
    expect((first.data as { repositories: unknown[] }).repositories).toEqual([
      { repositoryId: api, alias: 'api', results: 2, truncated: false },
      { repositoryId: web, alias: 'web', results: 2, truncated: true }
    ]);
    expect(first.truncated).toBe(true);
    expect(first).not.toHaveProperty('cursor');

    // An exact fit is not a cut.
    const exact = await service.execute(principal, 'grep_search', { workspaceId, pattern: 'x', scope: 'all', maxResults: 5, cursor: web });
    expect((exact.data as { repositories: unknown[] }).repositories).toEqual([{ repositoryId: web, alias: 'web', results: 5, truncated: false }]);
    expect(exact.truncated).toBe(false);

    // Without the scope the worker sees the caller's maxResults unchanged.
    await service.execute(principal, 'grep_search', { workspaceId, pattern: 'x', maxResults: 4 });
    expect(JSON.parse(workerCalls().at(-1)![1]!.stdin!).input).toMatchObject({ maxResults: 4 });
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
