import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const docker = vi.hoisted(() => ({
  runDocker: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
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
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(authMode: RunnerConfig['authMode']) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-privileged-gate-'));
  directories.push(directory);
  mkdirSync(join(directory, 'jobs'), { recursive: true });
  const config = {
    authMode,
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
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: `privileged-gate-${authMode}` });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'p'.repeat(24)}`,
    ownerId,
    idempotencyKey: 'privileged-gate-key',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'chm-privileged-gate-container',
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
  const service = new WorkspaceService(config, store);
  const privilegedRuns = vi.fn(async () => ({ ok: true, message: 'ran', data: { output: 'root\n' }, truncated: false }));
  (service as unknown as { runPrivilegedEphemeralExec: unknown }).runPrivilegedEphemeralExec = privilegedRuns;
  const workerRuns = vi.fn(async () => ({ ok: true, message: 'Command exited with 0', data: { output: 'user\n', exitCode: 0 }, truncated: false }));
  (service as unknown as { runWorker: unknown }).runWorker = workerRuns;
  return { service, store, ownerId, record, privilegedRuns, workerRuns };
}

describe('privileged exec_run gate without Docker', () => {
  it('refuses privileged exec without an approval grant and never reaches the privileged helper', async () => {
    const { service, ownerId, record, store, privilegedRuns, workerRuns } = setup('cloudflare-access');

    const refused = await service.execute(ownerId, 'exec_run', { workspaceId: record.id, command: 'whoami', privileged: true });

    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('PRIVILEGE_APPROVAL_REQUIRED');
    const grantRequest = refused.error?.grantRequest as { grantId: string; commandSha256: string; cwd: string };
    expect(grantRequest).toMatchObject({ workspaceId: record.id, cwd: '.' });
    // The pending grant is recorded but cannot be spent until the operator approves it.
    expect(store.getPrivilegeGrant(grantRequest.grantId)?.status).toBe('PENDING');
    expect(privilegedRuns).not.toHaveBeenCalled();
    expect(workerRuns).not.toHaveBeenCalled();
  });

  it('refuses a fabricated grant token that was never approved, and never reaches the privileged helper', async () => {
    const { service, ownerId, record, privilegedRuns } = setup('cloudflare-access');

    await expect(service.execute(ownerId, 'exec_run', {
      workspaceId: record.id,
      command: 'whoami',
      privileged: true,
      approvalGrantToken: 'pgrant_never_issued'
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(privilegedRuns).not.toHaveBeenCalled();
  });

  it('refuses privileged exec outright in owner-bearer mode', async () => {
    const { service, ownerId, record, privilegedRuns, workerRuns } = setup('owner-bearer');

    await expect(service.execute(ownerId, 'exec_run', {
      workspaceId: record.id,
      command: 'whoami',
      privileged: true
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(privilegedRuns).not.toHaveBeenCalled();
    expect(workerRuns).not.toHaveBeenCalled();
  });
});
