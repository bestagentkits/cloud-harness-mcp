import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, ReposFinalizeDataSchema, type ReposFinalizeData, type RunnerConfig, type RunnerResponse } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/opt/harness/clone-helper.sh')) {
      const volume = args[args.indexOf('--volume') + 1]!;
      const jobMount = volume.slice(0, volume.lastIndexOf(':/job'));
      const destination = args[args.indexOf('/opt/harness/clone-helper.sh') + 3]!;
      mkdirSync(join(jobMount, destination.replace(/^\/job\//, '')), { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('branch') && args.includes('--show-current')) return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
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

import { WorkspaceService } from '../src/workspace-service.js';
import { reposFinalizeStepKey } from '../src/repos-finalize.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const principal = { kind: 'owner' as const, ownerId: 'repos-finalize-owner' };

type Internals = {
  runWorker: (record: WorkspaceRecord, operation: string, input: Record<string, unknown>) => Promise<RunnerResponse>;
  remotePush: (record: WorkspaceRecord, input: Record<string, unknown>) => Promise<RunnerResponse>;
  runBrokeredGitHubAction: (record: WorkspaceRecord, action: string, args: string[]) => Promise<{ result: RunnerResponse; credentialSource: 'app' }>;
};

/**
 * A fake Git remote per checkout: uncommitted changes until a commit, a commit counter, pushes, and open
 * pull requests. Every effect is appended to `events` so ordering and duplicates are observable.
 */
function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'ch-repos-finalize-'));
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
    executorImage: 'cloud-harness-executor:test'
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const service = new WorkspaceService(config, store);
  const internals = service as unknown as Internals;

  const events: string[] = [];
  const dirty = new Set<string>(['api', 'web', 'docs', 'solo']);
  const commits = new Map<string, number>();
  const failPush = new Set<string>();
  const failPullRequest = new Set<string>();
  const throwAfterCommit = new Set<string>();
  const onPullRequest: Array<(alias: string) => void> = [];
  const openPullRequests: Array<{ alias: string; number: number; headRefName: string; headRefOid: string; baseRefName: string; url: string }> = [];
  const aliasOf = (record: WorkspaceRecord) => record.repositoryScope?.alias ?? 'solo';
  const sha = (alias: string) => `${alias.padEnd(4, 'x')}${String(commits.get(alias) ?? 0).padStart(36, '0')}`;

  vi.spyOn(internals, 'runWorker').mockImplementation(async (record, operation) => {
    const alias = aliasOf(record);
    if (operation === 'git_status') {
      return { ok: true, message: 'status', data: { output: dirty.has(alias) ? '## main\n M src/index.ts\n' : '## main\n' }, truncated: false };
    }
    if (operation === 'git_commit') {
      commits.set(alias, (commits.get(alias) ?? 0) + 1);
      dirty.delete(alias);
      events.push(`commit:${alias}`);
      return { ok: true, message: 'committed', data: {}, truncated: false };
    }
    if (operation === 'git_log' && throwAfterCommit.has(alias) && commits.has(alias)) {
      throwAfterCommit.delete(alias);
      throw new Error(`unexpected worker fault for ${alias}`);
    }
    if (operation === 'git_log') return { ok: true, message: 'log', data: { output: `${sha(alias)}\tcommit` }, truncated: false };
    return { ok: true, message: operation, data: { output: '' }, truncated: false };
  });
  vi.spyOn(internals, 'remotePush').mockImplementation(async (record, input) => {
    const alias = aliasOf(record);
    if (failPush.has(alias)) {
      events.push(`push-failed:${alias}`);
      throw new HarnessError('CONFLICT', `remote rejected the push for ${alias}`, 409, false);
    }
    events.push(`push:${alias}:${String(input.refspec)}`);
    return { ok: true, message: 'Git push complete', data: { refspec: input.refspec }, truncated: false };
  });
  vi.spyOn(internals, 'runBrokeredGitHubAction').mockImplementation(async (record, action, args) => {
    const alias = aliasOf(record);
    if (action === 'pr_list') {
      events.push(`pr-list:${alias}`);
      const listed = openPullRequests.filter((pr) => pr.alias === alias)
        .map(({ number, headRefName, headRefOid, baseRefName, url }) => ({ number, headRefName, headRefOid, baseRefName, url, isCrossRepository: false }));
      return { result: { ok: true, message: 'listed', data: { output: JSON.stringify(listed) }, truncated: false }, credentialSource: 'app' };
    }
    if (action !== 'pr_create') throw new Error(`unexpected GitHub action ${action}`);
    const [title, , head, base] = args;
    const number = openPullRequests.length + 10;
    const url = `https://github.com/acme/${alias}/pull/${number}`;
    // A lost response: the pull request exists on GitHub, but the caller only sees a transport failure.
    openPullRequests.push({ alias, number, headRefName: head!, headRefOid: sha(alias), baseRefName: base!, url });
    events.push(`pr:${alias}:${head}->${base}:${title}`);
    for (const listener of onPullRequest) listener(alias);
    if (failPullRequest.has(alias)) throw new HarnessError('UNAVAILABLE', 'GitHub did not answer', 503, true);
    return { result: { ok: true, message: 'GitHub pr_create successful', data: { output: `${url}\n` }, truncated: false }, credentialSource: 'app' };
  });

  /** Effects only: the read-only pull request lookups that precede each pr_create are left out. */
  const effects = () => events.filter((event) => !event.startsWith('pr-list:'));
  return { service, store, events, effects, dirty, commits, failPush, throwAfterCommit, failPullRequest, onPullRequest, openPullRequests, sha };
}

async function openWorkspace(service: WorkspaceService, repositories: Array<Record<string, unknown>>): Promise<string> {
  const opened = await service.execute(principal, 'workspace_open', { idempotencyKey: `open-${repositories.length}-key`, repositories });
  expect(opened.ok).toBe(true);
  return (opened.data as { workspaceId: string }).workspaceId;
}

const threeRepositories = [
  { url: 'https://github.com/acme/api.git', alias: 'api' },
  { url: 'https://github.com/acme/web.git', alias: 'web' },
  { url: 'https://github.com/acme/docs.git', alias: 'docs' }
];

function plan(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    idempotencyKey: 'cross-repo-release-1',
    repositories: [
      { repositoryId: 'api', commitMessage: 'feat(api): add endpoint', branch: 'feature/x', pullRequest: { title: 'API change', base: 'develop' } },
      { repositoryId: 'web', commitMessage: 'feat(web): call endpoint', branch: 'feature/x', pullRequest: { title: 'Web change' } },
      { repositoryId: 'docs', commitMessage: 'docs: describe endpoint', branch: 'feature/x' }
    ],
    ...overrides
  };
}

function dataOf(result: RunnerResponse): ReposFinalizeData {
  return ReposFinalizeDataSchema.parse(result.data);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('workspace_repos_finalize', () => {
  it('finalizes every repository in the declared order and opens each pull request after its push', async () => {
    const { service, effects } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);

    const result = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(result.ok).toBe(true);
    const data = dataOf(result);
    expect(data).toMatchObject({ status: 'succeeded', atomic: false, replayed: false });
    expect(effects()).toEqual([
      'commit:api', 'push:api:HEAD:refs/heads/feature/x', 'pr:api:feature/x->develop:API change',
      'commit:web', 'push:web:HEAD:refs/heads/feature/x', 'pr:web:feature/x->main:Web change',
      'commit:docs', 'push:docs:HEAD:refs/heads/feature/x'
    ]);
    expect(data.repositories.map((repository) => [repository.alias, repository.status, repository.finalize.pushed, repository.pullRequest?.number])).toEqual([
      ['api', 'SUCCEEDED', true, 10],
      ['web', 'SUCCEEDED', true, 11],
      ['docs', 'SUCCEEDED', true, undefined]
    ]);
    expect(data.repositories[0]!.finalize.commitSha).toMatch(/^apix0+1$/);
    expect(data.repositories[0]!.pullRequest).toMatchObject({ status: 'SUCCEEDED', url: 'https://github.com/acme/api/pull/10', head: 'feature/x', base: 'develop' });
    expect(data.repositories[2]).not.toHaveProperty('pullRequest');
  });

  it('reports a failure on the second repository as partial, skips the rest, and never rolls back the first push', async () => {
    const { service, effects, failPush } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPush.add('web');

    const result = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'CONFLICT', repository: 'web' });
    expect(result.message).toContain('Not atomic');
    const data = dataOf(result);
    expect(data).toMatchObject({ status: 'partial', atomic: false });
    const [api, web, docs] = data.repositories;
    expect(api).toMatchObject({ status: 'SUCCEEDED', finalize: { status: 'SUCCEEDED', pushed: true }, pullRequest: { status: 'SUCCEEDED', number: 10 } });
    expect(web).toMatchObject({
      status: 'FAILED',
      finalize: { status: 'FAILED', pushed: false, error: { code: 'CONFLICT', retryable: false } },
      pullRequest: { status: 'SKIPPED', base: 'main' }
    });
    expect(web!.finalize.commitSha).toMatch(/^webx/);
    expect(docs).toMatchObject({ status: 'SKIPPED', finalize: { status: 'SKIPPED' } });
    // The pull request of the failed repository was never attempted, and the third repository was untouched.
    expect(effects()).toEqual([
      'commit:api', 'push:api:HEAD:refs/heads/feature/x', 'pr:api:feature/x->develop:API change',
      'commit:web', 'push-failed:web'
    ]);
  });

  it('retries only the failed and skipped steps on replay without committing or pushing the first repository again', async () => {
    const { service, events, effects, failPush, commits } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPush.add('web');
    await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    failPush.delete('web');
    events.length = 0;

    const replay = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(replay.ok).toBe(true);
    const data = dataOf(replay);
    expect(data).toMatchObject({ status: 'succeeded', replayed: true });
    // web's commit already exists, so its finalize only pushes; api is not touched at all.
    expect(effects()).toEqual([
      'push:web:HEAD:refs/heads/feature/x', 'pr:web:feature/x->main:Web change',
      'commit:docs', 'push:docs:HEAD:refs/heads/feature/x'
    ]);
    expect(commits.get('api')).toBe(1);
    expect(commits.get('web')).toBe(1);
    expect(data.repositories[0]).toMatchObject({ alias: 'api', status: 'SUCCEEDED', pullRequest: { number: 10 } });

    events.length = 0;
    const settled = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    expect(settled.ok).toBe(true);
    expect(dataOf(settled)).toMatchObject({ status: 'succeeded', replayed: true });
    expect(events).toEqual([]);
  });

  it('continues past a failure with continueOnFailure and still skips the failed repository pull request', async () => {
    const { service, events, failPush } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPush.add('web');

    const result = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId, { continueOnFailure: true }));

    expect(result.ok).toBe(false);
    const data = dataOf(result);
    expect(data.status).toBe('partial');
    expect(data.repositories.map((repository) => repository.status)).toEqual(['SUCCEEDED', 'FAILED', 'SUCCEEDED']);
    expect(events.some((event) => event.startsWith('pr:web'))).toBe(false);
    expect(events.at(-1)).toBe('push:docs:HEAD:refs/heads/feature/x');
  });

  it('reports failed when no repository was finalized', async () => {
    const { service, failPush } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPush.add('api');

    const result = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(result.ok).toBe(false);
    expect(dataOf(result).status).toBe('failed');
    expect(dataOf(result).repositories.map((repository) => repository.status)).toEqual(['FAILED', 'SKIPPED', 'SKIPPED']);
  });

  it('refuses the same key with different input as a CONFLICT without running anything', async () => {
    const { service, events, failPush } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPush.add('web');
    await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    events.length = 0;

    const changed = plan(workspaceId);
    changed.repositories[1] = { ...changed.repositories[1]!, commitMessage: 'feat(web): something else' };
    await expect(service.execute(principal, 'workspace_repos_finalize', changed)).rejects.toMatchObject({ code: 'CONFLICT', retryable: false });
    await expect(service.execute(principal, 'workspace_repos_finalize', plan(workspaceId, { continueOnFailure: true })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(events).toEqual([]);
  });

  it('treats an alias and the repo_ id of the same repository as the same input', async () => {
    const { service } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    const listed = await service.execute(principal, 'workspace_repos_list', { workspaceId });
    const ids = (listed.data as { repositories: Array<{ repositoryId: string; alias: string }> }).repositories;
    await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    const byId = plan(workspaceId);
    byId.repositories = byId.repositories.map((step) => ({ ...step, repositoryId: ids.find((entry) => entry.alias === step.repositoryId)!.repositoryId }));
    const replay = await service.execute(principal, 'workspace_repos_finalize', byId);
    expect(dataOf(replay)).toMatchObject({ status: 'succeeded', replayed: true });
  });

  it('adopts a pull request whose creation outcome was lost instead of opening a second one', async () => {
    const { service, events, failPullRequest, openPullRequests } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPullRequest.add('api');

    const first = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    expect(dataOf(first).repositories[0]).toMatchObject({ status: 'FAILED', pullRequest: { status: 'FAILED', error: { code: 'UNAVAILABLE' } } });
    expect(dataOf(first).status).toBe('partial');
    failPullRequest.delete('api');
    events.length = 0;

    const replay = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(dataOf(replay).repositories[0]).toMatchObject({
      status: 'SUCCEEDED', pullRequest: { status: 'SUCCEEDED', number: 10, reconciled: true, url: 'https://github.com/acme/api/pull/10' }
    });
    expect(events.filter((event) => event.startsWith('pr:api'))).toEqual([]);
    expect(events[0]).toBe('pr-list:api');
    expect(openPullRequests.filter((pr) => pr.alias === 'api')).toHaveLength(1);
  });

  it('derives distinct, schema-valid per-step idempotency keys', () => {
    const finalize = reposFinalizeStepKey('cross-repo-release-1', `repo_${'a'.repeat(32)}`, 'finalize');
    expect(finalize).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(finalize).toBe(reposFinalizeStepKey('cross-repo-release-1', `repo_${'a'.repeat(32)}`, 'finalize'));
    expect(finalize).not.toBe(reposFinalizeStepKey('cross-repo-release-1', `repo_${'b'.repeat(32)}`, 'finalize'));
    expect(finalize).not.toBe(reposFinalizeStepKey('cross-repo-release-1', `repo_${'a'.repeat(32)}`, 'pr'));
  });

  it('refuses unknown or repeated repositories and pushes to read-only ones before running anything', async () => {
    const { service, events, store } = harness();
    const workspaceId = await openWorkspace(service, [
      { url: 'https://github.com/acme/api.git', alias: 'api' },
      { url: 'https://github.com/acme/web.git', alias: 'web', access: 'read-only' }
    ]);
    const listed = await service.execute(principal, 'workspace_repos_list', { workspaceId });
    const apiId = (listed.data as { repositories: Array<{ repositoryId: string; alias: string }> }).repositories[0]!.repositoryId;
    const step = (repositoryId: string, extra: Record<string, unknown> = {}) => ({ repositoryId, commitMessage: 'chore: x', ...extra });

    await expect(service.execute(principal, 'workspace_repos_finalize', { workspaceId, idempotencyKey: 'unknown-repo-1', repositories: [step('mobile')] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('choose one of: api, web') });
    await expect(service.execute(principal, 'workspace_repos_finalize', { workspaceId, idempotencyKey: 'repeat-repo-1', repositories: [step('api'), step(apiId)] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.execute(principal, 'workspace_repos_finalize', { workspaceId, idempotencyKey: 'read-only-1', repositories: [step('api'), step('web')] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', repository: 'web' });
    expect(events).toEqual([]);
    expect(store.reposFinalizeSteps(store.resolvePrincipal(principal), workspaceId, 'read-only-1')).toEqual([]);

    // A read-only repository can still be committed locally when the step does not push.
    const local = await service.execute(principal, 'workspace_repos_finalize', { workspaceId, idempotencyKey: 'read-only-2', repositories: [step('web', { push: false })] });
    expect(dataOf(local).repositories[0]).toMatchObject({ status: 'SUCCEEDED', finalize: { pushed: false } });
    expect(events).toEqual(['commit:web']);
  });

  it('accepts one step naming the only checkout of a single-repository workspace', async () => {
    const { service, events } = harness();
    const opened = await service.execute(principal, 'workspace_open', { idempotencyKey: 'open-solo-key', repositoryUrl: 'https://github.com/acme/solo.git' });
    const workspaceId = (opened.data as { workspaceId: string }).workspaceId;
    const listed = await service.execute(principal, 'workspace_repos_list', { workspaceId });
    const only = (listed.data as { repositories: Array<{ repositoryId: string; alias: string }> }).repositories[0]!;

    const result = await service.execute(principal, 'workspace_repos_finalize', {
      workspaceId, idempotencyKey: 'solo-finalize-1', repositories: [{ repositoryId: only.alias, commitMessage: 'fix: solo', branch: 'fix/solo' }]
    });

    expect(result.ok).toBe(true);
    expect(dataOf(result).repositories).toEqual([expect.objectContaining({ repositoryId: only.repositoryId, status: 'SUCCEEDED' })]);
    expect(events).toEqual(['commit:solo', 'push:solo:HEAD:refs/heads/fix/solo']);
  });

  it('removes recorded steps with the workspace row', async () => {
    const { service, store } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    const ownerId = store.resolvePrincipal(principal);
    expect(store.reposFinalizeSteps(ownerId, workspaceId, 'cross-repo-release-1')).toHaveLength(3);

    store.database.prepare('DELETE FROM workspace_repositories WHERE workspace_id = ?').run(workspaceId);
    store.database.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);

    expect(store.reposFinalizeSteps(ownerId, workspaceId, 'cross-repo-release-1')).toEqual([]);
  });

  it('replays a pr_create with the same idempotency key from its recorded result', async () => {
    const { service, events } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    const request = { workspaceId, repositoryId: 'api', action: 'pr_create', title: 'API', head: 'feature/x', idempotencyKey: 'pr-create-key-1' };

    const first = await service.execute(principal, 'github_action', request);
    const replay = await service.execute(principal, 'github_action', request);

    expect(replay).toEqual(first);
    expect(events.filter((event) => event.startsWith('pr:'))).toHaveLength(1);
    await expect(service.execute(principal, 'github_action', { ...request, title: 'Other' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('adopts an open pull request for the same pushed commit under a new key instead of failing on a duplicate', async () => {
    const { service, events, effects, openPullRequests } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    const single = (key: string) => ({
      workspaceId, idempotencyKey: key,
      repositories: [{ repositoryId: 'api', commitMessage: 'feat(api): add endpoint', branch: 'feature/x', pullRequest: { title: 'API change' } }]
    });
    await service.execute(principal, 'workspace_repos_finalize', single('first-key-1'));
    events.length = 0;

    const fresh = await service.execute(principal, 'workspace_repos_finalize', single('second-key-1'));

    expect(dataOf(fresh).repositories[0]).toMatchObject({ status: 'SUCCEEDED', pullRequest: { status: 'SUCCEEDED', number: 10, reconciled: true } });
    expect(effects().filter((event) => event.startsWith('pr:'))).toEqual([]);
    expect(openPullRequests).toHaveLength(1);
  });

  it('never adopts an open pull request whose head is a different commit', async () => {
    const { service, effects, openPullRequests } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    openPullRequests.push({ alias: 'api', number: 7, headRefName: 'feature/x', headRefOid: 'f'.repeat(40), baseRefName: 'develop', url: 'https://github.com/acme/api/pull/7' });

    const result = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(effects()).toContain('pr:api:feature/x->develop:API change');
    expect(dataOf(result).repositories[0]!.pullRequest).not.toHaveProperty('reconciled');
  });

  it('starts no further step once the request is aborted and records the rest as skipped', async () => {
    const { service, effects, onPullRequest } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    const controller = new AbortController();
    onPullRequest.push((alias) => { if (alias === 'api') controller.abort(); });

    const result = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId), controller.signal);

    const data = dataOf(result);
    expect(data.status).toBe('partial');
    expect(data.repositories.map((repository) => repository.status)).toEqual(['SUCCEEDED', 'SKIPPED', 'SKIPPED']);
    expect(data.repositories[1]!.finalize.reason).toContain('replay the idempotencyKey');
    expect(effects()).toEqual(['commit:api', 'push:api:HEAD:refs/heads/feature/x', 'pr:api:feature/x->develop:API change']);

    const replay = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    expect(dataOf(replay)).toMatchObject({ status: 'succeeded', replayed: true });
  });

  it('reports the recorded status when a replay names a repository removed since the first run', async () => {
    const { service, store, effects, failPush } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    failPush.add('web');
    await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    const before = effects().length;
    store.database.prepare('DELETE FROM workspace_repositories WHERE workspace_id = ? AND alias = ?').run(workspaceId, 'docs');

    const replay = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(dataOf(replay)).toMatchObject({ status: 'partial', replayed: true });
    expect(dataOf(replay).repositories.map((repository) => repository.status)).toEqual(['SUCCEEDED', 'FAILED', 'SKIPPED']);
    expect(effects()).toHaveLength(before);
    // A key with no recorded run still refuses the unknown repository.
    await expect(service.execute(principal, 'workspace_repos_finalize', plan(workspaceId, { idempotencyKey: 'never-ran-key-1' })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps coordinated finalize and repository changes of one workspace mutually exclusive', async () => {
    const { service, effects } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    const locks = service as unknown as { reposFinalizes: Set<string>; repositoryChanges: Set<string> };

    locks.repositoryChanges.add(workspaceId);
    await expect(service.execute(principal, 'workspace_repos_finalize', plan(workspaceId))).rejects.toMatchObject({ code: 'CONFLICT', retryable: true });
    locks.repositoryChanges.delete(workspaceId);

    locks.reposFinalizes.add(workspaceId);
    await expect(service.execute(principal, 'workspace_repo_remove', { workspaceId, repositoryId: 'docs', idempotencyKey: 'remove-docs-1' }))
      .rejects.toMatchObject({ code: 'CONFLICT', retryable: true });
    locks.reposFinalizes.delete(workspaceId);
    expect(effects()).toEqual([]);
  });

  it('settles a step whose finalize threw an unexpected error so a replay retries it instead of reporting it in flight', async () => {
    const { service, effects, throwAfterCommit, commits } = harness();
    const workspaceId = await openWorkspace(service, threeRepositories);
    throwAfterCommit.add('web');

    const first = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));
    expect(dataOf(first).repositories[1]).toMatchObject({ status: 'FAILED', finalize: { status: 'FAILED' } });

    const replay = await service.execute(principal, 'workspace_repos_finalize', plan(workspaceId));

    expect(dataOf(replay)).toMatchObject({ status: 'succeeded', replayed: true });
    expect(commits.get('web')).toBe(1);
    expect(effects()).toContain('push:web:HEAD:refs/heads/feature/x');
  });
});
