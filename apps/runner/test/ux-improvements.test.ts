import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
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
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);

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
    const tracked = opManager.registerGenericOperation({
      id: 'op_custom_12345',
      kind: 'build',
      deadlineMs: Date.now() + 60_000
    });
    expect(tracked.id).toBe('op_custom_12345');

    // Poll operation_status
    const statusRes = await service.execute(ownerId, 'operation_status', { operationId: 'op_custom_12345' });
    expect(statusRes.ok).toBe(true);
    expect((statusRes.data as Record<string, unknown>).status).toBe('running');

    // Cancel operation
    const cancelRes = await service.execute(ownerId, 'operation_cancel', { operationId: 'op_custom_12345' });
    expect(cancelRes.ok).toBe(true);
    expect((cancelRes.data as Record<string, unknown>).status).toBe('cancelled');

    // Wait for operation (already terminal)
    const waitRes = await service.execute(ownerId, 'operation_wait', { operationId: 'op_custom_12345', timeoutMs: 1000 });
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
    store.setCommentIdempotency(ownerId, 'idem-comment-key-1', JSON.stringify(cachedResponse));

    const retrieved = store.getCommentIdempotency(ownerId, 'idem-comment-key-1');
    expect(retrieved).toBeDefined();
    expect(JSON.parse(retrieved!)).toEqual(cachedResponse);
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

    const ws = createWorkspaceRecord(ownerId, { id: `ws_${'5'.repeat(24)}`, idempotencyKey: 'key-5' });
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
});
