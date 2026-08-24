import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig, TOOL_SCHEMA_BY_NAME } from '@cloud-harness/contracts';
import { OperationManager } from '../src/operation-manager.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {}, truncated: false },
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
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* store already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* directory already removed */ }
  }
});

function createWorkspaceRecord(ownerId: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${'a'.repeat(24)}`,
    ownerId,
    idempotencyKey: 'key-1234',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'chm-test-container',
    workspacePath: '/tmp/test-workspace',
    status: 'ACTIVE',
    networkMode: 'none',
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
}

describe('UX Improvements and Feature Enhancements', () => {
  it('Issue #94: exposes lease visibility, warnings, and allows lease renewal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-lease-'));
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
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-1' });
    const now = Date.now();

    // Create workspace with 2 minutes remaining on idle lease to trigger warning
    const ws = createWorkspaceRecord(ownerId, {
      expiresAt: now + 120_000,
      hardExpiresAt: now + 14_400_000
    });
    store.create(ws);

    const service = new WorkspaceService(config, store);

    // Test workspace_status lease visibility
    const statusRes = service.status(ownerId, ws.id);
    expect(statusRes.ok).toBe(true);
    const data = statusRes.data as Record<string, unknown>;
    expect(data.leaseState).toBe('WARNING');
    expect(data.canRenewLease).toBe(true);
    expect(Array.isArray(data.leaseWarnings)).toBe(true);
    expect(data.remainingLeaseMs).toBeGreaterThan(0);
    expect(data.hardExpiresAt).toBeDefined();

    // Test workspace_lease_renew
    const renewRes = await service.execute(ownerId, 'workspace_lease_renew', { workspaceId: ws.id, extensionSeconds: 7200 });
    expect(renewRes.ok).toBe(true);
    const renewData = renewRes.data as Record<string, unknown>;
    expect(renewData.remainingLeaseMs).toBeGreaterThan(120_000);
    expect(renewData.leaseState).toBe('ACTIVE');
  });

  it('Issue #92: resolves implicit active workspace when workspaceId is omitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-implicit-ws-'));
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
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-2' });

    const service = new WorkspaceService(config, store);

    // 0 workspaces -> NOT_FOUND error
    expect(() => service.status(ownerId)).toThrow(/workspace not found/);

    // 1 active workspace -> automatically resolved
    const ws1 = createWorkspaceRecord(ownerId, { id: `ws_${'1'.repeat(24)}`, idempotencyKey: 'key-1' });
    store.create(ws1);

    const statusSingle = service.status(ownerId);
    expect(statusSingle.ok).toBe(true);
    expect((statusSingle.data as Record<string, unknown>).workspaceId).toBe(ws1.id);

    // Add git identity and test workspace_context
    await service.execute(ownerId, 'git_identity_set', { name: 'Alice Developer', email: 'alice@example.com' });
    const identityRes = await service.execute(ownerId, 'git_identity_status', {});
    expect(identityRes.ok).toBe(true);
    expect((identityRes.data as Record<string, unknown>).name).toBe('Alice Developer');

    const contextRes = await service.execute(ownerId, 'workspace_context', {});
    expect(contextRes.ok).toBe(true);
    const contextData = contextRes.data as Record<string, unknown>;
    expect((contextData.workspace as Record<string, unknown>).workspaceId).toBe(ws1.id);
    expect((contextData.gitIdentity as Record<string, unknown>).name).toBe('Alice Developer');

    // Test workspace_set_active
    const setActiveRes = await service.execute(ownerId, 'workspace_set_active', { workspaceId: ws1.id });
    expect(setActiveRes.ok).toBe(true);
    expect((setActiveRes.data as Record<string, unknown>).activeWorkspaceId).toBe(ws1.id);
  });

  it('Issue #90: tracks operations, cancellation, and status polling', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-ops-'));
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
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-3' });
    const service = new WorkspaceService(config, store);

    // Register a generic operation in operation manager
    const opManager = (service as unknown as { operations: { registerGenericOperation: (op: unknown) => { id: string, status: string } } }).operations;
    const opId = `op_${'a'.repeat(24)}`;
    const tracked = opManager.registerGenericOperation({
      id: opId,
      kind: 'build',
      deadlineMs: Date.now() + 60_000
    });
    expect(tracked.id).toBe(opId);

    // Poll operation_status
    const statusRes = await service.execute(ownerId, 'operation_status', { operationId: opId });
    expect(statusRes.ok).toBe(true);
    expect((statusRes.data as Record<string, unknown>).status).toBe('running');

    // Cancel operation
    const cancelRes = await service.execute(ownerId, 'operation_cancel', { operationId: opId });
    expect(cancelRes.ok).toBe(true);
    expect((cancelRes.data as Record<string, unknown>).status).toBe('cancelled');

    // Wait for operation (already terminal)
    const waitRes = await service.execute(ownerId, 'operation_wait', { operationId: opId, timeoutMs: 1000 });
    expect(waitRes.ok).toBe(false);
    expect((waitRes.data as Record<string, unknown>).status).toBe('cancelled');
  });

  it('Issue #89: supports comment idempotency in github_action', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-gh-'));
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
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-4' });

    // Store comment idempotency cache directly
    const cachedResponse = { ok: true, message: 'GitHub issue_comment successful', data: { url: 'https://github.com/example/repo/issues/1#issuecomment-100' }, truncated: false };
    store.setCommentIdempotency(ownerId, 'idem-comment-key-1', JSON.stringify(cachedResponse), 'fp1');

    const retrieved = store.getCommentIdempotency(ownerId, 'idem-comment-key-1', 'fp1');
    expect(retrieved?.resultJson).toBeDefined();
    expect(JSON.parse(retrieved!.resultJson!)).toEqual(cachedResponse);

    // Mismatched fingerprint returns mismatch: true
    const mismatched = store.getCommentIdempotency(ownerId, 'idem-comment-key-1', 'fp2');
    expect(mismatched?.mismatch).toBe(true);
  });

  it('Issue #88 & #93: executes files_write_batch and workspace_finalize via worker and mutation lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-batch-finalize-'));
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
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-5' });

    const wsPath = join(jobsRoot, `ws_${'5'.repeat(24)}`);
    mkdirSync(join(wsPath, 'repo'), { recursive: true });
    const ws = createWorkspaceRecord(ownerId, { id: `ws_${'5'.repeat(24)}`, workspacePath: wsPath, idempotencyKey: 'key-5' });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    // Mock worker result for files_write_batch
    docker.workerResult = {
      ok: true,
      message: 'Batch wrote 2 files',
      data: { createdCount: 2, updatedCount: 0, totalFiles: 2, files: [{ path: 'p1.md', sha256: 'a'.repeat(64), status: 'created' }] },
      truncated: false
    };

    const batchRes = await service.execute(ownerId, 'files_write_batch', {
      workspaceId: ws.id,
      files: [{ path: 'p1.md', content: 'test 1' }, { path: 'p2.md', content: 'test 2' }],
      idempotencyKey: 'batch-write-key-1'
    });
    expect(batchRes.ok).toBe(true);
    expect((batchRes.data as Record<string, unknown>).createdCount).toBe(2);

    // Retrying with same idempotency key returns cached result without running worker again
    const batchReplay = await service.execute(ownerId, 'files_write_batch', {
      workspaceId: ws.id,
      files: [{ path: 'p1.md', content: 'test 1' }, { path: 'p2.md', content: 'test 2' }],
      idempotencyKey: 'batch-write-key-1'
    });
    expect(batchReplay.ok).toBe(true);
    expect(batchReplay.message).toBe(batchRes.message);
    // Mock worker result for workspace_finalize git operations
    docker.workerResult = {
      ok: true,
      message: 'Git operation successful',
      data: { output: 'abc12345\t2026-08-24\tAgent\tfeat: test finalize' },
      truncated: false
    };

    const finalizeRes = await service.execute(ownerId, 'workspace_finalize', {
      workspaceId: ws.id,
      commitMessage: 'feat: test finalize',
      push: false
    });
    expect(finalizeRes.ok).toBe(true);
    expect((finalizeRes.data as Record<string, unknown>).pushed).toBe(false);

    // Test workspace_recover in status and patch mode
    docker.workerResult = {
      ok: true,
      message: 'Workspace recovery status',
      data: { status: '## main\n M file.ts\n', hasUncommitted: true },
      truncated: false
    };
    const recoverStatus = await service.execute(ownerId, 'workspace_recover', { workspaceId: ws.id, mode: 'status' });
    expect(recoverStatus.ok).toBe(true);
    expect((recoverStatus.data as Record<string, unknown>).workspace).toBeDefined();

    docker.workerResult = {
      ok: true,
      message: 'Workspace recovery patch',
      data: { workingTreePatch: 'diff --git a/file.ts b/file.ts', combinedPatch: 'diff --git a/file.ts b/file.ts' },
      truncated: false
    };
    const recoverPatch = await service.execute(ownerId, 'workspace_recover', { workspaceId: ws.id, mode: 'patch' });
    expect(recoverPatch.ok).toBe(true);
    expect((recoverPatch.data as Record<string, unknown>).workingTreePatch).toBeDefined();

    // Test workspace_recover in export mode on EXPIRED_RECOVERABLE workspace without container
    store.update(ws.id, { status: 'EXPIRED_RECOVERABLE', containerName: null });
    docker.workerResult = {
      ok: true,
      message: 'Recovery snapshot committed',
      data: { headCommitSha: 'sha1234567890', committedChanges: true },
      truncated: false
    };

    const recoverExport = await service.execute(ownerId, 'workspace_recover', {
      workspaceId: ws.id,
      mode: 'export',
      targetBranch: 'recovered-branch'
    });
    expect(recoverExport.ok).toBe(true);
    expect((recoverExport.data as Record<string, unknown>).branch).toBe('recovered-branch');
    expect((recoverExport.data as Record<string, unknown>).commitSha).toBe('sha1234567890');

    // Verify that runRecoveryWorker mounted the workspace repo with :rw when writable: true
    const recoverDockerCalls = docker.runDocker.mock.calls.filter((call) =>
      call[0].includes('--label') && call[0].includes('cloud-harness.role=recover-helper')
    );
    expect(recoverDockerCalls.length).toBeGreaterThan(0);
    const lastCallArgs = recoverDockerCalls.at(-1)![0];
    expect(lastCallArgs.some((arg: string) => arg.includes('/repo:/workspace:rw'))).toBe(true);
    expect(lastCallArgs.includes('--read-only')).toBe(true);
  });

  it('Issue #93: workspace_finalize validates preflight conflicts and enforces journal idempotency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-finalize-preflight-'));
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
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-finalize' });
    const ws = createWorkspaceRecord(ownerId, { id: `ws_${'6'.repeat(24)}`, idempotencyKey: 'key-6' });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    // Test 1: Preflight conflict marker detection
    docker.workerResult = {
      ok: true,
      message: 'git diff',
      data: { output: '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> branch\n' },
      truncated: false
    };

    const conflictRes = await service.execute(ownerId, 'workspace_finalize', {
      workspaceId: ws.id,
      commitMessage: 'feat: with conflict',
      push: false
    });
    expect(conflictRes.ok).toBe(false);
    expect(conflictRes.message).toContain('Preflight check failed');
    expect((conflictRes.data as Record<string, unknown>).step).toBe('preflight');

    // Test 2: Successful finalize with idempotency key
    docker.workerResult = {
      ok: true,
      message: 'Clean diff',
      data: { output: 'abc78901\t2026-08-24\tAgent\tfeat: finalized successfully' },
      truncated: false
    };

    const finalizeFirst = await service.execute(ownerId, 'workspace_finalize', {
      workspaceId: ws.id,
      commitMessage: 'feat: finalized successfully',
      idempotencyKey: 'finalize-key-100',
      push: false
    });
    expect(finalizeFirst.ok).toBe(true);

    // Test 3: Retrying with same idempotency key returns journaled result without re-executing
    const finalizeReplay = await service.execute(ownerId, 'workspace_finalize', {
      workspaceId: ws.id,
      commitMessage: 'feat: finalized successfully',
      idempotencyKey: 'finalize-key-100',
      push: false
    });
    expect(finalizeReplay.ok).toBe(true);
    expect(finalizeReplay.message).toBe(finalizeFirst.message);
  });

  it('Issue #94: reapExpired transitions active workspaces to EXPIRED_RECOVERABLE without deleting files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-reap-grace-'));
    temporaryDirectories.push(directory);
    const jobsRoot = join(directory, 'jobs');
    const wsPath = join(jobsRoot, `ws_${'7'.repeat(24)}`);
    mkdirSync(wsPath, { recursive: true });
    const config = {
      jobsRoot,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      reaperIntervalSeconds: 60,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner-reap' });
    const now = Date.now();

    // Create workspace with expired idle lease
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'7'.repeat(24)}`,
      workspacePath: wsPath,
      expiresAt: now - 1000,
      lastActivityAt: now - 1000
    });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    // Run reapExpired
    const reapExpiredFn = (service as unknown as { reapExpired: () => Promise<void> }).reapExpired;
    await reapExpiredFn.call(service);

    // Status should be EXPIRED_RECOVERABLE, not CLOSED
    const updated = store.byId(ws.id);
    expect(updated?.status).toBe('EXPIRED_RECOVERABLE');

    // Ensure capacity allows a new workspace to open because EXPIRED_RECOVERABLE doesn't block it
    const ensureCapacityFn = (service as unknown as { ensureCapacity: (owner: string) => Promise<void> }).ensureCapacity;
    await expect(ensureCapacityFn.call(service, ownerId)).resolves.not.toThrow();
  });

  it('Issue #89: github_action issue_publish schema validation and idempotency handling', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-issue89-'));
    temporaryDirectories.push(directory);
    const jobsRoot = join(directory, 'jobs');
    const wsPath = join(jobsRoot, `ws_${'8'.repeat(24)}`);
    mkdirSync(wsPath, { recursive: true });
    const config = {
      jobsRoot,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      reaperIntervalSeconds: 60,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_issue89' });
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'8'.repeat(24)}`,
      workspacePath: wsPath
    });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    // Verify schema validation accepts issue_publish with comment and addLabels
    const parsed = TOOL_SCHEMA_BY_NAME.github_action.safeParse({
      workspaceId: ws.id,
      action: 'issue_publish',
      issueNumber: 42,
      comment: 'Plan ready for review',
      addLabels: ['ready to cook', 'in progress'],
      createMissingLabels: true,
      idempotencyKey: 'idemp_pub_123'
    });
    expect(parsed.success).toBe(true);

    // Idempotency caching in store
    store.setCommentIdempotency(ownerId, 'idemp_pub_123', JSON.stringify({
      ok: true,
      message: 'Published successfully',
      data: { issueNumber: 42, published: true },
      truncated: false
    }));

    const result = await service.execute(ownerId, 'github_action', {
      workspaceId: ws.id,
      action: 'issue_publish',
      issueNumber: 42,
      comment: 'Plan ready for review',
      addLabels: ['ready to cook'],
      idempotencyKey: 'idemp_pub_123'
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ issueNumber: 42, published: true });
  });

  it('Issue #94: mutation_locked_until prevents reapExpired from reaping active workspaces', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-issue94-mut-'));
    temporaryDirectories.push(directory);
    const jobsRoot = join(directory, 'jobs');
    const wsPath = join(jobsRoot, `ws_${'9'.repeat(24)}`);
    mkdirSync(wsPath, { recursive: true });
    const config = {
      jobsRoot,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      reaperIntervalSeconds: 60,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_issue94_mutation' });
    const now = Date.now();
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'9'.repeat(24)}`,
      workspacePath: wsPath,
      expiresAt: now - 1000,
      mutationLockedUntil: now + 300_000
    });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    const reapExpiredFn = (service as unknown as { reapExpired: () => Promise<void> }).reapExpired;
    await reapExpiredFn.call(service);

    // Should NOT be transitioned while mutation locked
    const updated = store.byId(ws.id);
    expect(updated?.status).toBe('ACTIVE');

    // After unlocking, reapExpired transitions it
    store.clearMutationLock(ws.id);
    await reapExpiredFn.call(service);
    const reaped = store.byId(ws.id);
    expect(reaped?.status).toBe('EXPIRED_RECOVERABLE');
  });

  it('Issue #90: OperationManager preserves 10-minute terminal retention and rejects excess registration', () => {
    const manager = new OperationManager();

    // Register 500 fresh operations and mark terminal
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      const op = manager.registerGenericOperation({
        id: `op_test_${i}`,
        kind: 'exec_run',
        workspaceId: 'ws_test'
      });
      manager.updateGenericOperation(op.id, { status: 'completed' });
    }

    // All 500 recently completed operations exist
    expect(manager.getGenericOperation('op_test_0')).toBeDefined();
    expect(manager.getGenericOperation('op_test_499')).toBeDefined();

    // Registering a 501st operation when all 500 are fresh should throw LIMIT_EXCEEDED
    expect(() => {
      manager.registerGenericOperation({
        id: 'op_test_overflow',
        kind: 'exec_run',
        workspaceId: 'ws_test'
      });
    }).toThrow('too many live or retained operation handles');

    // All 500 originals must remain untouched
    expect(manager.getGenericOperation('op_test_0')).toBeDefined();
    expect(manager.getGenericOperation('op_test_499')).toBeDefined();
    expect(manager.getGenericOperation('op_test_overflow')).toBeUndefined();

    // Manually age op_test_0 to 11 minutes ago (past 10-minute retention)
    const op0 = manager.getGenericOperation('op_test_0');
    if (op0) {
      op0.finishedAt = now - 660_000;
      op0.createdAt = now - 660_000;
    }

    // Now registering should prune the expired op_test_0 and succeed
    const newOp = manager.registerGenericOperation({
      id: 'op_test_new',
      kind: 'exec_run',
      workspaceId: 'ws_test'
    });

    expect(newOp).toBeDefined();
    expect(manager.getGenericOperation('op_test_0')).toBeUndefined();
    expect(manager.getGenericOperation('op_test_new')).toBeDefined();
  });

  it('Issue #90: operation_wait timeout includes retryAfterMs and deadline in error response', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-issue90-'));
    temporaryDirectories.push(directory);
    const jobsRoot = join(directory, 'jobs');
    const wsPath = join(jobsRoot, `ws_${'a'.repeat(24)}`);
    mkdirSync(wsPath, { recursive: true });
    const config = {
      jobsRoot,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_issue90' });
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'a'.repeat(24)}`,
      workspacePath: wsPath
    });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    // Register a running operation with valid ID
    const validOpId = `op_${'b'.repeat(24)}`;
    const ops = (service as unknown as { operations: OperationManager }).operations;
    ops.registerGenericOperation({
      id: validOpId,
      kind: 'exec_run',
      workspaceId: ws.id
    });

    // operation_wait with 100ms timeout
    const waitRes = await service.execute(ownerId, 'operation_wait', {
      workspaceId: ws.id,
      operationId: validOpId,
      timeoutMs: 100
    });

    expect(waitRes.ok).toBe(false);
    expect(waitRes.error?.code).toBe('TIMEOUT');
    expect(waitRes.error?.retryAfterMs).toBeDefined();
    expect(waitRes.error?.deadline).toBeDefined();
  });

  it('Issue #94: non-batch mutations (e.g. files_write) hold mutation lock against reapExpired and ensureCapacity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-single-mut-'));
    temporaryDirectories.push(directory);
    const jobsRoot = join(directory, 'jobs');
    const wsPath = join(jobsRoot, `ws_${'c'.repeat(24)}`);
    mkdirSync(wsPath, { recursive: true });
    const config = {
      jobsRoot,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const store = new StateStore(config.stateDb);
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_single_mut' });
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'c'.repeat(24)}`,
      workspacePath: wsPath
    });
    store.create(ws);
    const service = new WorkspaceService(config, store);

    // Acquire mutation lock directly as files_write would
    const now = Date.now();
    store.setMutationLock(ws.id, now + 300_000);

    // 1. reapExpired does not reap workspace even if expired
    store.update(ws.id, { expiresAt: now - 1000 });
    const reapExpiredFn = (service as unknown as { reapExpired: () => Promise<void> }).reapExpired;
    await reapExpiredFn.call(service);
    expect(store.byId(ws.id)?.status).toBe('ACTIVE');

    // 2. ensureCapacity still protects the single active slot while active
    const ensureCapacityFn = (service as unknown as { ensureCapacity: (owner: string) => Promise<void> }).ensureCapacity;
    await expect(ensureCapacityFn.call(service, ownerId)).rejects.toThrow('only one active workspace is allowed');

    // Release mutation lock and expire
    store.clearMutationLock(ws.id);
    await reapExpiredFn.call(service);
    expect(store.byId(ws.id)?.status).toBe('EXPIRED_RECOVERABLE');

    // After transitioning to EXPIRED_RECOVERABLE, ensureCapacity allows a new workspace
    await expect(ensureCapacityFn.call(service, ownerId)).resolves.not.toThrow();
  });

  it('Issue #94: crash recovery allows claimForExpiry once timestamp lapses and generation-fences stale completions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-crash-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_crash' });
    const now = Date.now();
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'d'.repeat(24)}`,
      workspacePath: join(directory, 'ws_crash'),
      expiresAt: now - 1000
    });
    store.create(ws);

    // Simulate crashed process holding lock count > 0 with expired timestamp
    store.setMutationLock(ws.id, now - 500, ws.generation);
    expect(store.byId(ws.id)?.mutationLockedUntil).toBeLessThanOrEqual(now);

    // claimForExpiry should claim it despite positive lock count because timestamp lapsed
    const claimed = store.claimForExpiry(ws.id, ws.generation);
    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe('REAPING');
    expect(claimed?.generation).toBe(ws.generation + 1);

    // Stale release or clear from old generation cannot mutate the claimed workspace
    store.releaseMutationLease(ws.id, ws.generation);
    store.clearMutationLock(ws.id, ws.generation);
    const current = store.byId(ws.id);
    expect(current?.status).toBe('REAPING');
    expect(current?.generation).toBe(ws.generation + 1);
  });

  it('Issue #90 & #94: real task lifecycle callbacks and overlapping async operations maintain ref-counted mutation locks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-overlap-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_overlap' });
    const now = Date.now();
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'e'.repeat(24)}`,
      workspacePath: join(directory, 'ws_overlap'),
      expiresAt: now - 1000
    });
    store.create(ws);
    const manager = new OperationManager();
    manager.onTaskSettle = (wsId) => {
      const rec = store.byId(wsId);
      if (rec) store.clearMutationLock(rec.id, rec.generation);
    };

    // 1. Task 1 starts and acquires lock
    const t1 = manager.runTask(ws.id, 'cnt', '.', 'echo 1', 'key_1', 60000, 262144);
    expect(t1.created).toBe(true);
    store.setMutationLock(ws.id, now + 300_000, ws.generation);
    expect(store.byId(ws.id)?.mutationLockedUntil).toBeGreaterThan(now);

    // 2. Duplicate idempotent task request does NOT create new task or extra lease
    const t1Replay = manager.runTask(ws.id, 'cnt', '.', 'echo 1', 'key_1', 60000, 262144);
    expect(t1Replay.created).toBe(false);

    // 3. Task 2 starts (overlapping, ref count = 2)
    const t2 = manager.runTask(ws.id, 'cnt', '.', 'echo 2', 'key_2', 60000, 262144);
    expect(t2.created).toBe(true);
    store.setMutationLock(ws.id, now + 400_000, ws.generation);

    // 4. Cancel Task 1 (fires once-only settle, ref count = 1, workspace still protected!)
    await manager.cancelTask(ws.id, t1.id);
    expect(store.byId(ws.id)?.mutationLockedUntil).toBeGreaterThan(now);

    // 5. Cancelling Task 1 again does not double-decrement
    await manager.cancelTask(ws.id, t1.id);
    expect(store.byId(ws.id)?.mutationLockedUntil).toBeGreaterThan(now);

    // 6. Cancel Task 2 (ref count = 0, lock cleared)
    await manager.cancelTask(ws.id, t2.id);
    expect(store.byId(ws.id)?.mutationLockedUntil).toBeNull();
  });

  it('Issue #90: cancelGenericOperation sets finishedAt and preserves retention window', async () => {
    const { OperationManager } = await import('../src/operation-manager.js');
    const manager = new OperationManager();
    const op = manager.registerGenericOperation({
      id: 'op_cancel_test',
      kind: 'exec_run',
      workspaceId: 'ws_test'
    });

    await manager.cancelGenericOperation(op.id);
    const cancelled = manager.getGenericOperation(op.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.finishedAt).toBeDefined();
    expect(cancelled?.finishedAt).toBeGreaterThan(0);
  });

  it('Issue #90: operation_status & operation_wait return terminal error envelope within 10 minutes after close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-close-reconnect-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_reconnect' });
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'f'.repeat(24)}`,
      workspacePath: join(directory, 'ws_reconnect')
    });
    store.create(ws);
    const config = {
      jobsRoot: directory,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const service = new WorkspaceService(config, store);
    const ops = (service as unknown as { operations: OperationManager }).operations;
    const opId = `op_${'c'.repeat(24)}`;
    ops.registerGenericOperation({
      id: opId,
      kind: 'exec_run',
      workspaceId: ws.id
    });

    // Close the workspace
    await service.close(ownerId, ws.id);
    expect(store.byId(ws.id)?.status).toBe('CLOSED');

    // 1. Reconnecting to operation_status returns terminal cancelled result with error envelope
    const statusRes = await service.execute(ownerId, 'operation_status', {
      operationId: opId
    });

    expect(statusRes.ok).toBe(false);
    expect(statusRes.error?.code).toBe('CANCELLED');
    const statusData = statusRes.data as { status: string; operationId: string; finishedAt?: string };
    expect(statusData.operationId).toBe(opId);
    expect(statusData.status).toBe('cancelled');
    expect(statusData.finishedAt).toBeDefined();

    // 2. Reconnecting to operation_wait returns terminal cancelled result with error envelope
    const waitRes = await service.execute(ownerId, 'operation_wait', {
      workspaceId: ws.id,
      operationId: opId,
      timeoutMs: 100
    });

    expect(waitRes.ok).toBe(false);
    expect(waitRes.error?.code).toBe('CANCELLED');
    const waitData = waitRes.data as { status: string; operationId: string; finishedAt?: string };
    expect(waitData.operationId).toBe(opId);
    expect(waitData.status).toBe('cancelled');
    expect(waitData.finishedAt).toBeDefined();
  });

  it('Issue #90: async deadline records TIMEOUT with retryAfterMs and is never overwritten by CANCELLED', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-deadline-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_deadline' });
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'1'.repeat(24)}`,
      workspacePath: join(directory, 'ws_deadline'),
      containerName: 'cnt_deadline'
    });
    store.create(ws);
    const config = {
      jobsRoot: directory,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const service = new WorkspaceService(config, store);

    // Override runWorker to simulate a long-running command that hangs until aborted
    (service as unknown as { runWorker: (...args: unknown[]) => Promise<unknown> }).runWorker = vi.fn((_rec, _op, _inp, signal: AbortSignal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted by timeout'));
        });
      });
    });
    // 1. Start async command with 100ms timeout
    const startRes = await service.execute(ownerId, 'exec_run', {
      workspaceId: ws.id,
      command: 'sleep 10',
      async: true,
      timeoutMs: 100
    });
    expect(startRes.ok).toBe(true);
    const opId = (startRes.data as { operationId: string }).operationId;

    // Wait for the 100ms deadline to expire
    await new Promise((r) => setTimeout(r, 200));

    // 2. operation_status should return TIMEOUT with retryAfterMs and deadline, NOT CANCELLED
    const statusRes = await service.execute(ownerId, 'operation_status', {
      operationId: opId
    });
    expect(statusRes.ok).toBe(false);
    expect(statusRes.error?.code).toBe('TIMEOUT');
    expect(statusRes.error?.retryAfterMs).toBeDefined();
    expect(statusRes.error?.deadline).toBeDefined();

    // 3. operation_wait should also return TIMEOUT
    const waitRes = await service.execute(ownerId, 'operation_wait', {
      workspaceId: ws.id,
      operationId: opId,
      timeoutMs: 100
    });
    expect(waitRes.ok).toBe(false);
    expect(waitRes.error?.code).toBe('TIMEOUT');
  });

  it('Issue #94: workspace_lease_renew is generation-fenced and fails with CONFLICT if reaped concurrently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-renew-race-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_renew_race' });
    const now = Date.now();
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'2'.repeat(24)}`,
      workspacePath: join(directory, 'ws_renew_race'),
      expiresAt: now - 1000
    });
    store.create(ws);
    const config = {
      jobsRoot: directory,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const service = new WorkspaceService(config, store);

    // Simulate concurrent reaper claiming the workspace generation before renew executes
    const claimed = store.claimForExpiry(ws.id, ws.generation);
    expect(claimed?.status).toBe('REAPING');

    // workspace_lease_renew should fail and never resurrect status to ACTIVE
    await expect(service.execute(ownerId, 'workspace_lease_renew', {
      workspaceId: ws.id,
      extensionSeconds: 3600
    })).rejects.toThrow();

    expect(store.byId(ws.id)?.status).toBe('REAPING');
  });

  it('Issue #94: synchronous mutations with >5-minute timeout compute dynamic lease hold', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ux-long-mut-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner_long_mut' });
    const now = Date.now();
    const ws = createWorkspaceRecord(ownerId, {
      id: `ws_${'3'.repeat(24)}`,
      workspacePath: join(directory, 'ws_long_mut'),
      containerName: 'cnt_long_mut',
      expiresAt: now + 60_000,
      hardExpiresAt: now + 3_600_000
    });
    store.create(ws);
    const config = {
      jobsRoot: directory,
      stateDb: join(directory, 'state.db'),
      idleTtlSeconds: 3600,
      wallTtlSeconds: 14400,
      maxOutputBytes: 262144,
      maxWorkspaceBytes: 104857600,
      minFreeBytes: 1048576
    } as RunnerConfig;

    const service = new WorkspaceService(config, store);

    let leaseDuringExecution: number | null | undefined;
    (service as unknown as { runWorker: (...args: unknown[]) => Promise<unknown> }).runWorker = vi.fn(async () => {
      leaseDuringExecution = store.byId(ws.id)?.mutationLockedUntil;
      return { ok: true, message: 'done', data: {}, truncated: false };
    });
    // Run synchronous exec_run with 300,000ms (5 minutes) timeout
    await service.execute(ownerId, 'exec_run', {
      workspaceId: ws.id,
      command: 'echo test',
      timeoutMs: 300_000
    });

    expect(leaseDuringExecution).toBeDefined();
    // Must be greater than or equal to now + 315_000 (reflecting 300k timeout + 15k margin)
    expect(leaseDuringExecution!).toBeGreaterThanOrEqual(now + 315_000);
  });
});
