import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig } from '@cloud-harness/contracts';
import { StateStore } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false } as Record<string, unknown>,
  workerResults: new Map<string, Record<string, unknown>>(),
  failCloneAlias: undefined as string | undefined,
  runDocker: vi.fn(async (args: string[], options?: { stdin?: string }) => {
    if (args.includes('/opt/harness/clone-helper.sh')) {
      // The host side of `<host>:/job` may itself contain a drive colon.
      const volume = args[args.indexOf('--volume') + 1]!;
      const jobMount = volume.slice(0, volume.lastIndexOf(':/job'));
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
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
const principal = { kind: 'owner' as const, ownerId: 'multi-owner' };

function fixture(overrides: Partial<RunnerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-repo-targeted-'));
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

const MANIFEST = 'c'.repeat(64);
const hooksListing = { ok: true, message: 'hooks', data: { manifestSha256: MANIFEST, hooks: [{ name: 'lint', events: ['pre_commit'], failurePolicy: 'block' }] }, truncated: false };

function workerRoot(call: unknown[] | undefined): string | undefined {
  return (call?.[0] as string[] | undefined)?.find((value) => value.startsWith('CH_WORKSPACE_ROOT='))?.slice('CH_WORKSPACE_ROOT='.length);
}

function workerOperations(operation: string) {
  return workerCalls().filter((call) => (JSON.parse((call[1] as { stdin?: string } | undefined)?.stdin ?? '{}') as { operation?: string }).operation === operation);
}

async function openSingle(service: WorkspaceService) {
  const result = await service.execute(principal, 'workspace_open', { idempotencyKey: 'single-open-1', repositoryUrl: 'https://github.com/acme/api.git' });
  expect(result.ok).toBe(true);
  return result.data as { workspaceId: string };
}

describe('repository-targeted guidance, skills, hooks, and memories', () => {
  it('reads guidance and skills from the primary repository without a selector, and from the selected one with it', async () => {
    const { service } = fixture();
    const { workspaceId, repositories: entries } = await openMulti(service);

    const primary = await service.execute(principal, 'workspace_context', { workspaceId });
    expect(workerRoot(workerOperations('workspace_context').at(-1))).toBe('/workspace/repos/api');
    expect(primary.data).toMatchObject({ repositoryId: entries[0]!.repositoryId, repositoryAlias: 'api' });

    const selected = await service.execute(principal, 'workspace_context', { workspaceId, repositoryId: 'web' });
    expect(workerRoot(workerOperations('workspace_context').at(-1))).toBe('/workspace/repos/web');
    expect(selected.data).toMatchObject({ repositoryId: entries[1]!.repositoryId, repositoryAlias: 'web' });

    for (const operation of ['skills_list', 'hooks_list'] as const) {
      await service.execute(principal, operation, { workspaceId });
      expect(workerRoot(workerOperations(operation).at(-1))).toBe('/workspace/repos/api');
      const result = await service.execute(principal, operation, { workspaceId, repositoryId: entries[1]!.repositoryId });
      expect(workerRoot(workerOperations(operation).at(-1))).toBe('/workspace/repos/web');
      expect(result.data).toMatchObject({ repositoryAlias: 'web' });
    }
    await service.execute(principal, 'skills_read', { workspaceId, repositoryId: 'web', name: 'deploy' });
    expect(workerRoot(workerOperations('skills_read').at(-1))).toBe('/workspace/repos/web');
    await expect(service.execute(principal, 'skills_list', { workspaceId, repositoryId: 'docs' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never runs a skill or hook, or activates hooks, from a repository the caller did not name', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    const before = workerCalls().length;

    await expect(service.execute(principal, 'hooks_run', { workspaceId, name: 'lint', expectedManifestSha256: MANIFEST }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('api, web') });
    await expect(service.execute(principal, 'skills_run', { workspaceId, name: 'deploy', script: 'run.sh', expectedSha256: MANIFEST }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.execute(principal, 'hooks_activate', { workspaceId, manifestSha256: MANIFEST, events: ['pre_commit'] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(workerCalls()).toHaveLength(before);

    await service.execute(principal, 'hooks_run', { workspaceId, repositoryId: 'web', name: 'lint', expectedManifestSha256: MANIFEST });
    expect(workerRoot(workerOperations('hooks_run').at(-1))).toBe('/workspace/repos/web');
  });

  it('binds lifecycle hook activations to the repository they were activated for', async () => {
    const { service, store } = fixture();
    const { workspaceId, repositories: entries } = await openMulti(service);
    const [api, web] = entries;
    // Both checkouts carry an identical manifest, so only the repository binding can tell them apart.
    docker.workerResults.set('hooks_list:/workspace/repos/api', hooksListing);
    docker.workerResults.set('hooks_list:/workspace/repos/web', hooksListing);

    const activated = await service.execute(principal, 'hooks_activate', { workspaceId, repositoryId: 'web', manifestSha256: MANIFEST, events: ['pre_commit'] });
    expect(activated.data).toMatchObject({ repositoryAlias: 'web', activations: [expect.objectContaining({ repositoryId: web!.repositoryId, event: 'pre_commit' })] });
    const ownerId = store.byId(workspaceId)!.ownerId;
    expect(store.getActiveHookActivations(ownerId, workspaceId)).toHaveLength(0);
    expect(store.getActiveHookActivations(ownerId, workspaceId, api!.repositoryId)).toHaveLength(0);
    expect(store.getActiveHookActivations(ownerId, workspaceId, web!.repositoryId)).toHaveLength(1);

    const listedApi = await service.execute(principal, 'hooks_list', { workspaceId, repositoryId: 'api' });
    const listedWeb = await service.execute(principal, 'hooks_list', { workspaceId, repositoryId: 'web' });
    expect((listedApi.data as { hooks: Array<{ active: boolean }> }).hooks[0]!.active).toBe(false);
    expect((listedWeb.data as { hooks: Array<{ active: boolean }> }).hooks[0]!.active).toBe(true);

    await service.execute(principal, 'git_commit', { workspaceId, repositoryId: 'api', message: 'chore: api' });
    expect(workerOperations('hooks_run')).toHaveLength(0);
    await service.execute(principal, 'git_commit', { workspaceId, repositoryId: 'web', message: 'chore: web' });
    expect(workerOperations('hooks_run').map(workerRoot)).toEqual(['/workspace/repos/web']);

    // Deactivating one repository leaves the others, and the workspace-wide form clears every binding.
    await service.execute(principal, 'hooks_activate', { workspaceId, repositoryId: 'api', manifestSha256: MANIFEST, events: ['pre_commit'] });
    await service.execute(principal, 'hooks_deactivate', { workspaceId, repositoryId: 'web' });
    expect(store.getActiveHookActivations(ownerId, workspaceId, web!.repositoryId)).toHaveLength(0);
    expect(store.getActiveHookActivations(ownerId, workspaceId, api!.repositoryId)).toHaveLength(1);
    await service.execute(principal, 'hooks_deactivate', { workspaceId });
    expect(store.getActiveHookActivations(ownerId, workspaceId, api!.repositoryId)).toHaveLength(0);
  });

  it('drops a repository binding when that repository is removed', async () => {
    const { service, store } = fixture();
    const { workspaceId, repositories: entries } = await openMulti(service);
    await service.execute(principal, 'hooks_activate', { workspaceId, repositoryId: 'web', manifestSha256: MANIFEST, events: ['pre_commit'] });
    const ownerId = store.byId(workspaceId)!.ownerId;
    store.reapWorkspaceMemories(ownerId, workspaceId);
    expect(store.getActiveHookActivations(ownerId, workspaceId, entries[1]!.repositoryId)).toHaveLength(0);
  });

  it('keys repository-scoped memories by the selected repository and defaults to the primary one', async () => {
    const { service } = fixture();
    const { workspaceId } = await openMulti(service);
    const key = (url: string) => createHash('sha256').update(url.toLowerCase()).digest('hex');

    const written = await service.execute(principal, 'memories_write', { workspaceId, repositoryId: 'web', scope: 'repository', name: 'conventions', content: 'web rules' });
    expect(written.data).toMatchObject({ repositoryKey: key('https://github.com/acme/web.git'), repositoryAlias: 'web' });
    const primaryWrite = await service.execute(principal, 'memories_write', { workspaceId, scope: 'repository', name: 'conventions', content: 'api rules' });
    expect(primaryWrite.data).toMatchObject({ repositoryKey: key('https://github.com/acme/api.git'), repositoryAlias: 'api' });

    const fromWeb = await service.execute(principal, 'memories_read', { workspaceId, repositoryId: 'web', scope: 'repository', name: 'conventions' });
    expect(fromWeb.data).toMatchObject({ content: 'web rules' });
    const fromPrimary = await service.execute(principal, 'memories_read', { workspaceId, scope: 'repository', name: 'conventions' });
    expect(fromPrimary.data).toMatchObject({ content: 'api rules' });

    const searched = await service.execute(principal, 'memories_search', { workspaceId, repositoryId: 'web', scope: 'repository', query: 'rules' });
    expect((searched.data as { memories: Array<{ content?: string; name: string }> }).memories).toHaveLength(1);
    const listed = await service.execute(principal, 'memories_list', { workspaceId, repositoryId: 'api', scope: 'repository' });
    expect((listed.data as { memories: unknown[] }).memories).toHaveLength(1);

    const generation = (written.data as { generation: number }).generation;
    await service.execute(principal, 'memories_delete', { workspaceId, repositoryId: 'web', scope: 'repository', name: 'conventions', expectedGeneration: generation });
    await expect(service.execute(principal, 'memories_read', { workspaceId, repositoryId: 'web', scope: 'repository', name: 'conventions' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const stillPrimary = await service.execute(principal, 'memories_read', { workspaceId, repositoryId: 'api', scope: 'repository', name: 'conventions' });
    expect(stillPrimary.data).toMatchObject({ content: 'api rules' });
  });

  it('keeps single-repository guidance, skills, hooks, and memories unchanged', async () => {
    const { service, store } = fixture();
    const { workspaceId } = await openSingle(service);

    for (const operation of ['workspace_context', 'skills_list', 'hooks_list'] as const) {
      const result = await service.execute(principal, operation, { workspaceId });
      expect(workerRoot(workerOperations(operation).at(-1))).toBeUndefined();
      expect(result.data).not.toHaveProperty('repositoryAlias');
    }
    // A single repository needs no selector to run or activate hooks, and the activation stays unbound.
    await service.execute(principal, 'hooks_run', { workspaceId, name: 'lint', expectedManifestSha256: MANIFEST });
    expect(workerRoot(workerOperations('hooks_run').at(-1))).toBeUndefined();
    await service.execute(principal, 'hooks_activate', { workspaceId, manifestSha256: MANIFEST, events: ['pre_commit'] });
    const ownerId = store.byId(workspaceId)!.ownerId;
    expect(store.getActiveHookActivations(ownerId, workspaceId)).toEqual([expect.not.objectContaining({ repositoryId: expect.anything() })]);

    const written = await service.execute(principal, 'memories_write', { workspaceId, scope: 'repository', name: 'notes', content: 'x' });
    expect(written.data).toMatchObject({ repositoryKey: createHash('sha256').update('https://github.com/acme/api.git').digest('hex') });
    expect(written.data).not.toHaveProperty('repositoryAlias');
    // The workspace's own alias still addresses its single repository.
    const byAlias = await service.execute(principal, 'memories_read', { workspaceId, repositoryId: 'api', scope: 'repository', name: 'notes' });
    expect(byAlias.data).toMatchObject({ content: 'x' });
  });
});

describe('agent guidance repository selection', () => {
  function guidanceFor(service: WorkspaceService) {
    const internals = service as unknown as {
      resolveRepositoryView(record: unknown, validated: Record<string, unknown>, mode: string, operation: string): { scoped: { repositoryScope?: { alias: string } } };
    };
    return internals.resolveRepositoryView.bind(service);
  }

  it('normalizes a spawn selector to the stable id, refuses an unknown one, and drops it for one repository', async () => {
    const { service, store } = fixture();
    const { workspaceId, repositories: entries } = await openMulti(service);
    const record = store.byId(workspaceId)!;
    const validated: Record<string, unknown> = { repositoryId: 'web' };
    const resolve = guidanceFor(service);
    expect(resolve(record, validated, 'optional', 'agent_spawn').scoped.repositoryScope?.alias).toBe('web');
    expect(validated.repositoryId).toBe(entries[1]!.repositoryId);
    expect(() => resolve(record, { repositoryId: 'docs' }, 'optional', 'agent_spawn')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));

    const single = await openSingle(service);
    const singleInput: Record<string, unknown> = { repositoryId: 'api' };
    resolve(store.byId(single.workspaceId)!, singleInput, 'optional', 'agent_spawn');
    expect(singleInput).not.toHaveProperty('repositoryId');
  });
});
