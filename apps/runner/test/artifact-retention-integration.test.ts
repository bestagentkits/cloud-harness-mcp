import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const tempDir = () => {
  const dir = join(tmpdir(), `test-artifact-int-${randomBytes(8).toString('hex')}`);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  return dir;
};

describe('Artifact Retention Integration & Unified GC', () => {
  it('spools completed task log to ArtifactStore before workspace deletion on close', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.sqlite');
    const store = new StateStore(dbPath);
    const artifactRoot = join(dir, 'artifacts');
    const artifacts = new ArtifactStore(store.database, {
      root: artifactRoot,
      maxArtifactBytes: 16777216,
      maxPrincipalBytes: 134217728,
      defaultRetentionMs: 86400000,
      maxRetentionMs: 2592000000
    });

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
      artifactRoot,
      maxArtifactBytes: 16777216,
      maxPrincipalArtifactBytes: 134217728,
      artifactRetentionSeconds: 86400,
      enableRepoCache: false,
      repoCacheRoot: join(dir, 'cache')
    };

    const service = new WorkspaceService(config, store, undefined, undefined, undefined, artifacts);

    try {
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-art-1' });
      const wsId = 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const wsPath = join(dir, 'jobs', wsId);
      mkdirSync(wsPath, { recursive: true });

      store.create({
        id: wsId,
        ownerId,
        idempotencyKey: 'ik_ws_art',
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

      // Create a task with log file
      const taskId = 'task_spool_1';
      const logDir = join(wsPath, '.chm', 'tasks');
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${taskId}.log`);
      const logContent = 'Completed test output stream for retention verification.\n';
      writeFileSync(logFile, logContent, 'utf8');

      store.createDurableTask({
        id: taskId,
        workspaceId: wsId,
        ownerId,
        name: 'test-job',
        command: 'npm test',
        cwd: '.',
        status: 'SUCCEEDED',
        idempotencyKey: 'ik_task_spool',
        requestFingerprint: 'fp_spool',
        bootId: 'boot_spool',
        exitCode: 0,
        errorCode: null,
        errorMessage: null,
        timeoutMs: 60000,
        maxBytes: 65536,
        logPath: logFile,
        outputBytes: Buffer.byteLength(logContent),
        outputArtifactId: null,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: Date.now()
      });

      // Close the workspace
      const closeRes = await service.execute(ownerId, 'workspace_close', { workspaceId: wsId });
      expect(closeRes.ok).toBe(true);

      // Workspace directory should be removed
      expect(existsSync(wsPath)).toBe(false);

      // Task in SQLite should now have outputArtifactId linked
      const task = store.getDurableTask(ownerId, wsId, taskId);
      expect(task?.outputArtifactId).toBeDefined();
      expect(task?.outputArtifactId).toMatch(/^art_/);

      // Artifact should be readable from ArtifactStore
      const payload = artifacts.readPayload(ownerId, task!.outputArtifactId!);
      expect(payload.content.toString('utf8')).toBe(logContent);
    } finally {
      store.close();
    }
  });
});
