import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig } from '@cloud-harness/contracts';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false },
  createdEnvFiles: [] as string[],
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) {
      return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('branch') && args.includes('--show-current')) {
      return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args.includes('/opt/harness/worker-runner.sh')) {
      return {
        stdout: JSON.stringify(docker.workerResult), stderr: '', exitCode: 0, truncated: false
      };
    }
    if (args[0] === 'create') {
      const envFileIdx = args.indexOf('--env-file');
      if (envFileIdx !== -1 && args[envFileIdx + 1]) {
        try {
          const content = readFileSync(args[envFileIdx + 1]!, 'utf8');
          docker.createdEnvFiles.push(content);
        } catch {
          // ignore
        }
      }
      return { stdout: 'container-created\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (args[0] === 'start') {
      return { stdout: 'container-started\n', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
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
vi.mock('../src/github-app-broker.js', () => ({
  mintRepositoryToken: vi.fn(async () => 'mock-token'),
  mintPrincipalRepositoryScopedToken: vi.fn(async () => 'mock-token'),
  mintPrincipalRepositoryToken: vi.fn(async () => 'mock-token')
}));

import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: {}, truncated: false };
  docker.createdEnvFiles = [];
  vi.clearAllMocks();
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* store already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* directory already removed */ }
  }
});

function createTestService(): { service: WorkspaceService; store: StateStore; ownerId: string; jobsRoot: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-recovery-test-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    workspaceIdleTimeoutSeconds: 3600,
    maxOutputBytes: 262144,
    maxWorkspaceBytes: 104857600,
    minFreeBytes: 1048576,
    networkMode: 'none',
    allowedGitHosts: ['github.com'],
    executorImage: 'cloud-harness-executor:test'
  } as RunnerConfig;

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'test-owner' });
  const service = new WorkspaceService(config, store);
  return { service, store, ownerId, jobsRoot };
}

describe('Workspace Recovery and Lease Renewal (Issue #103)', () => {
  it('recovers an EXPIRED_RECOVERABLE workspace to ACTIVE state with default resume mode', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_recovertest123456789012';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });
    writeFileSync(join(wsPath, 'repo', 'uncommitted.txt'), 'persisted work');

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-1',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: null,
      workspacePath: wsPath,
      status: 'EXPIRED_RECOVERABLE',
      networkMode: 'none',
      createdAt: now - 5000,
      lastActivityAt: now - 4000,
      expiresAt: now - 1000,
      hardExpiresAt: now + 14_400_000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    };
    store.create(record);

    // Call workspace_recover with default mode (resume)
    const result = await service.execute(ownerId, 'workspace_recover', { workspaceId: wsId });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Workspace recovered to active state');

    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe('ACTIVE');
    expect(data.leaseState).toBe('ACTIVE');
    expect(data.availableActions).toContain('workspace_lease_renew');
    expect(data.availableActions).toContain('workspace_close');

    // Verify record in store was updated to ACTIVE with new container
    const updated = store.byId(wsId);
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.containerName).toBe(`cloud-harness-ws-${wsId.slice(3, 19).toLowerCase()}`);

    // Verify createExecutor was invoked to restart the container
    const createCalls = docker.runDocker.mock.calls.filter((c) => c[0][0] === 'create');
    expect(createCalls.length).toBeGreaterThan(0);
    const lastCreateArgs = createCalls.at(-1)![0];
    expect(lastCreateArgs.some((arg: string) => arg.includes(`${join(wsPath, 'repo')}:/workspace:rw`) || arg.includes(`${wsPath}/repo:/workspace:rw`))).toBe(true);
    const startCalls = docker.runDocker.mock.calls.filter((c) => c[0][0] === 'start');
    expect(startCalls.length).toBeGreaterThan(0);
  });

  it('renews lease and reactivates EXPIRED_RECOVERABLE workspace via workspace_lease_renew', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_renewtest1234567890123';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-2',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: null,
      workspacePath: wsPath,
      status: 'EXPIRED_RECOVERABLE',
      networkMode: 'none',
      createdAt: now - 5000,
      lastActivityAt: now - 4000,
      expiresAt: now - 1000,
      hardExpiresAt: now + 14_400_000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    };
    store.create(record);

    const result = await service.execute(ownerId, 'workspace_lease_renew', {
      workspaceId: wsId,
      extensionSeconds: 1800
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Workspace lease renewed');

    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe('ACTIVE');
    expect(data.leaseState).toBe('ACTIVE');

    const updated = store.byId(wsId);
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.containerName).toBeDefined();
  });

  it('exposes accurate availableActions across ACTIVE, EXPIRED_RECOVERABLE, and CLOSED states', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_actionstest12345678901';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-3',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: 'chm-test-container',
      workspacePath: wsPath,
      status: 'ACTIVE',
      networkMode: 'none',
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 3600000,
      hardExpiresAt: now + 14400000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    };
    store.create(record);

    // Active workspace status
    const activeStatus = await service.execute(ownerId, 'workspace_status', { workspaceId: wsId });
    expect(activeStatus.ok).toBe(true);
    const activeData = activeStatus.data as Record<string, unknown>;
    expect(activeData.availableActions).toEqual([
      'workspace_lease_renew',
      'workspace_close',
      'workspace_context',
      'workspace_finalize'
    ]);

    // Transition to EXPIRED_RECOVERABLE
    store.update(wsId, { status: 'EXPIRED_RECOVERABLE', containerName: null });
    const recoverableStatus = await service.execute(ownerId, 'workspace_status', { workspaceId: wsId });
    expect(recoverableStatus.ok).toBe(true);
    const recoverableData = recoverableStatus.data as Record<string, unknown>;
    expect(recoverableData.availableActions).toEqual([
      'workspace_recover',
      'workspace_lease_renew',
      'workspace_close'
    ]);
  });

  it('returns structured EXPIRED error when workspace is CLOSED or past hard deadline', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_closedtest123456789012';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-4',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: null,
      workspacePath: wsPath,
      status: 'CLOSED',
      networkMode: 'none',
      createdAt: now - 20000,
      lastActivityAt: now - 10000,
      expiresAt: now - 5000,
      hardExpiresAt: now + 14_400_000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: 'User closed'
    };
    store.create(record);

    await expect(service.execute(ownerId, 'workspace_recover', { workspaceId: wsId })).rejects.toMatchObject({
      code: 'EXPIRED'
    });

    await expect(service.execute(ownerId, 'workspace_lease_renew', { workspaceId: wsId })).rejects.toMatchObject({
      code: 'EXPIRED'
    });

    // Past hard deadline
    const wsIdHard = 'ws_harddead1234567890123';
    store.create({
      ...record,
      id: wsIdHard,
      idempotencyKey: 'idemp-hard',
      status: 'EXPIRED_RECOVERABLE',
      hardExpiresAt: now - 1000
    });

    await expect(service.execute(ownerId, 'workspace_recover', { workspaceId: wsIdHard, mode: 'resume' })).rejects.toMatchObject({
      code: 'EXPIRED'
    });
  });

  it('supports recovery in status and patch mode for non-destructive inspection', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_inspecttest12345678901';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-5',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: null,
      workspacePath: wsPath,
      status: 'EXPIRED_RECOVERABLE',
      networkMode: 'none',
      createdAt: now - 5000,
      lastActivityAt: now - 4000,
      expiresAt: now - 1000,
      hardExpiresAt: now + 14_400_000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    };
    store.create(record);

    docker.workerResult = {
      ok: true,
      message: 'Workspace recovery status',
      data: { status: ' M file.txt\n', hasUncommitted: true },
      truncated: false
    };

    const statusRes = await service.execute(ownerId, 'workspace_recover', { workspaceId: wsId, mode: 'status' });
    expect(statusRes.ok).toBe(true);
    expect((statusRes.data as Record<string, unknown>).hasUncommitted).toBe(true);

    docker.workerResult = {
      ok: true,
      message: 'Workspace recovery patch',
      data: { workingTreePatch: 'diff --git a/file.txt b/file.txt\n' },
      truncated: false
    };

    const patchRes = await service.execute(ownerId, 'workspace_recover', { workspaceId: wsId, mode: 'patch' });
    expect(patchRes.ok).toBe(true);
    expect((patchRes.data as Record<string, unknown>).workingTreePatch).toContain('diff --git');
  });

  it('throws EXPIRED if workspace repo directory on host was purged', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_purgedtest123456789012';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(wsPath, { recursive: true });
    // Intentionally do NOT create wsPath/repo!

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-purged',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: null,
      workspacePath: wsPath,
      status: 'EXPIRED_RECOVERABLE',
      networkMode: 'none',
      createdAt: now - 5000,
      lastActivityAt: now - 4000,
      expiresAt: now - 1000,
      hardExpiresAt: now + 14_400_000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    };
    store.create(record);

    await expect(service.execute(ownerId, 'workspace_recover', { workspaceId: wsId })).rejects.toMatchObject({
      code: 'EXPIRED',
      message: expect.stringContaining('no longer retained on disk')
    });
  });

  it('rejects recovery or renewal with LIMIT_EXCEEDED when a sibling workspace is ACTIVE', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const now = Date.now();

    // Active sibling workspace
    const wsActive = 'ws_siblingactive123456789';
    const wsActivePath = join(jobsRoot, wsActive);
    mkdirSync(join(wsActivePath, 'repo'), { recursive: true });
    store.create({
      id: wsActive,
      ownerId,
      idempotencyKey: 'idemp-active-sibling',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: 'chm-active-sibling',
      workspacePath: wsActivePath,
      status: 'ACTIVE',
      networkMode: 'none',
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 3600000,
      hardExpiresAt: now + 14400000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    });

    // Expired recoverable workspace
    const wsRecover = 'ws_siblingrecov1234567890';
    const wsRecoverPath = join(jobsRoot, wsRecover);
    mkdirSync(join(wsRecoverPath, 'repo'), { recursive: true });
    store.create({
      id: wsRecover,
      ownerId,
      idempotencyKey: 'idemp-recov-sibling',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: null,
      workspacePath: wsRecoverPath,
      status: 'EXPIRED_RECOVERABLE',
      networkMode: 'none',
      createdAt: now - 5000,
      lastActivityAt: now - 4000,
      expiresAt: now - 1000,
      hardExpiresAt: now + 14400000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    });

    await expect(service.execute(ownerId, 'workspace_recover', { workspaceId: wsRecover, mode: 'resume' })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED'
    });

    await expect(service.execute(ownerId, 'workspace_lease_renew', { workspaceId: wsRecover })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED'
    });
  });

  it('restarts stopped container on renew or recover if container is not running', async () => {
    const { service, store, ownerId, jobsRoot } = createTestService();
    const wsId = 'ws_deadcont12345678901234';
    const wsPath = join(jobsRoot, wsId);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });

    const now = Date.now();
    const record: WorkspaceRecord = {
      id: wsId,
      ownerId,
      idempotencyKey: 'idemp-dead',
      repositoryUrl: 'https://github.com/example/repo.git',
      repositoryRef: 'main',
      containerName: 'chm-dead-container',
      workspacePath: wsPath,
      status: 'ACTIVE',
      networkMode: 'none',
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 3600000,
      hardExpiresAt: now + 14400000,
      gitAuthorName: null,
      gitAuthorEmail: null,
      generation: 1,
      error: null
    };
    store.create(record);

    // Inspect returns container exists but Running: false
    docker.inspectContainer.mockResolvedValueOnce({
      State: { Running: false }
    });

    const recoverRes = await service.execute(ownerId, 'workspace_recover', { workspaceId: wsId, mode: 'resume' });
    expect(recoverRes.ok).toBe(true);

    // Verify start was called on the stopped container
    const startCalls = docker.runDocker.mock.calls.filter((c) => c[0][0] === 'start' && c[0][1] === 'chm-dead-container');
    expect(startCalls.length).toBeGreaterThan(0);
  });

  it('recovers workspace with exact pinned secret snapshot across container recreation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-recovery-secrets-'));
    temporaryDirectories.push(directory);
    const jobsRoot = join(directory, 'jobs');
    mkdirSync(jobsRoot, { recursive: true });
    const config = {
      jobsRoot,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      workspaceIdleTimeoutSeconds: 3600,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576,
      networkMode: 'none',
      allowedGitHosts: ['github.com'],
      executorImage: 'cloud-harness-executor:test'
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'test-owner' });
    const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 1) }]);
    const metadata = new MetadataStore(config.stateDb, keyring);

    const project = metadata.createProject(ownerId, 'Project', 0)!;
    const environment = metadata.createEnvironment(ownerId, project.id, 'Env', 0)!;
    metadata.secrets.create(ownerId, environment.id, 'DATABASE_URL', 'postgres://v1', 0, 'DB url');

    const service = new WorkspaceService(config, store, metadata);

    const principal = { kind: 'owner', ownerId: 'test-owner' } as const;
    const openResult = await service.execute(principal, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git',
      idempotencyKey: 'idemp-secret-rec-1',
      environmentId: environment.id,
      confirmEnvironmentInjection: true
    });
    const wsId = (openResult.data as { workspaceId: string }).workspaceId;
    mkdirSync(join(jobsRoot, wsId, 'repo'), { recursive: true });

    // Verify initial container create used --env-file containing v1 secret and kept values off argv
    const initialCreateCall = docker.runDocker.mock.calls.find((c) => c[0][0] === 'create' && c[0].includes('--env-file'));
    expect(initialCreateCall).toBeDefined();
    expect(initialCreateCall![0].join(' ')).not.toContain('postgres://v1');
    expect(docker.createdEnvFiles[0]).toContain('DATABASE_URL=postgres://v1');
    expect(docker.createdEnvFiles[0]).not.toContain('postgres://v2');

    // Rotate secret to v2 in metadata store
    metadata.secrets.rotate(ownerId, environment.id, 'DATABASE_URL', 'postgres://v2', 1, 'Rotated DB url');

    // Simulate container removal / crash
    docker.inspectContainer.mockResolvedValueOnce(null);
    docker.runDocker.mockClear();
    // Recover workspace (recreates executor)
    const recoverRes = await service.execute(principal, 'workspace_recover', { workspaceId: wsId, mode: 'resume' });
    expect(recoverRes.ok).toBe(true);

    // Verify recreated container received PINNED v1 secret via --env-file, not rotated v2
    const recreatedCall = docker.runDocker.mock.calls.find((c) => c[0][0] === 'create' && c[0].includes('--env-file'));
    expect(recreatedCall).toBeDefined();
    expect(recreatedCall![0].join(' ')).not.toContain('postgres://v2');
    expect(docker.createdEnvFiles[1]).toContain('DATABASE_URL=postgres://v1');
    expect(docker.createdEnvFiles[1]).not.toContain('postgres://v2');

    // Test key rotation and snapshot re-encryption
    const key2 = Buffer.alloc(32, 2);
    const keyringV2 = new SecretKeyring(2, [{ version: 1, key: Buffer.alloc(32, 1) }, { version: 2, key: key2 }]);
    const metadataV2 = new MetadataStore(config.stateDb, keyringV2);
    await metadataV2.secrets.reencrypt();
    const snapshotsReencrypted = store.reencryptSnapshots((item) => metadataV2.secrets.reencryptSnapshotItem(item));
    expect(snapshotsReencrypted).toBe(1);

    // Verify that after removing old key version 1, recovery still succeeds with key version 2 only
    const keyringOnlyV2 = new SecretKeyring(2, [{ version: 2, key: key2 }]);
    const metadataOnlyV2 = new MetadataStore(config.stateDb, keyringOnlyV2);
    const serviceOnlyV2 = new WorkspaceService(config, store, metadataOnlyV2);

    docker.inspectContainer.mockResolvedValueOnce(null);
    docker.runDocker.mockClear();
    const rekeyRecoverRes = await serviceOnlyV2.execute(principal, 'workspace_recover', { workspaceId: wsId, mode: 'resume' });
    expect(rekeyRecoverRes.ok).toBe(true);
    expect(docker.createdEnvFiles[2]).toContain('DATABASE_URL=postgres://v1');

    metadataV2.close();
    keyringV2.close();
    metadataOnlyV2.close();
    keyringOnlyV2.close();
    metadata.close();
    keyring.close();
  });
});
