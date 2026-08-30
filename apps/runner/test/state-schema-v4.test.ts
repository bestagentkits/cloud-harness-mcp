import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore, downgradeStateSchemaToV3, downgradeStateSchemaToV4 } from '../src/state-store.js';
import { migratePrincipalSchema, applyLegacyPrincipalMapping } from '../src/principal-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v4-${randomBytes(8).toString('hex')}.sqlite`);
describe('StateStore Schema Version 4 Migration & Durable Primitives', () => {
  it('migrates fresh database to schema version 7', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const version = (store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
      expect(version).toBe(7);
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

  it('downgrades a v7 store to v3 for legacy simulation', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(7);
      downgradeStateSchemaToV4(store.database, true);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(4);
      downgradeStateSchemaToV3(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(3);
    } finally {
      store.close();
    }
  });

  it('migrates legacy finalize_idempotency rows to v4 and replays without fingerprint conflict', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      // Downgrade to v3 to simulate a legacy database
      downgradeStateSchemaToV4(store.database);
      downgradeStateSchemaToV3(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(3);

      const p = store.resolvePrincipal({ kind: 'owner', ownerId: 'legacy-user' });
      const wsId = 'ws_legacy_finalize';
      store.database.prepare(`
        INSERT INTO workspaces (
          id, owner_id, idempotency_key, repository_url, workspace_path,
          status, network_mode, created_at, last_activity_at, expires_at, hard_expires_at, generation
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 'none', ?, ?, ?, ?, 1)
      `).run(
        wsId, p, 'ik_ws_legacy', 'https://github.com/org/repo', '/tmp/ws_legacy',
        Date.now() - 100_000, Date.now() - 100_000, Date.now() + 3600_000, Date.now() + 7200_000
      );

      // Seed legacy finalize_idempotency row
      const legacyResult = JSON.stringify({ ok: true, message: 'Legacy finalized', commitSha: '1111222233334444555566667777888899990000' });
      store.database.prepare(
        'INSERT INTO finalize_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(p, wsId, 'ik_legacy_fin_1', legacyResult, Date.now() - 50_000);

      // Upgrade to v4
      migratePrincipalSchema(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(7);
      // Verify row was migrated into git_operation_idempotency
      const migratedRow = store.getGitOperation(p, wsId, 'ik_legacy_fin_1');
      expect(migratedRow).toBeDefined();
      expect(migratedRow?.status).toBe('SUCCEEDED');
      expect(migratedRow?.operation).toBe('finalize');
      expect(migratedRow?.resultJson).toBe(legacyResult);
      expect(migratedRow?.requestFingerprint).toBe('');

      // Simulate workspace_finalize retry with computed SHA-256 fingerprint #1
      const claim1 = store.acquireGitOperation({
        ownerId: p,
        workspaceId: wsId,
        idempotencyKey: 'ik_legacy_fin_1',
        operation: 'finalize',
        requestFingerprint: 'sha256_fingerprint_1',
        createdAt: Date.now()
      });
      expect(claim1.action).toBe('REPLAY_SUCCEEDED');
      expect(claim1.existing?.resultJson).toBe(legacyResult);

      // Verify sentinel is NOT rewritten, keeping permanent wildcard replay
      const checkRow = store.getGitOperation(p, wsId, 'ik_legacy_fin_1');
      expect(checkRow?.requestFingerprint).toBe('');

      // Subsequent retry with a different fingerprint also succeeds (wildcard replay for legacy row)
      const claim2 = store.acquireGitOperation({
        ownerId: p,
        workspaceId: wsId,
        idempotencyKey: 'ik_legacy_fin_1',
        operation: 'finalize',
        requestFingerprint: 'sha256_fingerprint_2_different',
        createdAt: Date.now()
      });
      expect(claim2.action).toBe('REPLAY_SUCCEEDED');
      expect(claim2.existing?.resultJson).toBe(legacyResult);

      // Cross-operation rejection: git_push reusing legacy finalize key MUST be rejected with FINGERPRINT_CONFLICT
      const pushClaim = store.acquireGitOperation({
        ownerId: p,
        workspaceId: wsId,
        idempotencyKey: 'ik_legacy_fin_1',
        operation: 'push',
        requestFingerprint: 'sha256_fingerprint_1',
        createdAt: Date.now()
      });
      expect(pushClaim.action).toBe('FINGERPRINT_CONFLICT');

      // Cross-operation rejection: git_commit reusing legacy finalize key MUST be rejected with FINGERPRINT_CONFLICT
      const commitClaim = store.acquireGitOperation({
        ownerId: p,
        workspaceId: wsId,
        idempotencyKey: 'ik_legacy_fin_1',
        operation: 'commit',
        requestFingerprint: 'sha256_fingerprint_1',
        createdAt: Date.now()
      });
      expect(commitClaim.action).toBe('FINGERPRINT_CONFLICT');

      // Test lazy fallback for unmigrated finalize row
      store.database.prepare(
        'INSERT INTO finalize_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(p, wsId, 'ik_lazy_fin_2', legacyResult, Date.now() - 20_000);

      const lazyFinalizeClaim = store.acquireGitOperation({
        ownerId: p,
        workspaceId: wsId,
        idempotencyKey: 'ik_lazy_fin_2',
        operation: 'finalize',
        requestFingerprint: 'sha256_lazy_fp',
        createdAt: Date.now()
      });
      expect(lazyFinalizeClaim.action).toBe('REPLAY_SUCCEEDED');
      expect(lazyFinalizeClaim.existing?.resultJson).toBe(legacyResult);

      // Lazy fallback MUST NOT replay for push or commit
      store.database.prepare(
        'INSERT INTO finalize_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(p, wsId, 'ik_lazy_fin_3', legacyResult, Date.now() - 10_000);

      const lazyPushClaim = store.acquireGitOperation({
        ownerId: p,
        workspaceId: wsId,
        idempotencyKey: 'ik_lazy_fin_3',
        operation: 'push',
        requestFingerprint: 'sha256_lazy_push_fp',
        createdAt: Date.now()
      });
      expect(lazyPushClaim.action).toBe('ACQUIRED');
    } finally {
      store.close();
    }
  });

  it('successfully upgrades unmapped legacy owner databases to v4 and migrates finalize idempotency on principal relink', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      // Downgrade to v3 to simulate a legacy database
      downgradeStateSchemaToV4(store.database);
      downgradeStateSchemaToV3(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(3);

      // Seed an unmapped legacy workspace with NO principal record
      const legacyOwnerId = 'owner-raw-legacy-123';
      const wsId = 'ws_unmapped_legacy';
      store.database.prepare(`
        INSERT INTO workspaces (
          id, owner_id, idempotency_key, repository_url, workspace_path,
          status, network_mode, created_at, last_activity_at, expires_at, hard_expires_at, generation
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 'none', ?, ?, ?, ?, 1)
      `).run(
        wsId, legacyOwnerId, 'ik_ws_unmapped', 'https://github.com/org/repo', '/tmp/ws_unmapped',
        Date.now() - 100_000, Date.now() - 100_000, Date.now() + 3600_000, Date.now() + 7200_000
      );

      // Seed legacy finalize_idempotency row for the unmapped legacy owner
      const legacyResult = JSON.stringify({ ok: true, message: 'Unmapped finalize', commitSha: 'abcdef1234567890abcdef1234567890abcdef12' });
      store.database.prepare(
        'INSERT INTO finalize_idempotency(owner_id, workspace_id, idempotency_key, result_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(legacyOwnerId, wsId, 'ik_unmapped_fin', legacyResult, Date.now() - 50_000);

      // Upgrade to schema version 4: MUST NOT throw foreign key constraint error!
      migratePrincipalSchema(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(7);
      // Prior to principal mapping, git_operation_idempotency should NOT have the row (since FK to principals is enforced)
      const unmappedGitOp = store.database.prepare(
        'SELECT * FROM git_operation_idempotency WHERE workspace_id = ? AND idempotency_key = ?'
      ).get(wsId, 'ik_unmapped_fin');
      expect(unmappedGitOp).toBeUndefined();

      // Unmapped finalize row remains preserved in finalize_idempotency
      const preservedRow = store.database.prepare(
        'SELECT * FROM finalize_idempotency WHERE owner_id = ? AND workspace_id = ? AND idempotency_key = ?'
      ).get(legacyOwnerId, wsId, 'ik_unmapped_fin') as { result_json: string } | undefined;
      expect(preservedRow?.result_json).toBe(legacyResult);

      // Apply legacy principal mapping for this owner
      const mappedPrincipalId = applyLegacyPrincipalMapping(store.database, {
        legacyOwnerId,
        issuer: 'https://access.example.com',
        subject: 'user-legacy-mapped'
      });
      expect(mappedPrincipalId).toMatch(/^prn_/);

      // Workspace and finalize row must now be updated to the mapped principal ID
      const mappedWs = store.byId(wsId);
      expect(mappedWs?.ownerId).toBe(mappedPrincipalId);

      // git_operation_idempotency must now have the materialized row under mappedPrincipalId
      const mappedGitOp = store.getGitOperation(mappedPrincipalId, wsId, 'ik_unmapped_fin');
      expect(mappedGitOp).toBeDefined();
      expect(mappedGitOp?.status).toBe('SUCCEEDED');
      expect(mappedGitOp?.operation).toBe('finalize');
      expect(mappedGitOp?.resultJson).toBe(legacyResult);
      expect(mappedGitOp?.requestFingerprint).toBe('');

      // Permanent wildcard replay: acquireGitOperation returns REPLAY_SUCCEEDED regardless of fingerprint
      const replay1 = store.acquireGitOperation({
        ownerId: mappedPrincipalId,
        workspaceId: wsId,
        idempotencyKey: 'ik_unmapped_fin',
        operation: 'finalize',
        requestFingerprint: 'sha256_attempt_1',
        createdAt: Date.now()
      });
      expect(replay1.action).toBe('REPLAY_SUCCEEDED');
      expect(replay1.existing?.resultJson).toBe(legacyResult);

      const replay2 = store.acquireGitOperation({
        ownerId: mappedPrincipalId,
        workspaceId: wsId,
        idempotencyKey: 'ik_unmapped_fin',
        operation: 'finalize',
        requestFingerprint: 'sha256_attempt_2_different',
        createdAt: Date.now()
      });
      expect(replay2.action).toBe('REPLAY_SUCCEEDED');
      expect(replay2.existing?.resultJson).toBe(legacyResult);

      // Cross-operation conflict: push or commit with the same key is rejected
      const pushConflict = store.acquireGitOperation({
        ownerId: mappedPrincipalId,
        workspaceId: wsId,
        idempotencyKey: 'ik_unmapped_fin',
        operation: 'push',
        requestFingerprint: 'sha256_attempt_1',
        createdAt: Date.now()
      });
      expect(pushConflict.action).toBe('FINGERPRINT_CONFLICT');
    } finally {
      store.close();
    }
  });
});
