import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { MetadataStore } from '../src/metadata-store.js';
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
    if (args[0] === 'create') {
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
  vi.clearAllMocks();
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* store already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* directory already removed */ }
  }
});

function createTestContext(): {
  service: WorkspaceService;
  store: StateStore;
  metadata: MetadataStore;
  artifacts: ArtifactStore;
  ownerId: string;
  jobsRoot: string;
  wsId: string;
  wsPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-artifacts-test-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  const artifactRoot = join(directory, 'artifacts');
  mkdirSync(jobsRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });

  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
    artifactRoot,
    maxArtifactBytes: 1024 * 1024,
    maxPrincipalArtifactBytes: 16 * 1024 * 1024,
    artifactRetentionSeconds: 86400,
    idleTtlSeconds: 1800,
    wallTtlSeconds: 7200,
    maxExecutionTimeSeconds: 7200,
    executorImage: 'cloud-harness-executor:local',
    reaperIntervalSeconds: 30
  } as RunnerConfig;

  const store = new StateStore(config.stateDb);
  openStores.push(store);
  const metadata = new MetadataStore(config.stateDb);
  const artifacts = new ArtifactStore(store.database, {
    root: artifactRoot,
    maxArtifactBytes: config.maxArtifactBytes,
    maxPrincipalBytes: config.maxPrincipalArtifactBytes,
    defaultRetentionMs: config.artifactRetentionSeconds * 1000,
    maxRetentionMs: 86400 * 1000 * 30
  });
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'artifact-owner' });
  const service = new WorkspaceService(config, store, metadata, undefined, undefined, artifacts);

  const wsId = 'ws_artifacttest1234567890';
  const wsPath = join(jobsRoot, wsId);
  const repoPath = join(wsPath, 'repo');
  mkdirSync(repoPath, { recursive: true });

  const now = Date.now();
  const record: WorkspaceRecord = {
    id: wsId,
    ownerId,
    idempotencyKey: 'idemp-art-1',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'cloud-harness-ws-artifacttest12',
    workspacePath: wsPath,
    status: 'ACTIVE',
    networkMode: 'none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 1800 * 1000,
    hardExpiresAt: now + 7200 * 1000,
    generation: 1
  };
  store.database.prepare(`
    INSERT INTO workspaces (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status, network_mode, created_at, last_activity_at, expires_at, hard_expires_at, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.ownerId, record.idempotencyKey, record.repositoryUrl, record.repositoryRef,
    record.containerName, record.workspacePath, record.status, record.networkMode,
    record.createdAt, record.lastActivityAt, record.expiresAt, record.hardExpiresAt, record.generation
  );

  return { service, store, metadata, artifacts, ownerId, jobsRoot, wsId, wsPath };
}

describe('Artifacts Lifecycle in WorkspaceService', () => {
  it('allows listing, reading, and deleting artifacts without an active workspace', async () => {
    const { service, artifacts, ownerId } = createTestContext();
    const content = Buffer.from('handoff-data-json');
    const created = artifacts.create(ownerId, {
      logicalName: 'handoff.json',
      content
    });

    // List without active workspace
    const listRes = await service.execute(ownerId, 'artifacts_list', {});
    expect(listRes.ok).toBe(true);
    const artifactsList = (listRes.data as { artifacts: { artifactId: string; logicalName: string }[] }).artifacts;
    expect(artifactsList.some((a) => a.artifactId === created.artifactId)).toBe(true);

    // Read without active workspace
    const readRes = await service.execute(ownerId, 'artifacts_read', { artifactId: created.artifactId });
    expect(readRes.ok).toBe(true);
    const readData = readRes.data as { artifactId: string; logicalName: string; totalBytes: number; bytesReturned: number; sha256: string; eof: boolean; content: string };
    expect(readData.artifactId).toBe(created.artifactId);
    expect(readData.logicalName).toBe('handoff.json');
    expect(readData.totalBytes).toBe(content.length);
    expect(readData.bytesReturned).toBe(content.length);
    expect(readData.eof).toBe(true);
    expect(Buffer.from(readData.content, 'base64')).toEqual(content);

    // Delete without active workspace
    const delRes = await service.execute(ownerId, 'artifacts_delete', { artifactId: created.artifactId });
    expect(delRes.ok).toBe(true);

    // Subsequent read fails with NOT_FOUND
    await expect(service.execute(ownerId, 'artifacts_read', { artifactId: created.artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    });
  });

  it('snapshots a workspace file and restores it into an active workspace', async () => {
    const { service, ownerId, wsId, wsPath } = createTestContext();
    const sampleText = 'data for snapshot and restore test 456';
    writeFileSync(join(wsPath, 'repo', 'analysis.json'), sampleText);

    // Snapshot
    const snapRes = await service.execute(ownerId, 'artifacts_snapshot', {
      workspaceId: wsId,
      path: 'analysis.json',
      logicalName: 'analysis.json'
    });
    expect(snapRes.ok).toBe(true);
    const snapData = snapRes.data as { artifactId: string; logicalName: string; sha256: string; sizeBytes: number };
    expect(snapData.logicalName).toBe('analysis.json');
    expect(snapData.sizeBytes).toBe(Buffer.byteLength(sampleText));
    expect(snapData.sha256).toBe(createHash('sha256').update(sampleText).digest('hex'));

    // Mock worker success on restore
    docker.workerResult = {
      ok: true,
      message: 'Artifact restored to workspace',
      data: { path: 'context/analysis.json', sizeBytes: Buffer.byteLength(sampleText), sha256: snapData.sha256 },
      truncated: false
    };

    // Restore into workspace
    const restoreRes = await service.execute(ownerId, 'artifacts_restore', {
      workspaceId: wsId,
      artifactId: snapData.artifactId,
      path: 'context/analysis.json',
      overwrite: true,
      expectedSha256: snapData.sha256
    });
    expect(restoreRes.ok).toBe(true);
    expect(restoreRes.data).toMatchObject({
      artifactId: snapData.artifactId,
      workspaceId: wsId,
      path: 'context/analysis.json',
      sizeBytes: snapData.sizeBytes,
      sha256: snapData.sha256
    });

    // Check worker invocation args
    const runWorkerCalls = docker.runDocker.mock.calls.filter((c) => c[0].includes('/opt/harness/worker-runner.sh'));
    expect(runWorkerCalls.length).toBeGreaterThan(0);
    const lastCallStdin = runWorkerCalls.at(-1)![1]?.stdin as string;
    expect(lastCallStdin).toContain('artifacts_restore');
    expect(lastCallStdin).toContain('contentBase64');
  });

  it('rejects artifact restore when expectedSha256 does not match', async () => {
    const { service, artifacts, ownerId, wsId } = createTestContext();
    const created = artifacts.create(ownerId, {
      logicalName: 'hash-check.txt',
      content: Buffer.from('real-content')
    });

    await expect(service.execute(ownerId, 'artifacts_restore', {
      workspaceId: wsId,
      artifactId: created.artifactId,
      path: 'out.txt',
      expectedSha256: 'a'.repeat(64)
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409
    });
  });

  it('rejects cross-principal artifact access with NOT_FOUND', async () => {
    const { service, artifacts, ownerId, wsId } = createTestContext();
    const otherPrincipal = 'other-principal-id';
    const created = artifacts.create(otherPrincipal, {
      logicalName: 'private.txt',
      content: Buffer.from('private')
    });

    await expect(service.execute(ownerId, 'artifacts_read', {
      artifactId: created.artifactId
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    });

    await expect(service.execute(ownerId, 'artifacts_restore', {
      workspaceId: wsId,
      artifactId: created.artifactId,
      path: 'out.txt'
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    });
  });
});
