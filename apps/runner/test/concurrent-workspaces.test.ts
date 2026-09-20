import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig } from '@cloud-harness/contracts';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false },
  /** Container names whose `inspectContainer` reports `Running: true`. */
  runningContainers: new Set<string>(),
  /** One-shot hook awaited inside `inspectContainer`, used to interleave a race. */
  inspectHook: undefined as (() => Promise<unknown>) | undefined,
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) {
      return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('branch') && args.includes('--show-current')) {
      return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return { stdout: JSON.stringify(docker.workerResult), stderr: '', exitCode: 0, truncated: false };
    }
    if (args[0] === 'create') {
      return { stdout: 'container-created\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args[0] === 'start') {
      return { stdout: 'container-started\n', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async (name: string) => {
    const hook = docker.inspectHook;
    docker.inspectHook = undefined;
    if (hook) await hook();
    return docker.runningContainers.has(name) ? { State: { Running: true } } : undefined;
  }),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));
vi.mock('../src/github-app-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppBroker>()),
  mintRepositoryToken: vi.fn(async () => 'mock-token'),
  mintPrincipalRepositoryScopedToken: vi.fn(async () => ({ token: 'mock-token', permissions: { issues: 'write', pull_requests: 'write' } })),
  mintPrincipalRepositoryToken: vi.fn(async () => 'mock-token')
}));

import type * as GitHubAppBroker from '../src/github-app-broker.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: {}, truncated: false };
  docker.runningContainers.clear();
  docker.inspectHook = undefined;
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* store already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* directory already removed */ }
  }
});

function createService(limit: number): { service: WorkspaceService; store: StateStore; ownerId: string; jobsRoot: string; config: RunnerConfig } {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-concurrent-'));
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
    minFreeBytes: 1048576,
    maxActiveWorkspacesPerOwner: limit,
    networkProfile: 'network-none',
    allowedGitHosts: ['github.com'],
    executorImage: 'cloud-harness-executor:test'
  } as RunnerConfig;

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'concurrent-owner' });
  return { service: new WorkspaceService(config, store), store, ownerId, jobsRoot, config };
}

/**
 * Creates a workspace record directly so a test can hold a specific status and an
 * on-disk `repo` directory without paying for a clone.
 */
function seedWorkspace(
  store: StateStore,
  ownerId: string,
  jobsRoot: string,
  id: string,
  status: WorkspaceRecord['status'],
  overrides: Partial<WorkspaceRecord> = {}
): WorkspaceRecord {
  mkdirSync(join(jobsRoot, id, 'repo'), { recursive: true });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id,
    ownerId,
    idempotencyKey: `idemp-${id}`,
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: null,
    workspacePath: join(jobsRoot, id),
    status,
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 3_600_000,
    hardExpiresAt: now + 14_400_000,
    gitAuthorName: null,
    gitAuthorEmail: null,
    generation: 1,
    error: null,
    ...overrides
  };
  store.create(record);
  return record;
}

function containerNameFor(workspaceId: string): string {
  return `cloud-harness-ws-${workspaceId.slice(3, 19).toLowerCase()}`;
}

async function openWorkspace(
  service: WorkspaceService,
  ownerId: string,
  idempotencyKey: string,
  repositoryUrl = 'https://github.com/example/repo.git'
): Promise<string> {
  const result = await service.execute(ownerId, 'workspace_open', { repositoryUrl, idempotencyKey });
  return (result.data as { workspaceId: string }).workspaceId;
}

describe('Concurrent workspaces per owner (Issue #216)', () => {
  it('opens two workspaces for one owner and lists both', async () => {
    const { service, store, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'open-key-1');
    const second = await openWorkspace(service, ownerId, 'open-key-2');

    expect(first).not.toBe(second);
    const listed = await service.execute(ownerId, 'workspace_list', {});
    const workspaces = (listed.data as { workspaces: Array<{ workspaceId: string; status: string }> }).workspaces;
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((entry) => entry.workspaceId).sort()).toEqual([first, second].sort());
    expect(workspaces.every((entry) => entry.status === 'ACTIVE')).toBe(true);
    expect(store.byId(first)?.status).toBe('ACTIVE');
  });

  it('scopes a supplied workspaceId to its own record', async () => {
    const { service, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'scope-key-1', 'https://github.com/example/one.git');
    const second = await openWorkspace(service, ownerId, 'scope-key-2', 'https://github.com/example/two.git');

    const firstStatus = await service.execute(ownerId, 'workspace_status', { workspaceId: first });
    const secondStatus = await service.execute(ownerId, 'workspace_status', { workspaceId: second });

    expect((firstStatus.data as { workspaceId: string }).workspaceId).toBe(first);
    expect((firstStatus.data as { repositoryUrl: string }).repositoryUrl).toContain('one.git');
    expect((secondStatus.data as { workspaceId: string }).workspaceId).toBe(second);
    expect((secondStatus.data as { repositoryUrl: string }).repositoryUrl).toContain('two.git');
  });

  it('runs commands in the container owned by the addressed workspace', async () => {
    const { service, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'exec-key-1');
    const second = await openWorkspace(service, ownerId, 'exec-key-2');
    const firstContainer = containerNameFor(first);
    const secondContainer = containerNameFor(second);

    docker.runDocker.mockClear();
    const executed = await service.execute(ownerId, 'exec_run', { workspaceId: second, command: 'echo scoped', cwd: '.' });
    expect(executed.ok).toBe(true);

    const callContainers = docker.runDocker.mock.calls
      .map((call) => call[0])
      .filter((args) => args[0] === 'exec' && args.includes('/opt/harness/worker-runner.sh'))
      .map((args) => args[2]);
    expect(callContainers.length).toBeGreaterThan(0);
    expect(callContainers).toContain(secondContainer);
    expect(callContainers).not.toContain(firstContainer);
  });

  it('creates one labelled container per workspace', async () => {
    const { service, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'label-key-1');
    const second = await openWorkspace(service, ownerId, 'label-key-2');

    const createCalls = docker.runDocker.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'create');
    expect(createCalls.some((args) => args.includes(`cloud-harness.workspace=${first}`) && args.includes(containerNameFor(first)))).toBe(true);
    expect(createCalls.some((args) => args.includes(`cloud-harness.workspace=${second}`) && args.includes(containerNameFor(second)))).toBe(true);
  });

  it('refuses an omitted workspaceId with two active workspaces and no preference', async () => {
    const { service, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'ambiguous-1');
    const second = await openWorkspace(service, ownerId, 'ambiguous-2');

    await expect(service.execute(ownerId, 'workspace_status', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(first)
    });
    await expect(service.execute(ownerId, 'workspace_status', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(second)
    });
  });

  it('refuses an omitted workspaceId while several workspaces are active', async () => {
    const { service, store, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'pref-key-1');
    const second = await openWorkspace(service, ownerId, 'pref-key-2');

    // `workspace_close`, `workspace_finalize`, `files_write`, and `git_commit` all
    // accept an optional workspaceId, so an implicit target must never be guessed
    // while more than one workspace is active.
    await expect(service.execute(ownerId, 'workspace_status', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(first)
    });
    await expect(service.execute(ownerId, 'workspace_set_active', { workspaceId: first })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('more than one active workspace')
    });
    expect(store.getPreferredWorkspace(ownerId)).toBeUndefined();

    // An explicit id always resolves.
    const resolved = await service.execute(ownerId, 'workspace_status', { workspaceId: second });
    expect((resolved.data as { workspaceId: string }).workspaceId).toBe(second);
  });

  it('does not charge a capacity slot for a record in flight to teardown', async () => {
    const { service, store, ownerId, jobsRoot } = createService(1);
    seedWorkspace(store, ownerId, jobsRoot, `ws_${'d'.repeat(24)}`, 'REAPING');

    // A record being destroyed must not consume a slot or inflate the quota error.
    expect(store.countOwnerCountedWorkspaces(ownerId)).toBe(0);
    await expect(openWorkspace(service, ownerId, 'reaping-key-1')).resolves.toBeTruthy();
  });

  it('refuses to pin a recoverable workspace while another workspace is active', async () => {
    const { service, store, ownerId, jobsRoot } = createService(3);
    const active = await openWorkspace(service, ownerId, 'set-active-key-1');
    const quarantined = seedWorkspace(store, ownerId, jobsRoot, `ws_${'e'.repeat(24)}`, 'NETWORK_QUARANTINED');

    await expect(service.execute(ownerId, 'workspace_set_active', { workspaceId: quarantined.id })).rejects.toMatchObject({
      code: 'CONFLICT'
    });
    expect(store.getPreferredWorkspace(ownerId)).toBeUndefined();

    // A single active workspace stays addressable implicitly even beside a recoverable one.
    const resolved = await service.execute(ownerId, 'workspace_status', {});
    expect((resolved.data as { workspaceId: string }).workspaceId).toBe(active);
  });

  it('refuses to set a closed workspace as the active preference', async () => {
    const { service, store, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'closed-pref-1');
    await service.execute(ownerId, 'workspace_set_active', { workspaceId: first });
    await service.execute(ownerId, 'workspace_close', { workspaceId: first });

    await expect(service.execute(ownerId, 'workspace_set_active', { workspaceId: first })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('closed')
    });
    expect(store.getPreferredWorkspace(ownerId)).toBe(first);
  });

  it('keeps resolving a sole active workspace without a preference', async () => {
    const { service, ownerId } = createService(3);
    const only = await openWorkspace(service, ownerId, 'sole-key-1');

    const resolved = await service.execute(ownerId, 'workspace_status', {});
    expect((resolved.data as { workspaceId: string }).workspaceId).toBe(only);
  });

  it('closing one workspace leaves its sibling active and addressable', async () => {
    const { service, store, ownerId } = createService(3);
    const first = await openWorkspace(service, ownerId, 'close-key-1');
    const second = await openWorkspace(service, ownerId, 'close-key-2');
    const secondRecord = store.byId(second);

    await service.execute(ownerId, 'workspace_close', { workspaceId: first });

    expect(store.byId(first)?.status).toBe('CLOSED');
    const sibling = await service.execute(ownerId, 'workspace_status', { workspaceId: second });
    const siblingData = sibling.data as Record<string, unknown>;
    expect(siblingData.workspaceId).toBe(second);
    expect(siblingData.status).toBe('ACTIVE');
    expect(siblingData.repositoryUrl).toBe(secondRecord?.repositoryUrl);
    // `containerName` is internal and absent from the public payload, so assert the
    // stored sibling record is untouched instead.
    const siblingRecord = store.byId(second);
    expect(siblingRecord?.status).toBe('ACTIVE');
    expect(siblingRecord?.containerName).toBe(secondRecord?.containerName);
    expect(siblingRecord?.containerName).not.toBeNull();
    expect(siblingRecord?.generation).toBe(secondRecord?.generation);

    const listed = await service.execute(ownerId, 'workspace_list', {});
    const workspaces = (listed.data as { workspaces: Array<{ workspaceId: string; status: string }> }).workspaces;
    expect(workspaces).toHaveLength(2);
    expect(workspaces.find((entry) => entry.workspaceId === first)?.status).toBe('CLOSED');
    expect(workspaces.find((entry) => entry.workspaceId === second)?.status).toBe('ACTIVE');
  });

  it('rejects the workspace above the configured limit with a quota error', async () => {
    const { service, store, ownerId } = createService(2);
    await openWorkspace(service, ownerId, 'quota-key-1');
    await openWorkspace(service, ownerId, 'quota-key-2');

    await expect(openWorkspace(service, ownerId, 'quota-key-3')).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      retryable: true,
      message: expect.stringMatching(/active workspace limit reached: 2 active of a maximum 2/)
    });
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(2);
    expect(store.byIdempotency(ownerId, 'quota-key-3')).toBeUndefined();
  });

  it('never exceeds the limit when admissions race', async () => {
    const { service, store, ownerId } = createService(2);

    const settled = await Promise.allSettled([
      openWorkspace(service, ownerId, 'race-key-1'),
      openWorkspace(service, ownerId, 'race-key-2'),
      openWorkspace(service, ownerId, 'race-key-3'),
      openWorkspace(service, ownerId, 'race-key-4')
    ]);

    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((entry) => entry.status === 'rejected' && (entry.reason as { code?: string }).code === 'LIMIT_EXCEEDED')).toBe(true);
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(2);
  });

  it('preserves single-workspace behaviour when the limit is one', async () => {
    const { service, store, ownerId } = createService(1);
    const only = await openWorkspace(service, ownerId, 'legacy-1');

    await expect(openWorkspace(service, ownerId, 'legacy-2')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const resolved = await service.execute(ownerId, 'workspace_status', {});
    expect((resolved.data as { workspaceId: string }).workspaceId).toBe(only);
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(1);
  });

  it('blocks new admission but never reaps existing workspaces when the limit is lowered', async () => {
    const { service, store, ownerId, config } = createService(2);
    const first = await openWorkspace(service, ownerId, 'lower-key-1');
    const second = await openWorkspace(service, ownerId, 'lower-key-2');

    const narrowed = new WorkspaceService({ ...config, maxActiveWorkspacesPerOwner: 1 }, store);

    expect(store.byId(first)?.status).toBe('ACTIVE');
    expect(store.byId(second)?.status).toBe('ACTIVE');
    await expect(narrowed.execute(ownerId, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git',
      idempotencyKey: 'lower-key-3'
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(2);
  });

  it('promotes an expired workspace while the owner stays within the limit', async () => {
    const { service, store, ownerId, jobsRoot } = createService(2);
    const active = await openWorkspace(service, ownerId, 'recover-ok-active');
    const expired = seedWorkspace(store, ownerId, jobsRoot, `ws_${'r'.repeat(24)}`, 'EXPIRED_RECOVERABLE');

    const recovered = await service.execute(ownerId, 'workspace_recover', { workspaceId: expired.id });

    expect(recovered.ok).toBe(true);
    expect(store.byId(expired.id)?.status).toBe('ACTIVE');
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(2);
    expect(active).not.toBe(expired.id);
  });

  it('refuses to promote an expired workspace when the owner is at the limit', async () => {
    const { service, store, ownerId, jobsRoot } = createService(2);
    await openWorkspace(service, ownerId, 'recover-full-1');
    await openWorkspace(service, ownerId, 'recover-full-2');
    const expired = seedWorkspace(store, ownerId, jobsRoot, `ws_${'s'.repeat(24)}`, 'EXPIRED_RECOVERABLE');

    await expect(service.execute(ownerId, 'workspace_recover', { workspaceId: expired.id })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED'
    });
    expect(store.byId(expired.id)?.status).toBe('EXPIRED_RECOVERABLE');
  });

  it('counts a promotion that reuses an already running container', async () => {
    const { service, store, ownerId, jobsRoot } = createService(2);
    const active = await openWorkspace(service, ownerId, 'live-container-active');
    const containerName = containerNameFor(`ws_${'t'.repeat(24)}`);
    const expired = seedWorkspace(store, ownerId, jobsRoot, `ws_${'t'.repeat(24)}`, 'EXPIRED_RECOVERABLE', { containerName });
    docker.runningContainers.add(containerName);

    const recovered = await service.execute(ownerId, 'workspace_recover', { workspaceId: expired.id });

    expect(recovered.ok).toBe(true);
    expect(store.byId(expired.id)?.status).toBe('ACTIVE');
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(2);
    expect(active).not.toBe(expired.id);
    // The running container was reused rather than rebuilt.
    expect(docker.runDocker.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'create')).toHaveLength(1);
  });

  it('refuses a promotion whose container reuse races with a concurrent admission', async () => {
    const { service, store, ownerId, jobsRoot } = createService(2);
    await openWorkspace(service, ownerId, 'race-promote-1');
    const containerName = containerNameFor(`ws_${'u'.repeat(24)}`);
    const expired = seedWorkspace(store, ownerId, jobsRoot, `ws_${'u'.repeat(24)}`, 'EXPIRED_RECOVERABLE', { containerName });
    docker.runningContainers.add(containerName);

    // The reuse branch inspects the container before it promotes, so admitting a
    // second workspace inside that await is exactly the window the atomic promotion
    // guard exists to close.
    docker.inspectHook = () => openWorkspace(service, ownerId, 'race-promote-2');

    await expect(service.execute(ownerId, 'workspace_recover', { workspaceId: expired.id })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED'
    });
    expect(store.byId(expired.id)?.status).toBe('EXPIRED_RECOVERABLE');
    expect(store.list(ownerId).filter((entry) => entry.status === 'ACTIVE')).toHaveLength(2);
    expect(store.list(ownerId).filter((entry) => ['ACTIVE', 'CREATING', 'REAPING', 'NETWORK_QUARANTINED'].includes(entry.status))).toHaveLength(2);
  });
});
