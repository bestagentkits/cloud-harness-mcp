import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig, WorkspaceLifecycleSettingsView } from '@cloud-harness/contracts';

const docker = vi.hoisted(() => ({
  workerResult: { ok: true, message: 'worker complete', data: {} as unknown, truncated: false } as Record<string, unknown>,
  workerRequests: [] as string[],
  runDocker: vi.fn(async (args: string[], options?: { stdin?: string }) => {
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('branch') && args.includes('--show-current')) return { stdout: 'main\n', stderr: '', exitCode: 0, truncated: false };
    if (args.includes('/opt/harness/worker-runner.sh')) {
      docker.workerRequests.push(options?.stdin ?? '');
      return { stdout: JSON.stringify(docker.workerResult), stderr: '', exitCode: 0, truncated: false };
    }
    if (args[0] === 'create') return { stdout: 'container-created\n', stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined),
  spawnDocker: vi.fn(() => ({
    stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn(), kill: vi.fn()
  }))
}));

vi.mock('../src/docker-engine.js', () => docker);
vi.mock('../src/repository-policy.js', () => ({ validateRepositoryUrl: vi.fn(async (value: string) => new URL(value)) }));

import { executeInternalRunnerOperation } from '../src/internal-runner-operations.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  docker.workerResult = { ok: true, message: 'worker complete', data: {}, truncated: false };
  docker.workerRequests = [];
  vi.clearAllMocks();
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator' };

function fixture(configOverrides: Partial<RunnerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-lifecycle-settings-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const config = {
    jobsRoot,
    stateDb: join(directory, 'state.db'),
    idleTtlSeconds: 300,
    wallTtlSeconds: 900,
    recoverableGraceSeconds: 3600,
    reaperIntervalSeconds: 60,
    maxOutputBytes: 262144,
    maxWorkspaceBytes: 104857600,
    minFreeBytes: 1048576,
    maxActiveWorkspacesPerOwner: 3,
    lifecycleEnvironmentKeys: [],
    networkProfile: 'network-none',
    allowedGitHosts: ['github.com'],
    executorImage: 'cloud-harness-executor:test',
    ...configOverrides
  } as RunnerConfig;
  const store = new StateStore(config.stateDb, { maxActiveWorkspacesPerOwner: config.maxActiveWorkspacesPerOwner });
  const metadata = new MetadataStore(config.stateDb, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
  closers.push(() => metadata.database.close(), () => store.close());
  const ownerId = store.resolvePrincipal(principal);
  const service = new WorkspaceService(config, store, metadata);
  return { config, store, metadata, ownerId, service, jobsRoot };
}

type Fixture = ReturnType<typeof fixture>;

async function settings(service: WorkspaceService, input?: Record<string, unknown>): Promise<WorkspaceLifecycleSettingsView> {
  const result = await executeInternalRunnerOperation(service, input === undefined
    ? { version: 2, principal, operation: 'settings_get', input: {} }
    : { version: 2, principal, operation: 'settings_update', input });
  return (result.data as { workspaceLifecycle: WorkspaceLifecycleSettingsView }).workspaceLifecycle;
}

async function openWorkspace({ service, ownerId }: Fixture, idempotencyKey: string): Promise<string> {
  const result = await service.execute(ownerId, 'workspace_open', { repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey });
  return (result.data as { workspaceId: string }).workspaceId;
}

function seedRecoverable({ store, ownerId, jobsRoot }: Fixture, suffix: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  const id = `ws_${suffix.repeat(24).slice(0, 24)}`;
  mkdirSync(join(jobsRoot, id, 'repo'), { recursive: true });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id, ownerId, idempotencyKey: `seed-${id}`,
    repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: 'main',
    containerName: null, workspacePath: join(jobsRoot, id), status: 'EXPIRED_RECOVERABLE', networkProfile: 'network-none',
    createdAt: now - 7_200_000, lastActivityAt: now - 7_200_000, expiresAt: now - 7_200_000, hardExpiresAt: now,
    gitAuthorName: null, gitAuthorEmail: null, generation: 2, error: null,
    expiredAt: now - 7_200_000, recoverableUntil: now - 1_000, recoverableGraceSeconds: 3600,
    ...overrides
  };
  store.create(record);
  return record;
}

const reap = async (service: WorkspaceService) => {
  await (service as unknown as { reapExpired: () => Promise<void> }).reapExpired.call(service);
};
const cleanCheck = { ok: true, message: 'Workspace close check', data: { uncommittedPaths: 0, stashes: 0, unpushedCommits: 0 }, truncated: false };

describe('workspace lifecycle settings', () => {
  it('reports runner values with their source before any override exists', async () => {
    const { service } = fixture({ idleTtlSeconds: 600, lifecycleEnvironmentKeys: ['idleTtlSeconds'] });
    const view = await settings(service);
    expect(view.revision).toBe(0);
    expect(view.updatedAt).toBeNull();
    expect(view.settings.idleTtlSeconds).toMatchObject({ value: 600, source: 'environment', runnerValue: 600, min: 60, max: 43_200 });
    expect(view.settings.maxActiveWorkspacesPerOwner).toMatchObject({ value: 3, source: 'default' });
    expect(view.settings.recoverableGraceSeconds).toMatchObject({ value: 3600, source: 'default', min: 0 });
    expect(view.reaperIntervalSeconds).toBe(60);
    expect(view.usage).toEqual({ counted: 0, limit: 3, recoverable: 0, autoCloseDeferred: 0 });
    expect(view.executorCeilings).toEqual({ memoryBytes: 1_073_741_824, cpus: 1, pids: 256 });
  });

  it('saves only the fields sent, audits both sides, and resets a field with null', async () => {
    const { service, store, metadata } = fixture();
    const saved = await settings(service, { workspaceLifecycle: { expectedRevision: 0, idleTtlSeconds: 120 } });
    expect(saved.revision).toBe(1);
    expect(saved.settings.idleTtlSeconds).toMatchObject({ value: 120, source: 'setting', runnerValue: 300 });
    expect(saved.settings.wallTtlSeconds).toMatchObject({ value: 900, source: 'default' });

    const reset = await settings(service, { workspaceLifecycle: { expectedRevision: 1, idleTtlSeconds: null } });
    expect(reset.revision).toBe(2);
    expect(reset.settings.idleTtlSeconds).toMatchObject({ value: 300, source: 'default' });

    const audits = metadata.listAudit(store.resolvePrincipal(principal), 10)
      .filter((entry) => entry.action === 'settings.workspace_lifecycle.changed');
    expect(audits).toHaveLength(2);
    expect(audits[0]!.details).toMatchObject({ 'idleTtlSeconds.previous': 120, 'idleTtlSeconds.next': 'runner-default' });
    expect(audits[1]!.details).toMatchObject({ 'idleTtlSeconds.previous': 'runner-default', 'idleTtlSeconds.next': 120 });
    expect(audits[1]!.details).not.toHaveProperty('wallTtlSeconds.next');
  });

  it('rejects a stale revision without changing anything', async () => {
    const { service, store } = fixture();
    await settings(service, { workspaceLifecycle: { expectedRevision: 0, maxActiveWorkspacesPerOwner: 5 } });
    await expect(settings(service, { workspaceLifecycle: { expectedRevision: 0, maxActiveWorkspacesPerOwner: 7 } }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.getWorkspaceLifecycleOverrides()).toMatchObject({ maxActiveWorkspacesPerOwner: 5, revision: 1 });
  });

  it('rejects an idle timeout longer than the effective lifetime, including against the runner value', async () => {
    const { service, store } = fixture({ wallTtlSeconds: 900 });
    await expect(settings(service, { workspaceLifecycle: { expectedRevision: 0, idleTtlSeconds: 1_200 } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await settings(service, { workspaceLifecycle: { expectedRevision: 0, idleTtlSeconds: 1_200, wallTtlSeconds: 3_600 } });
    await expect(settings(service, { workspaceLifecycle: { expectedRevision: 1, wallTtlSeconds: null } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(store.getWorkspaceLifecycleOverrides()).toMatchObject({ idleTtlSeconds: 1_200, wallTtlSeconds: 3_600, revision: 1 });
  });

  it('requires an acknowledgement for a zero grace and leaves the network default alone', async () => {
    const { service, store } = fixture();
    await expect(settings(service, { workspaceLifecycle: { expectedRevision: 0, recoverableGraceSeconds: 0 } })).rejects.toBeTruthy();
    const view = await settings(service, { workspaceLifecycle: { expectedRevision: 0, recoverableGraceSeconds: 0, acknowledgeImmediateClose: true } });
    expect(view.settings.recoverableGraceSeconds).toMatchObject({ value: 0, source: 'setting' });
    expect(store.getWorkspaceDefaultNetworkProfile()).toBeUndefined();
  });

  it('enforces a lowered quota on the next open without closing open workspaces', async () => {
    const context = fixture();
    const first = await openWorkspace(context, 'quota-key-1');
    const second = await openWorkspace(context, 'quota-key-2');
    await settings(context.service, { workspaceLifecycle: { expectedRevision: 0, maxActiveWorkspacesPerOwner: 1 } });

    await expect(context.service.execute(context.ownerId, 'workspace_open', {
      repositoryUrl: 'https://github.com/example/repo.git', idempotencyKey: 'quota-key-3'
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(context.store.byId(first)?.status).toBe('ACTIVE');
    expect(context.store.byId(second)?.status).toBe('ACTIVE');
    expect((await settings(context.service)).usage).toMatchObject({ counted: 2, limit: 1 });

    await settings(context.service, { workspaceLifecycle: { expectedRevision: 1, maxActiveWorkspacesPerOwner: 3 } });
    await expect(openWorkspace(context, 'quota-key-4')).resolves.toMatch(/^ws_/);
  });

  it('snapshots TTLs at open so a later change applies only to new workspaces', async () => {
    const context = fixture();
    const before = await openWorkspace(context, 'snapshot-1');
    const original = context.store.byId(before)!;
    expect(original).toMatchObject({ idleTtlSeconds: 300, recoverableGraceSeconds: 3600 });
    expect(original.hardExpiresAt! - original.createdAt).toBe(900_000);

    await settings(context.service, { workspaceLifecycle: { expectedRevision: 0, idleTtlSeconds: 1_800, wallTtlSeconds: 7_200, recoverableGraceSeconds: 600 } });
    const after = await openWorkspace(context, 'snapshot-2');
    const changed = context.store.byId(after)!;
    expect(changed).toMatchObject({ idleTtlSeconds: 1_800, recoverableGraceSeconds: 600 });
    expect(changed.hardExpiresAt! - changed.createdAt).toBe(7_200_000);
    expect(changed.expiresAt - changed.createdAt).toBe(1_800_000);

    const unchanged = context.store.byId(before)!;
    expect(unchanged).toMatchObject({ idleTtlSeconds: 300, recoverableGraceSeconds: 3600, hardExpiresAt: original.hardExpiresAt });
  });

  it('stamps the recoverable window from the workspace snapshot when it expires', async () => {
    const context = fixture();
    await settings(context.service, { workspaceLifecycle: { expectedRevision: 0, recoverableGraceSeconds: 120 } });
    const id = await openWorkspace(context, 'expire-key-1');
    // A later change must not alter the window this workspace was opened with.
    await settings(context.service, { workspaceLifecycle: { expectedRevision: 1, recoverableGraceSeconds: 7_200 } });
    context.store.update(id, { expiresAt: Date.now() - 1_000 });
    docker.workerRequests = [];
    await reap(context.service);
    const expired = context.store.byId(id)!;
    expect(expired.status).toBe('EXPIRED_RECOVERABLE');
    expect(expired.expiredAt).toBeTypeOf('number');
    expect(expired.recoverableUntil! - expired.expiredAt!).toBe(120_000);
    expect(docker.workerRequests.filter((request) => request.includes('close_check'))).toHaveLength(0);
  });

  it('auto-closes a clean recoverable workspace once its window passes', async () => {
    const context = fixture();
    const record = seedRecoverable(context, 'c');
    docker.workerResult = cleanCheck;
    await reap(context.service);
    expect(context.store.byId(record.id)?.status).toBe('CLOSED');
    expect(docker.workerRequests.some((request) => request.includes('close_check'))).toBe(true);
    const audits = context.metadata.listAudit(context.ownerId, 10).filter((entry) => entry.action === 'workspace.auto_closed');
    expect(audits).toHaveLength(1);
  });

  it('keeps a recoverable workspace whose window has not passed', async () => {
    const context = fixture();
    const record = seedRecoverable(context, 'd', { recoverableUntil: Date.now() + 60_000 });
    docker.workerResult = cleanCheck;
    await reap(context.service);
    expect(context.store.byId(record.id)?.status).toBe('EXPIRED_RECOVERABLE');
    expect(docker.workerRequests).toHaveLength(0);
  });

  it('defers auto-close for unsaved work, audits the reason once, and counts it in usage', async () => {
    const context = fixture();
    const record = seedRecoverable(context, 'e');
    docker.workerResult = { ok: true, message: 'Workspace close check', data: { uncommittedPaths: 2, stashes: 0, unpushedCommits: 1 }, truncated: false };
    await reap(context.service);

    const deferred = context.store.byId(record.id)!;
    expect(deferred.status).toBe('EXPIRED_RECOVERABLE');
    expect(deferred.error).toMatch(/^auto-close deferred: 2 uncommitted or untracked path\(s\), 1 commit\(s\) not on any remote$/);
    expect(deferred.recoverableUntil!).toBeGreaterThanOrEqual(Date.now() + 3_500_000);
    expect((await settings(context.service)).usage).toMatchObject({ recoverable: 1, autoCloseDeferred: 1 });

    // The same reason on a later pass is not audited again.
    context.store.update(record.id, { recoverableUntil: Date.now() - 1 });
    await reap(context.service);
    const audits = context.metadata.listAudit(context.ownerId, 10).filter((entry) => entry.action === 'workspace.auto_close_deferred');
    expect(audits).toHaveLength(1);
    expect(context.store.byId(record.id)?.status).toBe('EXPIRED_RECOVERABLE');
  });

  it('defers auto-close when the unsaved-work check fails or returns malformed data', async () => {
    const context = fixture();
    const failing = seedRecoverable(context, 'f');
    docker.workerResult = { ok: false, message: 'git status failed', error: { code: 'INTERNAL_ERROR', message: 'git status failed', retryable: false }, truncated: false };
    await reap(context.service);
    expect(context.store.byId(failing.id)).toMatchObject({ status: 'EXPIRED_RECOVERABLE', error: 'auto-close deferred: the unsaved-work check could not run' });

    const malformed = seedRecoverable(context, 'g');
    docker.workerResult = { ok: true, message: 'ok', data: { uncommittedPaths: '0' }, truncated: false };
    await reap(context.service);
    expect(context.store.byId(malformed.id)?.status).toBe('EXPIRED_RECOVERABLE');
  });

  it('never claims a workspace that was recovered to ACTIVE', async () => {
    const context = fixture();
    const record = seedRecoverable(context, 'h');
    context.store.update(record.id, { status: 'ACTIVE' });
    expect(context.store.byId(record.id)).toMatchObject({ expiredAt: null, recoverableUntil: null });
    expect(context.store.claimRecoverableForAutoClose(record.id, record.generation, Date.now())).toBe(false);
    expect(context.store.listAutoCloseDue(Date.now())).toEqual([]);
  });

  it('falls back to the former one-hour grace for a recoverable row without a window', async () => {
    const context = fixture();
    const now = Date.now();
    const legacy = seedRecoverable(context, 'i', {
      expiredAt: undefined, recoverableUntil: undefined, recoverableGraceSeconds: undefined, lastActivityAt: now - 1_800_000
    });
    expect(context.store.listAutoCloseDue(now).map((entry) => entry.id)).not.toContain(legacy.id);
    expect(context.store.listAutoCloseDue(now + 1_800_001).map((entry) => entry.id)).toContain(legacy.id);
  });

  it('upgrades a database from before the configurable policy without moving any close time', async () => {
    const context = fixture();
    const legacy = seedRecoverable(context, 'j', { lastActivityAt: 1_000_000 });
    const active = seedRecoverable(context, 'k', { status: 'ACTIVE' });
    context.store.close();
    const database = new DatabaseSync(context.config.stateDb);
    for (const column of ['idle_ttl_seconds', 'recoverable_grace_seconds', 'expired_at', 'recoverable_until']) {
      database.exec(`ALTER TABLE workspaces DROP COLUMN ${column}`);
    }
    for (const column of ['max_active_workspaces_per_owner', 'workspace_idle_ttl_seconds', 'workspace_wall_ttl_seconds',
      'recoverable_grace_seconds', 'lifecycle_revision', 'lifecycle_updated_at']) {
      database.exec(`ALTER TABLE instance_settings DROP COLUMN ${column}`);
    }
    database.close();

    const upgraded = new StateStore(context.config.stateDb);
    closers.push(() => upgraded.close());
    expect(upgraded.byId(legacy.id)).toMatchObject({ expiredAt: 1_000_000, recoverableUntil: 1_000_000 + 3_600_000 });
    expect(upgraded.byId(legacy.id)?.recoverableGraceSeconds ?? null).toBeNull();
    expect(upgraded.byId(active.id)).toMatchObject({ expiredAt: null, recoverableUntil: null });
    expect(upgraded.getWorkspaceLifecycleOverrides()).toMatchObject({ revision: 0, maxActiveWorkspacesPerOwner: null });
  });
});
