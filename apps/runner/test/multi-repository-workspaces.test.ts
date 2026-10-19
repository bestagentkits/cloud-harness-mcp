import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig, type RunnerResponse } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false } as Record<string, unknown>,
  workerResults: new Map<string, Record<string, unknown>>(),
  failCloneAlias: undefined as string | undefined,
  runDocker: vi.fn(async (args: string[], options?: { stdin?: string }) => {
    if (args.includes('/opt/harness/clone-helper.sh')) {
      const jobMount = args[args.indexOf('--volume') + 1]!.split(':')[0]!;
      const destination = args[args.indexOf('/opt/harness/clone-helper.sh') + 3]!;
      if (docker.failCloneAlias && destination.endsWith(`/${docker.failCloneAlias}`)) {
        return { stdout: '', stderr: 'fatal: repository not found', exitCode: 128, truncated: false };
      }
      mkdirSync(join(jobMount, destination.replace(/^\/job\//, '')), { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('branch') && args.includes('--show-current')) return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('/opt/harness/worker-runner.sh')) {
      const root = args.find((value) => value.startsWith('CH_WORKSPACE_ROOT='))?.slice('CH_WORKSPACE_ROOT='.length) ?? '/workspace';
      const operation = (JSON.parse(options?.stdin ?? '{}') as { operation?: string }).operation ?? '';
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
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  mintRepositoryToken: vi.fn(async () => 'mock-token'),
  mintPrincipalRepositoryToken: vi.fn(async () => 'mock-token')
}));

import type * as GitHubAppBroker from '../src/github-app-broker.js';
import { computeWorkspaceOpenFingerprint, WorkspaceService } from '../src/workspace-service.js';
import { legacyRepositoryEntry } from '../src/workspace-repositories.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const principal = { kind: 'owner' as const, ownerId: 'multi-owner' };

function fixture(overrides: Partial<RunnerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-multi-repo-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
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
  return { config, store, jobsRoot, service: new WorkspaceService(config, store) };
}

const repositories = [
  { url: 'https://github.com/acme/api.git', alias: 'api' },
  { url: 'https://github.com/acme/web.git', alias: 'web', ref: 'develop', access: 'read-only' }
];

async function openMulti(service: WorkspaceService, key = 'multi-open-1') {
  const result = await service.execute(principal, 'workspace_open', { idempotencyKey: key, repositories, primaryRepositoryAlias: 'api' });
  expect(result.ok).toBe(true);
  return result.data as { workspaceId: string; repositoryUrl: string; repositories: Array<{ repositoryId: string; alias: string; path: string; access: string }> };
}

function workerCalls() {
  return docker.runDocker.mock.calls.filter((call) => call[0].includes('/opt/harness/worker-runner.sh'));
}

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: {}, truncated: false };
  docker.workerResults.clear();
  docker.failCloneAlias = undefined;
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('multi-repository workspaces', () => {
  it('clones each repository into its own checkout and records the registry with the workspace', async () => {
    const { service, store, jobsRoot } = fixture();
    const opened = await openMulti(service);

    expect(opened.repositoryUrl).toBe('https://github.com/acme/api.git');
    expect(opened.repositories.map((entry) => [entry.alias, entry.path, entry.access])).toEqual([
      ['api', 'repos/api', 'read-write'],
      ['web', 'repos/web', 'read-only']
    ]);
    expect(existsSync(join(jobsRoot, opened.workspaceId, 'repo', 'repos', 'api'))).toBe(true);
    expect(existsSync(join(jobsRoot, opened.workspaceId, 'repo', 'repos', 'web'))).toBe(true);

    // Clones run two at a time, so compare them by destination rather than arrival order.
    const clones = docker.runDocker.mock.calls.filter((call) => call[0].includes('/opt/harness/clone-helper.sh')).map((call) => call[0])
      .sort((left, right) => left.at(-4)!.localeCompare(right.at(-4)!));
    expect(clones.map((args) => args.slice(-5, -3))).toEqual([
      ['https://github.com/acme/api.git', '/job/repo/repos/api'],
      ['https://github.com/acme/web.git', '/job/repo/repos/web']
    ]);
    expect(clones.map((args) => args.at(-3))).toEqual(['', 'develop']);
    const helperNames = clones.map((args) => args[args.indexOf('--name') + 1]);
    expect(new Set(helperNames).size).toBe(2);

    // The executor still mounts the whole workspace tree at /workspace.
    const create = docker.runDocker.mock.calls.find((call) => call[0][0] === 'create')![0];
    expect(create).toContain(`${join(jobsRoot, opened.workspaceId, 'repo')}:/workspace:rw`);

    const rows = store.workspaceRepositories(opened.workspaceId);
    expect(rows.map((row) => [row.alias, row.primary, row.access, row.repositoryRef])).toEqual([
      ['api', true, 'read-write', null],
      ['web', false, 'read-only', 'develop']
    ]);
    expect(rows.every((row) => /^repo_[A-Za-z0-9_-]{20,80}$/.test(row.id))).toBe(true);
  });

  it('requires a selector for Git tools and confines a selected call to that checkout', async () => {
    const { service } = fixture();
    const opened = await openMulti(service);
    const { workspaceId } = opened;
    const before = workerCalls().length;

    await expect(service.execute(principal, 'git_status', { workspaceId })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('api, web') });
    await expect(service.execute(principal, 'git_status', { workspaceId, repositoryId: 'docs' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(workerCalls()).toHaveLength(before);

    await service.execute(principal, 'git_status', { workspaceId, repositoryId: 'web' });
    const byAlias = workerCalls().at(-1)![0];
    expect(byAlias.slice(0, 6)).toEqual(['exec', '-i', '--env', 'CH_WORKSPACE_ROOT=/workspace/repos/web', '--workdir', '/workspace/repos/web']);

    const apiId = opened.repositories[0]!.repositoryId;
    await service.execute(principal, 'git_status', { workspaceId, repositoryId: apiId });
    expect(workerCalls().at(-1)![0]).toContain('CH_WORKSPACE_ROOT=/workspace/repos/api');
  });

  it('runs file and command tools on the tree root without a selector and in the checkout with one', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);

    await service.execute(principal, 'files_list', { workspaceId });
    expect(workerCalls().at(-1)![0].some((value) => value.startsWith('CH_WORKSPACE_ROOT='))).toBe(false);

    await service.execute(principal, 'exec_run', { workspaceId, repositoryId: 'api', command: 'pwd', cwd: 'src' });
    const exec = workerCalls().at(-1)!;
    expect(exec[0]).toContain('CH_WORKSPACE_ROOT=/workspace/repos/api');
    expect(JSON.parse(exec[1]!.stdin!).input.cwd).toBe('src');
  });

  it('refuses brokered writes to a read-only repository and clamps its advertised capabilities', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);

    await expect(service.execute(principal, 'git_push', { workspaceId, repositoryId: 'web', refspec: 'HEAD:refs/heads/feature' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('read-only') });
    await expect(service.execute(principal, 'workspace_finalize', { workspaceId, repositoryId: 'web', commitMessage: 'feat: x' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.execute(principal, 'github_action', { workspaceId, repositoryId: 'web', action: 'issue_comment', issueNumber: 1, body: 'hi' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(docker.runDocker.mock.calls.some((call) => call[0].includes('/opt/harness/git-transfer-helper.sh'))).toBe(false);

    const web = await service.execute(principal, 'workspace_capabilities', { workspaceId, repositoryId: 'web' });
    expect(web.data).toMatchObject({ repositoryAlias: 'web', repositoryAccess: 'read-only', operations: { gitPush: false, pullRequestCreate: false, workflowDispatch: false } });
    const primary = await service.execute(principal, 'workspace_capabilities', { workspaceId });
    expect(primary.data).toMatchObject({ repositoryAlias: 'api', repositoryAccess: 'read-write' });
  });

  it('keeps a single-repository workspace byte-identical and addressable by its synthesized entry', async () => {
    const { service } = fixture();
    const opened = await service.execute(principal, 'workspace_open', { idempotencyKey: 'single-1', repositoryUrl: 'https://github.com/acme/api.git' });
    const { workspaceId } = opened.data as { workspaceId: string; repositories?: unknown };
    expect((opened.data as { repositories?: unknown }).repositories).toBeUndefined();
    const clone = docker.runDocker.mock.calls.find((call) => call[0].includes('/opt/harness/clone-helper.sh'))![0];
    expect(clone.slice(-5, -3)).toEqual(['https://github.com/acme/api.git', '/job/repo']);
    expect(clone[clone.indexOf('--name') + 1]).toBe(`chm-clone-${workspaceId.slice(3, 15)}`);

    await service.execute(principal, 'git_status', { workspaceId });
    const legacyArgs = workerCalls().at(-1)![0];
    expect(legacyArgs.slice(0, 4)).toEqual(['exec', '-i', expect.any(String), '/usr/bin/setsid']);

    const listed = await service.execute(principal, 'workspace_repos_list', { workspaceId });
    const entry = (listed.data as { multiRepository: boolean; repositories: Array<{ repositoryId: string; alias: string; path: string }> });
    expect(entry.multiRepository).toBe(false);
    expect(entry.repositories).toEqual([expect.objectContaining({ alias: 'api', path: '.', primary: true })]);

    await service.execute(principal, 'git_status', { workspaceId, repositoryId: entry.repositories[0]!.repositoryId });
    expect(workerCalls().at(-1)![0]).toEqual(legacyArgs.map((value, index) => index === 6 ? workerCalls().at(-1)![0][6] : value));
    await expect(service.execute(principal, 'git_status', { workspaceId, repositoryId: 'web' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails the open, removes every checkout, and names the repository when one clone fails', async () => {
    const { service, store, jobsRoot } = fixture();
    docker.failCloneAlias = 'web';
    await expect(service.execute(principal, 'workspace_open', { idempotencyKey: 'multi-fail', repositories }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('repository web') });
    const ownerId = store.resolvePrincipal(principal);
    const failed = store.byIdempotency(ownerId, 'multi-fail')!;
    expect(failed.status).toBe('FAILED');
    expect(existsSync(join(jobsRoot, failed.id))).toBe(false);
  });

  it('refuses a repository set above the operator limit before admitting anything', async () => {
    const { service, store } = fixture({ maxWorkspaceRepositories: 1 } as Partial<RunnerConfig>);
    await expect(service.execute(principal, 'workspace_open', { idempotencyKey: 'multi-limit', repositories }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(store.byIdempotency(store.resolvePrincipal(principal), 'multi-limit')).toBeUndefined();
  });

  it('keeps repository ids across a runner restart and replays the open idempotently', async () => {
    const { service, store, config } = fixture();
    const opened = await openMulti(service);
    store.close();
    openStores.splice(openStores.indexOf(store), 1);
    const reopened = new StateStore(config.stateDb);
    openStores.push(reopened);
    const restarted = new WorkspaceService(config, reopened);
    const listed = await restarted.execute(principal, 'workspace_repos_list', { workspaceId: opened.workspaceId });
    expect((listed.data as { repositories: Array<{ repositoryId: string }> }).repositories.map((entry) => entry.repositoryId))
      .toEqual(opened.repositories.map((entry) => entry.repositoryId));

    const replay = await restarted.execute(principal, 'workspace_open', { idempotencyKey: 'multi-open-1', repositories, primaryRepositoryAlias: 'api' });
    expect((replay.data as { workspaceId: string }).workspaceId).toBe(opened.workspaceId);
    await expect(restarted.execute(principal, 'workspace_open', { idempotencyKey: 'multi-open-1', repositories, primaryRepositoryAlias: 'web' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps the single-repository open fingerprint unchanged', () => {
    const input = { repositoryUrl: 'https://github.com/acme/api.git', ref: 'main' };
    expect(computeWorkspaceOpenFingerprint({ ...input, repositories: undefined })).toBe(computeWorkspaceOpenFingerprint(input));
    expect(computeWorkspaceOpenFingerprint({ repositories: [{ url: input.repositoryUrl, alias: 'api', access: 'read-write' }] }))
      .not.toBe(computeWorkspaceOpenFingerprint({ repositories: [{ url: input.repositoryUrl, alias: 'api', access: 'read-only' }] }));
  });

  it('reports every checkout with unsaved work, and loose files beside them, before an auto-close', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.workerResults.set('workspace_recover:/workspace/repos/api', { ok: true, message: 'ok', data: { uncommittedPaths: 2, stashes: 0, unpushedCommits: 0 }, truncated: false });
    docker.workerResults.set('workspace_recover:/workspace/repos/web', { ok: true, message: 'ok', data: { uncommittedPaths: 0, stashes: 0, unpushedCommits: 1 }, truncated: false });
    writeFileSync(join(jobsRoot, workspaceId, 'repo', 'notes.md'), 'scratch');
    const record = store.byId(workspaceId) as WorkspaceRecord;
    const blocker = await (service as unknown as { autoCloseBlocker(record: WorkspaceRecord): Promise<string | undefined> }).autoCloseBlocker(record);
    expect(blocker).toBe('api: 2 uncommitted or untracked path(s); web: 1 commit(s) not on any remote; 1 path(s) outside the repository checkouts');
  });

  it('counts entries under repos/ that are not a registered checkout directory as unsaved work', async () => {
    const { service, store, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.workerResult = { ok: true, message: 'ok', data: { uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 }, truncated: false };
    const repos = join(jobsRoot, workspaceId, 'repo', 'repos');
    mkdirSync(join(repos, 'scratch'));
    writeFileSync(join(repos, 'NOTES.md'), 'scratch');
    const autoCloseBlocker = (service as unknown as { autoCloseBlocker(record: WorkspaceRecord): Promise<string | undefined> }).autoCloseBlocker.bind(service);
    expect(await autoCloseBlocker(store.byId(workspaceId) as WorkspaceRecord)).toBe('2 path(s) outside the repository checkouts');
    rmSync(join(repos, 'scratch'), { recursive: true });
    rmSync(join(repos, 'NOTES.md'));
    expect(await autoCloseBlocker(store.byId(workspaceId) as WorkspaceRecord)).toBeUndefined();
  });

  it('refuses a scoped call when the checkout directory was replaced by a symlink', async () => {
    const { service, jobsRoot } = fixture();
    const { workspaceId } = await openMulti(service);
    const repos = join(jobsRoot, workspaceId, 'repo', 'repos');
    rmSync(join(repos, 'web'), { recursive: true });
    symlinkSync(join(repos, 'api'), join(repos, 'web'));
    const before = workerCalls().length;
    await expect(service.execute(principal, 'files_list', { workspaceId, repositoryId: 'web' })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('repos/web') });
    expect(workerCalls()).toHaveLength(before);
  });

  it('keeps commit idempotency keys separate per repository', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.workerResults.set('git_commit:/workspace/repos/api', { ok: true, message: 'committed', data: { commit: 'a'.repeat(40) }, truncated: false });
    docker.workerResults.set('git_commit:/workspace/repos/web', { ok: true, message: 'committed', data: { commit: 'b'.repeat(40) }, truncated: false });
    const commit = { workspaceId, message: 'chore: sync', idempotencyKey: 'commit-sync-1' };
    const api = await service.execute(principal, 'git_commit', { ...commit, repositoryId: 'api' });
    const web = await service.execute(principal, 'git_commit', { ...commit, repositoryId: 'web' });
    expect(api.data).toMatchObject({ commit: 'a'.repeat(40) });
    expect(web.data).toMatchObject({ commit: 'b'.repeat(40) });
    expect(web.data).not.toHaveProperty('alreadyFinalized');
    const replay = await service.execute(principal, 'git_commit', { ...commit, repositoryId: 'api' });
    expect(replay.data).toMatchObject({ commit: 'a'.repeat(40), alreadyFinalized: true });
  });

  it('keeps push idempotency keys separate per repository', async () => {
    const { service } = fixture();
    const opened = await service.execute(principal, 'workspace_open', {
      idempotencyKey: 'push-open-1',
      repositories: [{ url: 'https://github.com/acme/api.git', alias: 'api' }, { url: 'https://github.com/acme/web.git', alias: 'web' }]
    });
    const { workspaceId } = opened.data as { workspaceId: string };
    const push = { workspaceId, refspec: 'HEAD:refs/heads/feat-x', idempotencyKey: 'push-feat-x' };
    const transfers = () => docker.runDocker.mock.calls.filter((call) => call[0].some((value) => value.includes('git-transfer'))).length;
    await service.execute(principal, 'git_push', { ...push, repositoryId: 'api' });
    const afterApi = transfers();
    const web = await service.execute(principal, 'git_push', { ...push, repositoryId: 'web' });
    expect(web.data).not.toHaveProperty('alreadyFinalized');
    expect(transfers()).toBeGreaterThan(afterApi);
    const replay = await service.execute(principal, 'git_push', { ...push, repositoryId: 'api' });
    expect(replay.data).toMatchObject({ alreadyFinalized: true });
  });

  it('confines a background agent tool call to the repository it selects', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openMulti(service);
    const record = store.byId(workspaceId) as WorkspaceRecord;
    const proxy = (service as unknown as { executeAgentProxy(request: Record<string, unknown>): Promise<RunnerResponse> }).executeAgentProxy.bind(service);
    await proxy({ ownerId: record.ownerId, workspaceId, workspaceGeneration: record.generation, operation: 'files_write', toolInput: { repositoryId: 'web', path: 'src/a.ts', content: 'x' } });
    expect(workerCalls().at(-1)![0]).toContain('CH_WORKSPACE_ROOT=/workspace/repos/web');
    await expect(proxy({ ownerId: record.ownerId, workspaceId, workspaceGeneration: record.generation, operation: 'files_read', toolInput: { repositoryId: 'docs', path: 'a' } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('summarizes each checkout through workspace_repo_status', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    docker.workerResults.set('workspace_recover:/workspace/repos/api', { ok: true, message: 'ok', data: { status: '## main...origin/main\n M a.ts', hasUncommitted: true }, truncated: false });
    docker.workerResults.set('workspace_recover:/workspace/repos/web', { ok: true, message: 'ok', data: { status: '## develop', hasUncommitted: false }, truncated: false });
    const result = await service.execute(principal, 'workspace_repo_status', { workspaceId }) as RunnerResponse & { data: { repositories: Array<Record<string, unknown>> } };
    expect(result.data.repositories.map((entry) => [entry.alias, entry.branch, entry.hasUncommitted])).toEqual([
      ['api', 'main...origin/main', true],
      ['web', 'develop', false]
    ]);
  });

  it('derives a stable synthetic id and a safe alias for a single-repository workspace', () => {
    const record = { id: 'ws_abcdefghijklmnopqrstuvwx', repositoryUrl: 'https://github.com/Acme/My_Repo.git', repositoryRef: null };
    const entry = legacyRepositoryEntry(record);
    expect(entry).toMatchObject({ alias: 'my-repo', primary: true, access: 'read-write' });
    expect(legacyRepositoryEntry(record).id).toBe(entry.id);
    expect(legacyRepositoryEntry({ ...record, repositoryUrl: 'https://github.com/acme/___.git' }).alias).toBe('primary');
  });
});
