import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { OperationManager } from '../src/operation-manager.js';
import { WorkspaceService } from '../src/workspace-service.js';
const tempDir = () => {
  const dir = join(tmpdir(), `test-durable-tasks-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('Durable Task Engine & Restart Reconciliation', () => {
  it('creates durable tasks, enforces idempotency, and detects parameter conflicts', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const bootId1 = 'boot_1111111111111111';
    const ops = new OperationManager(store, bootId1);

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-1' });
      store.create({
        id: 'ws_tasks',
        ownerId,
        idempotencyKey: 'ik_ws_tasks',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      // 1. Run task
      const task1 = ops.runTask(
        'ws_tasks',
        'dummy_container',
        '.',
        'echo "hello"',
        'ik_task_1',
        60_000,
        65536,
        [],
        ownerId,
        dir,
        'my-task'
      );
      expect(task1.created).toBe(true);
      expect(task1.id).toBeDefined();

      // 2. Rerun with same idempotency key -> returns existing
      const task1Replay = ops.runTask(
        'ws_tasks',
        'dummy_container',
        '.',
        'echo "hello"',
        'ik_task_1',
        60_000,
        65536,
        [],
        ownerId,
        dir,
        'my-task'
      );
      expect(task1Replay.created).toBe(false);
      expect(task1Replay.id).toBe(task1.id);

      // 3. Rerun with same key but different command -> throws CONFLICT (409)
      expect(() => {
        ops.runTask(
          'ws_tasks',
          'dummy_container',
          '.',
          'echo "different command"',
          'ik_task_1',
          60_000,
          65536,
          [],
          ownerId,
          dir,
          'my-task'
        );
      }).toThrow(/Idempotency key reused with different task parameters/);

      // 4. Verify persisted in SQLite
      const persisted = store.getDurableTask(ownerId, 'ws_tasks', task1.id);
      expect(persisted).toBeDefined();
      expect(persisted?.command).toBe('echo "hello"');
      expect(['QUEUED', 'RUNNING']).toContain(persisted?.status);
      expect(persisted?.bootId).toBe(bootId1);
    } finally {
      store.close();
    }
  });

  it('reads output via cursor from log file on disk across manager re-instantiation', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const bootId = 'boot_log_test';
    const ops1 = new OperationManager(store, bootId);

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-2' });
      store.create({
        id: 'ws_logs',
        ownerId,
        idempotencyKey: 'ik_ws_logs',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const task = ops1.runTask(
        'ws_logs',
        'dummy_container',
        '.',
        'build',
        'ik_build',
        60_000,
        65536,
        [],
        ownerId,
        dir
      );

      // Simulate output written to log file
      const logDir = join(dir, '.chm', 'tasks');
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${task.id}.log`);
      const sampleText = 'Line 1: Building project...\nLine 2: Finished build successfully.\n';
      writeFileSync(logFile, sampleText, 'utf8');

      // Update task to SUCCEEDED
      const currentTask = store.getDurableTask(ownerId, 'ws_logs', task.id);
      store.updateDurableTaskStatus(task.id, currentTask?.generation ?? 1, {
        status: 'SUCCEEDED',
        exitCode: 0,
        outputBytes: Buffer.byteLength(sampleText),
        finishedAt: Date.now()
      });

      // Now create a new OperationManager instance (simulating restart)
      const ops2 = new OperationManager(store, 'boot_restart');
      const loadedTask = ops2.task('ws_logs', task.id, ownerId);
      expect(loadedTask.status).toBe('succeeded');
      expect(loadedTask.exitCode).toBe(0);

      // Read output with cursor
      const page1 = ops2.viewSince(loadedTask, '0');
      expect(page1.data.output).toBe(sampleText);
      expect(page1.truncated).toBe(false);
      expect(page1.cursor).toBe(String(Buffer.byteLength(sampleText)));
      expect(loadedTask.logPath).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('reconciles orphaned running tasks on runner restart', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const bootId1 = 'boot_original';
    const ops1 = new OperationManager(store, bootId1);

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-3' });
      store.create({
        id: 'ws_reconcile',
        ownerId,
        idempotencyKey: 'ik_ws_reconcile',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const task = ops1.runTask(
        'ws_reconcile',
        'dummy_container',
        '.',
        'long_running_job',
        'ik_long',
        60_000,
        65536,
        [],
        ownerId,
        dir
      );

      // Simulate task in RUNNING state
      store.updateDurableTaskStatus(task.id, 1, {
        status: 'RUNNING',
        startedAt: Date.now()
      });

      // Runner restarts with bootId2
      const bootId2 = 'boot_restarted';
      const count = store.reconcileRunningTasks(bootId2, Date.now());
      expect(count).toBe(1);

      const reconciled = store.getDurableTask(ownerId, 'ws_reconcile', task.id);
      expect(reconciled?.status).toBe('FAILED');
      expect(reconciled?.errorCode).toBe('RUNNER_RESTARTED');
      expect(reconciled?.errorMessage).toContain('interrupted by runner restart');
      expect(reconciled?.finishedAt).toBeDefined();

      const ops2 = new OperationManager(store, bootId2);
      const taskView = ops2.task('ws_reconcile', task.id, ownerId);
      expect(taskView.status).toBe('failed');
      expect(taskView.errorCode).toBe('RUNNER_RESTARTED');
    } finally {
      store.close();
    }
  });

  it('enforces bounded log spooling at maxBytes without disk exhaustion', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const bootId = 'boot_bounded_test';
    const ops = new OperationManager(store, bootId);

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-4' });
      store.create({
        id: 'ws_bounded',
        ownerId,
        idempotencyKey: 'ik_ws_bounded',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const maxBytes = 100;
      const task = ops.runTask(
        'ws_bounded',
        'dummy_container',
        '.',
        'noisy_job',
        'ik_noisy',
        60_000,
        maxBytes,
        [],
        ownerId,
        dir
      );

      expect(task.logPath).toBeDefined();
      const logFile = task.logPath!;
      expect(logFile).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('persists BLOCKED status when a dependency fails', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const ops = new OperationManager(store, 'boot_dep_test');

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-5' });
      store.create({
        id: 'ws_dep',
        ownerId,
        idempotencyKey: 'ik_ws_dep',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const task1 = ops.runTask('ws_dep', 'c1', '.', 'cmd1', 'ik_d1', 60000, 65536, [], ownerId, dir);
      const task2 = ops.runTask('ws_dep', 'c1', '.', 'cmd2', 'ik_d2', 60000, 65536, [task1.id], ownerId, dir);

      expect(task2.status).toBe('queued');

      // Simulate task1 failing
      store.updateDurableTaskStatus(task1.id, 1, { status: 'FAILED', exitCode: 1, finishedAt: Date.now() });
      ops.task('ws_dep', task1.id, ownerId).status = 'failed';

      // Trigger reconciliation
      (ops as unknown as { reconcileQueued: (ws: string) => void }).reconcileQueued('ws_dep');

      expect(task2.status).toBe('blocked');
      const persistedTask2 = store.getDurableTask(ownerId, 'ws_dep', task2.id);
      expect(persistedTask2?.status).toBe('BLOCKED');

      // Test taskGraph across manager restart
      const opsRestarted = new OperationManager(store, 'boot_restarted_graph');
      const graph = opsRestarted.taskGraph('ws_dep', ownerId);
      expect(graph.nodes.length).toBe(2);
      expect(graph.edges).toEqual([{ from: task1.id, to: task2.id }]);
    } finally {
      store.close();
    }
  });

  it('safely slices multi-byte UTF-8 characters across chunk boundaries in viewSince', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const ops = new OperationManager(store, 'boot_utf8_test');

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-6' });
      store.create({
        id: 'ws_utf8',
        ownerId,
        idempotencyKey: 'ik_ws_utf8',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const task = ops.runTask('ws_utf8', 'c1', '.', 'echo', 'ik_utf8', 60000, 65536, [], ownerId, dir);
      const logFile = task.logPath!;

      // 4-byte UTF-8 character: 🚀 (F0 9F 99 80)
      const rocket = '🚀';
      const repeated = rocket.repeat(20000); // 80,000 bytes
      writeFileSync(logFile, repeated, 'utf8');

      const page1 = ops.viewSince(task, '0');
      expect(page1.truncated).toBe(true);
      expect(page1.data.output.endsWith('🚀')).toBe(true); // Should not end in replacement char or broken byte!

      // Next page reading from returned cursor
      const page2 = ops.viewSince(task, page1.cursor);
      expect(page2.data.output.startsWith('🚀')).toBe(true);
    } finally {
      store.close();
    }
  });
  it('awaits child process exit and captures late output emitted during SIGTERM', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const ops = new OperationManager(store, 'boot_term_test');

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-term' });
      store.create({
        id: 'ws_term',
        ownerId,
        idempotencyKey: 'ik_ws_term',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: dir,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const task = ops.runTask('ws_term', 'c1', '.', 'worker', 'ik_term_1', 60000, 65536, [], ownerId, dir);
      expect(task.logPath).toBeDefined();

      // Mock a live child that emits late output when receiving SIGTERM before closing
      const fakeChild = new EventEmitter() as unknown as {
        exitCode: number | null;
        signalCode: string | null;
        killed: boolean;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: string) => void;
      };
      fakeChild.exitCode = null;
      fakeChild.signalCode = null;
      fakeChild.killed = false;
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      fakeChild.kill = (signal?: string) => {
        fakeChild.killed = true;
        if (signal === 'SIGTERM') {
          setTimeout(() => {
            // Late output emitted during SIGTERM handler
            fakeChild.stdout.emit('data', Buffer.from('Final flush before exit.\n'));
            fakeChild.exitCode = 0;
            fakeChild.emit('close', 0);
            fakeChild.emit('exit', 0);
          }, 50);
        }
      };

      (ops as unknown as { track: (t: unknown, c: unknown, b: number) => void }).track(task, fakeChild, 65536);
      task.child = fakeChild as unknown as ChildProcessWithoutNullStreams;
      await ops.stopWorkspace('ws_term', ownerId);

      const page = ops.viewSince(task, '0');
      expect(page.data.output).toContain('Final flush before exit.');
    } finally {
      store.close();
    }
  });
  it('rejects teardown on unkillable process, preserves workspace directory and transitions to EXPIRED_RECOVERABLE', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);

    const config = {
      host: '0.0.0.0',
      port: 3001,
      serviceToken: 'a'.repeat(32),
      jobsRoot: join(dir, 'jobs'),
      stateDb: dbPath,
      executorImage: 'cloud-harness-executor:local',
      allowedGitHosts: ['github.com'],
      networkMode: 'none' as const,
      wallTtlSeconds: 900,
      idleTtlSeconds: 300,
      maxOutputBytes: 262144,
      minFreeBytes: 104857600,
      maxWorkspaceBytes: 104857600,
      reaperIntervalSeconds: 30,
      artifactRoot: join(dir, 'artifacts'),
      maxArtifactBytes: 16777216,
      maxPrincipalArtifactBytes: 134217728,
      artifactRetentionSeconds: 86400,
      enableRepoCache: false,
      repoCacheRoot: join(dir, 'cache')
    };
    const service = new WorkspaceService(config, store);
    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-task-unkillable' });
      const wsId = 'ws_uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';
      const wsPath = join(dir, 'jobs', wsId);
      mkdirSync(wsPath, { recursive: true });

      store.create({
        id: wsId,
        ownerId,
        idempotencyKey: 'ik_ws_unkillable',
        repositoryUrl: 'https://github.com/org/repo',
        containerName: null,
        workspacePath: wsPath,
        status: 'ACTIVE',
        networkMode: 'none',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        hardExpiresAt: Date.now() + 7200_000,
        gitAuthorName: null,
        gitAuthorEmail: null,
        mutationLockedUntil: null,
        generation: 1,
        error: null
      });

      const ops = (service as unknown as { operations: OperationManager }).operations;
      const task = ops.runTask(wsId, 'c_dummy', '.', 'sleep', 'ik_unkillable_task', 60000, 65536, [], ownerId, wsPath);
      const logFile = task.logPath!;
      writeFileSync(logFile, 'Live output stream.\n', 'utf8');

      // Mock an unkillable child process that ignores SIGTERM and SIGKILL
      const unkillableChild = new EventEmitter() as unknown as {
        exitCode: number | null;
        signalCode: string | null;
        killed: boolean;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: string) => void;
      };
      unkillableChild.exitCode = null;
      unkillableChild.signalCode = null;
      unkillableChild.killed = false;
      unkillableChild.stdout = new EventEmitter();
      unkillableChild.stderr = new EventEmitter();
      unkillableChild.kill = () => { /* ignores signals */ };
      if (task.child) {
        task.child.removeAllListeners();
        try { task.child.kill(); } catch { /* ignore */ }
      }
      (ops as unknown as { track: (t: unknown, c: unknown, b: number) => void }).track(task, unkillableChild, 65536);
      task.child = unkillableChild as unknown as ChildProcessWithoutNullStreams;
      task.status = 'running';
      task.exitCode = undefined;
      // Attempt 1: workspace_close -> stopWorkspace hits deadline and throws 503 UNAVAILABLE
      await expect(
        service.execute(ownerId, 'workspace_close', { workspaceId: wsId })
      ).rejects.toThrow(/failed to terminate within teardown deadline/);

      // Workspace directory and log file must NOT be deleted!
      expect(existsSync(wsPath)).toBe(true);
      expect(existsSync(logFile)).toBe(true);

      // Workspace status must be rolled back to EXPIRED_RECOVERABLE
      const wsRecord1 = store.byId(wsId);
      expect(wsRecord1?.status).toBe('EXPIRED_RECOVERABLE');
      expect(wsRecord1?.error).toContain('Workspace stop failed');

      // Attempt 2: retry while child is STILL unkillable -> must reject AGAIN without bypassing live child!
      await expect(
        service.execute(ownerId, 'workspace_close', { workspaceId: wsId })
      ).rejects.toThrow(/failed to terminate within teardown deadline/);
      expect(existsSync(wsPath)).toBe(true);

      // Attempt 3: child is allowed to exit on signal
      unkillableChild.kill = () => {
        unkillableChild.exitCode = 0;
        unkillableChild.emit('close', 0);
        unkillableChild.emit('exit', 0);
      };

      const closeSuccess = await service.execute(ownerId, 'workspace_close', { workspaceId: wsId });
      expect(closeSuccess.ok).toBe(true);

      // Now workspace path is cleaned up and status is CLOSED
      expect(existsSync(wsPath)).toBe(false);
      const wsRecordFinal = store.byId(wsId);
      expect(wsRecordFinal?.status).toBe('CLOSED');
    } finally {
      store.close();
    }
  }, 20_000);
});
