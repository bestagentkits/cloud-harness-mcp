import { createHash, randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, readdir, realpath, rm, stat, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  HarnessError,
  InternalRunnerRequestSchema,
  RunnerOperationSchema,
  RunnerResponseSchema,
  TOOL_SCHEMA_BY_NAME,
  type RunnerConfig,
  type InternalRunnerOperation,
  type RunnerOperation,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { inspectContainer, removeContainer, runDocker, terminateContainerProcessGroup } from './docker-engine.js';
import { readVerifiedWorkspaceFile } from './bounded-workspace-file-reader.js';
import { mintPrincipalRepositoryScopedToken, mintPrincipalRepositoryToken, mintRepositoryToken } from './github-app-broker.js';
import type { GitHubBindingService } from './github-binding-service.js';
import type { GitHubInstallationRecord, GitHubInstallationStore } from './github-installation-store.js';
import type { MetadataStore } from './metadata-store.js';
import { OperationManager } from './operation-manager.js';
import { validateRepositoryUrl } from './repository-policy.js';
import type { PrincipalSelector, StateStore, WorkspaceRecord } from './state-store.js';
import { validatedWorkspaceEnvironment } from './workspace-environment.js';

const opaqueId = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const activeStatus = new Set<WorkspaceRecord['status']>(['CREATING', 'ACTIVE', 'REAPING']);
const auditedFileMutations = new Set<RunnerOperation>([
  'files_write', 'files_write_batch', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir'
]);

function availableLifecycleActions(status: WorkspaceRecord['status'], canRenewLease: boolean): string[] {
  switch (status) {
    case 'ACTIVE':
      return canRenewLease
        ? ['workspace_lease_renew', 'workspace_close', 'workspace_context', 'workspace_finalize']
        : ['workspace_close', 'workspace_context', 'workspace_finalize'];
    case 'EXPIRED_RECOVERABLE':
      return canRenewLease
        ? ['workspace_recover', 'workspace_lease_renew', 'workspace_close']
        : ['workspace_recover', 'workspace_close'];
    case 'CREATING':
    case 'REAPING':
      return ['workspace_status'];
    case 'CLOSED':
    case 'FAILED':
      return ['workspace_open'];
    default:
      return [];
  }
}

function publicRecord(record: WorkspaceRecord) {
  const now = Date.now();
  const remainingLeaseMs = Math.max(0, record.expiresAt - now);
  const hardRemainingMs = Math.max(0, record.hardExpiresAt - now);
  const canRenewLease = (record.status === 'ACTIVE' || record.status === 'EXPIRED_RECOVERABLE') && hardRemainingMs > 60_000;
  let leaseState: 'ACTIVE' | 'WARNING' | 'EXPIRED_RECOVERABLE' | 'EXPIRED' = 'ACTIVE';
  const leaseWarnings: string[] = [];

  if (record.status === 'EXPIRED_RECOVERABLE') {
    leaseState = 'EXPIRED_RECOVERABLE';
    leaseWarnings.push('Workspace lease has expired. Work is retained in recoverable grace state.');
  } else if (record.status === 'CLOSED' || record.status === 'FAILED') {
    leaseState = 'EXPIRED';
  } else if (remainingLeaseMs <= 300_000 && record.status === 'ACTIVE') {
    leaseState = 'WARNING';
    leaseWarnings.push(`Workspace idle lease expiring in ${Math.round(remainingLeaseMs / 1000)}s.`);
  }

  if (hardRemainingMs <= 600_000 && hardRemainingMs > 0 && record.status === 'ACTIVE') {
    leaseWarnings.push(`Workspace approaching hard deadline in ${Math.round(hardRemainingMs / 1000)}s.`);
  }

  return {
    workspaceId: record.id,
    repositoryUrl: record.repositoryUrl,
    ref: record.repositoryRef,
    status: record.status,
    networkMode: record.networkMode,
    createdAt: new Date(record.createdAt).toISOString(),
    lastActivityAt: new Date(record.lastActivityAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    idleExpiresAt: new Date(record.expiresAt).toISOString(),
    hardExpiresAt: new Date(record.hardExpiresAt).toISOString(),
    remainingLeaseMs,
    canRenewLease,
    leaseState,
    availableActions: availableLifecycleActions(record.status, canRenewLease),
    ...(leaseWarnings.length > 0 ? { leaseWarnings } : {}),
    error: record.error
  };
}

function internalWorkspaceDetail(record: WorkspaceRecord) {
  return { ...publicRecord(record), generation: record.generation };
}

export class WorkspaceService {
  private readonly operations = new OperationManager();
  private readonly instanceId: string;
  private reaper?: NodeJS.Timeout;
  private reaperRunning = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly store: StateStore,
    private readonly metadata?: MetadataStore,
    private readonly githubInstallations?: GitHubInstallationStore,
    private readonly githubBinding?: GitHubBindingService
  ) {
    this.instanceId = store.instanceId();
    this.operations.onTaskStart = (wsId, timeoutMs) => {
      const rec = this.store.byId(wsId);
      if (rec) this.store.refreshMutationLock(rec.id, Date.now() + timeoutMs + 10_000, rec.generation);
    };
    this.operations.onTaskSettle = (wsId) => {
      const rec = this.store.byId(wsId);
      if (rec) this.store.clearMutationLock(rec.id, rec.generation);
    };
  }

  async start(): Promise<void> {
    if ((this.config.authMode ?? 'owner-bearer') === 'cloudflare-access') {
      const legacyOwners = this.store.legacyWorkspaceOwnerIds();
      if (legacyOwners.length > 0 && !this.config.legacyPrincipalMapping) {
        throw new Error('cloudflare-access mode requires an exact legacy principal mapping before startup');
      }
      if (this.config.legacyPrincipalMapping) this.store.applyLegacyPrincipalMapping(this.config.legacyPrincipalMapping);
      this.store.applyPrincipalRelinks(this.config.principalRelinks ?? [], (database, result) => {
        if (!this.metadata) throw new Error('principal relink audit store is unavailable');
        this.metadata.recordAuditInTransaction(
          database,
          result.principalId,
          'principal.relinked',
          'principal',
          result.principalId,
          1,
          { oldIssuer: result.oldIssuer, newIssuer: result.newIssuer }
        );
      });
    }
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
      if (!record || (!activeStatus.has(record.status) && record.status !== 'EXPIRED_RECOVERABLE')) {
        await this.safeRemovePath(join(this.config.jobsRoot, entry.name));
      }
    }
  }

  private async ensureCapacity(ownerId: string): Promise<void> {
    const list = this.store.list(ownerId);
    const active = list.filter((record) => activeStatus.has(record.status));
    const now = Date.now();
    for (const record of active) {
      if (record.status === 'ACTIVE' && (record.expiresAt <= now || record.hardExpiresAt <= now)) {
        const claimed = this.store.claimForExpiry(record.id, record.generation);
        if (claimed) {
          if (claimed.containerName) {
            await removeContainer(claimed.containerName).catch(() => undefined);
          }
          this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], {
            status: 'EXPIRED_RECOVERABLE',
            containerName: null,
            lastActivityAt: now
          });
        }
      }
    }
    const remainingActive = this.store.list(ownerId).filter((record) => activeStatus.has(record.status));
    if (remainingActive.length > 0) {
      throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
    }
    const info = await statfs(this.config.jobsRoot);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    if (freeBytes < this.config.minFreeBytes) throw new HarnessError('LIMIT_EXCEEDED', 'host free-space reserve would be violated', 507, true);
  }

  private async workspaceBytes(record: WorkspaceRecord): Promise<number | undefined> {
    let result;
    if (record.containerName) {
      result = await runDocker(
        ['exec', record.containerName, '/usr/bin/du', '-sb', '--apparent-size', '/workspace', '/opt/user-tools', '/var/cache/harness'],
        { timeoutMs: 30_000, maxBytes: 8_192 }
      );
    }
    if (!result || result.exitCode !== 0) {
      const helperName = `chm-size-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
      try {
        result = await runDocker([
          'run', '--rm', '--pull', 'never', '--name', helperName,
          '--label', 'cloud-harness.role=size-helper', '--label', 'cloud-harness.ephemeral=true',
          '--label', `cloud-harness.instance=${this.instanceId}`, '--label', `cloud-harness.workspace=${record.id}`,
          '--network', 'none', '--user', '0:0', '--read-only',
          '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25',
          '--volume', `${record.workspacePath}:/target:ro`, '--entrypoint', '/usr/bin/du', this.config.executorImage,
          '-sb', '--apparent-size', '/target'
        ], { timeoutMs: 30_000, maxBytes: 8_192 });
      } finally {
        await removeContainer(helperName);
      }
    }
    if (result.exitCode !== 0) return undefined;
    const lines = result.stdout.trim().split('\n');
    let totalBytes = 0;
    for (const line of lines) {
      const bytes = Number(line.trim().split(/\s+/, 1)[0]);
      if (Number.isSafeInteger(bytes) && bytes >= 0) {
        totalBytes += bytes;
      }
    }
    return totalBytes >= 0 ? totalBytes : undefined;
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
    const repositoryPath = join(jobPath, 'repo');
    const helperName = `chm-clone-${record.id.slice(3, 15)}`;
    await mkdir(jobPath, { recursive: true, mode: 0o700 });
    await chmod(jobPath, 0o777);
    const args = [
      'run', '-i', '--rm', '--pull', 'never', '--name', helperName,
      '--label', 'cloud-harness.role=clone-helper', '--label', 'cloud-harness.ephemeral=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`, '--network', 'bridge', '--user', '10001:10001',
      '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
      '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
      '--volume', `${jobPath}:/job`, '--entrypoint', '/opt/harness/clone-helper.sh', this.config.executorImage,
      record.repositoryUrl, '/job/repo', ref ?? ''
    ];
    const runClone = async (token: string | undefined) => {
      try {
        return await runDocker(args, { stdin: `${token ?? ''}\n`, timeoutMs: 120_000, maxBytes: this.config.maxOutputBytes });
      } finally {
        await removeContainer(helperName);
      }
    };

    let repositoryToken = await this.repositoryToken(record.ownerId, repositoryUrl, 'read');
    let result = await runClone(repositoryToken);
    if (result.exitCode !== 0 && !repositoryToken) {
      const refreshedToken = await this.refreshRepositoryToken(record.ownerId, repositoryUrl);
      if (refreshedToken) {
        await this.safeRemovePath(repositoryPath);
        repositoryToken = refreshedToken;
        result = await runClone(repositoryToken);
      }
    }
    if (result.exitCode !== 0) throw new HarnessError('UNAVAILABLE', `repository clone failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
    return repositoryPath;
  }

  private async refreshRepositoryToken(ownerId: string, repositoryUrl: URL, permission: 'read' | 'write' = 'read'): Promise<string | undefined> {
    if ((this.config.authMode ?? 'owner-bearer') !== 'cloudflare-access') return undefined;
    if (!this.githubInstallations || !this.githubBinding || !this.config.githubApp) return undefined;
    if (repositoryUrl.hostname.toLowerCase() !== 'github.com') return undefined;
    const repositoryOwner = repositoryUrl.pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase();
    const installation = this.githubInstallations.listInstallations(ownerId).find((candidate) =>
      candidate.status !== 'uninstalled' && candidate.accountLogin.toLowerCase() === repositoryOwner
    );
    if (!installation) return undefined;
    const audit = this.metadata
      ? (record: GitHubInstallationRecord) => this.metadata!.recordAuditInTransaction(
          this.store.database,
          ownerId,
          record.status === 'uninstalled' ? 'github.uninstalled' : 'github.reconciled',
          'github_installation',
          record.installationId,
          record.generation,
          { status: record.status }
        )
      : undefined;
    await this.githubBinding.reconcile(ownerId, audit, installation.installationId);
    return await mintPrincipalRepositoryToken({
      config: this.config,
      principalId: ownerId,
      repositoryUrl,
      installations: this.githubInstallations,
      requiredPermission: permission
    });
  }

  private async provisionMountDirectories(record: WorkspaceRecord): Promise<{ toolsPath: string; cachePath: string }> {
    const jobPath = record.workspacePath;
    const toolsPath = join(jobPath, 'tools');
    const cachePath = join(jobPath, 'cache');
    await mkdir(toolsPath, { recursive: true, mode: 0o755 });
    await mkdir(cachePath, { recursive: true, mode: 0o755 });
    try {
      await chown(toolsPath, 10001, 10001);
      await chown(cachePath, 10001, 10001);
      await chmod(toolsPath, 0o755);
      await chmod(cachePath, 0o755);
    } catch {
      const helperName = `chm-chown-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
      try {
        const result = await runDocker([
          'run', '--rm', '--pull', 'never', '--name', helperName,
          '--label', 'cloud-harness.role=chown-helper', '--label', 'cloud-harness.ephemeral=true',
          '--label', `cloud-harness.instance=${this.instanceId}`, '--label', `cloud-harness.workspace=${record.id}`,
          '--network', 'none', '--user', '0:0',
          '--volume', `${jobPath}:/job`,
          '--entrypoint', '/bin/sh', this.config.executorImage,
          '-c', 'mkdir -p /job/tools /job/cache && chown -R 10001:10001 /job/tools /job/cache && chmod 0755 /job/tools /job/cache'
        ], { timeoutMs: 30_000, maxBytes: 8_192 });
        if (result.exitCode !== 0) {
          throw new HarnessError('UNAVAILABLE', `mount directory provisioning failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
        }
      } finally {
        await removeContainer(helperName);
      }
    }
    return { toolsPath, cachePath };
  }

  private async createExecutor(record: WorkspaceRecord, repositoryPath: string, environment: Record<string, string> = {}): Promise<string> {
    const name = `cloud-harness-ws-${record.id.slice(3, 19).toLowerCase()}`;
    await removeContainer(name).catch(() => undefined);
    const { toolsPath, cachePath } = await this.provisionMountDirectories(record);
    const args = [
      'create', '--name', name,
      '--label', 'cloud-harness.managed=true', '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`,
      '--user', '10001:10001', '--workdir', '/workspace', '--read-only',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024',
      '--network', record.networkMode,
      '--volume', `${repositoryPath}:/workspace:rw`,
      '--volume', `${toolsPath}:/opt/user-tools:rw`,
      '--volume', `${cachePath}:/var/cache/harness:rw`,
      '--env', 'HOME=/tmp/cloud-harness-home',
      '--env', 'GIT_CONFIG_NOSYSTEM=1',
      '--env', 'XDG_CONFIG_HOME=/tmp/cloud-harness-home/.config',
      '--env', 'XDG_CACHE_HOME=/var/cache/harness',
      '--env', 'XDG_DATA_HOME=/opt/user-tools/data',
      '--env', 'NPM_CONFIG_PREFIX=/opt/user-tools',
      '--env', 'NPM_CONFIG_CACHE=/var/cache/harness/npm',
      '--env', 'UV_CACHE_DIR=/var/cache/harness/uv',
      '--env', 'BUN_INSTALL=/opt/user-tools/bun',
      '--env', 'PNPM_HOME=/opt/user-tools/pnpm',
      '--env', 'UV_TOOL_BIN_DIR=/opt/user-tools/bin',
      '--env', 'PATH=/workspace/node_modules/.bin:/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
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

  private async ensureActiveExecutor(record: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (record.containerName) {
      const inspected = await inspectContainer(record.containerName);
      if (inspected) {
        const state = inspected.State as { Running?: boolean } | undefined;
        if (state?.Running) {
          return record;
        }
        const started = await runDocker(['start', record.containerName], { timeoutMs: 30_000 });
        if (started.exitCode === 0) {
          return record;
        }
      }
      await removeContainer(record.containerName).catch(() => undefined);
    }
    const repositoryPath = join(record.workspacePath, 'repo');
    const repoExists = await stat(repositoryPath).then(() => true).catch(() => false);
    if (!repoExists) {
      throw new HarnessError('EXPIRED', 'workspace repository data is no longer retained on disk and cannot be recovered', 410);
    }
    const containerName = await this.createExecutor(record, repositoryPath, {});
    const updated = this.store.updateFenced(record.id, record.generation, ['ACTIVE', 'EXPIRED_RECOVERABLE'], {
      containerName
    });
    if (!updated) {
      await removeContainer(containerName).catch(() => undefined);
      throw new HarnessError('CONFLICT', 'workspace lifecycle changed during executor activation', 409, true);
    }
    return updated;
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
    const hardExpiresAt = now + this.config.wallTtlSeconds * 1_000;
    const record: WorkspaceRecord = {
      id: workspaceId, ownerId, idempotencyKey: parsed.idempotencyKey, repositoryUrl: url.toString(),
      repositoryRef: parsed.ref ?? null, containerName: null, workspacePath: join(this.config.jobsRoot, workspaceId),
      status: 'CREATING', networkMode: parsed.networkMode ?? this.config.networkMode, createdAt: now,
      lastActivityAt: now, expiresAt: this.expiry(now, now), hardExpiresAt, gitAuthorName: null, gitAuthorEmail: null,
      mutationLockedUntil: null, generation: 1, error: null
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
      let environment: Record<string, string> | undefined = {};
      try {
        environment = parsed.environmentId ? this.metadata?.environmentValues(ownerId, parsed.environmentId) : {};
      } catch {
        throw new HarnessError('UNAVAILABLE', 'Workspace secret injection is temporarily unavailable', 503, false);
      }
      if (parsed.environmentId && !environment) throw new HarnessError('NOT_FOUND', 'environment not found', 404, false);
      const repositoryPath = await this.clone(record, url, parsed.ref);
      const cloneViolation = await this.resourceViolation(record);
      if (cloneViolation) throw new HarnessError('LIMIT_EXCEEDED', cloneViolation, 507, false);
      const containerName = await this.createExecutor(record, repositoryPath, validatedWorkspaceEnvironment(environment ?? {}));
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

  status(ownerId: string, workspaceId?: string): RunnerResponse {
    const record = this.requireWorkspace(ownerId, workspaceId, false, true);
    return { ok: true, message: 'Workspace status', data: publicRecord(record), truncated: false };
  }

  private requireWorkspace(ownerId: string, workspaceId?: string, active = true, allowRecoverable = false): WorkspaceRecord {
    let record: WorkspaceRecord;
    try {
      record = this.store.resolveActiveWorkspace(ownerId, workspaceId);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === 'NO_ACTIVE_WORKSPACE' || err.message === 'NOT_FOUND') {
          throw new HarnessError('NOT_FOUND', 'workspace not found', 404);
        }
        if (err.message === 'AMBIGUOUS_ACTIVE_WORKSPACES') {
          const list = this.store.list(ownerId).filter((w) => w.status === 'ACTIVE' || w.status === 'CREATING');
          throw new HarnessError('CONFLICT', `Multiple active workspaces found (${list.map((w) => w.id).join(', ')}). Specify workspaceId or set active workspace.`, 409);
        }
        if (err.message === 'FORBIDDEN') {
          throw new HarnessError('FORBIDDEN', 'workspace access not authorized', 403);
        }
      }
      throw new HarnessError('NOT_FOUND', `workspace ${workspaceId ?? ''} not found`, 404);
    }
    if (record.status === 'EXPIRED_RECOVERABLE') {
      if (allowRecoverable) return record;
      throw new HarnessError('EXPIRED', 'workspace is expired and in recoverable grace state; use workspace_recover or workspace_lease_renew', 410);
    }
    if (active && record.status !== 'ACTIVE') {
      throw new HarnessError(record.status === 'CLOSED' ? 'EXPIRED' : 'CONFLICT', `workspace is ${record.status.toLowerCase()}`, 409);
    }
    if (active && record.status === 'ACTIVE' && (record.expiresAt <= Date.now() || record.hardExpiresAt <= Date.now())) {
      const now = Date.now();
      const claimed = this.store.claimForExpiry(record.id, record.generation);
      if (claimed) {
        if (claimed.containerName) {
          void removeContainer(claimed.containerName).catch(() => undefined);
        }
        this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], { status: 'EXPIRED_RECOVERABLE', containerName: null, lastActivityAt: now });
        throw new HarnessError('EXPIRED', 'workspace expired', 410);
      }
      return this.store.byId(record.id) ?? record;
    }
    return record;
  }

  private touch(record: WorkspaceRecord): WorkspaceRecord {
    if (record.status === 'EXPIRED_RECOVERABLE') return record;
    const now = Date.now();
    const touched = this.store.updateFenced(record.id, record.generation, ['ACTIVE'], {
      lastActivityAt: now,
      expiresAt: this.expiry(record.createdAt, now)
    });
    if (!touched) throw new HarnessError('EXPIRED', 'workspace lifecycle changed', 410);
    return touched;
  }

  private async withMutationLease<T>(record: WorkspaceRecord, action: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const now = Date.now();
    const holdDuration = Math.max(600_000, (timeoutMs ?? 600_000) + 30_000);
    const holdExpiry = Math.min(record.hardExpiresAt + holdDuration, Math.max(record.expiresAt, now + holdDuration));
    try {
      this.store.acquireMutationLease(record.id, record.generation, holdExpiry);
    } catch {
      throw new HarnessError('EXPIRED', 'workspace lifecycle changed or is no longer active', 410);
    }
    let actionSucceeded = false;
    try {
      const result = await action();
      actionSucceeded = true;
      return result;
    } finally {
      this.store.releaseMutationLease(record.id, record.generation);
      if (actionSucceeded) {
        this.touch(record);
      }
    }
  }

  private async runWorker(record: WorkspaceRecord, operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    if (!record.containerName) throw new HarnessError('UNAVAILABLE', 'workspace executor is unavailable', 503, true);
    const containerName = record.containerName;
    const timeout = typeof input.timeoutMs === 'number' ? input.timeoutMs + 5_000 : 65_000;
    const operationId = (typeof input.operationId === 'string' && input.operationId) || opaqueId('op');
    const pidFile = `/tmp/cloud-harness-operations/${operationId}.pid`;
    const jsonMaxBytes = Math.min(67_108_864, Math.max(this.config.maxOutputBytes, 262_144) * 6 + 8_192);
    this.operations.registerGenericOperation({
      id: operationId,
      workspaceId: record.id,
      kind: operation,
      deadlineMs: Date.now() + timeout,
      container: containerName
    });

    let result;
    try {
      result = await runDocker([
        'exec', '-i', containerName, '/usr/bin/setsid', '--wait', '/opt/harness/worker-runner.sh', operationId
      ], {
        stdin: JSON.stringify({ operation, input }), timeoutMs: Math.min(timeout, 305_000), maxBytes: jsonMaxBytes,
        abortKillGraceMs: 2_000,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      this.operations.updateGenericOperation(operationId, {
        status: signal?.aborted ? 'cancelled' : 'failed',
        error: { code: signal?.aborted ? 'CANCELLED' : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'worker failed', retryable: false }
      });
      if (signal?.aborted) {
        await terminateContainerProcessGroup(containerName, pidFile);
        throw new HarnessError('CANCELLED', 'request cancelled', 499, false);
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      this.operations.updateGenericOperation(operationId, {
        status: 'failed',
        error: { code: 'INTERNAL_ERROR', message: result.stderr || result.stdout || 'worker failed', retryable: true }
      });
      throw new HarnessError('INTERNAL_ERROR', `worker failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 500, true);
    }
    try {
      const parsed = RunnerResponseSchema.parse(JSON.parse(result.stdout));
      this.operations.updateGenericOperation(operationId, {
        status: parsed.ok ? 'completed' : 'failed',
        result: parsed.data,
        error: parsed.error
      });
      return {
        ...parsed,
        data: parsed.data && typeof parsed.data === 'object' ? { ...parsed.data, operationId } : parsed.data
      };
    } catch {
      this.operations.updateGenericOperation(operationId, {
        status: 'failed',
        error: { code: 'INTERNAL_ERROR', message: 'worker returned an invalid bounded result', retryable: true }
      });
      throw new HarnessError('INTERNAL_ERROR', 'worker returned an invalid bounded result', 500, true);
    }
  }

  private async runRecoveryWorker(
    record: WorkspaceRecord,
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    writable = false
  ): Promise<RunnerResponse> {
    if (record.containerName) {
      return await this.runWorker(record, operation, input, signal);
    }
    const helperName = `chm-rec-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
    const mode = writable ? 'rw' : 'ro';
    const jsonMaxBytes = Math.min(67_108_864, Math.max(this.config.maxOutputBytes, 262_144) * 6 + 8_192);
    try {
      const result = await runDocker([
        'run', '-i', '--rm', '--name', helperName,
        '--label', 'cloud-harness.role=recover-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.instanceId}`, '--label', `cloud-harness.workspace=${record.id}`,
        '--network', 'none', '--user', '10001:10001',
        '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m',
        '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
        '--volume', `${record.workspacePath}/repo:/workspace:${mode}`,
        '--workdir', '/workspace',
        '--env', 'HOME=/tmp/cloud-harness-home',
        '--entrypoint', '/opt/harness/worker-runner.sh',
        this.config.executorImage,
        opaqueId('rec')
      ], {
        stdin: JSON.stringify({ operation, input }),
        timeoutMs: 60_000,
        maxBytes: jsonMaxBytes,
        ...(signal ? { signal } : {})
      });
      if (result.exitCode !== 0) throw new HarnessError('INTERNAL_ERROR', `recovery worker failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 500, true);
      return RunnerResponseSchema.parse(JSON.parse(result.stdout));
    } finally {
      await removeContainer(helperName);
    }
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
        'run', '-i', '--rm', '--pull', 'never', '--name', helperName,
        '--label', 'cloud-harness.role=git-transfer-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.instanceId}`, '--label', `cloud-harness.workspace=${record.id}`,
        '--network', network, '--user', '10001:10001', '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
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
    if (record.containerName) {
      const result = await runDocker([
        'exec', record.containerName, 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', 'branch', '--show-current'
      ], { timeoutMs: 30_000, maxBytes: 8_192, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new HarnessError('CONFLICT', 'current Git branch could not be determined', 409, false);
      return result.stdout.trim();
    }
    const helperName = `chm-br-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
    try {
      const result = await runDocker([
        'run', '--rm', '--name', helperName,
        '--label', 'cloud-harness.ephemeral=true',
        '--network', 'none', '--user', '10001:10001', '--read-only',
        '--volume', `${record.workspacePath}/repo:/workspace:ro`,
        '--workdir', '/workspace',
        '--entrypoint', 'git',
        this.config.executorImage,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', 'branch', '--show-current'
      ], { timeoutMs: 30_000, maxBytes: 8_192, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new HarnessError('CONFLICT', 'current Git branch could not be determined', 409, false);
      return result.stdout.trim();
    } finally {
      await removeContainer(helperName);
    }
  }

  private async remoteFetch(record: WorkspaceRecord, remoteRef: string | undefined, signal?: AbortSignal) {
    const repositoryUrl = await validateRepositoryUrl(record.repositoryUrl, this.config.allowedGitHosts);
    const token = await this.repositoryToken(record.ownerId, repositoryUrl, 'read');
    const transferName = `git-transfer-${randomBytes(12).toString('hex')}`;
    try {
      const fetched = await this.runGitTransferHelper(record, 'fetch', transferName, remoteRef ?? '', token, undefined, signal);
      const imported = record.containerName
        ? await this.withPausedExecutor(record, async () =>
            await this.runGitTransferHelper(record, 'import', transferName, remoteRef ?? '', undefined, undefined, signal)
          )
        : await this.runGitTransferHelper(record, 'import', transferName, remoteRef ?? '', undefined, undefined, signal);
      return { fetched, imported };
    } finally {
      await this.safeRemovePath(join(record.workspacePath, transferName));
    }
  }

  private async remotePush(record: WorkspaceRecord, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    const repositoryUrl = await validateRepositoryUrl(record.repositoryUrl, this.config.allowedGitHosts);
    const token = await this.repositoryToken(record.ownerId, repositoryUrl, 'write');
    if (!token) throw new HarnessError('UNAVAILABLE', 'Git push requires a configured GitHub App with repository write access', 503, false);
    const requestedRefspec = input.refspec as string | undefined;
    const branch = requestedRefspec ? '' : await this.currentBranch(record, signal);
    if (!requestedRefspec && !branch) throw new HarnessError('CONFLICT', 'git_push requires refspec when HEAD is detached', 409, false);
    const refspec = normalizePushRefspec(requestedRefspec, branch);
    const transferName = `git-transfer-${randomBytes(12).toString('hex')}`;
    try {
      if (record.containerName) {
        await this.withPausedExecutor(record, async () =>
          await this.runGitTransferHelper(record, 'stage-push', transferName, '', undefined, undefined, signal)
        );
      } else {
        await this.runGitTransferHelper(record, 'stage-push', transferName, '', undefined, undefined, signal);
      }
      const pushed = await this.runGitTransferHelper(record, 'push', transferName, refspec, token, input.expectedRemoteOid as string | undefined, signal);
      return { ok: true, message: 'Git push complete', data: { output: pushed.stdout || pushed.stderr, refspec }, truncated: pushed.truncated };
    } finally {
      await this.safeRemovePath(join(record.workspacePath, transferName));
    }
  }

  private async handleExecRun(record: WorkspaceRecord, validated: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    const command = validated.command as string;
    const cwd = ((validated.cwd as string) || '.').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '') || '.';
    const timeoutMs = (validated.timeoutMs as number) || 60_000;
    const maxOutputBytes = (validated.maxOutputBytes as number) || this.config.maxOutputBytes;
    const privileged = Boolean(validated.privileged);
    const approvalGrantToken = validated.approvalGrantToken as string | undefined;

    if (privileged) {
      if ((this.config.authMode ?? 'owner-bearer') === 'owner-bearer') {
        throw new HarnessError('FORBIDDEN', 'Privileged execution requires Cloudflare Access operator dashboard approval and is disabled in owner-bearer mode', 403, false);
      }
      const commandSha256 = createHash('sha256').update(command).digest('hex');
      if (!approvalGrantToken) {
        const grant = this.store.createPrivilegeGrant({
          ownerId: record.ownerId,
          workspaceId: record.id,
          command,
          cwd,
          ttlMs: 60_000
        });

        return {
          ok: false,
          message: 'Privileged execution requires explicit operator approval grant',
          error: {
            code: 'PRIVILEGE_APPROVAL_REQUIRED',
            message: `Approval grant required to execute privileged command on workspace ${record.id}`,
            grantRequest: {
              grantId: grant.id,
              workspaceId: grant.workspaceId,
              commandSha256: grant.commandSha256,
              cwd: grant.cwd,
              expiresAt: new Date(grant.expiresAt).toISOString()
            },
            retryable: true
          },
          truncated: false
        };
      }

      const grantValid = this.store.consumePrivilegeGrant({
        ownerId: record.ownerId,
        workspaceId: record.id,
        grantId: approvalGrantToken,
        commandSha256,
        cwd
      });

      if (!grantValid) {
        throw new HarnessError('FORBIDDEN', 'Invalid, expired, or already-consumed approval grant token', 403);
      }

      return await this.runPrivilegedEphemeralExec(record, { command, cwd, timeoutMs, maxOutputBytes }, signal);
    }
    if (validated.async === true) {
      const operationId = opaqueId('op');
      const serverAbortController = new AbortController();
      this.operations.registerGenericOperation({
        id: operationId,
        workspaceId: record.id,
        kind: 'exec_run',
        deadlineMs: Date.now() + timeoutMs,
        container: record.containerName ?? undefined,
        abortController: serverAbortController
      });
      const lockExpiry = Date.now() + timeoutMs + 10_000;
      this.store.setMutationLock(record.id, lockExpiry, record.generation);
      let timedOut = false;
      const deadlineTimer = setTimeout(() => {
        timedOut = true;
        serverAbortController.abort();
        this.operations.updateGenericOperation(operationId, {
          status: 'failed',
          error: {
            code: 'TIMEOUT',
            message: 'Command execution exceeded server deadline',
            retryable: false,
            retryAfterMs: 5000,
            deadline: new Date(Date.now()).toISOString()
          }
        });
      }, timeoutMs);
      deadlineTimer.unref();

      void (async () => {
        try {
          const result = await this.runWorker(record, 'exec_run', { ...validated, async: false }, serverAbortController.signal);
          clearTimeout(deadlineTimer);
          if (!timedOut) {
            this.operations.updateGenericOperation(operationId, {
              status: result.ok ? 'completed' : 'failed',
              result: result.data,
              error: result.error
            });
          }
        } catch (err: unknown) {
          clearTimeout(deadlineTimer);
          if (!timedOut) {
            this.operations.updateGenericOperation(operationId, {
              status: serverAbortController.signal.aborted ? 'cancelled' : 'failed',
              error: { code: serverAbortController.signal.aborted ? 'CANCELLED' : 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'command failed', retryable: false }
            });
          }
        } finally {
          this.store.clearMutationLock(record.id, record.generation);
        }
      })();
      return {
        ok: true,
        message: 'Command started in background',
        data: { operationId, status: 'running' },
        truncated: false
      };
    }

    return await this.runWorker(record, 'exec_run', validated, signal);
  }
  private async runPrivilegedEphemeralExec(
    record: WorkspaceRecord,
    input: { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number },
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    const privName = `chm-priv-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
    const toolsPath = join(record.workspacePath, 'tools');
    const cachePath = join(record.workspacePath, 'cache');
    const normalizedCwd = input.cwd.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '') || '.';
    const workdir = normalizedCwd === '.' ? '/workspace' : `/workspace/${normalizedCwd}`;
    try {
      const result = await runDocker([
        'run', '-i', '--rm', '--name', privName,
        '--label', 'cloud-harness.managed=true',
        '--label', `cloud-harness.instance=${this.instanceId}`,
        '--label', `cloud-harness.workspace=${record.id}`,
        '--label', 'cloud-harness.role=priv-exec',
        '--label', 'cloud-harness.ephemeral=true',
        '--network', record.networkMode,
        '--user', '0:0',
        '--workdir', workdir,
        '--pids-limit', '256',
        '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m',
        '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
        '--volume', `${record.workspacePath}/repo:/workspace:rw`,
        '--volume', `${toolsPath}:/opt/user-tools:rw`,
        '--volume', `${cachePath}:/var/cache/harness:rw`,
        '--env', 'HOME=/tmp/cloud-harness-home',
        '--env', 'BUN_INSTALL=/opt/user-tools/bun',
        '--env', 'PNPM_HOME=/opt/user-tools/pnpm',
        '--env', 'UV_TOOL_BIN_DIR=/opt/user-tools/bin',
        '--env', 'PATH=/workspace/node_modules/.bin:/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '--entrypoint', '/bin/bash',
        this.config.executorImage,
        '-c', input.command
      ], {
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxOutputBytes,
        ...(signal ? { signal } : {})
      });

      return {
        ok: result.exitCode === 0,
        message: result.exitCode === 0 ? 'Privileged execution completed successfully' : `Privileged execution failed with exit code ${result.exitCode}`,
        data: { output: result.stdout || result.stderr, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
        truncated: result.truncated
      };
    } finally {
      await removeContainer(privName);
    }
  }

  private async runBrokeredGitHubAction(
    record: WorkspaceRecord,
    action: string,
    args: string[],
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    const isWrite = ['pr_create', 'pr_update', 'pr_comment', 'issue_create', 'issue_comment', 'issue_comment_update', 'label_create', 'issue_labels_add', 'issue_labels_remove', 'issue_update', 'issue_publish'].includes(action);
    const permissionScope = action.startsWith('pr_') ? 'pull_requests' : 'issues';

    const token = await mintPrincipalRepositoryScopedToken({
      config: this.config,
      principalId: record.ownerId,
      repositoryUrl: new URL(record.repositoryUrl),
      installations: this.githubInstallations,
      permissionScope,
      requiredPermission: isWrite ? 'write' : 'read'
    });
    if (!token) {
      throw new HarnessError('FORBIDDEN', `No GitHub App installation available for ${record.repositoryUrl}`, 403);
    }

    const helperName = `chm-gh-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
    try {
      const result = await runDocker([
        'run', '-i', '--rm', '--name', helperName,
        '--label', 'cloud-harness.managed=true',
        '--label', `cloud-harness.instance=${this.instanceId}`,
        '--label', `cloud-harness.workspace=${record.id}`,
        '--label', 'cloud-harness.role=gh-helper',
        '--label', 'cloud-harness.ephemeral=true',
        '--network', 'bridge',
        '--user', '10001:10001',
        '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '64',
        '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
        '--ulimit', 'nofile=1024:1024',
        '--volume', `${record.workspacePath}/repo:/workspace:ro`,
        '--workdir', '/workspace',
        '--env', 'HOME=/tmp/cloud-harness-home',
        '--env', `GH_REPO=${new URL(record.repositoryUrl).pathname.replace(/^\//, '').replace(/\.git$/, '')}`,
        '--entrypoint', '/opt/harness/gh-helper.sh',
        this.config.executorImage,
        action,
        ...args
      ], {
        stdin: `${token}\n`,
        timeoutMs: 60_000,
        maxBytes: this.config.maxOutputBytes,
        ...(signal ? { signal } : {})
      });

      return {
        ok: result.exitCode === 0,
        message: (result.exitCode === 0 ? `GitHub ${action} successful` : `GitHub ${action} failed: ${result.stderr}`).slice(0, 2_000),
        data: { output: result.stdout || result.stderr },
        truncated: result.truncated
      };
    } finally {
      await removeContainer(helperName);
    }
  }

  async execute(principal: PrincipalSelector | string, operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    const ownerId = this.store.resolvePrincipal(typeof principal === 'string' ? { kind: 'owner', ownerId: principal } : principal);
    RunnerOperationSchema.parse(operation);
    const validated = TOOL_SCHEMA_BY_NAME[operation].parse(input) as Record<string, unknown>;
    if (operation === 'workspace_open') return await this.open(ownerId, validated);
    if (operation === 'workspace_list') return this.list(ownerId, validated);
    if (operation === 'operation_status') {
      const opId = validated.operationId as string;
      const op = this.operations.getGenericOperation(opId);
      if (!op) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
      if (op.workspaceId) {
        const ws = this.store.byOwnerAndId(ownerId, op.workspaceId);
        if (!ws) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
      }
      const offset = validated.cursor ? Number(validated.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('INVALID_INPUT', 'invalid operation output cursor');
      const total = op.output.length;
      const end = Math.min(total, offset + 65_536);
      const page = op.output.subarray(offset, end).toString('utf8');
      const isTruncated = end < total;
      const isOk = op.status !== 'failed' && op.status !== 'cancelled';
      return {
        ok: isOk,
        message: `Operation ${op.status}`,
        data: {
          operationId: op.id,
          status: op.status,
          kind: op.kind,
          createdAt: new Date(op.createdAt).toISOString(),
          deadline: op.deadlineMs ? new Date(op.deadlineMs).toISOString() : undefined,
          finishedAt: op.finishedAt ? new Date(op.finishedAt).toISOString() : undefined,
          progress: op.progress,
          result: op.result,
          output: page
        },
        ...(op.error ? { error: op.error } : {}),
        ...(isTruncated ? { cursor: String(end) } : {}),
        truncated: isTruncated
      };
    }
    if (operation === 'operation_cancel') {
      const opId = validated.operationId as string;
      const existing = this.operations.getGenericOperation(opId);
      if (!existing) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
      if (existing.workspaceId) {
        const ws = this.store.byOwnerAndId(ownerId, existing.workspaceId);
        if (!ws) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
      }
      const op = await this.operations.cancelGenericOperation(opId);
      return {
        ok: true,
        message: 'Operation cancelled',
        data: {
          operationId: op.id,
          status: op.status
        },
        truncated: false
      };
    }
    if (operation === 'operation_wait') {
      const opId = validated.operationId as string;
      const existing = this.operations.getGenericOperation(opId);
      if (!existing) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
      if (existing.workspaceId) {
        const ws = this.store.byOwnerAndId(ownerId, existing.workspaceId);
        if (!ws) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
      }
      const timeoutMs = (validated.timeoutMs as number) || 60_000;
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        const op = this.operations.getGenericOperation(opId);
        if (!op) throw new HarnessError('NOT_FOUND', `operation ${opId} not found`);
        if (op.status === 'completed' || op.status === 'failed' || op.status === 'cancelled') {
          const isOk = op.status === 'completed';
          return {
            ok: isOk,
            message: `Operation ${op.status}`,
            data: {
              operationId: op.id,
              status: op.status,
              result: op.result,
              finishedAt: op.finishedAt ? new Date(op.finishedAt).toISOString() : undefined
            },
            ...(op.error ? { error: op.error } : {}),
            truncated: false
          };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return {
        ok: false,
        message: 'Operation wait timed out',
        error: {
          code: 'TIMEOUT',
          message: 'Operation did not reach terminal state within timeout',
          retryable: true,
          retryAfterMs: 2000,
          deadline: new Date(startTime + timeoutMs).toISOString()
        },
        truncated: false
      };
    }
    if (operation === 'workspace_set_active') {
      const targetId = validated.workspaceId as string;
      const targetRecord = this.store.byOwnerAndId(ownerId, targetId);
      if (!targetRecord) throw new HarnessError('NOT_FOUND', `workspace ${targetId} not found`);
      this.store.setPreferredWorkspace(ownerId, targetId);
      return {
        ok: true,
        message: 'Active workspace set',
        data: { activeWorkspaceId: targetId, workspace: publicRecord(targetRecord) },
        truncated: false
      };
    }
    if (operation === 'git_identity_status') {
      const identity = this.store.getGitIdentity(ownerId);
      return {
        ok: true,
        message: 'Git identity status',
        data: identity ? { ...identity, source: 'owner' } : {
          name: 'Cloud Harness Agent',
          email: 'agent@cloud-harness.local',
          source: 'default'
        },
        truncated: false
      };
    }
    if (operation === 'git_identity_set') {
      const name = validated.name as string;
      const email = validated.email as string;
      if (validated.workspaceId) {
        const ws = this.requireWorkspace(ownerId, validated.workspaceId as string, false, true);
        this.store.update(ws.id, { gitAuthorName: name, gitAuthorEmail: email });
      } else {
        this.store.setGitIdentity(ownerId, { name, email });
      }
      return {
        ok: true,
        message: 'Git identity configured',
        data: { name, email },
        truncated: false
      };
    }

    const workspaceId = validated.workspaceId as string | undefined;
    if (operation === 'workspace_status') return this.status(ownerId, workspaceId);
    if (operation === 'workspace_close') {
      const rec = this.requireWorkspace(ownerId, workspaceId, false, true);
      return await this.close(ownerId, rec.id);
    }
    if (operation === 'workspace_lease_renew') {
      const rec = this.requireWorkspace(ownerId, workspaceId, false, true);
      if (rec.status === 'CLOSED' || rec.status === 'FAILED') {
        throw new HarnessError('EXPIRED', `workspace is ${rec.status.toLowerCase()} and cannot be renewed`, 410);
      }
      if (rec.status === 'CREATING' || rec.status === 'REAPING') {
        throw new HarnessError('CONFLICT', `workspace is ${rec.status.toLowerCase()}`, 409, true);
      }
      const now = Date.now();
      if (rec.hardExpiresAt <= now) {
        throw new HarnessError('EXPIRED', 'Workspace hard lease limit reached and cannot be renewed', 410);
      }
      const isRecoverable = rec.status === 'EXPIRED_RECOVERABLE';
      if (isRecoverable) {
        const activeSiblings = this.store.list(ownerId).filter((w) => w.id !== rec.id && activeStatus.has(w.status));
        if (activeSiblings.length > 0) {
          throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
        }
        const holdExpiry = now + 300_000;
        try {
          this.store.acquireRecoverableMutationLease(rec.id, rec.generation, holdExpiry);
        } catch {
          throw new HarnessError('CONFLICT', 'workspace lifecycle changed or was reaped during renewal', 409);
        }
      }
      try {
        const extSec = (validated.extensionSeconds as number) ?? this.config.idleTtlSeconds;
        const newExpires = Math.min(rec.hardExpiresAt, now + extSec * 1000);
        let activeRecord = rec;
        if (isRecoverable) {
          activeRecord = await this.ensureActiveExecutor(rec);
        }
        let updated: WorkspaceRecord | undefined;
        try {
          updated = this.store.updateFenced(activeRecord.id, activeRecord.generation, ['ACTIVE', 'EXPIRED_RECOVERABLE'], {
            status: 'ACTIVE',
            lastActivityAt: now,
            expiresAt: newExpires
          });
        } catch (err) {
          if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
            throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
          }
          throw err;
        }
        if (!updated) {
          throw new HarnessError('CONFLICT', 'workspace lifecycle changed or was reaped during renewal', 409);
        }
        return { ok: true, message: 'Workspace lease renewed', data: publicRecord(updated), truncated: false };
      } finally {
        if (isRecoverable) {
          this.store.releaseMutationLease(rec.id, rec.generation);
        }
      }
    }
    if (operation === 'workspace_recover') {
      const rec = this.requireWorkspace(ownerId, workspaceId, false, true);
      if (rec.status === 'CLOSED' || rec.status === 'FAILED') {
        throw new HarnessError('EXPIRED', `workspace is ${rec.status.toLowerCase()} and cannot be recovered`, 410);
      }
      if (rec.status === 'CREATING' || rec.status === 'REAPING') {
        throw new HarnessError('CONFLICT', `workspace is ${rec.status.toLowerCase()}`, 409, true);
      }
      const mode = (validated.mode as 'resume' | 'status' | 'patch' | 'export') ?? 'resume';
      if (mode === 'resume') {
        const now = Date.now();
        if (rec.hardExpiresAt <= now) {
          throw new HarnessError('EXPIRED', 'Workspace hard lease limit reached and cannot be recovered to active state; use mode: export to save work', 410);
        }
        const isRecoverable = rec.status === 'EXPIRED_RECOVERABLE';
        if (isRecoverable) {
          const activeSiblings = this.store.list(ownerId).filter((w) => w.id !== rec.id && activeStatus.has(w.status));
          if (activeSiblings.length > 0) {
            throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
          }
          const holdExpiry = now + 300_000;
          try {
            this.store.acquireRecoverableMutationLease(rec.id, rec.generation, holdExpiry);
          } catch {
            throw new HarnessError('CONFLICT', 'workspace lifecycle changed or was reaped during recovery', 409);
          }
        }
        try {
          const activeRecord = await this.ensureActiveExecutor(rec);
          const extSec = this.config.idleTtlSeconds;
          const newExpires = Math.min(activeRecord.hardExpiresAt, now + extSec * 1000);
          let updated: WorkspaceRecord | undefined;
          try {
            updated = this.store.updateFenced(activeRecord.id, activeRecord.generation, ['ACTIVE', 'EXPIRED_RECOVERABLE'], {
              status: 'ACTIVE',
              lastActivityAt: now,
              expiresAt: newExpires
            });
          } catch (err) {
            if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
              throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
            }
            throw err;
          }
          if (!updated) {
            throw new HarnessError('CONFLICT', 'workspace lifecycle changed or was reaped during recovery', 409);
          }
          return {
            ok: true,
            message: 'Workspace recovered to active state',
            data: publicRecord(updated),
            truncated: false
          };
        } finally {
          if (isRecoverable) {
            this.store.releaseMutationLease(rec.id, rec.generation);
          }
        }
      }
      if (mode === 'status') {
        const recoverRes = await this.runRecoveryWorker(rec, 'workspace_recover', { mode: 'status' }, signal);
        return {
          ok: true,
          message: 'Workspace recovery status',
          data: {
            workspace: publicRecord(rec),
            ...(recoverRes.data && typeof recoverRes.data === 'object' ? recoverRes.data : {})
          },
          truncated: false
        };
      }
      if (mode === 'patch') {
        const patchRes = await this.runRecoveryWorker(rec, 'workspace_recover', { mode: 'patch' }, signal);
        return {
          ok: true,
          message: 'Workspace recovery patch',
          data: {
            workspace: publicRecord(rec),
            ...(patchRes.data && typeof patchRes.data === 'object' ? patchRes.data : {})
          },
          truncated: false
        };
      }
      if (mode === 'export') {
        const holdExpiry = Date.now() + 300_000;
        try {
          this.store.acquireRecoverableMutationLease(rec.id, rec.generation, holdExpiry);
        } catch {
          throw new HarnessError('CONFLICT', 'workspace lifecycle changed during export', 409);
        }
        try {
          const targetBranch = (validated.targetBranch as string | undefined) ?? await this.currentBranch(rec, signal);
          const snapshotRes = await this.runRecoveryWorker(rec, 'workspace_recover', {
            mode: 'snapshot_commit',
            message: `chore(recovery): export snapshot for ${targetBranch}`
          }, signal, true);
          if (!snapshotRes.ok) {
            return {
              ok: false,
              message: `Recovery snapshot failed: ${snapshotRes.message}`,
              data: { step: 'snapshot_commit', error: snapshotRes.message },
              error: { code: 'INTERNAL_ERROR', message: snapshotRes.message, retryable: true },
              truncated: false
            };
          }
          const snapshotData = snapshotRes.data as { headCommitSha?: string; committedChanges?: boolean } | undefined;
          const pushResult = await this.remotePush(rec, { refspec: `HEAD:refs/heads/${targetBranch}` }, signal);
          return {
            ok: pushResult.ok,
            message: pushResult.ok ? `Recovered work exported to ${targetBranch}` : 'Workspace export failed',
            data: {
              workspace: publicRecord(rec),
              branch: targetBranch,
              commitSha: snapshotData?.headCommitSha,
              committedChanges: snapshotData?.committedChanges,
              pushResult: pushResult.data
            },
            truncated: false
          };
        } finally {
          this.store.releaseMutationLease(rec.id, rec.generation);
        }
      }
    }

    const record = this.touch(this.requireWorkspace(ownerId, workspaceId, true, false));
    await this.enforceActiveLimits(record);

    const dispatchAction = async (): Promise<RunnerResponse> => {
    if (operation === 'workspace_context') {
      let branch = '';
      try {
        branch = await this.currentBranch(record, signal);
      } catch { /* branch resolution optional */ }
      const gitIdentity = this.store.getGitIdentity(ownerId) ?? {
        name: record.gitAuthorName || 'Cloud Harness Agent',
        email: record.gitAuthorEmail || 'agent@cloud-harness.local'
      };
      return {
        ok: true,
        message: 'Workspace context',
        data: {
          workspace: publicRecord(record),
          branch,
          gitIdentity
        },
        truncated: false
      };
    }
    if (operation === 'files_write_batch') {
      const idempotencyKey = validated.idempotencyKey as string | undefined;
      if (idempotencyKey) {
        const cached = this.store.getBatchWriteIdempotency(ownerId, record.id, idempotencyKey);
        if (cached) {
          return JSON.parse(cached) as RunnerResponse;
        }
      }
      const result = await this.runWorker(record, 'files_write_batch', validated, signal);
      await this.enforceActiveLimits(record);
      if (idempotencyKey && result.ok) {
        this.store.setBatchWriteIdempotency(ownerId, record.id, idempotencyKey, JSON.stringify(result));
      }
      return result;
    }
    if (operation === 'workspace_finalize') {
      const idempotencyKey = validated.idempotencyKey as string | undefined;
      if (idempotencyKey) {
        const cached = this.store.getFinalizeIdempotency(ownerId, record.id, idempotencyKey);
        if (cached) {
          return JSON.parse(cached) as RunnerResponse;
        }
      }
      // Step 1: Preflight checks
        const preflight = validated.preflight as { checkDiff?: boolean; forbiddenPatterns?: string[] } | undefined;
        if (preflight?.checkDiff !== false) {
          const diffResult = await this.runWorker(record, 'git_diff', { readAll: true }, signal);
          const diffOutput = (diffResult.data && typeof diffResult.data === 'object' && 'output' in diffResult.data && typeof diffResult.data.output === 'string') ? diffResult.data.output : '';
          if (diffResult.truncated) {
            return {
              ok: false,
              message: 'Preflight check failed: diff output too large to verify cleanly',
              data: { step: 'preflight', error: 'diff output exceeds preflight capacity' },
              error: { code: 'LIMIT_EXCEEDED', message: 'diff exceeds verification limit', retryable: false },
              truncated: false
            };
          }
          if (diffOutput.includes('<<<<<<< ') || diffOutput.includes('=======\n') || diffOutput.includes('>>>>>>> ')) {
            return {
              ok: false,
              message: 'Preflight check failed: unresolved merge conflict markers detected',
              data: { step: 'preflight', errors: ['Merge conflict markers found in working tree'] },
              error: { code: 'CONFLICT', message: 'Merge conflict markers detected', retryable: false },
              truncated: false
            };
          }
          if (preflight?.forbiddenPatterns) {
            for (const pat of preflight.forbiddenPatterns) {
              if (pat && diffOutput.includes(pat)) {
                return {
                  ok: false,
                  message: `Preflight check failed: forbidden pattern "${pat}" detected`,
                  data: { step: 'preflight', errors: [`Forbidden pattern "${pat}" found in diff`] },
                  error: { code: 'INVALID_INPUT', message: `Forbidden pattern "${pat}" detected`, retryable: false },
                  truncated: false
                };
              }
            }
          }
        }

        // Step 2: Check current git status
        const currentStatus = await this.runWorker(record, 'git_status', {}, signal);
        const statusOutput = (currentStatus.data && typeof currentStatus.data === 'object' && 'output' in currentStatus.data && typeof currentStatus.data.output === 'string') ? currentStatus.data.output : '';
        const changedLines = statusOutput.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('##'));
        const branch = (validated.branch as string | undefined) ?? await this.currentBranch(record, signal);

        // If tree is already clean, check if we need to push or if already finalized
        if (changedLines.length === 0) {
          const logResult = await this.runWorker(record, 'git_log', { limit: 1 }, signal);
          const commitSha = (logResult.data && typeof logResult.data === 'object' && 'output' in logResult.data && typeof logResult.data.output === 'string') ? logResult.data.output.split('\t')?.[0] || '' : '';
          let pushed = false;
          let pushResult: RunnerResponse | undefined;
          if (validated.push !== false) {
            try {
              pushResult = await this.remotePush(record, { refspec: `HEAD:refs/heads/${branch}` }, signal);
              pushed = Boolean(pushResult.ok);
            } catch (err: unknown) {
              const pushErrMsg = err instanceof Error ? err.message : 'push failed';
              return {
                ok: false,
                message: `Working tree clean but push failed: ${pushErrMsg}`,
                data: { step: 'push', commitSha, branch, pushed: false, pushError: pushErrMsg, resumeAction: 'Call git_push or workspace_finalize to retry push' },
                error: { code: 'UNAVAILABLE', message: pushErrMsg, retryable: true },
                truncated: false
              };
            }
          }
          const response: RunnerResponse = {
            ok: true,
            message: `Workspace already clean and finalized at ${commitSha.slice(0, 7)}`,
            data: { commitSha, branch, pushed, alreadyFinalized: true, finalStatus: currentStatus.data },
            truncated: false
          };
          if (idempotencyKey) {
            this.store.setFinalizeIdempotency(ownerId, record.id, idempotencyKey, JSON.stringify(response));
          }
          return response;
        }

        // Step 3: Stage changes
        const stageResult = await this.runWorker(record, 'git_add', {
          all: validated.all !== false && (!validated.paths || (validated.paths as string[]).length === 0),
          paths: (validated.paths as string[]) ?? []
        }, signal);
        if (!stageResult.ok) {
          return {
            ok: false,
            message: 'Failed to stage changes',
            data: { step: 'stage', error: stageResult.message },
            error: { code: 'CONFLICT', message: stageResult.message, retryable: true },
            truncated: false
          };
        }

        // Step 4: Resolve Git author & Commit
        const storedIdentity = this.store.getGitIdentity(ownerId);
        const authorName = (validated.authorName as string | undefined) || record.gitAuthorName || storedIdentity?.name || 'Cloud Harness Agent';
        const authorEmail = (validated.authorEmail as string | undefined) || record.gitAuthorEmail || storedIdentity?.email || 'agent@cloud-harness.local';

        const commitMsg = validated.commitMessage as string;
        const commitResult = await this.runWorker(record, 'git_commit', {
          message: commitMsg,
          authorName,
          authorEmail,
          all: false
        }, signal);
        if (!commitResult.ok) {
          return {
            ok: false,
            message: `Commit failed: ${commitResult.message}`,
            data: { step: 'commit', error: commitResult.message },
            error: { code: 'CONFLICT', message: commitResult.message, retryable: true },
            truncated: false
          };
        }

        const logResult = await this.runWorker(record, 'git_log', { limit: 1 }, signal);
        const commitSha = (logResult.data && typeof logResult.data === 'object' && 'output' in logResult.data && typeof logResult.data.output === 'string') ? logResult.data.output.split('\t')?.[0] || '' : '';

        // Step 5: Push if requested
        let pushResult: RunnerResponse | undefined;
        let pushed = false;
        if (validated.push !== false) {
          try {
            pushResult = await this.remotePush(record, { refspec: `HEAD:refs/heads/${branch}` }, signal);
            pushed = Boolean(pushResult.ok);
          } catch (pushErr: unknown) {
            const pushErrMsg = pushErr instanceof Error ? pushErr.message : 'push failed';
            return {
              ok: false,
              message: `Commit created (${commitSha.slice(0, 7)}) but push failed: ${pushErrMsg}`,
              data: {
                step: 'push',
                commitSha,
                branch,
                pushed: false,
                pushError: pushErrMsg,
                resumeAction: 'Call git_push or workspace_finalize to retry push'
              },
              error: { code: 'UNAVAILABLE', message: pushErrMsg, retryable: true },
              truncated: false
            };
          }
        }

        const finalStatus = await this.runWorker(record, 'git_status', {}, signal);
        await this.enforceActiveLimits(record);

        const response: RunnerResponse = {
          ok: true,
          message: pushed ? `Workspace finalized and pushed to ${branch}` : `Workspace finalized (commit ${commitSha.slice(0, 7)})`,
          data: {
            commitSha,
            branch,
            pushed,
            pushResult: pushResult?.data,
            finalStatus: finalStatus.data
          },
          truncated: false
        };
        if (idempotencyKey) {
          this.store.setFinalizeIdempotency(ownerId, record.id, idempotencyKey, JSON.stringify(response));
        }
      return response;
    }
    if (operation === 'exec_run') {
      validated.maxOutputBytes = Math.min(validated.maxOutputBytes as number, this.config.maxOutputBytes);
      const result = await this.handleExecRun(record, validated, signal);
      await this.enforceActiveLimits(record);
      return result;
    }
    if (operation === 'github_action') {
      const action = validated.action as string;
      let fingerprint: string | undefined;
      if (validated.idempotencyKey) {
        fingerprint = createHash('sha256').update(JSON.stringify({ action, workspaceId: record.id, repo: record.repositoryUrl, validated })).digest('hex');
        const cached = this.store.getCommentIdempotency(ownerId, validated.idempotencyKey as string, fingerprint);
        if (cached?.mismatch) {
          throw new HarnessError('CONFLICT', 'idempotency key reused with different request payload', 409);
        }
        if (cached?.resultJson) {
          return JSON.parse(cached.resultJson) as RunnerResponse;
        }
      }
      let args: string[] = [];
      switch (action) {
        case 'pr_list': args = [String(validated.limit ?? 20), (validated.state as string) ?? 'open']; break;
        case 'pr_view': args = [String(validated.prNumber)]; break;
        case 'pr_create': args = [
          validated.title as string,
          (validated.body as string) ?? '',
          validated.head as string,
          (validated.base as string) ?? 'main',
          String(validated.draft ?? false),
          ((validated.labels as string[]) ?? []).join(',')
        ]; break;
        case 'pr_update': args = [
          String(validated.prNumber),
          (validated.title as string) ?? '',
          (validated.body as string) ?? '',
          (validated.base as string) ?? '',
          (validated.state as string) ?? ''
        ]; break;
        case 'pr_comment': args = [String(validated.prNumber), validated.body as string]; break;
        case 'issue_list': args = [String(validated.limit ?? 20), (validated.state as string) ?? 'open']; break;
        case 'issue_view': args = [String(validated.issueNumber)]; break;
        case 'issue_create': args = [
          validated.title as string,
          (validated.body as string) ?? '',
          ((validated.labels as string[]) ?? []).join(','),
          ((validated.assignees as string[]) ?? []).join(',')
        ]; break;
        case 'issue_comment': args = [String(validated.issueNumber), validated.body as string]; break;
        case 'issue_comment_update': args = [String(validated.commentId), validated.body as string]; break;
        case 'label_create': args = [validated.name as string, (validated.color as string) ?? '0E8A16', (validated.description as string) ?? '']; break;
        case 'issue_labels_add': args = [String(validated.issueNumber), (validated.labels as string[]).join(','), String(validated.createMissing ?? true)]; break;
        case 'issue_labels_remove': args = [String(validated.issueNumber), validated.label as string]; break;
        case 'issue_update': args = [String(validated.issueNumber), (validated.title as string) ?? '', (validated.body as string) ?? '', (validated.state as string) ?? '', (validated.stateReason as string) ?? '']; break;
        case 'issue_publish': args = [
          String(validated.issueNumber),
          (validated.comment as string) ?? '',
          ((validated.addLabels as string[]) ?? []).join(','),
          ((validated.removeLabels as string[]) ?? []).join(','),
          String(validated.createMissingLabels ?? true)
        ]; break;
      }
      const result = await this.runBrokeredGitHubAction(record, action, args, signal);
      if ((action === 'pr_comment' || action === 'issue_comment' || action === 'issue_labels_add' || action === 'issue_publish') && validated.idempotencyKey && result.ok) {
        this.store.setCommentIdempotency(ownerId, validated.idempotencyKey as string, JSON.stringify(result), fingerprint);
      }
      await this.enforceActiveLimits(record);
      return result;
    }
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
      const taskTimeout = (validated.timeoutMs as number) || 60_000;
      const mapKey = `task:${record.id}:${validated.idempotencyKey as string}`;
      const isNew = !this.operations.hasTaskKey(mapKey);
      if (isNew) {
        this.store.setMutationLock(record.id, Date.now() + taskTimeout + 10_000, record.generation);
      }
      try {
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
        return { ok: true, message: task.created ? 'Task started' : 'Idempotent task result', data: this.operations.view(task), truncated: false };
      } catch (error) {
        if (isNew) {
          this.store.clearMutationLock(record.id, record.generation);
        }
        throw error;
      }
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
    if (!auditedFileMutations.has(operation)) {
      const result = await this.runWorker(record, operation, validated, signal);
      await this.enforceActiveLimits(record);
      return result;
    }
    this.auditWorkspaceMutation(ownerId, 'workspace.file_mutation.requested', record, { operation });
    try {
      const result = await this.runWorker(record, operation, validated, signal);
      await this.enforceActiveLimits(record);
      this.auditWorkspaceOutcome(
        ownerId,
        result.ok ? 'workspace.file_mutation.succeeded' : 'workspace.file_mutation.failed',
        record,
        { operation }
      );
      return result;
    } catch (error) {
      this.auditWorkspaceOutcome(ownerId, 'workspace.file_mutation.failed', record, { operation });
      throw error;
    }
  };

  if (isMutationOperation(operation, validated)) {
    const opTimeout = typeof validated.timeoutMs === 'number' ? validated.timeoutMs : undefined;
    return await this.withMutationLease(record, dispatchAction, opTimeout);
  }
  return await dispatchAction();
}

  private async repositoryToken(ownerId: string, repositoryUrl: URL, permission: 'read' | 'write'): Promise<string | undefined> {
    if ((this.config.authMode ?? 'owner-bearer') !== 'cloudflare-access') {
      return await mintRepositoryToken(this.config, repositoryUrl);
    }
    if (!this.githubInstallations || !this.config.githubApp) return undefined;

    let token: string | undefined;
    let mintError: unknown;
    try {
      token = await mintPrincipalRepositoryToken({
        config: this.config, principalId: ownerId, repositoryUrl,
        installations: this.githubInstallations, requiredPermission: permission
      });
    } catch (error) {
      mintError = error;
    }

    if (token) return token;

    if (permission === 'write' && this.githubBinding) {
      const refreshed = await this.refreshRepositoryToken(ownerId, repositoryUrl, 'write');
      if (refreshed) return refreshed;
    }

    if (mintError) throw mintError;
    return undefined;
  }

  private auditWorkspaceMutation(
    ownerId: string,
    action: string,
    record: WorkspaceRecord,
    details: Record<string, string | number | boolean>
  ): void {
    if (!this.metadata) return;
    try {
      this.metadata.recordAudit(
        ownerId,
        action,
        'workspace',
        record.id,
        record.generation,
        details
      );
    } catch { /* mutation audit persistence is best-effort */ }
  }

  private auditWorkspaceOutcome(
    ownerId: string,
    action: string,
    record: WorkspaceRecord,
    details: Record<string, string | number | boolean>
  ): void {
    try {
      this.metadata?.recordAudit(ownerId, action, 'workspace', record.id, record.generation, details);
    } catch { /* outcome audit persistence is best-effort */ }
  }

  async readArtifactSource(
    principal: PrincipalSelector,
    input: { workspaceId: string; path: string }
  ): Promise<{ ownerId: string; content: Buffer }> {
    const ownerId = this.store.resolvePrincipal(principal);
    const record = this.requireWorkspace(ownerId, input.workspaceId);
    const repositoryRoot = await realpath(join(record.workspacePath, 'repo'));
    const content = await readVerifiedWorkspaceFile(repositoryRoot, input.path, this.config.maxArtifactBytes);
    return { ownerId, content };
  }

  async executeInternal(
    principal: PrincipalSelector,
    operation: InternalRunnerOperation,
    input: { workspaceId: string; expectedGeneration?: number }
  ): Promise<RunnerResponse> {
    const parsed = InternalRunnerRequestSchema.parse({ version: 2, principal, operation, input });
    const ownerId = this.store.resolvePrincipal(parsed.principal);
    const record = this.requireWorkspace(ownerId, parsed.input.workspaceId, false, true);
    if (parsed.operation === 'workspace_detail') {
      return { ok: true, message: 'Workspace detail', data: internalWorkspaceDetail(record), truncated: false };
    }
    return await this.closeFenced(ownerId, parsed.input.workspaceId, parsed.input.expectedGeneration!);
  }

  async closeFenced(ownerId: string, workspaceId: string, expectedGeneration: number): Promise<RunnerResponse> {
    const record = this.requireWorkspace(ownerId, workspaceId, false, true);
    if (record.status === 'CLOSED' || (record.status === 'ACTIVE' && record.expiresAt <= Date.now())) {
      throw new HarnessError('EXPIRED', 'workspace expired', 410);
    }
    if (record.generation !== expectedGeneration) {
      throw new HarnessError('CONFLICT', 'workspace lifecycle changed', 409);
    }
    this.auditWorkspaceMutation(ownerId, 'workspace.close.requested', record, {});
    if (!this.store.claimForReaping(record.id, expectedGeneration, true)) {
      const current = this.store.byOwnerAndId(ownerId, workspaceId);
      if (!current || current.status === 'CLOSED' || (current.status === 'ACTIVE' && current.expiresAt <= Date.now())) {
        throw new HarnessError('EXPIRED', 'workspace expired', 410);
      }
      throw new HarnessError('CONFLICT', 'workspace lifecycle changed', 409);
    }
    const claimed = this.store.byOwnerAndId(ownerId, workspaceId)!;
    try {
      await this.closeRecord(claimed, 'closed by operator');
    } catch (error) {
      this.auditWorkspaceOutcome(ownerId, 'workspace.close.failed', claimed, {});
      throw error;
    }
    const closed = this.store.byOwnerAndId(ownerId, workspaceId)!;
    this.auditWorkspaceOutcome(ownerId, 'workspace.close.succeeded', closed, {});
    return {
      ok: true,
      message: 'Workspace closed',
      data: internalWorkspaceDetail(closed),
      truncated: false
    };
  }

  async close(ownerId: string, workspaceId: string): Promise<RunnerResponse> {
    const record = this.requireWorkspace(ownerId, workspaceId, false, true);
    await this.closeRecord(record, 'closed by client');
    this.auditWorkspaceOutcome(ownerId, 'workspace.closed', record, { reason: 'closed by client' });
    const finalRecord = this.store.byId(workspaceId) ?? record;
    if (finalRecord.status !== 'CLOSED') {
      throw new HarnessError('CONFLICT', 'workspace could not be closed', 409);
    }
    return { ok: true, message: 'Workspace closed', data: publicRecord(finalRecord), truncated: false };
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
        '--label', `cloud-harness.instance=${this.instanceId}`, '--network', 'none', '--user', '0:0',
        '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
        '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25',
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
      if (!this.store.claimForReaping(claimed.id, claimed.generation, true)) {
        const reloaded = this.store.byId(record.id);
        if (!reloaded || reloaded.status === 'CLOSED') return;
        if (reloaded.status === 'REAPING') {
          claimed = reloaded;
        } else {
          if (!this.store.claimForReaping(reloaded.id, reloaded.generation, true)) return;
          claimed = this.store.byId(reloaded.id)!;
        }
      } else {
        claimed = this.store.byId(claimed.id)!;
      }
    }
    this.operations.stopWorkspace(claimed.id);
    if (claimed.containerName) await removeContainer(claimed.containerName);
    await this.safeRemovePath(claimed.workspacePath);
    const closed = this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], { status: 'CLOSED', containerName: null, error: reason, expiresAt: Date.now() });
    if (!closed) {
      const finalState = this.store.byId(claimed.id);
      if (finalState?.status === 'CLOSED') return;
      throw new HarnessError('CONFLICT', 'workspace cleanup lost its lifecycle lease', 409, true);
    }
  }

  private async reapExpired(): Promise<void> {
    const now = Date.now();
    for (const record of this.store.active()) {
      if (record.status === 'ACTIVE' && (record.expiresAt <= now || record.hardExpiresAt <= now)) {
        const claimed = this.store.claimForExpiry(record.id, record.generation);
        if (claimed) {
          if (claimed.containerName) {
            await removeContainer(claimed.containerName).catch(() => undefined);
          }
          this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], {
            status: 'EXPIRED_RECOVERABLE',
            containerName: null,
            lastActivityAt: now
          });
        }
      } else if (record.status === 'ACTIVE') {
        const violation = await this.resourceViolation(record).catch(() => undefined);
        if (violation) await this.closeRecord(record, violation).catch(() => undefined);
      }
    }
    const recoverableRows = this.store.database.prepare(
      "SELECT id, generation, last_activity_at FROM workspaces WHERE status = 'EXPIRED_RECOVERABLE' AND (mutation_locked_until IS NULL OR mutation_locked_until <= ?) AND (last_activity_at + 3600000 <= ?)"
    ).all(now, now) as { id: string; generation: number; last_activity_at: number }[];
    for (const row of recoverableRows) {
      if (this.store.claimForReaping(row.id, row.generation, false)) {
        const fullRec = this.store.byId(row.id);
        if (fullRec) await this.closeRecord(fullRec, 'recoverable grace period expired').catch(() => undefined);
      }
    }
  }
}

function isMutationOperation(operation: RunnerOperation, validated: Record<string, unknown>): boolean {
  if (operation === 'exec_run') {
    if (validated.privileged === true) return true;
    return validated.async !== true;
  }
  if (operation === 'tasks_run') {
    return false;
  }
  if (['files_write', 'files_write_batch', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir',
       'git_checkout', 'git_add', 'git_commit', 'git_fetch', 'git_pull', 'git_merge', 'git_rebase', 'git_push',
       'workspace_finalize', 'worktrees_create', 'worktrees_remove', 'memories_write', 'skills_run', 'hooks_run', 'deployments_run'].includes(operation)) {
    return true;
  }
  if (operation === 'git_branch' && (validated.action === 'create' || validated.action === 'delete')) {
    return true;
  }
  if (operation === 'github_action') {
    const action = validated.action as string;
    return ['pr_create', 'pr_update', 'pr_comment', 'issue_create', 'issue_comment', 'issue_comment_update', 'label_create', 'issue_labels_add', 'issue_labels_remove', 'issue_update', 'issue_publish'].includes(action);
  }
  return false;
}

function normalizePushRefspec(refspec: string | undefined, defaultBranch: string | undefined): string {
  if (!refspec) return `${defaultBranch}:refs/heads/${defaultBranch}`;
  if (!refspec.includes(':')) return `${refspec}:refs/heads/${refspec}`;
  const [source, destination] = refspec.split(':');
  if (!destination) return `${source}:refs/heads/${source}`;
  const normalizedDestination = destination.startsWith('refs/heads/')
    ? destination
    : `refs/heads/${destination}`;
  return `${source}:${normalizedDestination}`;
}
