import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore, downgradeStateSchemaToV3 } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v4-${randomBytes(8).toString('hex')}.sqlite`);

describe('StateStore Schema Version 4 Migration & Durable Primitives', () => {
  it('migrates fresh database to schema version 5', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const version = (store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
      expect(version).toBe(5);
    } finally {
      store.close();
    }
  });

  it('manages repo_caches CRUD and constraints', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const p = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-1' });
      const record = {
        id: 'rc_1',
        ownerId: p,
        repositoryUrl: 'https://github.com/org/repo',
        repositoryUrlHash: 'hash123',
        cachePath: '/cache/repo.git',
        defaultBranch: 'main',
        lastFetchedAt: Date.now(),
        sizeBytes: 1024,
        status: 'READY' as const,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      const created = store.upsertRepoCache(record);
      expect(created.generation).toBe(1);

      const fetched = store.getRepoCache(p, 'hash123');
      expect(fetched).toBeDefined();
      expect(fetched?.repositoryUrl).toBe('https://github.com/org/repo');

      // Upsert update
      const updated = store.upsertRepoCache({ ...record, sizeBytes: 2048, updatedAt: Date.now() + 10 });
      expect(updated.generation).toBe(2);
      expect(store.getRepoCache(p, 'hash123')?.sizeBytes).toBe(2048);

      const stale = store.listStaleRepoCaches(Date.now() + 1000);
      expect(stale.length).toBe(1);

      expect(store.deleteRepoCache('rc_1')).toBe(true);
      expect(store.getRepoCache(p, 'hash123')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('manages durable_tasks and task_dependencies with foreign key cascade', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const p = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-2' });
      store.create({
        id: 'ws_1',
        ownerId: p,
        idempotencyKey: 'ik_ws',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: '/job/ws_1',
        status: 'ACTIVE',
        networkProfile: 'network-none',
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

      const task1 = store.createDurableTask({
        id: 'task_1',
        workspaceId: 'ws_1',
        ownerId: p,
        name: 'build',
        command: 'npm run build',
        cwd: '.',
        status: 'QUEUED',
        idempotencyKey: 'ik_t1',
        requestFingerprint: 'fp_1',
        bootId: 'boot_a',
        exitCode: null,
        errorCode: null,
        errorMessage: null,
        timeoutMs: 60_000,
        maxBytes: 65536,
        logPath: '/job/ws_1/.chm/tasks/task_1.log',
        outputBytes: 0,
        outputArtifactId: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null
      });
      expect(task1.generation).toBe(1);

      const task2 = store.createDurableTask({
        id: 'task_2',
        workspaceId: 'ws_1',
        ownerId: p,
        name: 'test',
        command: 'npm test',
        cwd: '.',
        status: 'QUEUED',
        idempotencyKey: 'ik_t2',
        requestFingerprint: 'fp_2',
        bootId: 'boot_a',
        exitCode: null,
        errorCode: null,
        errorMessage: null,
        timeoutMs: 60_000,
        maxBytes: 65536,
        logPath: '/job/ws_1/.chm/tasks/task_2.log',
        outputBytes: 0,
        outputArtifactId: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null
      }, ['task_1']);

      expect(task2.dependsOn).toEqual(['task_1']);
      expect(store.getDurableTask(p, 'ws_1', 'task_2')?.dependsOn).toEqual(['task_1']);
      expect(store.getDurableTaskByIdempotencyKey(p, 'ws_1', 'ik_t1')?.id).toBe('task_1');

      // Update status with generation fencing
      const ok = store.updateDurableTaskStatus('task_1', 1, {
        status: 'RUNNING',
        startedAt: Date.now()
      });
      expect(ok).toBe(true);
      expect(store.getDurableTask(p, 'ws_1', 'task_1')?.status).toBe('RUNNING');

      // Reconcile across boot IDs
      const reconciledCount = store.reconcileRunningTasks('boot_b', Date.now());
      expect(reconciledCount).toBe(2); // task_1 (RUNNING) and task_2 (QUEUED)

      const reconciledTask1 = store.getDurableTask(p, 'ws_1', 'task_1');
      expect(reconciledTask1?.status).toBe('FAILED');
      expect(reconciledTask1?.errorCode).toBe('RUNNER_RESTARTED');

      // Mismatched owner/workspace insertion must be rejected by foreign key constraint
      const otherPrincipal = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'other-user' });
      expect(() => {
        store.createDurableTask({
          id: 'task_bad_owner',
          workspaceId: 'ws_1',
          ownerId: otherPrincipal,
          name: 'bad',
          command: 'ls',
          cwd: '.',
          status: 'QUEUED',
          idempotencyKey: 'ik_bad',
          requestFingerprint: 'fp_bad',
          bootId: 'boot_a',
          exitCode: null,
          errorCode: null,
          errorMessage: null,
          timeoutMs: 60_000,
          maxBytes: 65536,
          logPath: '/job/ws_1/.chm/tasks/task_bad.log',
          outputBytes: 0,
          outputArtifactId: null,
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null
        });
      }).toThrow(/FOREIGN KEY constraint failed/);

      expect(() => {
        store.recordGitOperationPending({
          ownerId: otherPrincipal,
          workspaceId: 'ws_1',
          idempotencyKey: 'ik_git_bad',
          operation: 'push',
          requestFingerprint: 'fp_bad',
          targetRef: 'refs/heads/main',
          expectedRemoteOid: null,
          localCommitSha: null,
          createdAt: Date.now()
        });
      }).toThrow(/FOREIGN KEY constraint failed/);
      // Cascading workspace delete
      store.database.prepare('DELETE FROM workspaces WHERE id = ?').run('ws_1');
      expect(store.getDurableTask(p, 'ws_1', 'task_1')).toBeUndefined();
      expect(store.getDurableTask(p, 'ws_1', 'task_2')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('manages git_operation_idempotency ledger', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const p = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-3' });
      store.create({
        id: 'ws_test',
        ownerId: p,
        idempotencyKey: 'ik_ws_test',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: '/job/ws_test',
        status: 'ACTIVE',
        networkProfile: 'network-none',
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
      const op = store.recordGitOperationPending({
        ownerId: p,
        workspaceId: 'ws_test',
        idempotencyKey: 'ik_push_1',
        operation: 'push',
        requestFingerprint: 'fp_sha1',
        targetRef: 'refs/heads/main',
        expectedRemoteOid: 'oid1',
        localCommitSha: 'sha1',
        createdAt: Date.now()
      });
      expect(op.status).toBe('PENDING');

      const fetched = store.getGitOperation(p, 'ws_test', 'ik_push_1');
      expect(fetched?.status).toBe('PENDING');
      expect(fetched?.requestFingerprint).toBe('fp_sha1');

      // Update to SUCCEEDED
      const ok = store.updateGitOperationStatus(p, 'ws_test', 'ik_push_1', 'SUCCEEDED', JSON.stringify({ ok: true }), null, 'sha1');
      expect(ok).toBe(true);

      const succeeded = store.getGitOperation(p, 'ws_test', 'ik_push_1');
      expect(succeeded?.status).toBe('SUCCEEDED');
      expect(succeeded?.resultJson).toBe('{"ok":true}');
    } finally {
      store.close();
    }
  });

  it('rejects downgradeStateSchemaToV3 once the store is at schema v5', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(5);
      expect(() => downgradeStateSchemaToV3(store.database)).toThrow(/state schema must be version 4 before downgrade/);
    } finally {
      store.close();
    }
  });
});
