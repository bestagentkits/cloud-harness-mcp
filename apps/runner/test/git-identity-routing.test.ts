import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunnerConfig, type RunnerResponse } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn()
}));
const toolbox = vi.hoisted(() => ({
  runToolboxCommand: vi.fn(async () => ({ output: 'v24\n', exitCode: 0, signal: null, truncated: false, timedOut: false }))
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/toolbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ToolboxRunner>()),
  runToolboxCommand: toolbox.runToolboxCommand
}));
import type * as ToolboxRunner from '../src/toolbox-runner.js';
import { WorkspaceService } from '../src/workspace-service.js';

type WorkerCall = { operation: string; workspaceId: string; input: Record<string, unknown> };

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspaceRecord(ownerId: string, directory: string, letter: string): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${letter.repeat(24)}`,
    ownerId,
    idempotencyKey: `identity-key-${letter}`,
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: `chm-identity-${letter}`,
    workspacePath: join(directory, `ws-${letter}`),
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
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-git-identity-routing-'));
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
    minFreeBytes: 1_048_576,
    packagesRoot: join(directory, 'packages'),
    packagesBuildTimeoutMs: 600_000
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  stores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'identity-owner' });
  const first = workspaceRecord(ownerId, directory, 'c');
  const second = workspaceRecord(ownerId, directory, 'd');
  store.create(first);
  store.create(second);
  const service = new WorkspaceService(config, store);
  const workerCalls: WorkerCall[] = [];
  (service as unknown as { runWorker: (...args: unknown[]) => Promise<RunnerResponse> }).runWorker = vi.fn(async (record, operation, input) => {
    workerCalls.push({ operation: operation as string, workspaceId: (record as WorkspaceRecord).id, input: input as Record<string, unknown> });
    return { ok: true, message: 'ok', data: { output: '' }, truncated: false };
  });
  const lastCall = (operation: string) => workerCalls.filter((call) => call.operation === operation).at(-1)!;
  return { service, ownerId, first, second, lastCall };
}

describe('git identity routing to commit-creating operations', () => {
  it('leaves merge and rebase to the worker default until an identity is configured', async () => {
    const { service, ownerId, first, lastCall } = setup();

    await service.execute(ownerId, 'git_merge', { workspaceId: first.id, ref: 'main' });
    await service.execute(ownerId, 'git_rebase', { workspaceId: first.id, action: 'continue' });

    expect(lastCall('git_merge').input.authorName).toBeUndefined();
    expect(lastCall('git_rebase').input.authorName).toBeUndefined();
    const status = await service.execute(ownerId, 'git_identity_status', { workspaceId: first.id });
    expect(status.data).toEqual({ name: 'Cloud Harness Agent', email: 'agent@cloud-harness.local', source: 'default' });
  });

  it('applies the owner default, then a workspace override, without leaking into another workspace', async () => {
    const { service, ownerId, first, second, lastCall } = setup();

    await service.execute(ownerId, 'git_identity_set', { name: 'Owner Default', email: 'owner@example.com' });
    await service.execute(ownerId, 'git_merge', { workspaceId: first.id, ref: 'main' });
    expect(lastCall('git_merge').input).toMatchObject({ authorName: 'Owner Default', authorEmail: 'owner@example.com' });

    const set = await service.execute(ownerId, 'git_identity_set', { workspaceId: first.id, name: 'Workspace Agent', email: 'workspace@example.com' });
    expect(set.ok).toBe(true);

    await service.execute(ownerId, 'git_merge', { workspaceId: first.id, ref: 'main' });
    expect(lastCall('git_merge')).toMatchObject({ workspaceId: first.id, input: { authorName: 'Workspace Agent', authorEmail: 'workspace@example.com' } });
    await service.execute(ownerId, 'git_rebase', { workspaceId: first.id, action: 'continue' });
    expect(lastCall('git_rebase').input).toMatchObject({ authorName: 'Workspace Agent', authorEmail: 'workspace@example.com' });
    await service.execute(ownerId, 'git_commit', { workspaceId: first.id, message: 'change' });
    expect(lastCall('git_commit').input).toMatchObject({ authorName: 'Workspace Agent', authorEmail: 'workspace@example.com' });

    await service.execute(ownerId, 'git_merge', { workspaceId: second.id, ref: 'main' });
    expect(lastCall('git_merge')).toMatchObject({ workspaceId: second.id, input: { authorName: 'Owner Default', authorEmail: 'owner@example.com' } });

    expect((await service.execute(ownerId, 'git_identity_status', { workspaceId: first.id })).data)
      .toEqual({ name: 'Workspace Agent', email: 'workspace@example.com', source: 'workspace' });
    expect((await service.execute(ownerId, 'git_identity_status', { workspaceId: second.id })).data)
      .toEqual({ name: 'Owner Default', email: 'owner@example.com', source: 'owner' });
  });

  it('keeps an explicit git_commit author over the configured identity', async () => {
    const { service, ownerId, first, lastCall } = setup();

    await service.execute(ownerId, 'git_identity_set', { workspaceId: first.id, name: 'Workspace Agent', email: 'workspace@example.com' });
    await service.execute(ownerId, 'git_commit', { workspaceId: first.id, message: 'change', authorName: 'Explicit', authorEmail: 'explicit@example.com' });

    expect(lastCall('git_commit').input).toMatchObject({ authorName: 'Explicit', authorEmail: 'explicit@example.com' });
  });
});
