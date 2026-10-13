import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { HarnessError, type RunnerConfig, type RunnerResponse } from '@cloud-harness/contracts';
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

type WorkerCall = { operation: string; input: Record<string, unknown> };

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(overrides: Partial<RunnerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-bash-tool-'));
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
    ...overrides
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  stores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'bash-owner' });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'b'.repeat(24)}`,
    ownerId,
    idempotencyKey: 'bash-key-1234',
    repositoryUrl: 'https://github.com/example/repo.git',
    repositoryRef: 'main',
    containerName: 'chm-bash-container',
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
  const workerCalls: WorkerCall[] = [];
  let lockDuringWorker: number | null | undefined;
  let release: (() => void) | undefined;
  let hold = false;
  (service as unknown as { runWorker: (...args: unknown[]) => Promise<RunnerResponse> }).runWorker = vi.fn(async (_record, operation, input) => {
    workerCalls.push({ operation: operation as string, input: input as Record<string, unknown> });
    lockDuringWorker = store.byId(record.id)?.mutationLockedUntil;
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true, message: 'Command exited with 0', data: { output: 'hello\n', exitCode: 0, signal: null, truncated: false }, truncated: false };
  });
  return {
    service, store, ownerId, record, workerCalls,
    lock: () => lockDuringWorker,
    holdWorker: () => { hold = true; },
    releaseWorker: () => release?.()
  };
}

describe('bash tool, workspace target', () => {
  it('delegates to the exec_run worker path with the same bounds, mutation lease, and envelope plus target', async () => {
    const { service, ownerId, record, workerCalls, lock } = setup();
    const before = Date.now();

    const result = await service.execute(ownerId, 'bash', { workspaceId: record.id, command: 'echo hello', cwd: 'src', timeoutMs: 5_000, maxOutputBytes: 1_000_000 });

    expect(result).toMatchObject({ ok: true, message: 'Command exited with 0', truncated: false });
    expect(result.data).toEqual({ output: 'hello\n', exitCode: 0, signal: null, truncated: false, target: 'workspace' });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]!.operation).toBe('exec_run');
    expect(workerCalls[0]!.input).toEqual({
      workspaceId: record.id, command: 'echo hello', cwd: 'src', timeoutMs: 5_000, maxOutputBytes: 262_144, privileged: false, async: false
    });
    // A synchronous workspace command holds the workspace mutation lease, exactly as exec_run does.
    expect(lock()).toBeGreaterThanOrEqual(before + 5_000);
    expect(toolbox.runToolboxCommand).not.toHaveBeenCalled();
  });

  it('returns an operation handle for async commands that operation_wait resolves', async () => {
    const { service, ownerId, record, workerCalls, store, holdWorker, releaseWorker } = setup();
    holdWorker();

    const started = await service.execute(ownerId, 'bash', { workspaceId: record.id, command: 'make test', async: true, timeoutMs: 10_000 });

    expect(started.ok).toBe(true);
    const data = started.data as { operationId: string; status: string; target: string };
    expect(data).toMatchObject({ status: 'running', target: 'workspace' });
    expect(data.operationId).toMatch(/^op_/);
    await vi.waitFor(() => expect(workerCalls).toHaveLength(1));
    expect(workerCalls[0]!.input).toMatchObject({ async: false, command: 'make test' });
    expect(store.byId(record.id)?.mutationLockedUntil).toBeGreaterThan(Date.now());

    const running = await service.execute(ownerId, 'operation_status', { operationId: data.operationId });
    expect(running.data).toMatchObject({ status: 'running', kind: 'exec_run' });

    releaseWorker();
    const finished = await service.execute(ownerId, 'operation_wait', { operationId: data.operationId, timeoutMs: 5_000 });
    // The result read through the handle names its target, as the synchronous result does.
    expect(finished).toMatchObject({ ok: true, data: { status: 'completed', result: { output: 'hello\n', exitCode: 0, target: 'workspace' } } });
  });

  it('refuses a privileged request at the schema, naming the field, instead of running it unprivileged', async () => {
    const { service, ownerId, record, workerCalls } = setup();
    const refusal = service.execute(ownerId, 'bash', { workspaceId: record.id, command: 'id', privileged: true });
    await expect(refusal).rejects.toBeInstanceOf(ZodError);
    await expect(refusal).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['privileged'] })] });
    expect(workerCalls).toHaveLength(0);
  });

  it('refuses a NUL byte in the command as invalid input before any worker runs', async () => {
    const { service, ownerId, record, workerCalls } = setup();
    for (const operation of ['bash', 'exec_run'] as const) {
      const refusal = service.execute(ownerId, operation, { workspaceId: record.id, command: 'echo a\u0000b' });
      await expect(refusal).rejects.toBeInstanceOf(ZodError);
      await expect(refusal).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ['command'], message: expect.stringMatching(/NUL/) })] });
    }
    expect(workerCalls).toHaveLength(0);
  });
});

describe('bash tool, toolbox target', () => {
  it('is refused while PACKAGES_ENABLED is off and starts no container', async () => {
    const { service, ownerId, workerCalls } = setup();
    const refusal = service.execute(ownerId, 'bash', { command: 'node --version', target: 'toolbox' });
    await expect(refusal).rejects.toBeInstanceOf(HarnessError);
    await expect(refusal).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/PACKAGES_ENABLED/) });
    expect(toolbox.runToolboxCommand).not.toHaveBeenCalled();
    expect(docker.runDocker).not.toHaveBeenCalled();
    expect(workerCalls).toHaveLength(0);
  });

  it('runs in a disposable executor-image container with no mounts when enabled', async () => {
    const { service, ownerId, store, workerCalls } = setup({ packagesEnabled: true, maxOutputBytes: 4_096 });
    const controller = new AbortController();

    const result = await service.execute(ownerId, 'bash', { command: 'node --version', target: 'toolbox', timeoutMs: 7_000, maxOutputBytes: 65_536 }, controller.signal);

    expect(result).toEqual({
      ok: true,
      message: 'Command exited with 0',
      data: { output: 'v24\n', exitCode: 0, signal: null, truncated: false, target: 'toolbox' },
      truncated: false
    });
    expect(toolbox.runToolboxCommand).toHaveBeenCalledTimes(1);
    const [spec, limits, signal] = toolbox.runToolboxCommand.mock.calls[0] as unknown as [ToolboxRunner.ToolboxRunSpec, { timeoutMs: number; maxOutputBytes: number }, AbortSignal];
    expect(spec).toMatchObject({ image: 'cloud-harness-executor:test', instanceId: store.instanceId(), command: 'node --version', mounts: [] });
    expect(spec.name).toMatch(/^chm-toolbox-[a-f0-9]{16}$/);
    // The instance output ceiling still applies to the caller's request.
    expect(limits).toEqual({ timeoutMs: 7_000, maxOutputBytes: 4_096 });
    expect(signal).toBe(controller.signal);
    expect(workerCalls).toHaveLength(0);
  });

  it('reports a run the harness stopped by its signal, not as an exit code', async () => {
    const { service, ownerId } = setup({ packagesEnabled: true });
    toolbox.runToolboxCommand.mockResolvedValueOnce({ output: 'yyyy', exitCode: null, signal: 'SIGKILL', truncated: true, timedOut: false } as never);

    const result = await service.execute(ownerId, 'bash', { command: 'yes', target: 'toolbox' });

    expect(result).toMatchObject({ ok: true, message: 'Command was stopped with SIGKILL after its output reached maxOutputBytes', truncated: true });
    expect(result.data).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  });

  it('reports a timeout as a failed TIMEOUT result that keeps the partial output', async () => {
    const { service, ownerId } = setup({ packagesEnabled: true });
    toolbox.runToolboxCommand.mockResolvedValueOnce({ output: 'partial', exitCode: null, signal: 'SIGTERM', truncated: false, timedOut: true } as never);

    const result = await service.execute(ownerId, 'bash', { command: 'sleep 60', target: 'toolbox', timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'TIMEOUT', retryable: false });
    expect(result.data).toMatchObject({ output: 'partial', exitCode: null, target: 'toolbox' });
  });
});

/** Holds every toolbox run until released, and records the signal each run was given. */
function holdToolboxRuns() {
  const runs: Array<{ signal: AbortSignal | undefined; release: () => void }> = [];
  toolbox.runToolboxCommand.mockImplementation(((_spec: unknown, _limits: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
    const result = { output: 'done\n', exitCode: 0, signal: null, truncated: false, timedOut: false };
    runs.push({ signal, release: () => resolve(result) });
    signal?.addEventListener('abort', () => reject(new HarnessError('CANCELLED', 'request cancelled', 499, false)), { once: true });
  })) as never);
  return runs;
}

describe('bash tool, toolbox concurrency and operation handles', () => {
  afterEach(() => {
    toolbox.runToolboxCommand.mockReset();
    toolbox.runToolboxCommand.mockImplementation(async () => ({ output: 'v24\n', exitCode: 0, signal: null, truncated: false, timedOut: false }));
  });

  it('refuses a toolbox call beyond TOOLBOX_MAX_CONCURRENT with a retryable LIMIT_EXCEEDED and frees the slot afterwards', async () => {
    const { service, ownerId } = setup({ packagesEnabled: true, toolboxMaxConcurrent: 2 });
    const runs = holdToolboxRuns();
    const first = service.execute(ownerId, 'bash', { command: 'sleep 1', target: 'toolbox' });
    // An async run holds a slot too.
    const second = await service.execute(ownerId, 'bash', { command: 'sleep 1', target: 'toolbox', async: true });
    expect(second.ok).toBe(true);

    const refusal = service.execute(ownerId, 'bash', { command: 'true', target: 'toolbox' });
    await expect(refusal).rejects.toBeInstanceOf(HarnessError);
    await expect(refusal).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', status: 429, retryable: true });
    expect(toolbox.runToolboxCommand).toHaveBeenCalledTimes(2);

    runs[0]!.release();
    await first;
    const third = service.execute(ownerId, 'bash', { command: 'true', target: 'toolbox' });
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    runs[1]!.release();
    runs[2]!.release();
    await expect(third).resolves.toMatchObject({ ok: true });
  });

  it('returns an owner-scoped operation handle whose result names the toolbox target', async () => {
    const { service, store, ownerId } = setup({ packagesEnabled: true });
    const runs = holdToolboxRuns();
    const started = await service.execute(ownerId, 'bash', { command: 'make', target: 'toolbox', async: true, timeoutMs: 10_000 });
    const data = started.data as { operationId: string; status: string; target: string };
    expect(started).toMatchObject({ ok: true, message: 'Command started in background' });
    expect(data).toMatchObject({ status: 'running', target: 'toolbox' });
    expect(data.operationId).toMatch(/^op_/);

    const running = await service.execute(ownerId, 'operation_status', { operationId: data.operationId });
    expect(running.data).toMatchObject({ status: 'running', kind: 'bash' });

    // A handle with no workspace is still visible only to the owner that started it.
    const otherOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'someone-else' });
    for (const operation of ['operation_status', 'operation_wait', 'operation_cancel'] as const) {
      await expect(service.execute(otherOwner, operation, { operationId: data.operationId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.release();
    const finished = await service.execute(ownerId, 'operation_wait', { operationId: data.operationId, timeoutMs: 5_000 });
    expect(finished).toMatchObject({
      ok: true,
      data: { status: 'completed', result: { output: 'done\n', exitCode: 0, signal: null, truncated: false, target: 'toolbox' } }
    });
  });

  it('never exposes a handle that has neither a workspace nor an owner', async () => {
    const { service, ownerId } = setup();
    const operations = (service as unknown as { operations: { registerGenericOperation: (op: { id: string; kind: string }) => unknown } }).operations;
    const operationId = `op_${'u'.repeat(24)}`;
    operations.registerGenericOperation({ id: operationId, kind: 'bash' });

    await expect(service.execute(ownerId, 'operation_status', { operationId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancels an async toolbox run by aborting it and waits for its container removal', async () => {
    const { service, ownerId } = setup({ packagesEnabled: true });
    let removed = false;
    toolbox.runToolboxCommand.mockImplementation(((_spec: unknown, _limits: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        // The real runner removes the container before it settles; cancellation must wait for that.
        setTimeout(() => { removed = true; reject(new HarnessError('CANCELLED', 'request cancelled', 499, false)); }, 20);
      }, { once: true });
    })) as never);
    const started = await service.execute(ownerId, 'bash', { command: 'sleep 120', target: 'toolbox', async: true });
    const { operationId } = started.data as { operationId: string };

    const cancelledResult = await service.execute(ownerId, 'operation_cancel', { operationId });

    expect(cancelledResult).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(removed).toBe(true);
    const status = await service.execute(ownerId, 'operation_status', { operationId });
    expect(status).toMatchObject({ ok: false, data: { status: 'cancelled' } });
  });

  it('records a daemon failure on the handle as a retryable UNAVAILABLE', async () => {
    const { service, ownerId } = setup({ packagesEnabled: true });
    toolbox.runToolboxCommand.mockRejectedValueOnce(new HarnessError('UNAVAILABLE', 'toolbox container could not be created: No such image', 503, true));
    const started = await service.execute(ownerId, 'bash', { command: 'true', target: 'toolbox', async: true });
    const { operationId } = started.data as { operationId: string };

    const finished = await service.execute(ownerId, 'operation_wait', { operationId, timeoutMs: 5_000 });

    expect(finished).toMatchObject({ ok: false, data: { status: 'failed' }, error: { code: 'UNAVAILABLE', retryable: true } });
  });
});
