import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { HarnessError } from '@cloud-harness/contracts';

const tempDir = () => {
  const dir = join(tmpdir(), `test-git-durability-${randomBytes(8).toString('hex')}`);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  return dir;
};

describe('Remote-Git Idempotency & Error Taxonomy', () => {
  it('validates expectedHeadOid and rejects stale commits', async () => {
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
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-git-1' });
      mkdirSync(join(dir, 'jobs', 'ws_111111111111111111111111'), { recursive: true });
      store.create({
        id: 'ws_111111111111111111111111',
        ownerId,
        idempotencyKey: 'ik_ws_git_1',
        repositoryUrl: 'https://github.com/org/repo',
        containerName: null,
        workspacePath: join(dir, 'jobs', 'ws_111111111111111111111111'),
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
      vi.spyOn(service as unknown as { workspaceBytes: () => Promise<number> }, 'workspaceBytes').mockResolvedValue(1024);

      let mockHead = '1111111111111111111111111111111111111111';
      vi.spyOn(service as unknown as { currentHead: () => Promise<string> }, 'currentHead').mockImplementation(async () => mockHead);
      const workerSpy = vi.spyOn(service as unknown as { runWorker: () => Promise<unknown> }, 'runWorker').mockImplementation(async () => {
        mockHead = '2222222222222222222222222222222222222222';
        return {
          ok: true,
          message: 'Commit created',
          data: { commitSha: '2222222222222222222222222222222222222222' }
        };
      });

      // 1. Expected head matches -> succeeds, HEAD advances to 2222...
      const res1 = await service.execute(ownerId, 'git_commit', {
        workspaceId: 'ws_111111111111111111111111',
        message: 'feat: add thing',
        expectedHeadOid: '1111111111111111111111111111111111111111',
        idempotencyKey: 'ik_commit_1'
      });
      expect(res1.ok).toBe(true);
      expect(workerSpy).toHaveBeenCalledTimes(1);

      // 2. Expected head mismatch for a new commit -> throws STALE_HEAD (409)
      await expect(
        service.execute(ownerId, 'git_commit', {
          workspaceId: 'ws_111111111111111111111111',
          message: 'feat: add another',
          expectedHeadOid: '9999999999999999999999999999999999999999'
        })
      ).rejects.toThrow(/STALE_HEAD|expected/);

      // 3. Retry with same idempotencyKey AFTER HEAD advanced -> returns cached commit result without running worker again!
      const replay = await service.execute(ownerId, 'git_commit', {
        workspaceId: 'ws_111111111111111111111111',
        message: 'feat: add thing',
        expectedHeadOid: '1111111111111111111111111111111111111111',
        idempotencyKey: 'ik_commit_1'
      });
      expect(replay.ok).toBe(true);
      expect((replay.data as Record<string, unknown>).alreadyFinalized).toBe(true);
      expect((replay.data as Record<string, unknown>).commitSha).toBe('2222222222222222222222222222222222222222');
      expect(workerSpy).toHaveBeenCalledTimes(1); // Worker was NOT called a second time!
      // 4. Retry with same key but different message -> throws CONFLICT (409)
      await expect(
        service.execute(ownerId, 'git_commit', {
          workspaceId: 'ws_111111111111111111111111',
          message: 'different message',
          idempotencyKey: 'ik_commit_1'
        })
      ).rejects.toThrow(/Idempotency key reused with different commit parameters/);
    } finally {
      store.close();
    }
  }, 15_000);

  it('records git_push idempotency and returns cached response on retry', async () => {
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
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-git-2' });
      mkdirSync(join(dir, 'jobs', 'ws_222222222222222222222222'), { recursive: true });
      store.create({
        id: 'ws_222222222222222222222222',
        ownerId,
        idempotencyKey: 'ik_ws_git_2',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: join(dir, 'jobs', 'ws_222222222222222222222222'),
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

      vi.spyOn(service as unknown as { workspaceBytes: () => Promise<number> }, 'workspaceBytes').mockResolvedValue(1024);
      vi.spyOn(service as unknown as { repositoryToken: () => Promise<string> }, 'repositoryToken').mockResolvedValue('token123');
      vi.spyOn(service as unknown as { currentBranch: () => Promise<string> }, 'currentBranch').mockResolvedValue('main');
      let pushHead = 'aaaabbbbccccddddeeeeffff1111222233334444';
      vi.spyOn(service as unknown as { currentHead: () => Promise<string> }, 'currentHead').mockImplementation(async () => pushHead);
      const pushTransferSpy = vi.spyOn(service as unknown as { runGitTransferHelper: () => Promise<unknown> }, 'runGitTransferHelper').mockResolvedValue({
        exitCode: 0,
        stdout: 'To https://github.com/org/repo\n   1111..aaaa  main -> main',
        stderr: '',
        truncated: false
      });

      // 1. Initial push with idempotencyKey
      const res = await service.execute(ownerId, 'git_push', {
        workspaceId: 'ws_222222222222222222222222',
        refspec: 'refs/heads/main:refs/heads/main',
        idempotencyKey: 'ik_push_success'
      });
      expect(res.ok).toBe(true);
      expect(pushTransferSpy).toHaveBeenCalledTimes(2); // stage-push + push

      // Advance local HEAD commit (user committed again locally)
      pushHead = 'bbbbccccddddeeeeffff11112222333344445555';

      // 2. Replay push AFTER local HEAD moved -> returns cached result without running transfer again!
      const replay = await service.execute(ownerId, 'git_push', {
        workspaceId: 'ws_222222222222222222222222',
        refspec: 'refs/heads/main:refs/heads/main',
        idempotencyKey: 'ik_push_success'
      });
      expect(replay.ok).toBe(true);
      expect((replay.data as Record<string, unknown>).alreadyFinalized).toBe(true);
      expect(pushTransferSpy).toHaveBeenCalledTimes(2); // No second transfer!
      // 3. Replay with different refspec -> throws CONFLICT
      await expect(
        service.execute(ownerId, 'git_push', {
          workspaceId: 'ws_222222222222222222222222',
          refspec: 'refs/heads/feature:refs/heads/feature',
          idempotencyKey: 'ik_push_success'
        })
      ).rejects.toThrow(/Idempotency key reused with different push parameters/);
    } finally {
      store.close();
    }
  }, 15_000);

  it('classifies network failures as UNKNOWN_REMOTE_STATE with resumeAction', async () => {
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
      const ownerId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.com', subject: 'user-git-3' });
      mkdirSync(join(dir, 'jobs', 'ws_333333333333333333333333'), { recursive: true });
      store.create({
        id: 'ws_333333333333333333333333',
        ownerId,
        idempotencyKey: 'ik_ws_git_3',
        repositoryUrl: 'https://github.com/org/repo',
        repositoryRef: null,
        containerName: null,
        workspacePath: join(dir, 'jobs', 'ws_333333333333333333333333'),
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

      vi.spyOn(service as unknown as { workspaceBytes: () => Promise<number> }, 'workspaceBytes').mockResolvedValue(1024);
      vi.spyOn(service as unknown as { repositoryToken: () => Promise<string> }, 'repositoryToken').mockResolvedValue('token123');
      vi.spyOn(service as unknown as { currentBranch: () => Promise<string> }, 'currentBranch').mockResolvedValue('main');
      vi.spyOn(service as unknown as { currentHead: () => Promise<string> }, 'currentHead').mockResolvedValue('aaaabbbbccccddddeeeeffff1111222233334444');

      // Simulate push timeout (runDocker throwing TIMEOUT)
      vi.spyOn(service as unknown as { runGitTransferHelper: (_rec: unknown, mode: string) => Promise<unknown> }, 'runGitTransferHelper').mockImplementation(async (_rec, mode) => {
        if (mode === 'push') {
          throw new HarnessError('TIMEOUT', 'Docker command timed out after 120000ms', 504, true);
        }
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      });

      await expect(
        service.execute(ownerId, 'git_push', {
          workspaceId: 'ws_333333333333333333333333',
          refspec: 'refs/heads/main:refs/heads/main',
          idempotencyKey: 'ik_push_timeout'
        })
      ).rejects.toThrow(/UNKNOWN_REMOTE_STATE|timed out/);

      const op = store.getGitOperation(ownerId, 'ws_333333333333333333333333', 'ik_push_timeout');
      expect(op?.status).toBe('UNKNOWN_REMOTE_STATE');
      // Retry when remote OID matches the local commit SHA -> reconciles as SUCCEEDED without re-pushing
      vi.spyOn(service as unknown as { probeRemoteRefOid: () => Promise<string> }, 'probeRemoteRefOid').mockResolvedValue('aaaabbbbccccddddeeeeffff1111222233334444');
      const retryRes = await service.execute(ownerId, 'git_push', {
        workspaceId: 'ws_333333333333333333333333',
        refspec: 'refs/heads/main:refs/heads/main',
        idempotencyKey: 'ik_push_timeout'
      });
      expect(retryRes.ok).toBe(true);
      expect((retryRes.data as Record<string, unknown>).alreadyFinalized).toBe(true);
      expect(store.getGitOperation(ownerId, 'ws_333333333333333333333333', 'ik_push_timeout')?.status).toBe('SUCCEEDED');

      // Reject concurrent PENDING operations
      store.recordGitOperationPending({
        ownerId,
        workspaceId: 'ws_333333333333333333333333',
        idempotencyKey: 'ik_in_flight',
        operation: 'push',
        requestFingerprint: 'fp_in_flight',
        targetRef: 'refs/heads/main:refs/heads/main',
        expectedRemoteOid: null,
        localCommitSha: 'aaaabbbbccccddddeeeeffff1111222233334444',
        createdAt: Date.now()
      });
      await expect(
        service.execute(ownerId, 'git_push', {
          workspaceId: 'ws_333333333333333333333333',
          refspec: 'refs/heads/main:refs/heads/main',
          idempotencyKey: 'ik_in_flight'
        })
      ).rejects.toThrow(/already in progress|parameters/);
    } finally {
      store.close();
    }
  }, 15_000);
});
