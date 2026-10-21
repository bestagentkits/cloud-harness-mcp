import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const MANIFEST_SHA = 'd'.repeat(64);

type WorkerExec = { operation: string; input: Record<string, unknown>; timeoutMs: number | undefined };

const docker = vi.hoisted(() => ({
  workerExecs: [] as Array<{ operation: string; input: Record<string, unknown>; timeoutMs: number | undefined }>,
  runDocker: vi.fn(async (args: string[], options: { stdin?: string; timeoutMs?: number } = {}) => {
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('/opt/harness/worker-runner.sh')) {
      const request = JSON.parse(options.stdin ?? '{}') as { operation: string; input: Record<string, unknown> };
      docker.workerExecs.push({ operation: request.operation, input: request.input, timeoutMs: options.timeoutMs });
      const data = request.operation === 'hooks_list'
        ? { manifestSha256: 'd'.repeat(64), hooks: [{ name: 'slow-check', failurePolicy: 'warn' }] }
        : { output: '', exitCode: 0 };
      return { stdout: JSON.stringify({ ok: true, message: 'worker complete', data, truncated: false }), stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));

vi.mock('../src/docker-engine.js', () => docker);
import { WorkspaceService } from '../src/workspace-service.js';

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  docker.workerExecs.splice(0);
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-hook-timeout-'));
  directories.push(directory);
  mkdirSync(join(directory, 'jobs'), { recursive: true });
  const config = {
    jobsRoot: join(directory, 'jobs'),
    stateDb: join(directory, 'state.db'),
    executorImage: 'cloud-harness-executor:test',
    idleTtlSeconds: 3600,
    wallTtlSeconds: 14400,
    maxOutputBytes: 262_144,
    maxWorkspaceBytes: 104_857_600,
    minFreeBytes: 1_048_576
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  stores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'hook-owner' });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'h'.repeat(24)}`,
    ownerId,
    idempotencyKey: 'hook-key-1234',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'chm-hook-container',
    workspacePath: join(directory, 'ws'),
    status: 'ACTIVE',
    networkProfile: 'network-none',
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 3_600_000,
    hardExpiresAt: now + 14_400_000,
    gitAuthorName: null,
    gitAuthorEmail: null,
    generation: 1,
    error: null
  };
  store.create(record);
  return { service: new WorkspaceService(config, store), store, ownerId, record };
}

const hookRuns = (): WorkerExec[] => docker.workerExecs.filter((exec) => exec.operation === 'hooks_run');

describe('hook run timeout resolution', () => {
  it('leaves timeoutMs unset so the manifest value applies, and allows the executor the maximum hook bound', async () => {
    const { service, ownerId, record } = setup();

    const result = await service.execute(ownerId, 'hooks_run', { workspaceId: record.id, name: 'slow-check', expectedManifestSha256: MANIFEST_SHA });

    expect(result.ok).toBe(true);
    expect(hookRuns()).toHaveLength(1);
    expect(hookRuns()[0]!.input).not.toHaveProperty('timeoutMs');
    expect(hookRuns()[0]!.timeoutMs).toBe(305_000);
  });

  it('forwards an explicit caller timeoutMs and bounds the executor call by it', async () => {
    const { service, ownerId, record } = setup();

    await service.execute(ownerId, 'hooks_run', { workspaceId: record.id, name: 'slow-check', expectedManifestSha256: MANIFEST_SHA, timeoutMs: 1_000 });

    expect(hookRuns()[0]!.input).toMatchObject({ timeoutMs: 1_000 });
    expect(hookRuns()[0]!.timeoutMs).toBe(6_000);
  });

  it('gives lifecycle hook runs the same manifest-governed time budget', async () => {
    const { service, store, ownerId, record } = setup();
    store.activateHook({ principalId: ownerId, workspaceId: record.id, event: 'pre_commit', manifestSha256: MANIFEST_SHA });

    await (service as unknown as { runLifecycleHooks: (r: WorkspaceRecord, e: string) => Promise<void> }).runLifecycleHooks(record, 'pre_commit');

    expect(hookRuns()).toHaveLength(1);
    expect(hookRuns()[0]!.input).not.toHaveProperty('timeoutMs');
    expect(hookRuns()[0]!.timeoutMs).toBe(305_000);
  });
});
