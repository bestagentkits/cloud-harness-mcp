import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { chmod, chown, cp, mkdir, readdir, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  AgentProxyOperationSchema,
  HarnessError,
  InternalRunnerRequestSchema,
  RunnerOperationSchema,
  RunnerResponseSchema,
  TOOL_SCHEMA_BY_NAME,
  type AgentProxyOperation,
  type RunnerConfig,
  type InternalRunnerOperation,
  type RunnerOperation,
  type RunnerResponse,
  type WorkspaceCapabilityResult,
  type ToolkitSelection
} from '@cloud-harness/contracts';
import { inspectContainer, removeContainer, runDocker, terminateContainerProcessGroup } from './docker-engine.js';
import { readVerifiedWorkspaceFile } from './bounded-workspace-file-reader.js';
import { mintPrincipalRepositoryScopedToken, mintPrincipalRepositoryToken, mintRepositoryToken } from './github-app-broker.js';
import type { GitHubBindingService } from './github-binding-service.js';
import { ArtifactStoreError, type ArtifactMetadata, type ArtifactStore } from './artifact-store.js';
import type { GitHubInstallationRecord, GitHubInstallationStore } from './github-installation-store.js';
import type { MetadataStore } from './metadata-store.js';
import { OperationManager } from './operation-manager.js';
import { validateRepositoryUrl } from './repository-policy.js';
import type { GitOperationStatus, PrincipalSelector, StateStore, WorkspaceRecord } from './state-store.js';
import { validatedWorkspaceEnvironment } from './workspace-environment.js';
import { RepositoryCacheManager } from './repository-cache-manager.js';
import { ToolkitCacheManager } from './toolkit-cache-manager.js';
import { ToolkitService } from './toolkit-service.js';
import { NetworkProfileManager } from './network-profile-manager.js';
import { SecretSnapshotRedactor } from './output-redactor.js';
import type { EncryptedSecret } from './secret-keyring.js';
import { opaqueId } from './metadata-records.js';
import { classifyGitHubFailure } from './github-error-classifier.js';
import { AgentManager, type AgentManagerDependencies } from './agent-manager.js';
import { computeFullTreeDigest } from './adapters/mattpocock-adapter.js';
const activeStatus = new Set<WorkspaceRecord['status']>(['CREATING', 'ACTIVE', 'REAPING', 'NETWORK_QUARANTINED']);
const auditedFileMutations = new Set<RunnerOperation>([
  'files_write', 'files_write_batch', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir'
]);
export function computeWorkspaceOpenFingerprint(input: {
  repositoryUrl: string | URL;
  ref?: string | undefined;
  environmentId?: string | undefined;
  networkProfile?: string | undefined;
  toolkits?: ToolkitSelection[] | undefined;
  allowToolkitWorkspaceChanges?: boolean | undefined;
  confirmToolkitSecretUse?: boolean | undefined;
}): string {
  const canonicalToolkits = [...(input.toolkits ?? [])].sort((a, b) => {
    const idA = a.kind === 'git' ? a.instanceId : a.id;
    const idB = b.kind === 'git' ? b.instanceId : b.id;
    return idA.localeCompare(idB);
  });
  const payload = {
    repositoryUrl: String(input.repositoryUrl),
    ref: input.ref ?? null,
    environmentId: input.environmentId ?? null,
    networkProfile: input.networkProfile ?? 'network-none',
    toolkits: canonicalToolkits,
    allowToolkitWorkspaceChanges: input.allowToolkitWorkspaceChanges ?? false,
    confirmToolkitSecretUse: input.confirmToolkitSecretUse ?? false
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}


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
    case 'NETWORK_QUARANTINED':
      return ['workspace_recover', 'workspace_close', 'workspace_context'];
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

function publicRecord(record: WorkspaceRecord, capabilities?: WorkspaceCapabilityResult) {
  const now = Date.now();
  const remainingLeaseMs = Math.max(0, record.expiresAt - now);
  const hardRemainingMs = Math.max(0, record.hardExpiresAt - now);
  const canRenewLease = (record.status === 'ACTIVE' || record.status === 'EXPIRED_RECOVERABLE') && hardRemainingMs > 60_000;
  let leaseState: 'ACTIVE' | 'WARNING' | 'EXPIRED_RECOVERABLE' | 'EXPIRED' = 'ACTIVE';
  const leaseWarnings: string[] = [];

  if (record.status === 'EXPIRED_RECOVERABLE') {
    leaseState = 'EXPIRED_RECOVERABLE';
    leaseWarnings.push('Workspace lease has expired. Work is retained in recoverable grace state.');
  } else if (record.status === 'NETWORK_QUARANTINED') {
    leaseState = 'EXPIRED';
    leaseWarnings.push('Workspace is quarantined due to network security policy drift. Work is retained and recoverable after policy reconciliation.');
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
    networkProfile: record.networkProfile,
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
    ...(capabilities ? {
      capabilities: capabilities.capabilities,
      permissions: capabilities.permissions,
      operations: capabilities.operations
    } : {}),
    error: record.error
  };
}

function internalWorkspaceDetail(record: WorkspaceRecord) {
  return { ...publicRecord(record), generation: record.generation };
}

export class WorkspaceService {
  private readonly operations: OperationManager;
  private readonly repoCacheManager: RepositoryCacheManager;
  private readonly instanceId: string;
  private readonly bootId: string = randomBytes(16).toString('hex');
  private readonly redactorCache = new Map<string, SecretSnapshotRedactor>();
  private reaper?: NodeJS.Timeout | undefined;
  private reaperRunning = false;
  readonly toolkitCacheManager: ToolkitCacheManager;
  readonly toolkitService: ToolkitService;

  public readonly networkProfileManager: NetworkProfileManager;
  private readonly agentManager?: AgentManager | undefined;
  private readonly metadata?: MetadataStore | undefined;
  constructor(
    private readonly config: RunnerConfig,
    private readonly store: StateStore,
    metadataOrDependencies?: MetadataStore | (Omit<AgentManagerDependencies, 'toolExecutor'> & { manager?: AgentManager }),
    private readonly githubInstallations?: GitHubInstallationStore,
    private readonly githubBinding?: GitHubBindingService,
    private readonly artifacts?: ArtifactStore,
    agentDependencies?: Omit<AgentManagerDependencies, 'toolExecutor'> & { manager?: AgentManager }
  ) {
    let metadata: MetadataStore | undefined;
    let agentDeps = agentDependencies;
    if (metadataOrDependencies && ('manager' in metadataOrDependencies || 'launcher' in metadataOrDependencies || 'gateway' in metadataOrDependencies)) {
      agentDeps = metadataOrDependencies as Omit<AgentManagerDependencies, 'toolExecutor'> & { manager?: AgentManager };
    } else {
      metadata = metadataOrDependencies as MetadataStore | undefined;
    }
    this.metadata = metadata;
    this.instanceId = store.instanceId();
    const { manager, ...managerDependencies } = agentDeps ?? {};
    this.agentManager = manager ?? (config.agents
      ? new AgentManager(config.agents, store, {
          ...managerDependencies,
          toolExecutor: async (request) => await this.executeAgentProxy(request)
        })
      : undefined);
    this.instanceId = store.instanceId();
    this.store.reconcileRunningTasks(this.bootId, Date.now());
    this.store.reconcilePendingGitOperations(Date.now());
    this.operations = new OperationManager(this.store, this.bootId);
    this.operations.redactorProvider = (wsId) => this.getRedactor(wsId);
    this.networkProfileManager = new NetworkProfileManager(this.config);
    this.repoCacheManager = new RepositoryCacheManager(this.config.repoCacheRoot, this.store, this.config.allowedGitHosts, this.config.executorImage, this.instanceId);
    const cacheRoot = this.config.toolkitCacheRoot || (this.config.jobsRoot && !this.config.jobsRoot.startsWith('/var/lib') ? join(this.config.jobsRoot, 'toolkit-cache') : '/var/lib/cloud-harness/cache/toolkits');
    const provNet = this.config.provisioningNetwork || 'cloud-harness-mcp_provisioning';
    this.toolkitCacheManager = new ToolkitCacheManager(cacheRoot, this.store);
    const proxyOpts = this.config.toolkitEgressProxy ? { toolkitEgressProxy: this.config.toolkitEgressProxy } : {};
    this.toolkitService = new ToolkitService({
      cacheManager: this.toolkitCacheManager,
      repoCacheManager: this.repoCacheManager,
      store: this.store,
      executorImage: this.config.executorImage,
      provisioningNetwork: provNet,
      allowedGitHosts: this.config.allowedGitHosts,
      instanceId: this.instanceId,
      enableToolkitCache: this.config.enableToolkitCache,
      toolkitNetworkPolicy: this.config.toolkitNetworkPolicy,
      ...proxyOpts
    });
    this.operations.onTaskStart = (wsId, timeoutMs) => {
      const rec = this.store.byId(wsId);
      if (rec) this.store.refreshMutationLock(rec.id, Date.now() + timeoutMs + 10_000, rec.generation);
    };
    this.operations.onTaskSettle = (wsId) => {
      const rec = this.store.byId(wsId);
      if (rec) this.store.clearMutationLock(rec.id, rec.generation);
    };
  }

  private getRedactor(workspaceId: string): SecretSnapshotRedactor {
    const cached = this.redactorCache.get(workspaceId);
    if (cached) return cached;
    const record = this.store.byId(workspaceId);
    if (!record) {
      const empty = new SecretSnapshotRedactor({});
      this.redactorCache.set(workspaceId, empty);
      return empty;
    }
    const snapshotResult = this.store.getSecretSnapshot(workspaceId);
    const values: Record<string, string> = {};
    if (snapshotResult.initialized) {
      for (const item of snapshotResult.secrets) {
        values[item.name] = this.metadata?.decryptEnvelope(record.ownerId, item.environmentId, item.name, item.version, item.envelope) ?? '';
      }
    } else if (record.environmentId) {
      Object.assign(values, this.metadata?.environmentValues(record.ownerId, record.environmentId) ?? {});
    }
    const redactor = new SecretSnapshotRedactor(values);
    this.redactorCache.set(workspaceId, redactor);
    return redactor;
  }

  private requireArtifacts(): ArtifactStore {
    if (!this.artifacts) throw new HarnessError('UNAVAILABLE', 'artifact store is unavailable', 503);
    return this.artifacts;
  }
  private async runLifecycleHooks(
    record: WorkspaceRecord,
    event: 'pre_commit' | 'post_commit' | 'post_checkout' | 'on_workspace_open',
    signal?: AbortSignal
  ): Promise<void> {
    const activations = this.store.getActiveHookActivations(record.ownerId, record.id);
    const act = activations.find((a) => a.event === event);
    if (!act) return;

    let listRes: RunnerResponse;
    try {
      listRes = await this.runWorker(record, 'hooks_list', { event }, signal);
    } catch {
      return;
    }
    if (!listRes.ok || !listRes.data || typeof listRes.data !== 'object') return;
    const manifestSha = (listRes.data as Record<string, unknown>).manifestSha256;
    if (manifestSha !== act.manifestSha256) {
      return;
    }

    const hooks = ((listRes.data as Record<string, unknown>).hooks || []) as Array<{ name: string; failurePolicy?: string }>;
    for (const h of hooks) {
      let runRes: RunnerResponse;
      try {
        runRes = await this.runWorker(record, 'hooks_run', {
          name: h.name,
          expectedManifestSha256: act.manifestSha256
        }, signal);
      } catch (err: unknown) {
        if (event === 'pre_commit' && h.failurePolicy === 'block') {
          throw new HarnessError('HOOK_FAILED', `pre_commit hook "${h.name}" failed: ${err instanceof Error ? err.message : String(err)}`, 400, false);
        }
        continue;
      }
      if (!runRes.ok) {
        if (event === 'pre_commit' && h.failurePolicy === 'block') {
          throw new HarnessError('HOOK_FAILED', `pre_commit hook "${h.name}" failed: ${runRes.message}`, 400, false);
        }
      }
    }
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
      if (record.status === 'NETWORK_QUARANTINED') {
        if (record.containerName) {
          try {
            await removeContainer(record.containerName);
            this.store.update(record.id, { containerName: null });
          } catch {
            // retain record.containerName for retry
          }
        }
        continue;
      }
      if (record.status === 'CREATING') await this.closeRecord(record, 'runner restarted during workspace creation');
      else if (!record.containerName || !(await inspectContainer(record.containerName))) await this.closeRecord(record, 'executor missing during startup reconciliation');
      else {
        const inspection = await inspectContainer(record.containerName);
        const hostConfig = inspection?.HostConfig as { NetworkMode?: string } | undefined;
        const expectedNetwork = record.networkProfile === 'network-none' ? 'none' : (this.config.dependencyNetworkName ?? 'cloud-harness-dependency-access');
        if (hostConfig?.NetworkMode !== expectedNetwork) {
          await removeContainer(record.containerName).catch(() => undefined);
          if (record.networkProfile === 'dependency-access') {
            const readiness = await this.networkProfileManager.checkAttestation().catch(() => ({ ok: false, reason: 'attestation probe failed' }));
            if (!readiness.ok) {
              this.store.update(record.id, { containerName: null, status: 'NETWORK_QUARANTINED', error: `dependency-access network unavailable: ${readiness.reason}` });
              continue;
            }
          }
          await this.ensureActiveExecutor(record);
          continue;
        }
        if (record.networkProfile === 'dependency-access') {
          const readiness = await this.networkProfileManager.checkAttestation().catch(() => ({ ok: false, reason: 'attestation probe failed' }));
          if (!readiness.ok) {
            await removeContainer(record.containerName).catch(() => undefined);
            this.store.update(record.id, { containerName: null, status: 'NETWORK_QUARANTINED', error: `dependency-access network unavailable: ${readiness.reason}` });
            continue;
          }
        }
        const restarted = await runDocker(['restart', record.containerName], { timeoutMs: 30_000, maxBytes: 65_536 });
        if (restarted.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'executor restart reconciliation failed', 503, true);
      }
    }
    await this.toolkitCacheManager.reconcileStartup().catch(() => undefined);
    await this.reconcileContainers();
    await this.reconcileJobDirectories();
    await this.agentManager?.start();
    this.reaper = setInterval(() => {
      if (this.reaperRunning) return;
      this.reaperRunning = true;
      void this.reapExpired().catch(() => undefined).finally(() => { this.reaperRunning = false; });
    }, this.config.reaperIntervalSeconds * 1_000);
    this.reaper.unref();
  }

  beginShutdown(): void {
    this.agentManager?.fence();
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    clearInterval(this.reaper);
    await this.agentManager?.stop();
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

    let repositoryToken = await this.repositoryToken(record.ownerId, repositoryUrl, 'read');
    let cachePathForVolume: string | undefined;
    if (this.config.enableRepoCache) {
      try {
        const cacheResult = await this.repoCacheManager.acquireCacheMirror(record.ownerId, record.repositoryUrl, repositoryToken);
        if (cacheResult.isReady) {
          cachePathForVolume = cacheResult.cachePath;
        }
      } catch { /* fallback to direct clone */ }
    }

    const buildArgs = (cachePath?: string) => [
      'run', '-i', '--rm', '--pull', 'never', '--name', helperName,
      '--label', 'cloud-harness.role=clone-helper', '--label', 'cloud-harness.ephemeral=true',
      '--label', `cloud-harness.instance=${this.instanceId}`,
      '--label', `cloud-harness.workspace=${record.id}`, '--network', 'bridge', '--user', '10001:10001',
      '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
      '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
      '--volume', `${jobPath}:/job`,
      ...(cachePath ? ['--volume', `${cachePath}:/job/cache:ro`] : []),
      '--entrypoint', '/opt/harness/clone-helper.sh', this.config.executorImage,
      record.repositoryUrl, '/job/repo', ref ?? '',
      ...(cachePath ? ['/job/cache'] : [])
    ];

    const runClone = async (token: string | undefined, cachePath?: string) => {
      try {
        return await runDocker(buildArgs(cachePath), { stdin: `${token ?? ''}\n`, timeoutMs: 120_000, maxBytes: this.config.maxOutputBytes });
      } finally {
        await removeContainer(helperName);
      }
    };

    let result = await runClone(repositoryToken, cachePathForVolume);
    if (result.exitCode !== 0 && cachePathForVolume) {
      // Fallback to independent clone without cache
      await this.safeRemovePath(repositoryPath);
      result = await runClone(repositoryToken, undefined);
    }
    if (result.exitCode !== 0 && !repositoryToken) {
      const refreshedToken = await this.refreshRepositoryToken(record.ownerId, repositoryUrl);
      if (refreshedToken) {
        await this.safeRemovePath(repositoryPath);
        repositoryToken = refreshedToken;
        result = await runClone(repositoryToken, undefined);
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

  private async provisionMountDirectories(record: WorkspaceRecord): Promise<{ toolsPath: string; cachePath: string; ownerSkillsPath: string }> {
    const jobPath = record.workspacePath;
    const toolsPath = join(jobPath, 'tools');
    const cachePath = join(jobPath, 'cache');
    const ownerSkillsPath = join(jobPath, 'toolkit-projection', 'owner-skills');
    await mkdir(toolsPath, { recursive: true, mode: 0o755 });
    await mkdir(cachePath, { recursive: true, mode: 0o755 });
    await mkdir(ownerSkillsPath, { recursive: true, mode: 0o755 });
    try {
      await chown(toolsPath, 10001, 10001);
      await chown(cachePath, 10001, 10001);
      await chown(ownerSkillsPath, 10001, 10001);
      await chmod(toolsPath, 0o755);
      await chmod(cachePath, 0o755);
      await chmod(ownerSkillsPath, 0o755);
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
          '-c', 'mkdir -p /job/tools /job/cache /job/toolkit-projection/owner-skills && chown -R 10001:10001 /job/tools /job/cache /job/toolkit-projection/owner-skills && chmod -R 0755 /job/tools /job/cache /job/toolkit-projection/owner-skills'
        ], { timeoutMs: 30_000, maxBytes: 8_192 });
        if (result.exitCode !== 0) {
          throw new HarnessError('UNAVAILABLE', `mount directory provisioning failed: ${result.stderr || result.stdout}`.slice(0, 2_000), 502, true);
        }
      } finally {
        await removeContainer(helperName);
      }
    }
    return { toolsPath, cachePath, ownerSkillsPath };
  }

  private async createExecutor(record: WorkspaceRecord, repositoryPath: string, environment: Record<string, string> = {}): Promise<string> {
    const name = `cloud-harness-ws-${record.id.slice(3, 19).toLowerCase()}`;
    await removeContainer(name).catch(() => undefined);
    const { toolsPath, cachePath, ownerSkillsPath } = await this.provisionMountDirectories(record);
    const envEntries = Object.entries(environment);
    const envFilePath = join(record.workspacePath, `.env.injected-${randomBytes(6).toString('hex')}`);
    let useEnvFile = false;
    if (envEntries.length > 0) {
      const content = envEntries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      await writeFile(envFilePath, content, { mode: 0o600, encoding: 'utf8' });
      useEnvFile = true;
    }
    try {
      await this.networkProfileManager.ensureProfileReady(record.networkProfile);
      const networkArgs = this.networkProfileManager.dockerLaunchArgs(record.networkProfile);
      const args = [
        'create', '--name', name,
        '--label', 'cloud-harness.managed=true', '--label', `cloud-harness.instance=${this.instanceId}`,
        '--label', `cloud-harness.workspace=${record.id}`,
        '--user', '10001:10001', '--workdir', '/workspace', '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
        '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024',
        ...networkArgs,
        '--volume', `${repositoryPath}:/workspace:rw`,
        '--volume', `${toolsPath}:/opt/user-tools:rw`,
        '--volume', `${cachePath}:/var/cache/harness:rw`,
        '--volume', `${ownerSkillsPath}:/opt/cloud-harness/owner-skills:ro`,
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
        ...(useEnvFile ? ['--env-file', envFilePath] : []),
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
    } finally {
      if (useEnvFile) {
        await rm(envFilePath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async ensureActiveExecutor(record: WorkspaceRecord): Promise<WorkspaceRecord> {
    // Dependency-access requires a fresh attestation before reuse; a quarantined
    // record must never resume its existing container. Force removal and rebuild
    // through createExecutor (which re-attests) instead of reusing a container
    // that may sit behind a drifted firewall.
    const mustRebuild = record.networkProfile === 'dependency-access' || record.status === 'NETWORK_QUARANTINED';
    if (record.containerName && mustRebuild) {
      await removeContainer(record.containerName).catch(() => undefined);
    } else if (record.containerName) {
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
    let environment: Record<string, string> = {};
    try {
      const snapshotResult = this.store.getSecretSnapshot(record.id);
      if (snapshotResult.initialized) {
        const decrypted: Record<string, string> = {};
        for (const item of snapshotResult.secrets) {
          decrypted[item.name] = this.metadata?.decryptEnvelope(record.ownerId, item.environmentId, item.name, item.version, item.envelope) ?? '';
        }
        environment = decrypted;
      } else if (record.environmentId) {
        environment = this.metadata?.environmentValues(record.ownerId, record.environmentId) ?? {};
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('UNAVAILABLE', 'Workspace secret injection is temporarily unavailable', 503, false);
    }
    const containerName = await this.createExecutor(record, repositoryPath, validatedWorkspaceEnvironment(environment));
    const updated = this.store.updateFenced(record.id, record.generation, ['ACTIVE', 'EXPIRED_RECOVERABLE', 'NETWORK_QUARANTINED'], {
      containerName,
      status: 'ACTIVE',
      error: null
    });
    if (!updated) {
      await removeContainer(containerName).catch(() => undefined);
      throw new HarnessError('CONFLICT', 'workspace lifecycle changed during executor activation', 409, true);
    }
    return updated;
  }

  async open(ownerId: string, input: Record<string, unknown>): Promise<RunnerResponse> {
    const parsed = TOOL_SCHEMA_BY_NAME.workspace_open.parse(input);
    const requestFingerprint = computeWorkspaceOpenFingerprint(parsed);
    const prior = this.store.byIdempotency(ownerId, parsed.idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint && prior.requestFingerprint !== requestFingerprint) {
        throw new HarnessError('CONFLICT', 'idempotency key reused with mismatched request parameters', 409, true);
      }
      return { ok: prior.status === 'ACTIVE', message: 'Idempotent workspace result', data: this.publicWorkspaceRecord(prior), truncated: false };
    }
    await this.ensureCapacity(ownerId);
    const url = await validateRepositoryUrl(parsed.repositoryUrl, this.config.allowedGitHosts);
    if (parsed.ref?.startsWith('-')) throw new HarnessError('INVALID_INPUT', 'ref cannot start with a dash');
    const now = Date.now();
    const workspaceId = opaqueId('ws');
    const hardExpiresAt = now + this.config.wallTtlSeconds * 1_000;
    const record: WorkspaceRecord = {
      id: workspaceId, ownerId, idempotencyKey: parsed.idempotencyKey, repositoryUrl: url.toString(),
      repositoryRef: parsed.ref ?? null, containerName: null, workspacePath: join(this.config.jobsRoot, workspaceId),
      environmentId: parsed.environmentId ?? null,
      status: 'CREATING', networkProfile: parsed.networkProfile ?? this.config.networkProfile, createdAt: now,
      lastActivityAt: now, expiresAt: this.expiry(now, now), hardExpiresAt, gitAuthorName: null, gitAuthorEmail: null,
      mutationLockedUntil: null, generation: 1, error: null, requestFingerprint
    };
    try {
      this.store.create(record);
    } catch (error) {
      const replay = this.store.byIdempotency(ownerId, parsed.idempotencyKey);
      if (replay) {
        if (replay.requestFingerprint && replay.requestFingerprint !== requestFingerprint) {
          throw new HarnessError('CONFLICT', 'idempotency key reused with mismatched request parameters', 409, true);
        }
        return { ok: replay.status === 'ACTIVE', message: 'Idempotent workspace result', data: this.publicWorkspaceRecord(replay), truncated: false };
      }
      if (this.store.list(ownerId).some((candidate) => activeStatus.has(candidate.status))) {
        throw new HarnessError('LIMIT_EXCEEDED', 'only one active workspace is allowed in this MVP', 429, true);
      }
      throw error;
    }
    try {
      let environment: Record<string, string> = {};
      const hasGlobals = Boolean(this.metadata?.hasActiveGlobalSecrets(ownerId));
      if (parsed.environmentId || hasGlobals) {
        try {
          const globalEnvelopes = this.metadata?.globalSecretEnvelopes(ownerId) ?? [];
          let envEnvelopes: Array<{ name: string; version: number; envelope: EncryptedSecret }> = [];
          if (parsed.environmentId) {
            const envFound = this.metadata?.environmentSecretEnvelopes(ownerId, parsed.environmentId);
            if (!envFound) {
              throw new HarnessError('NOT_FOUND', 'environment not found', 404, false);
            }
            envEnvelopes = envFound;
          }
          const mergedMap = new Map<string, { name: string; version: number; environmentId: string; envelope: EncryptedSecret }>();
          for (const g of globalEnvelopes) {
            mergedMap.set(g.name, { name: g.name, version: g.version, environmentId: 'global', envelope: g.envelope });
          }
          for (const e of envEnvelopes) {
            mergedMap.set(e.name, { name: e.name, version: e.version, environmentId: parsed.environmentId!, envelope: e.envelope });
          }
          const combined = Array.from(mergedMap.values());
          if (combined.length > 0 || parsed.environmentId) {
            this.store.saveSecretSnapshot(workspaceId, combined);
          }
          const decrypted: Record<string, string> = {};
          for (const item of combined) {
            decrypted[item.name] = this.metadata?.decryptEnvelope(ownerId, item.environmentId, item.name, item.version, item.envelope) ?? '';
          }
          environment = decrypted;
          this.redactorCache.set(workspaceId, new SecretSnapshotRedactor(environment));
        } catch (error) {
          if (error instanceof HarnessError) throw error;
          throw new HarnessError('UNAVAILABLE', 'Workspace secret injection is temporarily unavailable', 503, false);
        }
      }
      const { lockItems, bundlePaths } = await this.toolkitService.resolveToolkits(ownerId, parsed.toolkits);
      const ownerBundles = bundlePaths.filter(b => b.scope === 'owner');
      const workspaceBundles = bundlePaths.filter(b => b.scope === 'workspace');

      await this.composeOwnerToolkitProjection(record, ownerBundles);

      const repositoryPath = await this.clone(record, url, parsed.ref);
      if (workspaceBundles.length > 0) {
        await this.applyWorkspaceToolkitPatches(record, workspaceBundles, repositoryPath);
      }

      this.store.saveWorkspaceToolkits(
        workspaceId,
        ownerId,
        lockItems.map((item, idx) => ({
          ordinal: idx,
          toolkitId: item.id,
          scope: item.scope,
          requestedJson: JSON.stringify(item),
          resolvedJson: JSON.stringify(item),
          bundleSha256: item.bundleSha256
        }))
      );

      const cloneViolation = await this.resourceViolation(record);
      if (cloneViolation) throw new HarnessError('LIMIT_EXCEEDED', cloneViolation, 507, false);
      const containerName = await this.createExecutor(record, repositoryPath, validatedWorkspaceEnvironment(environment ?? {}));
      const active = this.store.updateFenced(workspaceId, record.generation, ['CREATING'], { containerName, status: 'ACTIVE', lastActivityAt: Date.now(), error: null });
      if (!active) {
        await removeContainer(containerName);
        throw new HarnessError('CONFLICT', 'workspace creation lost its lifecycle lease', 409, true);
      }
      await this.runLifecycleHooks(active, 'on_workspace_open').catch(() => undefined);
      return { ok: true, message: 'Workspace opened', data: this.publicWorkspaceRecord(active), truncated: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'workspace creation failed';
      this.store.updateFenced(workspaceId, record.generation, ['CREATING'], { status: 'FAILED', error: message.slice(0, 2_000) });
      this.store.deleteSecretSnapshot(workspaceId);
      this.redactorCache.delete(workspaceId);
      await this.safeRemovePath(record.workspacePath);
      throw error;
    }
  }

  private async composeOwnerToolkitProjection(
    record: WorkspaceRecord,
    ownerBundlePaths: Array<{ instanceId: string; path: string }>
  ): Promise<void> {
    const ownerSkillsPath = join(record.workspacePath, 'toolkit-projection', 'owner-skills');
    await mkdir(ownerSkillsPath, { recursive: true, mode: 0o755 });

    const seenSkills = new Map<string, { bundlePath: string; contentHash: string }>();

    for (const item of ownerBundlePaths) {
      const skillsDir = join(item.path, 'skills');
      if (!existsSync(skillsDir)) continue;

      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const srcSkill = join(skillsDir, entry.name);
        const skillMd = join(srcSkill, 'SKILL.md');
        if (!existsSync(skillMd)) continue;

        const digest = computeFullTreeDigest(srcSkill).bundleSha256;

        const prior = seenSkills.get(entry.name);
        if (prior && prior.contentHash !== digest) {
          throw new HarnessError('CONFLICT', `Same-tier toolkit skill collision: ${entry.name} is defined with conflicting content in multiple toolkits`, 409, false);
        }

        const destSkill = join(ownerSkillsPath, entry.name);
        if (!existsSync(destSkill)) {
          await cp(srcSkill, destSkill, { recursive: true });
        }
        seenSkills.set(entry.name, { bundlePath: item.path, contentHash: digest });
      }
    }
  }

  private async applyWorkspaceToolkitPatches(
    record: WorkspaceRecord,
    workspaceBundlePaths: Array<{ instanceId: string; path: string }>,
    repositoryPath: string
  ): Promise<string[]> {
    const changedPaths: string[] = [];
    const realRepoPath = realpathSync(repositoryPath);
    const cloudHarnessDir = join(repositoryPath, '.cloud-harness');
    if (existsSync(cloudHarnessDir)) {
      const st = lstatSync(cloudHarnessDir);
      if (st.isSymbolicLink()) {
        throw new HarnessError('INVALID_INPUT', 'repository contains .cloud-harness as a symbolic link', 400, false);
      }
      const realCloudHarness = realpathSync(cloudHarnessDir);
      if (!realCloudHarness.startsWith(realRepoPath)) {
        throw new HarnessError('INVALID_INPUT', '.cloud-harness escapes repository root', 400, false);
      }
    }
    const targetSkillsRoot = join(cloudHarnessDir, 'skills');
    if (existsSync(targetSkillsRoot)) {
      const st = lstatSync(targetSkillsRoot);
      if (st.isSymbolicLink()) {
        throw new HarnessError('INVALID_INPUT', 'repository contains .cloud-harness/skills as a symbolic link', 400, false);
      }
      const realSkills = realpathSync(targetSkillsRoot);
      if (!realSkills.startsWith(realRepoPath)) {
        throw new HarnessError('INVALID_INPUT', '.cloud-harness/skills escapes repository root', 400, false);
      }
    }
    await mkdir(targetSkillsRoot, { recursive: true, mode: 0o755 });

    for (const item of workspaceBundlePaths) {
      const skillsDir = join(item.path, 'skills');
      if (!existsSync(skillsDir)) continue;

      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const srcSkill = join(skillsDir, entry.name);
        const destSkill = join(targetSkillsRoot, entry.name);

        if (existsSync(destSkill)) {
          const st = lstatSync(destSkill);
          if (st.isSymbolicLink()) {
            throw new HarnessError('INVALID_INPUT', `target skill path ${entry.name} is a symbolic link`, 400, false);
          }
          const srcDigest = computeFullTreeDigest(srcSkill).bundleSha256;
          const destDigest = computeFullTreeDigest(destSkill).bundleSha256;
          if (srcDigest !== destDigest) {
            throw new HarnessError('CONFLICT', `Workspace skill patch conflict for ${entry.name}: target exists with different content`, 409, false);
          }
        } else {
          await cp(srcSkill, destSkill, { recursive: true });
          changedPaths.push(`.cloud-harness/skills/${entry.name}`);
        }
      }
    }

    try {
      await chown(targetSkillsRoot, 10001, 10001);
    } catch { /* ignore non-posix chown */ }

    return changedPaths;
  }

  list(ownerId: string, input: Record<string, unknown>): RunnerResponse {
    const records = this.store.list(ownerId);
    const offset = Number(input.cursor ?? 0);
    const limit = input.limit as number;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('INVALID_INPUT', 'invalid workspace cursor');
    const page = records.slice(offset, offset + limit);
    const next = offset + page.length < records.length ? String(offset + page.length) : undefined;
    return { ok: true, message: 'Workspaces listed', data: { workspaces: page.map((rec) => this.publicWorkspaceRecord(rec)) }, truncated: false, ...(next ? { cursor: next } : {}) };
  }

  status(ownerId: string, workspaceId?: string): RunnerResponse {
    const record = this.requireWorkspace(ownerId, workspaceId, false, true);
    return { ok: true, message: 'Workspace status', data: this.publicWorkspaceRecord(record), truncated: false };
  }

  publicWorkspaceRecord(record: WorkspaceRecord): Record<string, unknown> {
    return publicRecord(record, this.computeWorkspaceCapabilities(record));
  }

  private extractRepositoryName(repositoryUrl: URL): string | null {
    if (repositoryUrl.hostname.toLowerCase() !== 'github.com') return null;
    const parts = repositoryUrl.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  computeWorkspaceCapabilities(record: WorkspaceRecord): WorkspaceCapabilityResult {
    let repoName: string | null = null;
    let isGitHub = false;
    let owner = '';
    let repository = '';
    try {
      const url = new URL(record.repositoryUrl);
      if (url.hostname.toLowerCase() === 'github.com') {
        isGitHub = true;
        const parts = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
        if (parts.length === 2 && parts[0] && parts[1]) {
          owner = parts[0].toLowerCase();
          repository = parts[1].toLowerCase();
          repoName = `${parts[0]}/${parts[1]}`;
        }
      }
    } catch {
      // Ignore invalid url format fallback
    }

    const authMode = this.config.authMode ?? 'owner-bearer';
    let contentsRead = true;
    let contentsWrite = false;
    let issuesRead = false;
    let issuesWrite = false;
    let pullRequestsRead = false;
    let pullRequestsWrite = false;

    if (authMode === 'cloudflare-access') {
      if (this.githubInstallations && isGitHub && owner && repository) {
        const grant = this.githubInstallations.getRepositoryGrant(record.ownerId, owner, repository);
        if (grant && grant.status === 'granted') {
          const installation = this.githubInstallations.getInstallation(record.ownerId, grant.installationId);
          if (
            installation &&
            installation.status === 'active' &&
            String(this.config.githubApp?.appId) === installation.appId
          ) {
            contentsRead = true;
            contentsWrite = grant.contents === 'write';
            issuesRead = true;
            issuesWrite = grant.contents === 'write';
            pullRequestsRead = true;
            pullRequestsWrite = grant.contents === 'write';
          }
        }
      }
    } else {
      // owner-bearer mode
      if (isGitHub && this.config.githubApp?.installationId) {
        contentsRead = true;
        contentsWrite = true;
        issuesRead = true;
        issuesWrite = true;
        pullRequestsRead = true;
        pullRequestsWrite = true;
      }
    }

    const privileged = authMode === 'cloudflare-access';

    return {
      workspaceId: record.id,
      repository: repoName,
      repositoryUrl: record.repositoryUrl,
      capabilities: {
        repository: {
          read: contentsRead,
          push: contentsWrite,
          issuesRead,
          issuesWrite,
          pullRequestsRead,
          pullRequestsWrite
        },
        workspace: {
          shell: true,
          tasks: true,
          sessions: true,
          deployments: true,
          privileged,
          networkProfile: record.networkProfile
        }
      },
      permissions: {
        contents: {
          read: contentsRead,
          write: contentsWrite
        },
        issues: {
          read: issuesRead,
          write: issuesWrite
        },
        pullRequests: {
          read: pullRequestsRead,
          write: pullRequestsWrite
        }
      },
      operations: {
        gitFetch: contentsRead,
        gitPull: contentsRead,
        gitPush: contentsWrite,
        issueList: issuesRead,
        issueView: issuesRead,
        issueCreate: issuesWrite,
        issueComment: issuesWrite,
        issueUpdate: issuesWrite,
        issuePublish: issuesWrite,
        labelCreate: issuesWrite,
        pullRequestList: pullRequestsRead,
        pullRequestView: pullRequestsRead,
        pullRequestCreate: pullRequestsWrite,
        execRun: true,
        privilegedExec: privileged,
        deploymentsRun: true
      }
    };
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
    if (record.status === 'NETWORK_QUARANTINED') {
      if (allowRecoverable) return record;
      throw new HarnessError('DEPENDENCY_EGRESS_UNAVAILABLE', `workspace is quarantined due to network security policy drift (${record.error ?? 'firewall attestation failed'}); use workspace_recover after policy reconciliation or workspace_close`, 503, false);
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
    if (record.status === 'EXPIRED_RECOVERABLE' || record.status === 'NETWORK_QUARANTINED') return record;
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
    const redactor = this.getRedactor(record.id);
    if (result.exitCode !== 0) {
      const rawError = result.stderr || result.stdout || 'worker failed';
      const sanitized = redactor.sanitizeString(rawError);
      this.operations.updateGenericOperation(operationId, {
        status: 'failed',
        error: { code: 'INTERNAL_ERROR', message: sanitized.slice(0, 2_000), retryable: true }
      });
      throw new HarnessError('INTERNAL_ERROR', `worker failed: ${sanitized}`.slice(0, 2_000), 500, true);
    }
    try {
      const parsed = RunnerResponseSchema.parse(JSON.parse(result.stdout));
      const sanitized = redactor.sanitizeObject(parsed);
      this.operations.updateGenericOperation(operationId, {
        status: sanitized.ok ? 'completed' : 'failed',
        result: sanitized.data,
        error: sanitized.error
      });
      return {
        ...sanitized,
        data: sanitized.data && typeof sanitized.data === 'object' ? { ...sanitized.data, operationId } : sanitized.data
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
        const errText = result.stderr || result.stdout;
        if (mode === 'push') {
          if (errText.includes('stale info') || errText.includes('[rejected]') || errText.includes('lease') || errText.includes('non-fast-forward') || errText.includes('fetch first')) {
            throw new HarnessError('CONFLICT', `Git push rejected: remote ref has diverged or force-with-lease failed (${errText})`.slice(0, 2_000), 409, false, {
              expectedRemoteOid,
              resumeAction: 'reconcile_push'
            });
          }
          if (errText.includes('Connection timed out') || errText.includes('Connection reset') || errText.includes('timed out') || errText.includes('Could not resolve host')) {
            throw new HarnessError('UNKNOWN_REMOTE_STATE', `Git push was interrupted by network failure (${errText})`.slice(0, 2_000), 504, true, {
              expectedRemoteOid,
              resumeAction: 'reconcile_push'
            });
          }
        }
        throw new HarnessError('UNAVAILABLE', `Git ${action} failed: ${errText}`.slice(0, 2_000), 502, true);
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
  private async currentHead(record: WorkspaceRecord, signal?: AbortSignal): Promise<string> {
    if (record.containerName) {
      const result = await runDocker([
        'exec', record.containerName, 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', 'rev-parse', 'HEAD'
      ], { timeoutMs: 30_000, maxBytes: 8_192, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new HarnessError('CONFLICT', 'current Git HEAD could not be determined', 409, false);
      return result.stdout.trim();
    }
    const helperName = `chm-hd-${record.id.slice(3, 15)}-${randomBytes(4).toString('hex')}`;
    try {
      const result = await runDocker([
        'run', '--rm', '--name', helperName,
        '--label', 'cloud-harness.ephemeral=true',
        '--network', 'none', '--user', '10001:10001', '--read-only',
        '--volume', `${record.workspacePath}/repo:/workspace:ro`,
        '--workdir', '/workspace',
        '--entrypoint', 'git',
        this.config.executorImage,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', 'rev-parse', 'HEAD'
      ], { timeoutMs: 30_000, maxBytes: 8_192, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new HarnessError('CONFLICT', 'current Git HEAD could not be determined', 409, false);
      return result.stdout.trim();
    } finally {
      await removeContainer(helperName);
    }
  }

  private async probeRemoteRefOid(record: WorkspaceRecord, branch: string, token?: string, signal?: AbortSignal): Promise<string | undefined> {
    const repositoryUrl = await validateRepositoryUrl(record.repositoryUrl, this.config.allowedGitHosts);
    const helperName = `chm-probe-${randomBytes(6).toString('hex')}`;
    try {
      const askpassScript = `#!/usr/bin/env bash
case \${1:-} in
  *Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$CLOUD_HARNESS_GIT_TOKEN" ;;
esac
`;
      const result = await runDocker([
        'run', '-i', '--rm', '--name', helperName,
        '--label', 'cloud-harness.role=probe-helper', '--label', 'cloud-harness.ephemeral=true',
        '--network', 'bridge', '--user', '10001:10001', '--read-only',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
        '--entrypoint', '/bin/bash', this.config.executorImage,
        '-c',
        `token=; IFS= read -r token || true;
if [[ -n $token ]]; then
  printf '%s\\n' '${askpassScript}' > /tmp/askpass;
  chmod 0700 /tmp/askpass;
  export CLOUD_HARNESS_GIT_TOKEN=$token;
  export GIT_ASKPASS=/tmp/askpass;
fi;
git -c http.followRedirects=false -c core.hooksPath=/dev/null ls-remote "$1" "$2"
`,
        'probe-helper', repositoryUrl.toString(), `refs/heads/${branch}`
      ], {
        stdin: `${token ?? ''}\n`,
        timeoutMs: 30_000,
        maxBytes: 65_536,
        ...(signal ? { signal } : {})
      });
      if (result.exitCode === 0) {
        const line = result.stdout.trim().split('\n')[0];
        const oid = line?.split(/\s+/)[0];
        return oid || undefined;
      }
      return undefined;
    } catch {
      return undefined;
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
    const repoStr = this.extractRepositoryName(repositoryUrl);
    let token: string | undefined;
    try {
      token = await this.repositoryToken(record.ownerId, repositoryUrl, 'write');
    } catch (err: unknown) {
      if (err instanceof HarnessError && (err.code === 'FORBIDDEN' || err.code === 'REPOSITORY_OPERATION_NOT_AUTHORIZED')) {
        throw new HarnessError('REPOSITORY_OPERATION_NOT_AUTHORIZED', err.message, 403, false, {
          operation: 'git_push',
          repository: repoStr ?? undefined,
          requiredCapability: 'repository.push'
        });
      }
      throw err;
    }
    if (!token) {
      throw new HarnessError('REPOSITORY_OPERATION_NOT_AUTHORIZED', 'Git push requires a configured GitHub App with repository write access', 403, false, {
        operation: 'git_push',
        repository: repoStr ?? undefined,
        requiredCapability: 'repository.push'
      });
    }
    const idempotencyKey = input.idempotencyKey as string | undefined;
    const requestedRefspec = input.refspec as string | undefined;
    const branch = requestedRefspec ? '' : await this.currentBranch(record, signal);
    if (!requestedRefspec && !branch) throw new HarnessError('CONFLICT', 'git_push requires refspec when HEAD is detached', 409, false);
    const refspec = normalizePushRefspec(requestedRefspec, branch);
    const expectedRemoteOid = input.expectedRemoteOid as string | undefined;
    const forceWithLease = Boolean(input.forceWithLease);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ refspec, expectedRemoteOid: expectedRemoteOid ?? null, forceWithLease }))
      .digest('hex');
    const currentLocalHead = await this.currentHead(record, signal);

    if (idempotencyKey) {
      const claim = this.store.acquireGitOperation({
        ownerId: record.ownerId,
        workspaceId: record.id,
        idempotencyKey,
        operation: 'push',
        requestFingerprint,
        targetRef: refspec,
        expectedRemoteOid: expectedRemoteOid ?? null,
        localCommitSha: currentLocalHead,
        createdAt: Date.now()
      });

      if (claim.action === 'FINGERPRINT_CONFLICT') {
        throw new HarnessError('CONFLICT', 'Idempotency key reused with different push parameters', 409, false);
      }
      if (claim.action === 'IN_FLIGHT') {
        throw new HarnessError('CONFLICT', 'Git push operation with this idempotency key is already in progress', 409, true);
      }
      if (claim.action === 'REPLAY_SUCCEEDED' && claim.existing?.resultJson) {
        const parsed = JSON.parse(claim.existing.resultJson) as RunnerResponse;
        return { ...parsed, data: { ...(typeof parsed.data === 'object' && parsed.data ? parsed.data : {}), alreadyFinalized: true } };
      }
      if (claim.action === 'RECONCILE_REQUIRED' && claim.existing) {
        const existingOp = claim.existing;
        if (existingOp.status === 'UNKNOWN_REMOTE_STATE') {
          const targetBranchName = branch || (refspec.includes(':') ? refspec.split(':')[1]?.replace(/^refs\/heads\//, '') : refspec.replace(/^refs\/heads\//, '')) || 'main';
          const remoteOid = await this.probeRemoteRefOid(record, targetBranchName, token, signal);
          if (remoteOid && existingOp.localCommitSha && remoteOid === existingOp.localCommitSha) {
            const successResponse: RunnerResponse = {
              ok: true,
              message: 'Git push complete (reconciled from remote state)',
              data: { refspec, alreadyFinalized: true },
              truncated: false
            };
            this.store.updateGitOperationStatus(record.ownerId, record.id, idempotencyKey, 'SUCCEEDED', JSON.stringify(successResponse), null, existingOp.localCommitSha);
            return successResponse;
          }
          if (expectedRemoteOid && remoteOid && remoteOid !== expectedRemoteOid && remoteOid !== existingOp.localCommitSha) {
            throw new HarnessError('CONFLICT', `Remote branch moved to ${remoteOid} during push retry (expected ${expectedRemoteOid})`, 409, false, {
              currentRemoteOid: remoteOid,
              expectedRemoteOid,
              resumeAction: 'reconcile_push'
            });
          }
          if (!remoteOid) {
            throw new HarnessError('UNKNOWN_REMOTE_STATE', 'Remote state could not be determined during reconciliation probe; please retry after verifying connection', 504, true, {
              expectedRemoteOid,
              resumeAction: 'reconcile_push'
            });
          }
          this.store.updateGitOperationStatus(record.ownerId, record.id, idempotencyKey, 'PENDING');
        } else {
          this.store.updateGitOperationStatus(record.ownerId, record.id, idempotencyKey, 'PENDING');
        }
      }
    }

    const transferName = `git-transfer-${randomBytes(12).toString('hex')}`;
    try {
      if (record.containerName) {
        await this.withPausedExecutor(record, async () =>
          await this.runGitTransferHelper(record, 'stage-push', transferName, '', undefined, undefined, signal)
        );
      } else {
        await this.runGitTransferHelper(record, 'stage-push', transferName, '', undefined, undefined, signal);
      }
      let pushed: { exitCode: number; stdout: string; stderr: string; truncated: boolean };
      try {
        pushed = await this.runGitTransferHelper(record, 'push', transferName, refspec, token, expectedRemoteOid, signal);
      } catch (err: unknown) {
        if (err instanceof HarnessError && (err.code === 'TIMEOUT' || err.code === 'UNAVAILABLE')) {
          throw new HarnessError('UNKNOWN_REMOTE_STATE', `Git push interrupted by timeout or transport failure (${err.message})`.slice(0, 2_000), 504, true, {
            expectedRemoteOid,
            resumeAction: 'reconcile_push'
          });
        }
        throw err;
      }
      const response: RunnerResponse = {
        ok: true,
        message: 'Git push complete',
        data: { output: pushed.stdout || pushed.stderr, refspec },
        truncated: pushed.truncated
      };
      if (idempotencyKey) {
        this.store.updateGitOperationStatus(record.ownerId, record.id, idempotencyKey, 'SUCCEEDED', JSON.stringify(response), null, currentLocalHead);
      }
      return response;
    } catch (err: unknown) {
      if (err instanceof HarnessError && idempotencyKey) {
        const status: GitOperationStatus = err.code === 'UNKNOWN_REMOTE_STATE' ? 'UNKNOWN_REMOTE_STATE' : (err.code === 'CONFLICT' ? 'CONFLICT' : 'FAILED');
        this.store.updateGitOperationStatus(record.ownerId, record.id, idempotencyKey, status, null, JSON.stringify({ message: err.message, code: err.code }), currentLocalHead);
      }
      throw err;
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
      await this.networkProfileManager.ensureProfileReady(record.networkProfile);
      const result = await runDocker([
        'run', '-i', '--rm', '--name', privName,
        '--label', 'cloud-harness.managed=true',
        '--label', `cloud-harness.instance=${this.instanceId}`,
        '--label', `cloud-harness.workspace=${record.id}`,
        '--label', 'cloud-harness.role=priv-exec',
        '--label', 'cloud-harness.ephemeral=true',
        ...this.networkProfileManager.dockerLaunchArgs(record.networkProfile),
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
    const requiredCapability = permissionScope === 'pull_requests'
      ? (isWrite ? 'repository.pullRequestsWrite' : 'repository.pullRequestsRead')
      : (isWrite ? 'repository.issuesWrite' : 'repository.issuesRead');
    let repoUrl: URL;
    try {
      repoUrl = new URL(record.repositoryUrl);
    } catch {
      throw new HarnessError('INVALID_INPUT', 'Invalid repository URL');
    }
    const repoStr = this.extractRepositoryName(repoUrl);

    let token: string | undefined;
    try {
      token = await mintPrincipalRepositoryScopedToken({
        config: this.config,
        principalId: record.ownerId,
        repositoryUrl: repoUrl,
        installations: this.githubInstallations,
        permissionScope,
        requiredPermission: isWrite ? 'write' : 'read'
      });
    } catch (err: unknown) {
      if (err instanceof HarnessError && (err.code === 'FORBIDDEN' || err.code === 'REPOSITORY_OPERATION_NOT_AUTHORIZED')) {
        if (isWrite) {
          this.auditWorkspaceOutcome(record.ownerId, `github_action.${action}`, record, {
            repository: record.repositoryUrl,
            action,
            success: false,
            errorCode: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'
          });
        }
        throw new HarnessError('REPOSITORY_OPERATION_NOT_AUTHORIZED', err.message, 403, false, {
          operation: `github_action.${action}`,
          repository: repoStr ?? undefined,
          requiredCapability
        });
      }
      throw err;
    }
    if (!token) {
      if (isWrite) {
        this.auditWorkspaceOutcome(record.ownerId, `github_action.${action}`, record, {
          repository: record.repositoryUrl,
          action,
          success: false,
          errorCode: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'
        });
      }
      throw new HarnessError('REPOSITORY_OPERATION_NOT_AUTHORIZED', `No GitHub App installation available for ${record.repositoryUrl}`, 403, false, {
        operation: `github_action.${action}`,
        repository: repoStr ?? undefined,
        requiredCapability
      });
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

      if (result.exitCode === 0) {
        return {
          ok: true,
          message: `GitHub ${action} successful`,
          data: { output: result.stdout || result.stderr },
          truncated: result.truncated
        };
      }

      const classified = classifyGitHubFailure(result.stderr, result.stdout, action);
      return {
        ok: false,
        message: classified.message,
        data: { output: result.stdout || result.stderr },
        error: {
          code: classified.code,
          message: classified.message,
          retryable: classified.retryable,
          ...(classified.retryAfterMs ? { retryAfterMs: classified.retryAfterMs } : {})
        },
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
    if (operation === 'secrets_list') return this.secretsList(ownerId, validated);
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

    if (operation === 'artifacts_list') {
      try {
        const page = this.requireArtifacts().list(ownerId, {
          limit: validated.limit as number,
          ...(validated.cursor ? { cursor: validated.cursor as string } : {})
        });
        return { ok: true, message: 'Artifacts listed', data: { artifacts: page.artifacts }, truncated: false, ...(page.cursor ? { cursor: page.cursor } : {}) };
      } catch (error) {
        if (error instanceof ArtifactStoreError) {
          const status = error.code === 'NOT_FOUND' ? 404 : (error.code === 'CONFLICT' ? 409 : (error.code === 'LIMIT_EXCEEDED' ? 429 : 400));
          throw new HarnessError(error.code, error.message, status, false);
        }
        throw error;
      }
    }
    if (operation === 'artifacts_read') {
      try {
        const chunk = this.requireArtifacts().read(ownerId, {
          artifactId: validated.artifactId as string,
          ...(validated.offset !== undefined ? { offset: validated.offset as number } : {}),
          ...(validated.limit !== undefined ? { limit: validated.limit as number } : {})
        });
        return { ok: true, message: 'Artifact chunk read', data: chunk, truncated: !chunk.eof, ...(chunk.eof ? {} : { cursor: String(chunk.offset + chunk.bytesReturned) }) };
      } catch (error) {
        if (error instanceof ArtifactStoreError) {
          const status = error.code === 'NOT_FOUND' ? 404 : (error.code === 'CONFLICT' ? 409 : (error.code === 'LIMIT_EXCEEDED' ? 429 : 400));
          throw new HarnessError(error.code, error.message, status, false);
        }
        throw error;
      }
    }
    if (operation === 'artifacts_delete') {
      try {
        const deleted = this.requireArtifacts().delete(
          ownerId,
          validated.artifactId as string,
          (validated.expectedGeneration as number) ?? 1,
          (database, _owner, artifact) => this.metadata?.recordAuditInTransaction(
            database, ownerId, 'artifact.deleted', 'artifact', artifact.artifactId, artifact.generation
          )
        );
        return { ok: true, message: 'Artifact deleted', data: deleted, truncated: false };
      } catch (error) {
        if (error instanceof ArtifactStoreError) {
          const status = error.code === 'NOT_FOUND' ? 404 : (error.code === 'CONFLICT' ? 409 : (error.code === 'LIMIT_EXCEEDED' ? 429 : 400));
          throw new HarnessError(error.code, error.message, status, false);
        }
        throw error;
      }
    }

    const workspaceId = validated.workspaceId as string | undefined;
    if (operation === 'workspace_status') return this.status(ownerId, workspaceId);
    if (operation === 'workspace_capabilities') {
      const rec = this.requireWorkspace(ownerId, workspaceId, false, true);
      const caps = this.computeWorkspaceCapabilities(rec);
      return {
        ok: true,
        message: 'Workspace capabilities retrieved',
        data: caps,
        truncated: false
      };
    }
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
            updated = this.store.updateFenced(activeRecord.id, activeRecord.generation, ['ACTIVE', 'EXPIRED_RECOVERABLE', 'NETWORK_QUARANTINED'], {
              status: 'ACTIVE',
              lastActivityAt: now,
              expiresAt: newExpires,
              error: null
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
    if (AgentManager.isPublicOperation(operation)) {
      if (!this.agentManager) throw new HarnessError('UNAVAILABLE', 'agent execution is not configured', 503, false);
      const targetWorkspace = this.requireWorkspace(ownerId, workspaceId, false, true);
      return await this.agentManager.dispatch(ownerId, targetWorkspace, operation, validated);
    }

    const record = this.touch(this.requireWorkspace(ownerId, workspaceId, true, false));
    await this.enforceActiveLimits(record);

    const dispatchAction = async (): Promise<RunnerResponse> => {
    if (operation === 'artifacts_snapshot') {
      const created = await this.snapshotArtifact(principal, validated as {
        workspaceId?: string;
        path: string;
        logicalName: string;
        retentionSeconds?: number;
      });
      return { ok: true, message: 'Artifact snapshot created', data: created, truncated: false };
    }
    if (operation === 'artifacts_restore') {
      const restored = await this.restoreArtifact(principal, validated as {
        artifactId: string;
        workspaceId?: string;
        path: string;
        overwrite?: boolean;
        expectedSha256?: string;
      }, signal);
      return { ok: true, message: 'Artifact restored to workspace', data: restored, truncated: false };
    }
    if (operation === 'workspace_context') {
      let branch = '';
      try {
        branch = await this.currentBranch(record, signal);
      } catch { /* branch resolution optional */ }
      const gitIdentity = this.store.getGitIdentity(ownerId) ?? {
        name: record.gitAuthorName || 'Cloud Harness Agent',
        email: record.gitAuthorEmail || 'agent@cloud-harness.local'
      };
      const caps = this.computeWorkspaceCapabilities(record);
      let manifest: unknown = undefined;
      try {
        const scanRes = await this.runWorker(record, 'workspace_context', validated, signal);
        if (scanRes.ok && scanRes.data && typeof scanRes.data === 'object' && 'manifest' in scanRes.data) {
          const rawManifest = scanRes.data.manifest as Record<string, unknown>;
          const rawItems = Array.isArray(rawManifest.items) ? rawManifest.items : [];
          const maxBytes = Math.min(Math.max(Number((validated as { maxBytes?: number }).maxBytes || 32768), 4096), 131072);
          const sanitizedItems = [];
          let accumulatedBytes = 0;
          let truncated = Boolean(rawManifest.truncated);
          const truncationReasons = Array.isArray(rawManifest.truncationReasons) ? [...rawManifest.truncationReasons] : [];

          for (const rawItem of rawItems as Record<string, unknown>[]) {
            const pathStr = typeof rawItem.path === 'string' ? rawItem.path : undefined;
            const hashStr = typeof rawItem.contentSha256 === 'string' && rawItem.contentSha256.length === 64
              ? rawItem.contentSha256
              : '0'.repeat(64);
            const item = {
              id: typeof rawItem.id === 'string' ? rawItem.id : `ctx_${hashStr.slice(0, 12)}`,
              kind: typeof rawItem.kind === 'string' ? rawItem.kind : 'instruction',
              format: typeof rawItem.format === 'string' ? rawItem.format : 'plain',
              clients: Array.isArray(rawItem.clients) ? rawItem.clients : ['all'],
              path: pathStr,
              appliesTo: typeof rawItem.appliesTo === 'string' ? rawItem.appliesTo : undefined,
              activeForClient: Boolean(rawItem.activeForClient ?? true),
              contentSha256: hashStr,
              byteCount: typeof rawItem.byteCount === 'number' ? rawItem.byteCount : 0,
              excerpt: typeof rawItem.excerpt === 'string' ? rawItem.excerpt.slice(0, 8192) : undefined,
              references: Array.isArray(rawItem.references) ? rawItem.references : undefined,
              provenance: {
                source: 'repository',
                trust: 'untrusted-executor',
                mutableBy: 'repository-commit',
                path: pathStr,
                contentSha256: hashStr,
                discoveredAt: new Date().toISOString()
              }
            };
            const itemBytes = Buffer.byteLength(JSON.stringify(item));
            if (accumulatedBytes + itemBytes > maxBytes) {
              truncated = true;
              if (!truncationReasons.includes('byte-budget')) truncationReasons.push('byte-budget');
              break;
            }
            sanitizedItems.push(item);
            accumulatedBytes += itemBytes;
          }

          manifest = {
            contractVersion: 1,
            returnedBytes: accumulatedBytes,
            scannedFiles: typeof rawManifest.scannedFiles === 'number' ? rawManifest.scannedFiles : sanitizedItems.length,
            scannedSourceBytes: typeof rawManifest.scannedSourceBytes === 'number' ? rawManifest.scannedSourceBytes : accumulatedBytes,
            truncated,
            truncationReasons,
            cursor: typeof rawManifest.cursor === 'string' ? rawManifest.cursor : undefined,
            items: sanitizedItems,
            warnings: Array.isArray(rawManifest.warnings) ? rawManifest.warnings : []
          };
        }
      } catch {
        // manifest scanning is non-blocking
      }
      return {
        ok: true,
        message: 'Workspace context',
        data: {
          workspace: this.publicWorkspaceRecord(record),
          branch,
          gitIdentity,
          capabilities: caps.capabilities,
          permissions: caps.permissions,
          operations: caps.operations,
          ...(manifest ? { manifest } : {})
        },
        truncated: false
      };
    }
    if (operation === 'memories_write') {
      const scope = (validated.scope || 'workspace') as 'owner' | 'repository' | 'workspace';
      const repoKey = scope === 'repository' ? createHash('sha256').update(record.repositoryUrl.toLowerCase()).digest('hex') : null;
      const expectedGen = typeof validated.expectedGeneration === 'number' ? validated.expectedGeneration : 0;
      let mem;
      try {
        if (expectedGen === 0) {
          mem = this.store.createMemory({
            principalId: ownerId,
            scope,
            repositoryKey: repoKey,
            workspaceId: scope === 'workspace' ? record.id : null,
            name: validated.name as string,
            content: validated.content as string,
            ...(Array.isArray(validated.tags) ? { tags: validated.tags as string[] } : {}),
            ...(typeof validated.retentionSeconds === 'number' ? { retentionSeconds: validated.retentionSeconds } : {})
          });
        } else {
          mem = this.store.updateMemory({
            principalId: ownerId,
            ...(typeof validated.name === 'string' ? { name: validated.name } : {}),
            scope,
            repositoryKey: repoKey,
            workspaceId: scope === 'workspace' ? record.id : null,
            content: validated.content as string,
            ...(Array.isArray(validated.tags) ? { tags: validated.tags as string[] } : {}),
            ...(typeof validated.retentionSeconds === 'number' ? { retentionSeconds: validated.retentionSeconds } : {}),
            expectedGeneration: expectedGen
          });
        }
        this.auditWorkspaceMutation(ownerId, 'memory.written', record, { name: String(validated.name), scope, generation: mem.generation });
      } catch (err: unknown) {
        if (err instanceof Error && (err.message.includes('conflict') || err.message.includes('already exists'))) {
          throw new HarnessError('CONFLICT', err.message, 409, false);
        }
        throw err;
      }
      return { ok: true, message: 'Memory note saved', data: mem, truncated: false };
    }
    if (operation === 'memories_read') {
      const scope = validated.scope as 'owner' | 'repository' | 'workspace' | undefined;
      const repoKey = scope === 'repository' ? createHash('sha256').update(record.repositoryUrl.toLowerCase()).digest('hex') : null;
      const mem = this.store.readMemory({
        principalId: ownerId,
        ...(typeof validated.memoryId === 'string' ? { id: validated.memoryId } : {}),
        ...(typeof validated.name === 'string' ? { name: validated.name } : {}),
        ...(scope ? { scope } : {}),
        repositoryKey: repoKey,
        workspaceId: record.id
      });
      if (!mem) {
        throw new HarnessError('NOT_FOUND', 'memory note not found', 404, false);
      }
      return { ok: true, message: 'Memory note read', data: mem, truncated: false };
    }
    if (operation === 'memories_list') {
      const scope = validated.scope as 'owner' | 'repository' | 'workspace' | undefined;
      const repoKey = scope === 'repository' ? createHash('sha256').update(record.repositoryUrl.toLowerCase()).digest('hex') : null;
      const { memories, nextCursor } = this.store.listMemories({
        principalId: ownerId,
        ...(scope ? { scope } : {}),
        repositoryKey: repoKey,
        workspaceId: record.id,
        ...(Array.isArray(validated.tags) ? { tags: validated.tags as string[] } : {}),
        ...(typeof validated.limit === 'number' ? { limit: validated.limit } : {}),
        ...(typeof validated.cursor === 'string' ? { cursor: validated.cursor } : {})
      });
      return {
        ok: true,
        message: `Found ${memories.length} memories`,
        data: { memories: memories.map(m => ({ id: m.id, name: m.name, scope: m.scope, tags: m.tags, generation: m.generation, provenance: m.provenance })) },
        truncated: Boolean(nextCursor),
        ...(nextCursor ? { cursor: nextCursor } : {})
      };
    }
    if (operation === 'memories_search') {
      const scope = validated.scope as 'owner' | 'repository' | 'workspace' | undefined;
      const repoKey = scope === 'repository' ? createHash('sha256').update(record.repositoryUrl.toLowerCase()).digest('hex') : null;
      const { memories, nextCursor } = this.store.searchMemories({
        principalId: ownerId,
        query: validated.query as string,
        ...(scope ? { scope } : {}),
        repositoryKey: repoKey,
        workspaceId: record.id,
        ...(Array.isArray(validated.tags) ? { tags: validated.tags as string[] } : {}),
        ...(typeof validated.limit === 'number' ? { limit: validated.limit } : {}),
        ...(typeof validated.cursor === 'string' ? { cursor: validated.cursor } : {})
      });
      return {
        ok: true,
        message: `Found ${memories.length} matching memories`,
        data: { memories },
        truncated: Boolean(nextCursor),
        ...(nextCursor ? { cursor: nextCursor } : {})
      };
    }
    if (operation === 'memories_delete') {
      const scope = validated.scope as 'owner' | 'repository' | 'workspace' | undefined;
      const repoKey = scope === 'repository' ? createHash('sha256').update(record.repositoryUrl.toLowerCase()).digest('hex') : null;
      try {
        this.store.deleteMemory({
          principalId: ownerId,
          ...(typeof validated.memoryId === 'string' ? { id: validated.memoryId } : {}),
          ...(typeof validated.name === 'string' ? { name: validated.name } : {}),
          ...(scope ? { scope } : {}),
          repositoryKey: repoKey,
          workspaceId: record.id,
          expectedGeneration: (validated.expectedGeneration as number) || 1
        });
        this.auditWorkspaceMutation(ownerId, 'memory.deleted', record, {
          ...(typeof validated.memoryId === 'string' ? { memoryId: validated.memoryId } : {}),
          ...(typeof validated.name === 'string' ? { name: validated.name } : {})
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('conflict')) {
          throw new HarnessError('CONFLICT', err.message, 409, false);
        }
        if (err instanceof Error && err.message.includes('not found')) {
          throw new HarnessError('NOT_FOUND', err.message, 404, false);
        }
        throw err;
      }
      return { ok: true, message: 'Memory note deleted', data: { deleted: true }, truncated: false };
    }
    if (operation === 'hooks_activate') {
      const events = validated.events as string[];
      const results = [];
      for (const ev of events) {
        const act = this.store.activateHook({
          principalId: ownerId,
          workspaceId: record.id,
          event: ev,
          manifestSha256: validated.manifestSha256 as string,
          ...(typeof validated.retentionSeconds === 'number' ? { retentionSeconds: validated.retentionSeconds } : {})
        });
        results.push(act);
      }
      this.auditWorkspaceMutation(ownerId, 'hook.activated', record, { events: Array.isArray(validated.events) ? (validated.events as string[]).join(',') : '', manifestSha256: String(validated.manifestSha256) });
      return { ok: true, message: 'Hooks activated', data: { activations: results }, truncated: false };
    }
    if (operation === 'hooks_deactivate') {
      const events = validated.events as string[] | undefined;
      if (events && events.length > 0) {
        for (const ev of events) {
          this.store.deactivateHook({ principalId: ownerId, workspaceId: record.id, event: ev });
        }
      } else {
        this.store.deactivateHook({ principalId: ownerId, workspaceId: record.id });
      }
      this.auditWorkspaceMutation(ownerId, 'hook.deactivated', record, { ...(events ? { events: events.join(',') } : { all: true }) });
      return { ok: true, message: 'Hooks deactivated', data: { deactivated: true }, truncated: false };
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
      const branch = (validated.branch as string | undefined) ?? await this.currentBranch(record, signal);
      const targetRef = `refs/heads/${branch}`;
      const idempotencyKey = validated.idempotencyKey as string | undefined;
      const requestFingerprint = idempotencyKey
        ? createHash('sha256').update(JSON.stringify(validated)).digest('hex')
        : undefined;

      if (idempotencyKey && requestFingerprint) {
        const claim = this.store.acquireGitOperation({
          ownerId,
          workspaceId: record.id,
          idempotencyKey,
          operation: 'finalize',
          requestFingerprint,
          targetRef,
          expectedRemoteOid: null,
          localCommitSha: null,
          createdAt: Date.now()
        });

        if (claim.action === 'FINGERPRINT_CONFLICT') {
          throw new HarnessError('CONFLICT', 'Idempotency key reused with different finalize parameters', 409, false);
        }
        if (claim.action === 'IN_FLIGHT') {
          throw new HarnessError('CONFLICT', 'Finalize operation with this idempotency key is already in progress', 409, true);
        }
        if (claim.action === 'REPLAY_SUCCEEDED' && claim.existing?.resultJson) {
          const parsed = JSON.parse(claim.existing.resultJson) as RunnerResponse;
          return { ...parsed, data: { ...(typeof parsed.data === 'object' && parsed.data ? parsed.data : {}), alreadyFinalized: true } };
        }
        if (claim.action === 'RECONCILE_REQUIRED' && claim.existing) {
          const existingOp = claim.existing;
          if (existingOp.status === 'UNKNOWN_REMOTE_STATE' && existingOp.localCommitSha) {
            const repositoryUrl = await validateRepositoryUrl(record.repositoryUrl, this.config.allowedGitHosts);
            let token: string | undefined;
            try {
              token = await this.repositoryToken(record.ownerId, repositoryUrl, 'write');
            } catch { /* ignore if token cannot be minted */ }
            const remoteOid = await this.probeRemoteRefOid(record, branch, token, signal);
            if (remoteOid && remoteOid === existingOp.localCommitSha) {
              const successResponse: RunnerResponse = {
                ok: true,
                message: `Workspace finalized and pushed to ${branch} (reconciled from remote state)`,
                data: {
                  commitSha: existingOp.localCommitSha,
                  branch,
                  pushed: true,
                  alreadyFinalized: true
                },
                truncated: false
              };
              this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'SUCCEEDED', JSON.stringify(successResponse), null, existingOp.localCommitSha);
              return successResponse;
            }
          }
          this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'PENDING');
        }
      }

      const runFinalize = async (): Promise<RunnerResponse> => {
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
              pushResult = await this.remotePush(record, {
                refspec: `HEAD:refs/heads/${branch}`,
                idempotencyKey: idempotencyKey ? `${idempotencyKey}:push` : undefined
              }, signal);
              pushed = Boolean(pushResult.ok);
            } catch (err: unknown) {
              const pushErrMsg = err instanceof Error ? err.message : 'push failed';
              const errorCode = err instanceof HarnessError ? err.code : 'UNAVAILABLE';
              const retryable = err instanceof HarnessError ? err.retryable : true;
              const operationDetail = err instanceof HarnessError ? err.operation : undefined;
              const repositoryDetail = err instanceof HarnessError ? err.repository : undefined;
              const requiredCapDetail = err instanceof HarnessError ? err.requiredCapability : undefined;
              if (idempotencyKey) {
                const isUnknown = errorCode === 'UNKNOWN_REMOTE_STATE';
                this.store.updateGitOperationStatus(
                  ownerId, record.id, idempotencyKey,
                  isUnknown ? 'UNKNOWN_REMOTE_STATE' : 'FAILED',
                  null,
                  JSON.stringify({ message: pushErrMsg, code: errorCode }),
                  commitSha
                );
              }
              return {
                ok: false,
                message: `Working tree clean but push failed: ${pushErrMsg}`,
                data: { step: 'push', commitSha, branch, pushed: false, pushError: pushErrMsg, resumeAction: 'Call git_push or workspace_finalize to retry push' },
                error: {
                  code: errorCode,
                  message: pushErrMsg,
                  retryable,
                  operation: operationDetail,
                  repository: repositoryDetail,
                  requiredCapability: requiredCapDetail
                },
                truncated: false
              };
            }
          }
          return {
            ok: true,
            message: `Workspace already clean and finalized at ${commitSha.slice(0, 7)}`,
            data: { commitSha, branch, pushed, alreadyFinalized: true, finalStatus: currentStatus.data },
            truncated: false
          };
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

        // Step 4: Run pre_commit lifecycle hooks, resolve Git author & Commit
        await this.runLifecycleHooks(record, 'pre_commit', signal);

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
        await this.runLifecycleHooks(record, 'post_commit', signal);

        const logResult = await this.runWorker(record, 'git_log', { limit: 1 }, signal);
        const commitSha = (logResult.data && typeof logResult.data === 'object' && 'output' in logResult.data && typeof logResult.data.output === 'string') ? logResult.data.output.split('\t')?.[0] || '' : '';
        if (idempotencyKey && commitSha) {
          this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'PENDING', null, null, commitSha);
        }

        // Step 5: Push if requested
        let pushResult: RunnerResponse | undefined;
        let pushed = false;
        if (validated.push !== false) {
          try {
            pushResult = await this.remotePush(record, {
              refspec: `HEAD:refs/heads/${branch}`,
              idempotencyKey: idempotencyKey ? `${idempotencyKey}:push` : undefined
            }, signal);
            pushed = Boolean(pushResult.ok);
          } catch (pushErr: unknown) {
            const pushErrMsg = pushErr instanceof Error ? pushErr.message : 'push failed';
            const errorCode = pushErr instanceof HarnessError ? pushErr.code : 'UNAVAILABLE';
            const retryable = pushErr instanceof HarnessError ? pushErr.retryable : true;
            const operationDetail = pushErr instanceof HarnessError ? pushErr.operation : undefined;
            const repositoryDetail = pushErr instanceof HarnessError ? pushErr.repository : undefined;
            const requiredCapDetail = pushErr instanceof HarnessError ? pushErr.requiredCapability : undefined;
            if (idempotencyKey) {
              const isUnknown = errorCode === 'UNKNOWN_REMOTE_STATE';
              this.store.updateGitOperationStatus(
                ownerId, record.id, idempotencyKey,
                isUnknown ? 'UNKNOWN_REMOTE_STATE' : 'FAILED',
                null,
                JSON.stringify({ message: pushErrMsg, code: errorCode }),
                commitSha
              );
            }
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
              error: {
                code: errorCode,
                message: pushErrMsg,
                retryable,
                operation: operationDetail,
                repository: repositoryDetail,
                requiredCapability: requiredCapDetail
              },
              truncated: false
            };
          }
        }

        const finalStatus = await this.runWorker(record, 'git_status', {}, signal);
        await this.enforceActiveLimits(record);

        return {
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
      };

      let response: RunnerResponse;
      try {
        response = await runFinalize();
      } catch (err: unknown) {
        if (idempotencyKey && err instanceof HarnessError) {
          this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'FAILED', null, JSON.stringify({ message: err.message, code: err.code }));
        }
        throw err;
      }

      if (idempotencyKey) {
        const commitSha = (response.data && typeof response.data === 'object' && 'commitSha' in response.data && typeof response.data.commitSha === 'string') ? response.data.commitSha : undefined;
        if (response.ok) {
          this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'SUCCEEDED', JSON.stringify(response), null, commitSha);
        } else {
          const isUnknown = response.error?.code === 'UNKNOWN_REMOTE_STATE';
          this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, isUnknown ? 'UNKNOWN_REMOTE_STATE' : 'FAILED', null, JSON.stringify(response.error ?? { message: response.message }), commitSha);
        }
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
      const isWrite = ['pr_create', 'pr_update', 'pr_comment', 'issue_create', 'issue_comment', 'issue_comment_update', 'label_create', 'issue_labels_add', 'issue_labels_remove', 'issue_update', 'issue_publish'].includes(action);
      if (isWrite) {
        const details: Record<string, string | number | boolean> = {
          repository: record.repositoryUrl,
          action,
          success: result.ok
        };
        if (typeof validated.prNumber === 'number') details.prNumber = validated.prNumber;
        if (typeof validated.issueNumber === 'number') details.issueNumber = validated.issueNumber;
        if (typeof validated.commentId === 'number') details.commentId = validated.commentId;
        if (typeof validated.draft === 'boolean') details.draft = validated.draft;
        if (typeof validated.state === 'string') details.state = validated.state;
        if (typeof validated.idempotencyKey === 'string') details.idempotencyKey = validated.idempotencyKey;
        if (typeof validated.name === 'string' && action === 'label_create') details.labelName = validated.name;
        if (result.ok && (action === 'pr_create' || action === 'issue_create')) {
          const match = String((result.data as Record<string, unknown>)?.output ?? '').match(/\/(?:pull|issues)\/(\d+)/);
          if (match && match[1]) {
            if (action === 'pr_create') details.createdPrNumber = Number(match[1]);
            if (action === 'issue_create') details.createdIssueNumber = Number(match[1]);
          }
        }
        if (!result.ok && result.error?.code) {
          details.errorCode = result.error.code;
        }
        this.auditWorkspaceOutcome(ownerId, `github_action.${action}`, record, details);
      }
      if ((action === 'pr_comment' || action === 'issue_comment' || action === 'issue_labels_add' || action === 'issue_publish') && validated.idempotencyKey && result.ok) {
        this.store.setCommentIdempotency(ownerId, validated.idempotencyKey as string, JSON.stringify(result), fingerprint);
      }
      await this.enforceActiveLimits(record);
      return result;
    }
    if (operation === 'git_checkout') {
      const result = await this.runWorker(record, 'git_checkout', validated, signal);
      if (result.ok) {
        await this.runLifecycleHooks(record, 'post_checkout', signal).catch(() => undefined);
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
      const isNew = !this.operations.hasTaskKey(mapKey, ownerId, record.id);
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
          taskTimeout,
          this.config.maxOutputBytes,
          (validated.dependsOn as string[]) ?? [],
          ownerId,
          record.workspacePath,
          validated.name as string | undefined
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
      const tasks = this.operations.listTasks(record.id, ownerId);
      const offset = Number(validated.cursor ?? 0);
      const limit = validated.limit as number;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('INVALID_INPUT', 'invalid task cursor');
      const page = tasks.slice(offset, offset + limit);
      const next = offset + page.length < tasks.length ? String(offset + page.length) : undefined;
      return { ok: true, message: 'Tasks listed', data: { tasks: page.map((task) => this.operations.summary(task)) }, truncated: false, ...(next ? { cursor: next } : {}) };
    }
    if (operation === 'tasks_status') {
      const page = this.operations.viewSince(this.operations.task(record.id, validated.taskId as string, ownerId), validated.cursor as string | undefined);
      return { ok: true, message: 'Task status', ...page };
    }
    if (operation === 'tasks_cancel') return { ok: true, message: 'Task cancelled', data: this.operations.view(await this.operations.cancelTask(record.id, validated.taskId as string, ownerId)), truncated: false };
    if (operation === 'tasks_graph') return { ok: true, message: 'Task dependency graph', data: this.operations.taskGraph(record.id, ownerId), truncated: false };
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
    if (operation === 'git_commit') {
      const expectedHeadOid = validated.expectedHeadOid as string | undefined;
      const idempotencyKey = validated.idempotencyKey as string | undefined;
      let requestFingerprint: string | undefined;
      if (idempotencyKey) {
        requestFingerprint = createHash('sha256')
          .update(JSON.stringify({
            message: validated.message,
            authorName: validated.authorName ?? null,
            authorEmail: validated.authorEmail ?? null,
            all: Boolean(validated.all),
            expectedHeadOid: expectedHeadOid ?? null
          }))
          .digest('hex');

        const existing = this.store.getGitOperation(ownerId, record.id, idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new HarnessError('CONFLICT', 'Idempotency key reused with different commit parameters', 409, false);
          }
          if (existing.status === 'SUCCEEDED' && existing.resultJson) {
            const parsed = JSON.parse(existing.resultJson) as RunnerResponse;
            return { ...parsed, data: { ...(typeof parsed.data === 'object' && parsed.data ? parsed.data : {}), alreadyFinalized: true } };
          }
          if (existing.status === 'PENDING') {
            throw new HarnessError('CONFLICT', 'Git commit operation with this idempotency key is already in progress', 409, true);
          }
        }
      }

      const currentHeadOid = await this.currentHead(record, signal);
      if (expectedHeadOid) {
        if (currentHeadOid !== expectedHeadOid) {
          throw new HarnessError('STALE_HEAD', `workspace HEAD is ${currentHeadOid}, expected ${expectedHeadOid}`, 409, false, {
            currentHeadOid,
            expectedHeadOid
          });
        }
      }

      if (idempotencyKey && requestFingerprint) {
        const claim = this.store.acquireGitOperation({
          ownerId,
          workspaceId: record.id,
          idempotencyKey,
          operation: 'commit',
          requestFingerprint,
          targetRef: null,
          expectedRemoteOid: null,
          localCommitSha: currentHeadOid,
          createdAt: Date.now()
        });
        if (claim.action === 'FINGERPRINT_CONFLICT') {
          throw new HarnessError('CONFLICT', 'Idempotency key reused with different commit parameters', 409, false);
        }
        if (claim.action === 'IN_FLIGHT') {
          throw new HarnessError('CONFLICT', 'Git commit operation with this idempotency key is already in progress', 409, true);
        }
        if (claim.action === 'REPLAY_SUCCEEDED' && claim.existing?.resultJson) {
          const parsed = JSON.parse(claim.existing.resultJson) as RunnerResponse;
          return { ...parsed, data: { ...(typeof parsed.data === 'object' && parsed.data ? parsed.data : {}), alreadyFinalized: true } };
        }
      }
      let result: RunnerResponse;
      try {
        await this.runLifecycleHooks(record, 'pre_commit', signal);
        result = await this.runWorker(record, 'git_commit', validated, signal);
        if (result.ok) {
          await this.runLifecycleHooks(record, 'post_commit', signal);
        }
      } catch (err: unknown) {
        if (idempotencyKey && err instanceof HarnessError) {
          this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'FAILED', null, JSON.stringify({ message: err.message, code: err.code }), currentHeadOid);
        }
        throw err;
      }
      await this.enforceActiveLimits(record);
      if (idempotencyKey && result.ok) {
        const commitSha = result.data && typeof result.data === 'object' && 'commitSha' in result.data && typeof result.data.commitSha === 'string' ? result.data.commitSha : undefined;
        this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'SUCCEEDED', JSON.stringify(result), null, commitSha);
      } else if (idempotencyKey && !result.ok) {
        this.store.updateGitOperationStatus(ownerId, record.id, idempotencyKey, 'FAILED', null, JSON.stringify(result.error ?? { message: result.message }), currentHeadOid);
      }
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

  async snapshotArtifact(
    principal: PrincipalSelector | string,
    input: {
      workspaceId?: string | undefined;
      path: string;
      logicalName: string;
      retentionSeconds?: number | undefined;
      projectId?: string | undefined;
      environmentId?: string | undefined;
    }
  ): Promise<ArtifactMetadata> {
    const ownerId = this.store.resolvePrincipal(typeof principal === 'string' ? { kind: 'owner', ownerId: principal } : principal);
    const record = this.requireWorkspace(ownerId, input.workspaceId);
    const provenance = {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {})
    };
    if (provenance.projectId || provenance.environmentId) {
      if (!this.metadata?.validateArtifactProvenance(ownerId, provenance)) {
        throw new HarnessError('NOT_FOUND', 'artifact provenance is unavailable', 404, false);
      }
    }
    const source = await this.readArtifactSource(typeof principal === 'string' ? { kind: 'owner', ownerId: principal } : principal, { workspaceId: record.id, path: input.path });
    const artifacts = this.requireArtifacts();
    return artifacts.create(ownerId, {
      logicalName: input.logicalName,
      content: source.content,
      workspaceId: record.id,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.retentionSeconds ? { retentionMs: input.retentionSeconds * 1_000 } : {})
    }, (database, _owner, artifact) => {
      if (provenance.projectId || provenance.environmentId) {
        if (!this.metadata?.validateArtifactProvenance(ownerId, provenance)) {
          throw new HarnessError('NOT_FOUND', 'artifact provenance is unavailable', 404, false);
        }
      }
      this.metadata?.recordAuditInTransaction(
        database, ownerId, 'artifact.created', 'artifact', artifact.artifactId,
        artifact.generation, { sizeBytes: artifact.sizeBytes }
      );
    });
  }

  async restoreArtifact(
    principal: PrincipalSelector | string,
    input: {
      artifactId: string;
      workspaceId?: string | undefined;
      path: string;
      overwrite?: boolean | undefined;
      expectedSha256?: string | undefined;
    },
    signal?: AbortSignal
  ): Promise<{ artifactId: string; workspaceId: string; path: string; sizeBytes: number; sha256: string }> {
    const ownerId = this.store.resolvePrincipal(typeof principal === 'string' ? { kind: 'owner', ownerId: principal } : principal);
    const record = this.requireWorkspace(ownerId, input.workspaceId, true, false);
    const artifacts = this.requireArtifacts();
    let artifactMeta: ArtifactMetadata;
    let content: Buffer;
    try {
      const payload = artifacts.readPayload(ownerId, input.artifactId);
      artifactMeta = payload.metadata;
      content = payload.content;
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        const status = error.code === 'NOT_FOUND' ? 404 : (error.code === 'CONFLICT' ? 409 : 400);
        throw new HarnessError(error.code, error.message, status, false);
      }
      throw error;
    }
    if (input.expectedSha256 && artifactMeta.sha256 !== input.expectedSha256) {
      throw new HarnessError('CONFLICT', 'artifact hash mismatch', 409, false);
    }
    const workerRes = await this.runWorker(record, 'artifacts_restore', {
      path: input.path,
      contentBase64: content.toString('base64'),
      overwrite: input.overwrite ?? false,
      expectedSha256: input.expectedSha256
    }, signal);
    if (!workerRes.ok) {
      const code = workerRes.error?.code ?? 'INTERNAL_ERROR';
      const msg = workerRes.error?.message ?? workerRes.message ?? 'failed to restore artifact';
      const status = code === 'CONFLICT' ? 409 : (code === 'INVALID_INPUT' ? 400 : (code === 'NOT_FOUND' ? 404 : (code === 'LIMIT_EXCEEDED' ? 429 : 500)));
      const errCode = (code === 'CONFLICT' || code === 'INVALID_INPUT' || code === 'NOT_FOUND' || code === 'LIMIT_EXCEEDED') ? code : 'INTERNAL_ERROR';
      throw new HarnessError(errCode, msg, status, false);
    }
    await this.enforceActiveLimits(record);
    this.metadata?.recordAudit(
      ownerId,
      'artifact.restored',
      'artifact',
      artifactMeta.artifactId,
      artifactMeta.generation,
      {
        sourceWorkspaceId: artifactMeta.workspaceId ?? '',
        destinationWorkspaceId: record.id,
        destinationPath: input.path,
        sha256: artifactMeta.sha256,
        sizeBytes: artifactMeta.sizeBytes
      }
    );
    return {
      artifactId: artifactMeta.artifactId,
      workspaceId: record.id,
      path: input.path,
      sizeBytes: artifactMeta.sizeBytes,
      sha256: artifactMeta.sha256
    };
  }

  async executeInternal(
    principal: PrincipalSelector,
    operation: InternalRunnerOperation,
    input: Record<string, unknown>
  ): Promise<RunnerResponse> {
    const parsed = InternalRunnerRequestSchema.parse({ version: 2, principal, operation, input });
    const ownerId = this.store.resolvePrincipal(parsed.principal);
    if (parsed.operation === 'toolkits_list') {
      const presets = this.toolkitService.listCatalogPresets();
      return { ok: true, message: 'Catalog toolkits list', data: { toolkits: presets }, truncated: false };
    }
    if (parsed.operation === 'toolkits_preview') {
      const fingerprint = this.toolkitService.computeRequestFingerprint(parsed.input.toolkits);
      return {
        ok: true,
        message: 'Toolkits preview',
        data: {
          requestFingerprint: fingerprint,
          toolkitsCount: parsed.input.toolkits.length
        },
        truncated: false
      };
    }
    const workspaceInput = parsed.input as { workspaceId: string; expectedGeneration?: number };
    const record = this.requireWorkspace(ownerId, workspaceInput.workspaceId, false, true);
    if (parsed.operation === 'workspace_detail') {
      return { ok: true, message: 'Workspace detail', data: internalWorkspaceDetail(record), truncated: false };
    }
    return await this.closeFenced(ownerId, workspaceInput.workspaceId, workspaceInput.expectedGeneration!);
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
    try {
      await this.agentManager?.stopWorkspace(claimed.ownerId, claimed.id, reason);
      await this.operations.stopWorkspace(claimed.id, claimed.ownerId);
    } catch (stopErr) {
      this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], {
        status: 'EXPIRED_RECOVERABLE',
        lastActivityAt: Date.now(),
        error: `Workspace stop failed: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`
      });
      throw stopErr;
    }
    if (this.artifacts) {
      const tasks = this.store.listDurableTasks(claimed.ownerId, claimed.id);
      for (const t of tasks) {
        if (t.logPath && existsSync(t.logPath) && !t.outputArtifactId) {
          const fileSize = statSync(t.logPath).size;
          if (fileSize > 0) {
            const rawContent = readFileSync(t.logPath);
            const content = rawContent.length <= this.config.maxArtifactBytes
              ? rawContent
              : rawContent.subarray(0, this.config.maxArtifactBytes);
            try {
              this.artifacts.create(claimed.ownerId, {
                logicalName: `task-output-${t.id}.log`,
                content,
                workspaceId: claimed.id
              }, (database, _owner, art) => {
                database.prepare(
                  'UPDATE durable_tasks SET output_artifact_id = ?, output_bytes = ? WHERE id = ?'
                ).run(art.artifactId, fileSize, t.id);
                this.metadata?.recordAuditInTransaction(
                  database, claimed.ownerId, 'artifact.created', 'artifact', art.artifactId,
                  art.generation, { sizeBytes: art.sizeBytes, taskId: t.id }
                );
              });
            } catch (spoolErr) {
              this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], {
                status: 'EXPIRED_RECOVERABLE',
                lastActivityAt: Date.now(),
                error: `Artifact spool failed: ${spoolErr instanceof Error ? spoolErr.message : String(spoolErr)}`
              });
              throw new HarnessError('UNAVAILABLE', `Failed to archive task output for task ${t.id} during close: ${spoolErr instanceof Error ? spoolErr.message : String(spoolErr)}`, 503, true);
            }
          }
        }
      }
    }
    if (claimed.containerName) await removeContainer(claimed.containerName);
    await this.safeRemovePath(claimed.workspacePath);
    this.store.deleteSecretSnapshot(claimed.id);
    this.store.reapWorkspaceMemories(claimed.ownerId, claimed.id);
    this.redactorCache.delete(claimed.id);
    const closed = this.store.updateFenced(claimed.id, claimed.generation, ['REAPING'], { status: 'CLOSED', containerName: null, error: reason, expiresAt: Date.now() });
    if (!closed) {
      const finalState = this.store.byId(claimed.id);
      if (finalState?.status === 'CLOSED') return;
      throw new HarnessError('CONFLICT', 'workspace cleanup lost its lifecycle lease', 409, true);
    }
  }

  private async reapExpired(): Promise<void> {
    const now = Date.now();
    const hasDependencyWorkspaces = this.store.active().some((r) => r.status === 'ACTIVE' && r.networkProfile === 'dependency-access');
    if (hasDependencyWorkspaces) {
      const attestation = await this.networkProfileManager.checkAttestation().catch(() => ({ ok: false, reason: 'attestation probe failed' }));
      if (!attestation.ok) {
        for (const record of this.store.active()) {
          if (record.status === 'ACTIVE' && record.networkProfile === 'dependency-access') {
            // 1. Atomically fence the workspace record to NETWORK_QUARANTINED first so no new execution can start
            const fenced = this.store.updateFenced(record.id, record.generation, ['ACTIVE'], {
              status: 'NETWORK_QUARANTINED',
              lastActivityAt: now,
              error: `host firewall policy drift detected: ${attestation.reason}`
            });
            if (!fenced) continue;

            // 2. Stop and remove all containers carrying this workspace's label, including privileged ephemerals
            const labeled = await runDocker([
              'ps', '-a', '--filter', `label=cloud-harness.workspace=${record.id}`, '--format', '{{.Names}}'
            ], { timeoutMs: 30_000, maxBytes: 1_048_576 }).catch(() => ({ exitCode: 1, stdout: '', stderr: '', truncated: false }));
            const names = new Set<string>(labeled.stdout.split('\n').map((n) => n.trim()).filter(Boolean));
            if (fenced.containerName) names.add(fenced.containerName);
            let allRemoved = true;
            for (const name of names) {
              try {
                await removeContainer(name);
              } catch {
                allRemoved = false;
              }
            }
            if (allRemoved) {
              this.store.update(record.id, { containerName: null });
            }

            // 3. Emit audit event (best-effort; observability failure must not abort security fencing/cleanup)
            try {
              this.metadata?.recordAudit(
                record.ownerId,
                'network_profile.drift_detected',
                'workspace',
                record.id,
                fenced.generation,
                { profile: record.networkProfile, containersRemoved: allRemoved }
              );
            } catch {
              // Ignore audit failure to ensure subsequent workspaces are fenced
            }
          }
        }
      }
    }
    // Retry forced removal for quarantined workspaces whose container removal
    // previously failed, so an unfiltered executor cannot linger.
    for (const record of this.store.active()) {
      if (record.status === 'NETWORK_QUARANTINED') {
        const labeled = await runDocker([
          'ps', '-a', '--filter', `label=cloud-harness.workspace=${record.id}`, '--format', '{{.Names}}'
        ], { timeoutMs: 30_000, maxBytes: 1_048_576 }).catch(() => ({ exitCode: 1, stdout: '', stderr: '', truncated: false }));
        const names = new Set<string>(labeled.stdout.split('\n').map((n) => n.trim()).filter(Boolean));
        if (record.containerName) names.add(record.containerName);
        let allRemoved = true;
        for (const name of names) {
          try {
            await removeContainer(name);
          } catch {
            allRemoved = false;
          }
        }
        if (allRemoved && record.containerName) {
          this.store.update(record.id, { containerName: null });
        }
      }
    }
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
    if (this.artifacts) {
      try {
        this.artifacts.reapExpired(now, 100, (database, principalId, artifact) => {
          this.metadata?.recordAuditInTransaction(
            database, principalId, 'artifact.expired', 'artifact', artifact.artifactId, artifact.generation
          );
        });
      } catch { /* ignore sweep error */ }
    }
    try {
      const staleTasks = this.store.listStaleDurableTasks(now - 7 * 86_400_000);
      for (const t of staleTasks) {
        if (t.logPath && existsSync(t.logPath)) {
          try { rmSync(t.logPath, { force: true }); } catch { /* ignore */ }
        }
      }
      await this.repoCacheManager.cleanupStaleCaches(now - 14 * 86_400_000);
    } catch { /* ignore cleanup error */ }
  }
  private secretsList(ownerId: string, input: Record<string, unknown>): RunnerResponse {
    const parsed = TOOL_SCHEMA_BY_NAME.secrets_list.parse(input);
    let environmentId = parsed.environmentId;
    if (parsed.workspaceId) {
      const ws = this.store.byOwnerAndId(ownerId, parsed.workspaceId);
      if (!ws) {
        throw new HarnessError('NOT_FOUND', 'workspace not found', 404, false);
      }
      if (!environmentId && ws.environmentId) environmentId = ws.environmentId;
    }
    if (!environmentId) {
      const activeWorkspaces = this.store.active().filter((w) => w.ownerId === ownerId && w.environmentId);
      const uniqueEnvs = Array.from(new Set(activeWorkspaces.map((w) => w.environmentId)));
      if (uniqueEnvs.length === 1) {
        environmentId = uniqueEnvs[0]!;
      } else if (uniqueEnvs.length > 1) {
        throw new HarnessError('CONFLICT', 'multiple active workspaces exist with different environments; specify an explicit environmentId or workspaceId', 409, false);
      }
    }

    const globalSecrets = (this.metadata?.listGlobalSecrets(ownerId) ?? []).map((s) => ({
      ...s,
      scope: 'global' as const
    }));
    const envSecrets = environmentId
      ? (this.metadata?.listSecretReferences(ownerId, environmentId) ?? []).map((s) => ({
          ...s,
          scope: 'environment' as const
        }))
      : [];

    const merged = new Map<string, (typeof globalSecrets)[0] | (typeof envSecrets)[0]>();
    for (const g of globalSecrets) merged.set(g.name, g);
    for (const e of envSecrets) merged.set(e.name, e);
    let filtered = Array.from(merged.values());

    if (parsed.query) {
      const q = parsed.query.toLowerCase();
      filtered = filtered.filter((s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q)));
    }
    const offset = parsed.cursor ? Number(parsed.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HarnessError('INVALID_INPUT', 'invalid secrets_list cursor', 400, false);
    }
    const limit = parsed.limit ?? 100;
    const page = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < filtered.length;
    const nextCursor = hasMore ? String(offset + limit) : undefined;
    const secrets = page.map((s) => ({
      name: s.name,
      description: s.description ?? null,
      scope: s.scope,
      environmentId: s.environmentId,
      version: s.version,
      updatedAt: s.updatedAt
    }));
    return {
      ok: true,
      message: `Listed ${secrets.length} secret reference(s)`,
      data: {
        secrets,
        ...(nextCursor ? { cursor: nextCursor } : {})
      },
      truncated: hasMore,
      cursor: nextCursor
    };
  }
  private async executeAgentProxy(request: Parameters<AgentManagerDependencies['toolExecutor']>[0]): Promise<RunnerResponse> {
    const operation = AgentProxyOperationSchema.parse(request.operation) as AgentProxyOperation;
    const validated = TOOL_SCHEMA_BY_NAME[operation].parse(request.toolInput) as Record<string, unknown>;
    const before = this.requireWorkspaceForAgent(request.ownerId, request.workspaceId);
    if (before.generation !== request.workspaceGeneration || before.networkProfile !== 'network-none') {
      throw new HarnessError('EXPIRED', 'agent tool execution lost its workspace fence', 410, false);
    }
    const result = await this.runWorker(before, operation, validated, request.signal);
    const after = this.requireWorkspaceForAgent(request.ownerId, request.workspaceId);
    if (after.generation !== request.workspaceGeneration || after.networkProfile !== 'network-none') {
      throw new HarnessError('EXPIRED', 'agent tool execution lost its workspace fence', 410, false);
    }
    const violation = await this.resourceViolation(after);
    if (violation) {
      void this.closeRecord(after, violation).catch(() => undefined);
      throw new HarnessError('LIMIT_EXCEEDED', `${violation}; workspace cleanup started`, 507, false);
    }
    return result;
  }

  private requireWorkspaceForAgent(ownerId: string, workspaceId: string): WorkspaceRecord {
    const record = this.store.byId(workspaceId);
    if (!record || record.ownerId !== ownerId) throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
    if (record.status !== 'ACTIVE' || record.expiresAt <= Date.now()) {
      throw new HarnessError('EXPIRED', 'workspace is not active', 410, false);
    }
    return record;
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
       'workspace_finalize', 'worktrees_create', 'worktrees_remove', 'memories_write', 'skills_run', 'hooks_run', 'deployments_run',
       'artifacts_snapshot', 'artifacts_restore'].includes(operation)) {
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
