import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  HarnessError,
  RunnerOperationSchema,
  RunnerResponseSchema,
  TOOL_SCHEMA_BY_NAME,
  type RunnerConfig,
  type RunnerOperation,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { inspectContainer, removeContainer, runDocker, terminateContainerProcessGroup } from './docker-engine.js';
import { mintRepositoryToken } from './github-app-broker.js';
import { OperationManager } from './operation-manager.js';
import { validateRepositoryUrl } from './repository-policy.js';
import { assertOwner } from './security.js';
import type { StateStore, WorkspaceRecord } from './state-store.js';

const opaqueId = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const activeStatus = new Set<WorkspaceRecord['status']>(['CREATING', 'ACTIVE', 'REAPING']);

function publicRecord(record: WorkspaceRecord) {
  return {
    workspaceId: record.id,
    repositoryUrl: record.repositoryUrl,
    ref: record.repositoryRef,
    status: record.status,
    networkMode: record.networkMode,
    createdAt: new Date(record.createdAt).toISOString(),
    lastActivityAt: new Date(record.lastActivityAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    error: record.error
  };
}

export class WorkspaceService {
  private readonly operations = new OperationManager();
  private readonly instanceId: string;
  private reaper?: NodeJS.Timeout;
  private reaperRunning = false;

  constructor(private readonly config: RunnerConfig, private readonly store: StateStore) {
    this.instanceId = store.instanceId();
  }

  async start(): Promise<void> {
    await mkdir(this.config.jobsRoot, { recursive: true, mode: 0o700 });
    for (const record of this.store.active()) {
      if (record.status === 'CREATING') await this.closeRecord(record, 'runner restarted during workspace creation');
      else if (!record.containerName || !(await inspectContainer(record.containerName))) await this.closeRecord(record, 'executor missing during startup reconciliation');
      else {
        const restarted = await runDocker(['restart', record.containerName], { timeoutMs: 30_000, maxBytes: 65_536 });
        if (restarted.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'executor restart reconciliation failed', 503, true);
      }
    }
    await this.reconcileContainers();
    await this.reconcileJobDirectories();
    this.reaper = setInterval(() => {
      if (this.reaperRunning) return;
      this.reaperRunning = true;
      void this.reapExpired().catch(() => undefined).finally(() => { this.reaperRunning = false; });
    }, this.config.reaperIntervalSeconds * 1_000);
    this.reaper.unref();
  }

  async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
  }

  private async reconcileContainers(): Promise<void> {
    const managed = await runDocker([
      'ps', '-a', '--filter', 'label=cloud-harness.managed=true',
      '--filter', `label=cloud-harness.instance=${this.instanceId}`,
      '--format', '{{.Names}}\t{{.Label "cloud-harness.workspace"}}'
    ], { timeoutMs: 30_000, maxBytes: 1_048_576 });
    if (managed.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'Docker container inventory failed', 503, true);
    for (const line of managed.stdout.split('\n').filter(Boolean)) {
      const [name, workspaceId] = line.split('\t');
      if (!name) continue;
      const record = workspaceId ? this.store.byId(workspaceId) : undefined;
      if (!record || !activeStatus.has(record.status) || record.containerName !== name) await removeContainer(name);
    }

    const helpers = await runDocker([
      'ps', '-a', '--filter', 'label=cloud-harness.ephemeral=true',
      '--filter', `label=cloud-harness.instance=${this.instanceId}`, '--format', '{{.Names}}'
    ], { timeoutMs: 30_000, maxBytes: 1_048_576 });
    if (helpers.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'Docker clone-helper inventory failed', 503, true);
    for (const name of helpers.stdout.split('\n').filter(Boolean)) await removeContainer(name);
  }

  private async reconcileJobDirectories(): Promise<void> {
    for (const entry of await readdir(this.config.jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^ws_[A-Za-z0-9_-]{20,80}$/.test(entry.name)) continue;
      const record = this.store.byId(entry.name);
      if (!record || !activeStatus.has(record.status)) await this.safeRemovePath(join(this.config.jobsRoot, entry.name));
    }
  }

  private async ensureCapacity(ownerId: string): Promise<void> {
    if (this.store.list(ownerId).some((record) => activeStatus.has(record.status))) throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
    const info = await statfs(this.config.jobsRoot);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    if (freeBytes < this.config.minFreeBytes) throw new HarnessError('LIMIT_EXCEEDED', 'host free-space reserve would be violated', 507, true);
  }

  private async workspaceBytes(record: WorkspaceRecord): Promise<number | undefined> {
    let result;
    if (record.containerName) {
      result = await runDocker(
        ['exec', record.containerName, '/usr/bin/du', '-sb', '--apparent-size', '/workspace'],
        { timeoutMs: 30_000, maxBytes: 8_192 }
      );
    } else {
      const helperName = `chm-size-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
      try {
        result = await runDocker([
          'run', '--rm', '--pull', 'never', '--name', helperName,
          '--label', 'cloud-harness.role=size-helper', '--label', 'cloud-harness.ephemeral=true',
          '--label', `cloud-harness.instance=${this.instanceId}`, '--label', `cloud-harness.workspace=${record.id}`,
          '--network', 'none', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25',
          '--volume', `${record.workspacePath}:/target:ro`, '--entrypoint', '/usr/bin/du', this.config.executorImage,
          '-sb', '--apparent-size', '/target'
        ], { timeoutMs: 30_000, maxBytes: 8_192 });
      } finally {
        await removeContainer(helperName);
      }
    }
    if (result.exitCode !== 0) return undefined;
    const bytes = Number(result.stdout.trim().split(/\s+/, 1)[0]);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }

  private async resourceViolation(record: WorkspaceRecord): Promise<string | undefined> {
    const bytes = await this.workspaceBytes(record);
    if (bytes === undefined) {
      throw new HarnessError('UNAVAILABLE', 'workspace size could not be measured safely', 503, true);
    }
    if (bytes > this.config.maxWorkspaceBytes) return 'workspace soft size ceiling exceeded';
    const info = await statfs(this.config.jobsRoot);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    return freeBytes < this.config.minFreeBytes ? 'host free-space reserve violated' : undefined;
  }

  private async enforceActiveLimits(record: WorkspaceRecord): Promise<void> {
    const violation = await this.resourceViolation(record);
    if (!violation) return;
    await this.closeRecord(record, violation);
    throw new HarnessError('LIMIT_EXCEEDED', `${violation}; workspace was closed`, 507, false);
  }

  private expiry(createdAt: number, activityAt: number): number {
    return Math.min(createdAt + this.config.wallTtlSeconds * 1_000, activityAt + this.config.idleTtlSeconds * 1_000);
  }

  private async clone(record: WorkspaceRecord, repositoryUrl: URL, ref?: string): Promise<string> {
    const jobPath = record.workspacePath;
    const helperName = `chm-clone-${record.id.slice(3, 15)}`;
    await mkdir(jobPath, { recursive: true, mode: 0o700 });
    await chmod(jobPath, 0o777);
    const args = [
      'run', '--rm', '--pull', 'never', '--name', helperName,
      '--label', 'cloud-harness.role=clone-helper', '--label', 'cloud-harness.ephemeral=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`, '--network', 'bridge', '--user', '10001:10001',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
      '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
      '--volume', `${jobPath}:/job`, '--entrypoint', '/opt/harness/clone-helper.sh', this.config.executorImage,
      record.repositoryUrl, '/job/repo', ref ?? ''
    ];
    const repositoryToken = await mintRepositoryToken(this.config, repositoryUrl);
    let result;
    try {
      result = await runDocker(args, { stdin: `${repositoryToken ?? ''}\n`, timeoutMs: 120_000, maxBytes: this.config.maxOutputBytes });
    } finally {
      await removeContainer(helperName);
    }
    if (result.exitCode !== 0) throw new HarnessError('UNAVAILABLE', `repository clone failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
    return join(jobPath, 'repo');
  }

  private async createExecutor(record: WorkspaceRecord, repositoryPath: string): Promise<string> {
    const name = `cloud-harness-ws-${record.id.slice(3, 19).toLowerCase()}`;
    const args = [
      'create', '--name', name,
      '--label', 'cloud-harness.managed=true', '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`,
      '--user', '10001:10001', '--workdir', '/workspace', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024',
      '--network', record.networkMode, '--volume', `${repositoryPath}:/workspace:rw`,
      '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1',
      this.config.executorImage
    ];
    const created = await runDocker(args, { timeoutMs: 30_000 });
    if (created.exitCode !== 0) throw new HarnessError('UNAVAILABLE', `executor creation failed: ${created.stderr}`.slice(0, 2_000), 502, true);
    const started = await runDocker(['start', name], { timeoutMs: 30_000 });
    if (started.exitCode !== 0) {
      await removeContainer(name);
      throw new HarnessError('UNAVAILABLE', `executor start failed: ${started.stderr}`.slice(0, 2_000), 502, true);
    }
    return name;
  }

  async open(ownerId: string, input: Record<string, unknown>): Promise<RunnerResponse> {
    const parsed = TOOL_SCHEMA_BY_NAME.workspace_open.parse(input);
    const prior = this.store.byIdempotency(ownerId, parsed.idempotencyKey);
    if (prior) return { ok: prior.status === 'ACTIVE', message: 'Idempotent workspace result', data: publicRecord(prior), truncated: false };
    await this.ensureCapacity(ownerId);
    const url = await validateRepositoryUrl(parsed.repositoryUrl, this.config.allowedGitHosts);
    if (parsed.ref?.startsWith('-')) throw new HarnessError('INVALID_INPUT', 'ref cannot start with a dash');
    const now = Date.now();
    const workspaceId = opaqueId('ws');
    const record: WorkspaceRecord = {
      id: workspaceId, ownerId, idempotencyKey: parsed.idempotencyKey, repositoryUrl: url.toString(),
      repositoryRef: parsed.ref ?? null, containerName: null, workspacePath: join(this.config.jobsRoot, workspaceId),
      status: 'CREATING', networkMode: parsed.networkMode ?? this.config.networkMode, createdAt: now,
      lastActivityAt: now, expiresAt: this.expiry(now, now), generation: 1, error: null
    };
    try {
      this.store.create(record);
    } catch (error) {
      const replay = this.store.byIdempotency(ownerId, parsed.idempotencyKey);
      if (replay) return { ok: replay.status === 'ACTIVE', message: 'Idempotent workspace result', data: publicRecord(replay), truncated: false };
      if (this.store.list(ownerId).some((candidate) => activeStatus.has(candidate.status))) {
        throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
      }
      throw error;
    }
    try {
      const repositoryPath = await this.clone(record, url, parsed.ref);
      const cloneViolation = await this.resourceViolation(record);
      if (cloneViolation) throw new HarnessError('LIMIT_EXCEEDED', cloneViolation, 507, false);
      const containerName = await this.createExecutor(record, repositoryPath);
      const active = this.store.updateFenced(workspaceId, record.generation, ['CREATING'], { containerName, status: 'ACTIVE', lastActivityAt: Date.now(), error: null });
      if (!active) {
        await removeContainer(containerName);
        throw new HarnessError('CONFLICT', 'workspace creation lost its lifecycle lease', 409, true);
      }
      return { ok: true, message: 'Workspace opened', data: publicRecord(active), truncated: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'workspace creation failed';
      this.store.updateFenced(workspaceId, record.generation, ['CREATING'], { status: 'FAILED', error: message.slice(0, 2_000) });
      await this.safeRemovePath(record.workspacePath);
      throw error;
    }
  }

  list(ownerId: string, input: Record<string, unknown>): RunnerResponse {
    const records = this.store.list(ownerId);
    const offset = Number(input.cursor ?? 0);
    const limit = input.limit as number;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('INVALID_INPUT', 'invalid workspace cursor');
    const page = records.slice(offset, offset + limit);
    const next = offset + page.length < records.length ? String(offset + page.length) : undefined;
    return { ok: true, message: 'Workspaces listed', data: { workspaces: page.map(publicRecord) }, truncated: false, ...(next ? { cursor: next } : {}) };
  }

  status(ownerId: string, workspaceId: string): RunnerResponse {
    const record = this.requireWorkspace(ownerId, workspaceId, false);
    return { ok: true, message: 'Workspace status', data: publicRecord(record), truncated: false };
  }

  private requireWorkspace(ownerId: string, workspaceId: string, active = true): WorkspaceRecord {
    const record = this.store.byId(workspaceId);
    if (!record) throw new HarnessError('NOT_FOUND', 'workspace not found', 404);
    assertOwner(record.ownerId, ownerId);
    if (active && record.status !== 'ACTIVE') throw new HarnessError(record.status === 'CLOSED' ? 'EXPIRED' : 'CONFLICT', `workspace is ${record.status.toLowerCase()}`, 409);
    if (active && record.expiresAt <= Date.now()) throw new HarnessError('EXPIRED', 'workspace expired', 410);
    return record;
  }

  private touch(record: WorkspaceRecord): WorkspaceRecord {
    const now = Date.now();
    const touched = this.store.updateFenced(record.id, record.generation, ['ACTIVE'], { lastActivityAt: now, expiresAt: this.expiry(record.createdAt, now) });
    if (!touched) throw new HarnessError('EXPIRED', 'workspace lifecycle changed', 410);
    return touched;
  }

  private async runWorker(record: WorkspaceRecord, operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    if (!record.containerName) throw new HarnessError('UNAVAILABLE', 'workspace executor is unavailable', 503, true);
    const timeout = typeof input.timeoutMs === 'number' ? input.timeoutMs + 5_000 : 65_000;
    const operationId = opaqueId('op');
    const pidFile = `/tmp/cloud-harness-operations/${operationId}.pid`;
    const jsonMaxBytes = Math.min(67_108_864, Math.max(this.config.maxOutputBytes, 262_144) * 6 + 8_192);
    let result;
    try {
      result = await runDocker([
        'exec', '-i', record.containerName, '/usr/bin/setsid', '--wait', '/opt/harness/worker-runner.sh', operationId
      ], {
        stdin: JSON.stringify({ operation, input }), timeoutMs: Math.min(timeout, 305_000), maxBytes: jsonMaxBytes,
        abortKillGraceMs: 2_000,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (signal?.aborted) {
        await terminateContainerProcessGroup(record.containerName, pidFile);
        throw new HarnessError('CANCELLED', 'request cancelled', 499, false);
      }
      throw error;
    }
    if (result.exitCode !== 0) throw new HarnessError('INTERNAL_ERROR', `worker failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 500, true);
    try { return RunnerResponseSchema.parse(JSON.parse(result.stdout)); }
    catch { throw new HarnessError('INTERNAL_ERROR', 'worker returned an invalid bounded result', 500, true); }
  }

  private async runGitTransferHelper(
    record: WorkspaceRecord,
    mode: 'fetch' | 'import' | 'stage-push' | 'push',
    transferName: string,
    argument: string,
    token: string | undefined,
    expectedRemoteOid: string | undefined,
    signal?: AbortSignal
  ) {
    const helperName = `chm-git-${mode.replaceAll('-', '').slice(0, 5)}-${randomBytes(6).toString('hex')}`;
    const network = mode === 'fetch' || mode === 'push' ? 'bridge' : 'none';
    try {
      const result = await runDocker([
        'run', '--rm', '--pull', 'never', '--name', helperName,
        '--label', 'cloud-harness.role=git-transfer-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.instanceId}`, '--label', `cloud-harness.workspace=${record.id}`,
        '--network', network, '--user', '10001:10001', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
        '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
        '--volume', `${record.workspacePath}:/job:rw`, '--entrypoint', '/opt/harness/git-transfer-helper.sh',
        this.config.executorImage, mode, record.repositoryUrl, '/job/repo', `/job/${transferName}`, argument, expectedRemoteOid ?? ''
      ], {
        stdin: `${token ?? ''}\n`, timeoutMs: 120_000, maxBytes: this.config.maxOutputBytes,
        ...(signal ? { signal } : {})
      });
      if (result.exitCode !== 0) {
        const action = mode === 'push' ? 'push' : mode === 'fetch' ? 'fetch' : 'transfer';
        throw new HarnessError('UNAVAILABLE', `Git ${action} failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
      }
      return result;
    } finally {
      await removeContainer(helperName);
    }
  }

  private async withPausedExecutor<T>(record: WorkspaceRecord, action: () => Promise<T>): Promise<T> {
    if (!record.containerName) throw new HarnessError('UNAVAILABLE', 'workspace executor is unavailable', 503, true);
    const paused = await runDocker(['pause', record.containerName], { timeoutMs: 30_000, maxBytes: 8_192 });
    if (paused.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'executor could not be paused for an atomic Git transfer', 503, true);
    let value: T | undefined;
    let actionError: unknown;
    try {
      value = await action();
    } catch (error) { actionError = error; }
    const resumed = await runDocker(['unpause', record.containerName], { timeoutMs: 30_000, maxBytes: 8_192 });
    if (resumed.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'executor could not be resumed after Git transfer', 503, true);
    if (actionError) throw actionError;
    return value!;
  }

  private async currentBranch(record: WorkspaceRecord, signal?: AbortSignal): Promise<string> {
    if (!record.containerName) throw new HarnessError('UNAVAILABLE', 'workspace executor is unavailable', 503, true);
    const result = await runDocker([
      'exec', record.containerName, 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', 'branch', '--show-current'
    ], { timeoutMs: 30_000, maxBytes: 8_192, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) throw new HarnessError('CONFLICT', 'current Git branch could not be determined', 409, false);
    return result.stdout.trim();
  }

  private async remoteFetch(record: WorkspaceRecord, remoteRef: string | undefined, signal?: AbortSignal) {
    const repositoryUrl = await validateRepositoryUrl(record.repositoryUrl, this.config.allowedGitHosts);
    const token = await mintRepositoryToken(this.config, repositoryUrl);
    const transferName = `git-transfer-${randomBytes(12).toString('hex')}`;
    try {
      const fetched = await this.runGitTransferHelper(record, 'fetch', transferName, remoteRef ?? '', token, undefined, signal);
      const imported = await this.withPausedExecutor(record, async () =>
        await this.runGitTransferHelper(record, 'import', transferName, remoteRef ?? '', undefined, undefined, signal)
      );
      return { fetched, imported };
    } finally {
      await this.safeRemovePath(join(record.workspacePath, transferName));
    }
  }

  private async remotePush(record: WorkspaceRecord, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    const repositoryUrl = await validateRepositoryUrl(record.repositoryUrl, this.config.allowedGitHosts);
    const token = await mintRepositoryToken(this.config, repositoryUrl);
    if (!token) throw new HarnessError('UNAVAILABLE', 'Git push requires a configured GitHub App with repository write access', 503, false);
    const requestedRefspec = input.refspec as string | undefined;
    const branch = requestedRefspec ? '' : await this.currentBranch(record, signal);
    if (!requestedRefspec && !branch) throw new HarnessError('CONFLICT', 'git_push requires refspec when HEAD is detached', 409, false);
    const refspec = requestedRefspec ?? `${branch}:refs/heads/${branch}`;
    const transferName = `git-transfer-${randomBytes(12).toString('hex')}`;
    try {
      await this.withPausedExecutor(record, async () =>
        await this.runGitTransferHelper(record, 'stage-push', transferName, '', undefined, undefined, signal)
      );
      const pushed = await this.runGitTransferHelper(record, 'push', transferName, refspec, token, input.expectedRemoteOid as string | undefined, signal);
      return { ok: true, message: 'Git push complete', data: { output: pushed.stdout || pushed.stderr, refspec }, truncated: pushed.truncated };
    } finally {
      await this.safeRemovePath(join(record.workspacePath, transferName));
    }
  }

  async execute(ownerId: string, operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    RunnerOperationSchema.parse(operation);
    const validated = TOOL_SCHEMA_BY_NAME[operation].parse(input) as Record<string, unknown>;
    if (operation === 'workspace_open') return await this.open(ownerId, validated);
    if (operation === 'workspace_list') return this.list(ownerId, validated);
    const workspaceId = validated.workspaceId as string;
    if (operation === 'workspace_status') return this.status(ownerId, workspaceId);
    if (operation === 'workspace_close') return await this.close(ownerId, workspaceId);
    const record = this.touch(this.requireWorkspace(ownerId, workspaceId));
    await this.enforceActiveLimits(record);
    if (operation === 'exec_run') validated.maxOutputBytes = Math.min(validated.maxOutputBytes as number, this.config.maxOutputBytes);
    if (operation === 'shell_open') {
      const shell = this.operations.openShell(record.id, record.containerName!, validated.cwd as string, validated.idempotencyKey as string, this.config.maxOutputBytes);
      return { ok: true, message: 'Shell opened', data: this.operations.view(shell), truncated: false };
    }
    if (operation === 'shell_io') {
      const shell = this.operations.shellIo(record.id, validated.shellId as string, validated.input as string | undefined);
      if ((validated.waitMs as number) > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, validated.waitMs as number));
      const page = this.operations.viewSince(shell, validated.cursor as string | undefined);
      return { ok: true, message: 'Shell output', ...page };
    }
    if (operation === 'shell_close') {
      const shell = await this.operations.closeShell(record.id, validated.shellId as string);
      return { ok: true, message: 'Shell closed', data: this.operations.view(shell), truncated: false };
    }
    if (operation === 'sessions_open') {
      const session = this.operations.openSession(
        record.id,
        record.containerName!,
        validated.name as string,
        validated.cwd as string,
        validated.idempotencyKey as string,
        this.config.maxOutputBytes
      );
      return { ok: true, message: 'Coding session opened', data: this.operations.view(session), truncated: false };
    }
    if (operation === 'sessions_io') {
      const session = this.operations.sessionIo(record.id, validated.sessionId as string, validated.input as string | undefined);
      if ((validated.waitMs as number) > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, validated.waitMs as number));
      const page = this.operations.viewSince(session, validated.cursor as string | undefined);
      return { ok: true, message: 'Coding session output', ...page };
    }
    if (operation === 'sessions_close') {
      const session = await this.operations.closeSession(record.id, validated.sessionId as string);
      return { ok: true, message: 'Coding session closed', data: this.operations.view(session), truncated: false };
    }
    if (operation === 'sessions_list') {
      const sessions = this.operations.listSessions(record.id);
      const offset = Number(validated.cursor ?? 0);
      const limit = validated.limit as number;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('INVALID_INPUT', 'invalid session cursor');
      const page = sessions.slice(offset, offset + limit);
      const next = offset + page.length < sessions.length ? String(offset + page.length) : undefined;
      return { ok: true, message: 'Coding sessions listed', data: { sessions: page.map((session) => this.operations.summary(session)) }, truncated: false, ...(next ? { cursor: next } : {}) };
    }
    if (operation === 'tasks_run') {
      const task = this.operations.runTask(
        record.id,
        record.containerName!,
        validated.cwd as string,
        validated.command as string,
        validated.idempotencyKey as string,
        validated.timeoutMs as number,
        this.config.maxOutputBytes,
        validated.dependsOn as string[]
      );
      return { ok: true, message: 'Task started', data: this.operations.view(task), truncated: false };
    }
    if (operation === 'tasks_list') {
      const tasks = this.operations.listTasks(record.id);
      const offset = Number(validated.cursor ?? 0);
      const limit = validated.limit as number;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('INVALID_INPUT', 'invalid task cursor');
      const page = tasks.slice(offset, offset + limit);
      const next = offset + page.length < tasks.length ? String(offset + page.length) : undefined;
      return { ok: true, message: 'Tasks listed', data: { tasks: page.map((task) => this.operations.summary(task)) }, truncated: false, ...(next ? { cursor: next } : {}) };
    }
    if (operation === 'tasks_status') {
      const page = this.operations.viewSince(this.operations.task(record.id, validated.taskId as string), validated.cursor as string | undefined);
      return { ok: true, message: 'Task status', ...page };
    }
    if (operation === 'tasks_cancel') return { ok: true, message: 'Task cancelled', data: this.operations.view(await this.operations.cancelTask(record.id, validated.taskId as string)), truncated: false };
    if (operation === 'tasks_graph') return { ok: true, message: 'Task dependency graph', data: this.operations.taskGraph(record.id), truncated: false };
    if (operation === 'git_fetch') {
      const transfer = await this.remoteFetch(record, validated.refspec as string | undefined, signal);
      await this.enforceActiveLimits(record);
      return { ok: true, message: 'Git fetch complete', data: { output: transfer.imported.stdout || transfer.imported.stderr }, truncated: transfer.fetched.truncated || transfer.imported.truncated };
    }
    if (operation === 'git_pull') {
      const branch = (validated.branch as string | undefined) ?? await this.currentBranch(record, signal);
      if (!branch) throw new HarnessError('CONFLICT', 'git_pull requires branch when HEAD is detached', 409, false);
      await this.remoteFetch(record, `refs/heads/${branch}`, signal);
      const result = validated.strategy === 'rebase'
        ? await this.runWorker(record, 'git_rebase', { workspaceId: record.id, action: 'start', upstream: 'FETCH_HEAD' }, signal)
        : await this.runWorker(record, 'git_merge', {
            workspaceId: record.id,
            ref: 'FETCH_HEAD',
            fastForward: validated.strategy === 'ff-only' ? 'only' : 'allow'
          }, signal);
      await this.enforceActiveLimits(record);
      return result.ok ? { ...result, message: 'Git pull complete' } : result;
    }
    if (operation === 'git_push') {
      const result = await this.remotePush(record, validated, signal);
      await this.enforceActiveLimits(record);
      return result;
    }
    const result = await this.runWorker(record, operation, validated, signal);
    await this.enforceActiveLimits(record);
    return result;
  }

  async close(ownerId: string, workspaceId: string): Promise<RunnerResponse> {
    const record = this.requireWorkspace(ownerId, workspaceId, false);
    if (record.status === 'CLOSED') return { ok: true, message: 'Workspace already closed', data: publicRecord(record), truncated: false };
    await this.closeRecord(record, 'closed by owner');
    return { ok: true, message: 'Workspace closed', data: publicRecord(this.store.byId(workspaceId)!), truncated: false };
  }

  private async safeRemovePath(path: string): Promise<void> {
    const root = resolve(this.config.jobsRoot);
    const target = resolve(path);
    if (target === root || !target.startsWith(`${root}${sep}`) || relative(root, target).startsWith('..')) throw new Error('refusing unsafe workspace cleanup path');
    try {
      const actualRoot = await realpath(root);
      const actualTarget = await realpath(target);
      if (!actualTarget.startsWith(`${actualRoot}${sep}`)) throw new Error('workspace cleanup path escaped jobs root');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw error;
      const helperName = `chm-clean-${randomBytes(8).toString('hex')}`;
      const cleaned = await runDocker([
        'run', '--rm', '--pull', 'never', '--name', helperName,
        '--label', 'cloud-harness.role=cleanup-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.instanceId}`, '--network', 'none', '--user', '10001:10001',
        '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25',
        '--volume', `${target}:/target:rw`, '--entrypoint', '/usr/bin/find', this.config.executorImage,
        '/target', '-mindepth', '1', '-delete'
      ], { timeoutMs: 30_000, maxBytes: 65_536 });
      if (cleaned.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'workspace permissions could not be normalized for cleanup', 503, true);
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  private async closeRecord(record: WorkspaceRecord, reason: string): Promise<void> {
    let claimed = this.store.byId(record.id) ?? record;
    if (claimed.status !== 'REAPING') {
      if (claimed.status === 'CLOSED') return;
      if (!this.store.claimForReaping(claimed.id, claimed.generation)) return;
      claimed = this.store.byId(claimed.id)!;
    }
    this.operations.stopWorkspace(claimed.id);
    if (claimed.containerName) await removeContainer(claimed.containerName);
    await this.safeRemovePath(claimed.workspacePath);
    const closed = this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], { status: 'CLOSED', containerName: null, error: reason, expiresAt: Date.now() });
    if (!closed) throw new HarnessError('CONFLICT', 'workspace cleanup lost its lifecycle lease', 409, true);
  }

  private async reapExpired(): Promise<void> {
    const now = Date.now();
    for (const record of this.store.active()) {
      if (record.expiresAt <= now) await this.closeRecord(record, 'workspace TTL expired').catch(() => undefined);
      else if (record.status === 'ACTIVE') {
        const violation = await this.resourceViolation(record).catch(() => undefined);
        if (violation) await this.closeRecord(record, violation).catch(() => undefined);
      }
    }
  }
}
