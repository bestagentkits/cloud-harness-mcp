import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AGENT_PROXY_REPLAY_CLASS,
  AgentProxyOperationSchema,
  HarnessError,
  composeAgentBootstrapPrompt,
  resolveEffectivePricing,
  TOOL_SCHEMA_BY_NAME,
  type AgentBudget,
  type AgentModelProfile,
  type AgentModelProfileMetadata,
  type AgentProxyOperation,
  type AgentRuntimeKind,
  type AgentStatus,
  type GuidanceProfile,
  type RepositoryGuidanceSnapshot,
  type RunnerAgentsConfig,
  type RunnerOperation,
  type RunnerResponse
} from '@cloud-harness/contracts';
import {
  AGENT_TERMINAL_STATUSES,
  AgentStateRepository,
  type AgentEffectFence,
  type AgentEffectKey,
  type AgentEffectRecord,
  type AgentEffectState,
  type AgentRecord,
  type AgentTombstone
} from './agent-state-repository.js';
import {
  capturePatchImages,
  capturePreEntry,
  effectPayloadHash,
  danglingToolCalls,
  effectErrorText,
  reconcileEffect,
  reconciledResultText,
  writeImages,
  unknownEffectText,
  type DanglingToolCall,
  type EffectDispatchState,
  type EffectStateReader
} from './agent-effect-reconciler.js';
import type { ModelProfileStateRepository } from './model-profile-state-repository.js';
import {
  DockerAgentGatewayControl,
  isDefiniteIssueRefusal,
  type AgentGatewayControl,
  type AgentLeaseRevocation
} from './agent-gateway-control.js';
import {
  ModelSpendLedger,
  savedProfileSpendKey,
  staticProfileSpendKey,
  type ModelSpendThresholdCrossing
} from './model-spend-ledger.js';
import {
  AgentProtocolChannel,
  MAX_AGENT_TOOL_OUTCOME_ID_LENGTH,
  MAX_AGENT_TOOL_OUTCOME_TEXT_BYTES,
  MAX_AGENT_TOOL_OUTCOMES,
  MAX_PROTOCOL_RECORD_BYTES,
  MAX_TOOL_RESULT_RECORD_BYTES,
  MAX_TOOL_RESULT_TEXT_BYTES,
  type AgentInputRecord,
  type AgentOutputRecord,
  type AgentStartRecord,
  type AgentStorageRequestRecord,
  type AgentToolOutcome
} from './agent-protocol.js';
import { piCodingAdapter, piDurableAdapter, type AgentRuntimeAdapter, type AgentRuntimeSession } from './agent-runtime-adapter.js';
import { DurableSessionStore } from './durable-session-store.js';
import { DockerAgentLauncher, type AgentLaunchSpec, type AgentLauncher, type AgentRuntimeProcess } from './agent-launcher.js';
import type { StateStore, WorkspaceRecord } from './state-store.js';

/** A profile whose cache prices are resolved to the concrete prices the agent reports. */
type PricedAgentModelProfile = AgentModelProfile & {
  cacheReadMicrosPerMillionTokens: number;
  cacheWriteMicrosPerMillionTokens: number;
  /** The ledger key of the stable profile: a saved profile's id, or the static profile's id, namespaced. */
  spendProfileKey: string;
  revisionId: string | null;
};

/** How often, and after how long, open spend ledger rows are swept for settlement. */
const SPEND_SWEEP_INTERVAL_MS = 60_000;
const SPEND_SWEEP_MIN_AGE_MS = 60_000;

const AGENT_OPERATIONS: Readonly<Partial<Record<RunnerOperation, true>>> = {
  agent_spawn: true,
  agent_status: true,
  agent_logs: true,
  agent_message: true,
  agent_cancel: true,
  agent_list: true
};
const terminalStatuses = new Set<AgentStatus>(AGENT_TERMINAL_STATUSES);
/** Mutations whose target is read before dispatch so a continuation can settle a lost outcome. */
const OBSERVES_TARGET_BEFORE_DISPATCH: ReadonlySet<string> = new Set(['files_apply_patch', 'files_delete', 'files_mkdir', 'files_move']);
/** Mirrors the agent runtime's `start` record prompt bound (`apps/agent-runtime/src/protocol-schemas.ts`). */
const AGENT_START_PROMPT_MAX_BYTES = 256 * 1024;
/** Room kept in a start record for every field other than the prompt and the replayed session. */
const START_RECORD_FIXED_RESERVE_BYTES = 16 * 1024;

/**
 * Bytes left in a start record after the replayed session (each stored message's JSON plus its
 * array separator) and the JSON-encoded prompt. Negative means the record cannot be sent.
 */
function startRecordHeadroom(log: { bytes: number; messageCount: number }, prompt: string): number {
  return MAX_PROTOCOL_RECORD_BYTES - START_RECORD_FIXED_RESERVE_BYTES
    - log.bytes - log.messageCount - Buffer.byteLength(JSON.stringify(prompt), 'utf8');
}
type TerminalAgentStatus = 'CANCELLED' | 'TIMED_OUT' | 'LIMIT_EXCEEDED' | 'INTERRUPTED' | 'FAILED' | 'SUCCEEDED';

export type AgentToolExecutor = (input: {
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  agentId: string;
  agentGeneration: number;
  requestId: string;
  operation: AgentProxyOperation;
  toolInput: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<RunnerResponse>;
type RuntimeContext = {
  record: AgentRecord;
  process: AgentRuntimeProcess;
  channel: AgentProtocolChannel;
  /** The gateway lease handed to the runtime, held in memory only so receipts can redact it. */
  lease: string;
  /** The engine side of the run: start-record shaping and, for the durable engine, its session store claim. */
  session: AgentRuntimeSession;
  proxy: Map<string, { controller: AbortController; completion: Promise<void> }>;
  lastUsage: { input: number; output: number; costMicros: number; wallAt: number };
  terminalSeen: boolean;
  cleanup?: Promise<void>;
  cleanupTerminal?: TerminalAgentStatus;
  deadline?: NodeJS.Timeout;
  messageChain: Promise<void>;
  pendingMessages: number;
  pendingMessageBytes: number;
};

/** One proxied tool call, as the effect ledger and its reconciliation see it. */
type ProxyCall = {
  context: RuntimeContext;
  record: AgentRecord;
  output: Extract<AgentOutputRecord, { type: 'tool_request' }>;
  raw: Record<string, unknown>;
  fence: AgentEffectFence;
  key: AgentEffectKey;
  signal: AbortSignal;
};

/**
 * Resolves the workspace's repository-guidance snapshot for an agent's first message. It must
 * fail rather than return stale content when the workspace fence no longer holds.
 */
export type AgentRepositoryGuidance = (input: {
  ownerId: string;
  workspaceId: string;
  workspaceGeneration: number;
  signal?: AbortSignal;
}) => Promise<{ snapshot: RepositoryGuidanceSnapshot; reused: boolean }>;
export type AgentRepositoryContext = GuidanceProfile | 'none';

export type AgentManagerDependencies = {
  repository?: AgentStateRepository | undefined;
  gateway?: AgentGatewayControl | undefined;
  launcher?: AgentLauncher | undefined;
  toolExecutor: AgentToolExecutor;
  repositoryGuidance?: AgentRepositoryGuidance | undefined;
  modelProfiles?: ModelProfileStateRepository | undefined;
  spendLedger?: ModelSpendLedger | undefined;
  /** Runner-side session stores of durable-runtime agents; absent means no store, so durable runs cannot start. */
  durableSessions?: DurableSessionStore | undefined;
  now?: (() => number) | undefined;
};

export class AgentManager {
  private readonly repository: AgentStateRepository;
  private readonly gateway: AgentGatewayControl;
  private readonly launcher: AgentLauncher;
  private readonly modelProfiles?: ModelProfileStateRepository | undefined;
  private readonly spendLedger: ModelSpendLedger;
  private readonly durableSessions: DurableSessionStore;
  private readonly adapters: Readonly<Record<AgentRuntimeKind, AgentRuntimeAdapter>>;
  private lastSpendSweepAt = 0;
  private spendSweep?: Promise<void> | undefined;
  private readonly runtimes = new Map<string, RuntimeContext>();
  private readonly launches = new Map<string, Promise<void>>();
  private readonly cleanupTargets = new Map<string, TerminalAgentStatus>();
  private readonly now: () => number;
  private accepting = true;
  /** Set while stopping, so a reap already in flight cannot start a spend sweep after stop() returns. */
  private stopping = false;
  private epoch = 0;
  private reaper?: NodeJS.Timeout;
  constructor(
    private readonly config: RunnerAgentsConfig,
    private readonly store: StateStore,
    private readonly dependencies: AgentManagerDependencies
  ) {
    this.modelProfiles = dependencies.modelProfiles;
    this.repository = dependencies.repository ?? new AgentStateRepository(store.database, config.limits, store.instanceId());
    this.gateway = dependencies.gateway ?? new DockerAgentGatewayControl();
    this.launcher = dependencies.launcher ?? new DockerAgentLauncher(this.gateway, store.instanceId());
    this.now = dependencies.now ?? Date.now;
    // The ledger shares the state database so that admission commits atomically with the spawn.
    this.spendLedger = dependencies.spendLedger ?? new ModelSpendLedger(store.database);
    this.durableSessions = dependencies.durableSessions ?? new DurableSessionStore({ stateDir: undefined, enabled: false });
    this.adapters = { 'pi-coding': piCodingAdapter, 'pi-durable': piDurableAdapter(this.durableSessions) };
    // Durable lineage databases count toward the same aggregate session byte budgets as persisted logs.
    this.repository.countDurableStorage(this.durableSessions);
    this.epoch = this.repository.currentEpoch(store.instanceId());
    if (this.epoch === 0) {
      this.epoch = this.repository.bumpEpoch(store.instanceId(), this.now());
    }
  }


  async ensureGatewaySynced(): Promise<void> {
    const modelProfiles = this.modelProfiles;
    if (!modelProfiles || !this.hasSnapshotSync()) return;
    try {
      // Compare with the snapshot as it is now, built after any earlier push landed: it changes
      // without a push when an agent pinned to an older revision ends, and a restarted gateway
      // reports an empty digest.
      await this.gateway.syncSnapshot(() => modelProfiles.getExportSnapshot(), { onlyIfMismatch: true });
    } catch (err) {
      throw new HarnessError('UNAVAILABLE', `model gateway reconciliation failed: ${err instanceof Error ? err.message : 'unreachable'}`, 503, true);
    }
  }
  /** Lease-only gateway doubles built with a cast have no snapshot surface; there is nothing to reconcile. */
  private hasSnapshotSync(): boolean {
    return typeof (this.gateway as Partial<AgentGatewayControl>).syncSnapshot === 'function';
  }
  static isPublicOperation(operation: RunnerOperation): boolean {
    return AGENT_OPERATIONS[operation] === true;
  }
  fence(): void {
    this.accepting = false;
  }

  async start(): Promise<void> {
    this.accepting = false;
    this.stopping = false;
    this.epoch = this.repository.bumpEpoch(this.store.instanceId(), this.now());
    // Sized before any admission, so the session budgets count the durable stores already on disk.
    await this.durableSessions.measure();
    await this.launcher.reconcile?.();
    const modelProfiles = this.modelProfiles;
    if (modelProfiles && this.hasSnapshotSync()) {
      try {
        await this.gateway.syncSnapshot(() => modelProfiles.getExportSnapshot(), { onlyIfMismatch: false });
      } catch {
        // Gateway will be reconciled upon spawn or status check
      }
    }
    for (const workspace of this.store.active()) {
      if (workspace.status !== 'ACTIVE') continue;
      // Agent admission is defined only for network-disabled workspaces, matching the eligibility
      // guard in reserveSpawn and dispatch. An ACTIVE dependency-access workspace is a normal,
      // lease-bounded workspace that simply cannot host agents (its profile is fixed at creation,
      // and the workspace service has already reconciled its executor), so it is skipped rather
      // than closed. Admitting it would throw CONFLICT, abort runner startup, and take the whole
      // compose stack down.
      if (workspace.networkProfile !== 'network-none') continue;
      const records = this.repository.prepareWorkspaceStartupRepair(workspace.ownerId, workspace.id, workspace.generation, this.now());
      records.sort((left, right) => agentDepth(right, records) - agentDepth(left, records));
      for (const record of records) await this.reconcileInterrupted(record);
      this.repository.openWorkspaceAdmission(workspace.ownerId, workspace.id, workspace.generation, this.now());
    }
    this.repository.maintainClosedWorkspaces(this.now());
    this.accepting = true;
    // Every agent of the previous runner has been reconciled, so any row still open is an orphan.
    // The sweep may wait on the gateway for each row, so it runs in the background, never
    // delaying admission or failing startup.
    void this.sweepSpend(0);
    this.reaper = setInterval(() => { void this.reap().catch(() => undefined); }, 1_000);
    this.reaper.unref();
  }

  async stop(): Promise<void> {
    this.fence();
    this.stopping = true;
    clearInterval(this.reaper);
    // Promise.allSettled keeps teardown non-throwing: one workspace failing to stop must not abort
    // the rest. The callback returns the promise explicitly so that intent is unambiguous.
    await Promise.allSettled(this.store.active().map((workspace) => this.stopWorkspaceForShutdown(workspace)));
    // A sweep never rejects; waiting keeps it from touching the store after shutdown.
    await this.spendSweep;
    await this.durableSessions.close();
  }

  private async stopWorkspaceForShutdown(workspace: WorkspaceRecord): Promise<void> {
    this.repository.closeWorkspaceAdmission(workspace.ownerId, workspace.id, this.now());
    // A runner restart keeps the workspace, so its persisted sessions stay continuable.
    await this.cancelWorkspaceAgents(workspace.ownerId, workspace.id, 'runner stopping');
  }

  async dispatch(
    ownerId: string,
    workspace: WorkspaceRecord,
    operation: RunnerOperation,
    input: Record<string, unknown>
  ): Promise<RunnerResponse> {
    if (!AgentManager.isPublicOperation(operation)) {
      throw new HarnessError('INVALID_INPUT', 'operation is not an agent operation');
    }
    if (!this.accepting && (operation === 'agent_spawn' || operation === 'agent_message' || operation === 'agent_cancel')) {
      throw new HarnessError('UNAVAILABLE', 'agent mutation admission is closed', 503, true);
    }
    const validated = TOOL_SCHEMA_BY_NAME[operation].parse(input) as Record<string, unknown>;
    if (workspace.ownerId !== ownerId || workspace.id !== validated.workspaceId) {
      throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
    }
    switch (operation) {
      case 'agent_spawn': return await this.spawn(ownerId, workspace, validated);
      case 'agent_status': return this.status(ownerId, workspace.id, validated);
      case 'agent_logs': return this.logs(ownerId, workspace.id, validated);
      case 'agent_message': return await this.message(ownerId, workspace.id, validated);
      case 'agent_cancel': return await this.cancel(ownerId, workspace.id, validated.agentId as string, (validated.reason as string | undefined) ?? 'cancelled by owner');
      case 'agent_list': return this.list(ownerId, workspace.id, validated);
      default: throw new HarnessError('INVALID_INPUT', 'unsupported agent operation');
    }
  }

  /** Whether any agent of this workspace is still running, which keeps the reaper from auto-closing it. */
  hasActiveAgents(ownerId: string, workspaceId: string): boolean {
    // The agent reaper skips expired workspaces, so an agent past its TTL is never timed out there and
    // must not hold the close forever; closing the workspace stops it.
    const now = this.now();
    return this.repository.listActiveAgents(ownerId, workspaceId).some((agent) => agent.expiresAt > now);
  }

  /** Stops every agent of a closing or expiring workspace, then deletes its persisted sessions. */
  async stopWorkspace(ownerId: string, workspaceId: string, reason: string, generation?: number): Promise<void> {
    await this.cancelWorkspaceAgents(ownerId, workspaceId, reason, generation);
    // The session stores go first: the rows that name their lineages are deleted next, so a failed
    // file removal leaves them in place for the retried close.
    await this.durableSessions.deleteLineages(this.repository.durableLineageRoots(ownerId, workspaceId));
    this.repository.deleteWorkspaceSessions(ownerId, workspaceId);
  }

  private async cancelWorkspaceAgents(ownerId: string, workspaceId: string, reason: string, generation?: number): Promise<void> {
    this.repository.closeWorkspaceAdmission(ownerId, workspaceId, this.now(), generation);
    const active = this.repository.listActiveAgents(ownerId, workspaceId, generation);
    const seen = new Set<string>();
    const ordered: AgentRecord[] = [];
    for (const record of active) {
      for (const descendant of this.repository.descendants(ownerId, workspaceId, record.id)) {
        if (!terminalStatuses.has(descendant.status) && !seen.has(descendant.id)) {
          seen.add(descendant.id);
          ordered.push(descendant);
        }
      }
      if (!seen.has(record.id)) {
        seen.add(record.id);
        ordered.push(record);
      }
    }
    for (const record of ordered) await this.cancelOne(record, reason, 'CANCELLED', false);
  }

  private async spawn(ownerId: string, workspace: WorkspaceRecord, input: Record<string, unknown>): Promise<RunnerResponse> {
    if (!this.accepting || this.epoch !== this.repository.currentEpoch(this.store.instanceId())) {
      throw new HarnessError('UNAVAILABLE', 'agent mutation admission is closed', 503, true);
    }
    if (workspace.ownerId !== ownerId || workspace.status !== 'ACTIVE' || workspace.expiresAt <= this.now()) {
      throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
    }
    if (workspace.networkProfile !== 'network-none') {
      throw new HarnessError('CONFLICT', 'agents require a network-disabled workspace; open a separate workspace with networkProfile "network-none"', 409, false);
    }
    const continueFrom = input.continueFrom as string | undefined;
    if (continueFrom !== undefined && !this.config.sessionPersistenceEnabled && !this.config.durableRuntimeEnabled) {
      throw new HarnessError('NOT_SUPPORTED', 'continueFrom needs agent session persistence, which is off on this instance', 400, false);
    }
    const runtime = this.spawnRuntime(ownerId, workspace.id, continueFrom, input.runtime as AgentRuntimeKind | undefined);
    if (runtime === 'pi-durable' && !this.config.durableRuntimeEnabled) {
      throw new HarnessError('NOT_SUPPORTED', 'the pi-durable agent runtime is off on this instance', 400, false);
    }
    if (continueFrom !== undefined && runtime === 'pi-coding' && !this.config.sessionPersistenceEnabled) {
      throw new HarnessError('NOT_SUPPORTED', 'continueFrom needs agent session persistence, which is off on this instance', 400, false);
    }
    const profile = continueFrom === undefined
      ? this.profile(input.profileId as string, ownerId)
      : this.continuationProfile(ownerId, workspace.id, continueFrom, input.profileId as string | undefined);
    const dashboardManaged = this.modelProfiles !== undefined
      && (profile.id.startsWith('rev_') || this.config.profiles.every((p) => p.id !== profile.id));
    if (dashboardManaged) await this.ensureGatewaySynced();
    const tools = AgentProxyOperationSchema.array().parse(input.proxyOperations);
    if (tools.some((operation) => !profile.maxProxyOperations.includes(operation))) {
      throw new HarnessError('INVALID_INPUT', 'requested proxy operation exceeds the selected profile');
    }
    const budget: AgentBudget = {
      ttlSeconds: input.ttlSeconds as number,
      maxOutputBytes: input.maxOutputBytes as number,
      maxInputTokens: input.maxInputTokens as number,
      maxOutputTokens: input.maxOutputTokens as number,
      maxCostMicros: input.maxCostMicros as number
    };
    if (budget.maxInputTokens > profile.maxInputTokens
      || budget.maxOutputTokens > profile.maxOutputTokens
      || budget.maxCostMicros > profile.maxCostMicros) {
      throw new HarnessError('INVALID_INPUT', 'requested budget exceeds the selected profile');
    }
    const prompt = input.prompt as string;
    if (Buffer.byteLength(prompt, 'utf8') > this.config.limits.maxPromptBytes) {
      throw new HarnessError('LIMIT_EXCEEDED', 'agent prompt exceeds the configured byte limit', 413, false);
    }
    const now = this.now();
    const agentId = `agent_${randomBytes(24).toString('base64url')}`;
    const suffix = createHash('sha256').update(agentId).digest('hex').slice(0, 20);
    const payloadHash = digest({ ...input, workspaceId: workspace.id, proxyOperations: tools });
    const gatewayLeaseId = `lease_${randomBytes(24).toString('base64url')}`;
    let crossings: ModelSpendThresholdCrossing[] = [];
    const reservation = this.repository.reserveSpawn({
      id: agentId,
      ownerId,
      workspaceId: workspace.id,
      workspaceGeneration: workspace.generation,
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId as string } : {}),
      idempotencyKey: input.idempotencyKey as string,
      payloadHash,
      promptHash: digest(prompt),
      profileId: profile.id,
      proxyOperations: tools,
      budget,
      containerName: `ch-agent-${suffix}`,
      networkName: `ch-agent-net-${suffix}`,
      gatewayLeaseId,
      runtimeEpoch: this.epoch,
      runtime,
      now,
      expiresAt: Math.min(workspace.expiresAt, now + budget.ttlSeconds * 1_000),
      // A durable agent always records its lineage, which names its runner-side session store.
      ...(this.config.sessionPersistenceEnabled || runtime === 'pi-durable' ? {
        session: continueFrom === undefined ? {} : {
          continuedFrom: continueFrom,
          admitContinuation: (predecessor: AgentRecord, log: { bytes: number; messageCount: number }) => {
            try {
              this.profile(predecessor.profileId, ownerId);
            } catch {
              throw new HarnessError('CONFLICT', 'the model profile of the agent to continue is no longer enabled', 409, false);
            }
            // The replayed log and the prompt travel in one start record, so a continuation that
            // cannot fit is refused here instead of failing at launch.
            if (startRecordHeadroom(log, prompt) < 0) {
              throw new HarnessError(
                'LIMIT_EXCEEDED',
                'the continued session and prompt exceed the agent start record limit; shorten the prompt or start a fresh agent',
                413,
                false
              );
            }
          }
        }
      } : {}),
      // The run's whole cost cap is reserved against every applicable spend policy. The gateway
      // still enforces the cap itself; a policy only bounds how many caps may be outstanding.
      admit: () => {
        crossings = this.spendLedger.admit({
          leaseId: gatewayLeaseId,
          principalId: ownerId,
          profileKey: profile.spendProfileKey,
          revisionId: profile.revisionId,
          agentId,
          workspaceId: workspace.id,
          reservedMicros: budget.maxCostMicros,
          now
        });
      }
    });
    this.spendLedger.reportThresholds(crossings);
    if (reservation.replayed) {
      return success('Agent spawn replayed', spawnData(reservation.record, true));
    }
    const repositoryContext = (input.repositoryContext as AgentRepositoryContext | undefined) ?? 'codex';
    const launch = this.launch(reservation.record, prompt, profile, repositoryContext, dashboardManaged)
      .finally(() => this.launches.delete(reservation.record.id));
    this.launches.set(reservation.record.id, launch);
    void launch.catch(() => undefined);
    return success('Agent spawn accepted', spawnData(reservation.record, false));
  }

  /**
   * Places the workspace's applicable repository guidance before the caller's task. Guidance gets at
   * most a quarter of the agent's input-token budget (about four bytes per token), capped by the
   * composer's absolute bound. What was injected, skipped, or truncated is recorded as a bounded
   * `repository_context` log event that carries paths and digests but never document content.
   */
  private async bootstrapPrompt(
    record: AgentRecord,
    prompt: string,
    repositoryContext: AgentRepositoryContext,
    session?: { bytes: number; messages: unknown[] }
  ): Promise<string> {
    if (repositoryContext === 'none' || !this.dependencies.repositoryGuidance) return prompt;
    let resolved: Awaited<ReturnType<AgentRepositoryGuidance>>;
    try {
      resolved = await this.dependencies.repositoryGuidance({
        ownerId: record.ownerId,
        workspaceId: record.workspaceId,
        workspaceGeneration: record.workspaceGeneration
      });
    } catch (error) {
      const reason = error instanceof HarnessError ? error.message : 'repository guidance could not be scanned';
      throw new HarnessError('UNAVAILABLE', `agent bootstrap failed: ${reason}; retry, or spawn with repositoryContext "none"`, 503, true);
    }
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const composed = composeAgentBootstrapPrompt({
      snapshot: resolved.snapshot,
      profile: repositoryContext,
      prompt,
      // The gateway reserves one input token per request-body byte and every model turn re-sends the
      // first message, so guidance and task together take at most a quarter of the input budget,
      // and never pass the runtime's start-record prompt bound once the block framing is added.
      // A replayed session shares the start record, so guidance also gets only the room it leaves,
      // divided by the worst-case JSON escaping expansion.
      budgetBytes: Math.max(0, Math.min(
        Math.floor(record.budget.maxInputTokens / 4) - promptBytes,
        AGENT_START_PROMPT_MAX_BYTES - promptBytes - 1_024,
        session ? Math.floor(startRecordHeadroom({ bytes: session.bytes, messageCount: session.messages.length }, prompt) / 6) : Infinity
      ))
    });
    const event = { ...composed.report, snapshotReused: resolved.reused };
    // The report is charged to the caller's output bytes like any log event, so it is kept to a
    // quarter of that budget and is dropped rather than ending the agent when it cannot fit.
    const eventLimit = Math.min(this.config.limits.maxLogEventBytes, Math.floor(record.budget.maxOutputBytes / 4));
    let serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized, 'utf8') > eventLimit) {
      serialized = JSON.stringify({ ...event, injected: event.injected.length, skipped: event.skipped.length, listsOmitted: true });
    }
    if (Buffer.byteLength(serialized, 'utf8') <= eventLimit) {
      try {
        this.repository.appendLog(record.ownerId, record.workspaceId, record.id, record.generation, 'repository_context', serialized, this.now());
      } catch (error) {
        if (!(error instanceof HarnessError && error.code === 'LIMIT_EXCEEDED')) throw error;
      }
    }
    return composed.prompt;
  }

  private async launch(
    record: AgentRecord,
    prompt: string,
    profile: PricedAgentModelProfile,
    repositoryContext: AgentRepositoryContext,
    reconcileGateway: boolean
  ): Promise<void> {
    const spec = this.launchSpec(record);
    let leaseMayExist = false;
    let runSession: AgentRuntimeSession | undefined;
    try {
      if (this.epoch !== this.repository.currentEpoch(this.store.instanceId())) {
        throw new HarnessError('CONFLICT', 'agent launch lost its runtime epoch fence', 409, true);
      }
      if (reconcileGateway) {
        // The revision was resolved before the agent row existed, so a snapshot built in that gap
        // (a profile edit's push) may omit it, and the gateway replaces its set with each snapshot.
        // Every snapshot built from now on includes the revision; reconcile once before the lease.
        await this.ensureGatewaySynced();
      }
      // A cancel that landed while this launch waited owns the cleanup; it waits for this launch,
      // so stop before any lease or container exists.
      if (!this.stillSpawning(record)) return;
      // A persisting agent always receives its log, empty for a fresh one, and it is verified
      // before any lease exists so a corrupted log costs nothing.
      const sessionLog = record.runtime === 'pi-coding' && this.repository.findSession(record.id)
        ? this.repository.loadSessionLog(record.id, record.generation)
        : undefined;
      // Guidance is composed before any lease or container exists, so an agent never starts its
      // first turn without the repository's applicable guidance, and a failed scan costs nothing.
      const initialPrompt = await this.bootstrapPrompt(record, prompt, repositoryContext, sessionLog);
      if (!this.stillSpawning(record)) return;
      // The engine session is opened before any lease exists: for the durable engine this claims
      // the lineage's session store, so a run that cannot own it costs nothing.
      runSession = await this.adapters[record.runtime].open({
        agentId: record.id,
        lineageRootId: this.repository.lineageRoot(record.id),
        epoch: this.epoch,
        depth: this.repository.lineageDepth(record.id),
        resume: this.durableResume(record),
        sessionLog,
        sessionBudget: (addedBytes) => this.repository.exceededSessionBudget(record.ownerId, record.workspaceId, addedBytes)
      });
      const session = runSession;
      if (!this.stillSpawning(record)) {
        await session.seal();
        return;
      }
      // From here the lease may exist in the gateway, so an unsettled row is charged its whole cap.
      leaseMayExist = true;
      this.spendLedger.markIssuing(record.gatewayLeaseId);
      let grant: Awaited<ReturnType<AgentGatewayControl['issue']>>;
      try {
        grant = await this.gateway.issue({
          leaseId: record.gatewayLeaseId,
          agentId: record.id,
          profileId: record.profileId,
          ttlMs: Math.max(1_000, record.expiresAt - this.now()),
          maxInputTokens: record.budget.maxInputTokens,
          maxOutputTokens: record.budget.maxOutputTokens,
          maxCostMicros: record.budget.maxCostMicros
        });
      } catch (error) {
        // An explicit refusal means no lease exists; any other failure may have issued one.
        if (isDefiniteIssueRefusal(error)) this.spendLedger.releaseRefusedIssue(record.gatewayLeaseId, this.now());
        throw error;
      }
      if (grant.gatewayBootId !== undefined) this.spendLedger.recordGatewayBoot(record.gatewayLeaseId, grant.gatewayBootId);
      const runtime = await this.launcher.launch(spec);
      const lease = grant.lease;
      const contextRef: { current?: RuntimeContext } = {};
      const channel = new AgentProtocolChannel(
        runtime.process.stdin,
        runtime.process.stdout,
        runtime.process.stderr,
        async (output) => {
          if (!contextRef.current) throw new Error('agent runtime emitted output before initialization');
          await this.onRecord(contextRef.current, output);
        },
        async (content) => { this.appendLogOrLimit(record, 'stderr', content); },
        (error) => { void this.interrupt(record, error.message); },
        record.runtime === 'pi-durable'
          ? async (request) => {
            if (!contextRef.current) throw new Error('agent runtime emitted output before initialization');
            await this.onStorage(contextRef.current, request);
          }
          : undefined
      );
      const context: RuntimeContext = {
        record, process: runtime, channel, lease, session, proxy: new Map(),
        lastUsage: { input: 0, output: 0, costMicros: 0, wallAt: this.now() }, terminalSeen: false,
        messageChain: Promise.resolve(),
        pendingMessages: 0,
        pendingMessageBytes: 0
      };
      contextRef.current = context;
      this.runtimes.set(record.id, context);
      const running = this.repository.transitionStatus({
        ownerId: record.ownerId,
        workspaceId: record.workspaceId,
        agentId: record.id,
        generation: record.generation,
        runtimeEpoch: this.epoch,
        expectedStatuses: ['SPAWNING'],
        status: 'RUNNING',
        now: this.now()
      });
      if (!running) throw new HarnessError('CONFLICT', 'agent launch lost its lifecycle fence', 409, true);
      context.record = running;
      const deadlineMs = Math.max(1_000, running.expiresAt - this.now());
      context.deadline = setTimeout(() => { void this.cancelOne(running, 'agent TTL expired', 'TIMED_OUT'); }, deadlineMs);
      context.deadline.unref();
      // A coding continuation learns what became of the tool calls its predecessor left unanswered
      // before its first turn, so it never issues an applied mutation again under a new tool call
      // ID. The durable engine settles its own interrupted calls when it resumes, so it gets none.
      // A cancel that lands meanwhile closes the channel, so the send below fails into failLaunch,
      // which leaves the cancel's cleanup in charge.
      const toolOutcomes = sessionLog ? await this.danglingToolOutcomes(context, sessionLog.messages) : [];
      await channel.send(this.startRecord(running, initialPrompt, profile, lease, session, toolOutcomes));
      void runtime.exited.then(({ code }) => {
        if (!context.terminalSeen) void this.interrupt(running, `agent runtime exited before terminal record (${code ?? 'signal'})`);
      }).catch((error: unknown) => { void this.interrupt(running, error instanceof Error ? error.message : 'agent runtime failed'); });
    } catch (error) {
      if (!leaseMayExist) {
        // No lease can exist, so the reservation is released at zero now instead of waiting for a
        // cleanup that may need the same unreachable gateway. A failure here leaves the row open for
        // the cleanup retry or the spend sweep, and must not keep the agent from ending.
        try {
          this.spendLedger.settle(record.gatewayLeaseId, undefined, this.now());
        } catch {
          // The open row is settled later; ending the agent below matters more.
        }
      }
      // Without a runtime context no cleanup will release the engine session, so it is released here.
      if (runSession && !this.runtimes.has(record.id)) await runSession.seal().catch(() => undefined);
      await this.failLaunch(record, error instanceof Error ? error.message : 'agent launch failed');
    }
  }

  /**
   * The engine of a new agent. A continuation runs on its predecessor's engine: an omitted runtime
   * inherits it, and a different one is refused.
   */
  private spawnRuntime(ownerId: string, workspaceId: string, continueFrom: string | undefined, requested: AgentRuntimeKind | undefined): AgentRuntimeKind {
    if (continueFrom === undefined) return requested ?? 'pi-coding';
    const predecessor = this.repository.findAgent(ownerId, workspaceId, continueFrom);
    if (!predecessor) throw new HarnessError('NOT_FOUND', 'the agent to continue was not found in this workspace', 404, false);
    if (requested !== undefined && requested !== predecessor.runtime) {
      throw new HarnessError('INVALID_INPUT', 'a continuation runs on the agent engine of the agent it continues; omit runtime or pass that engine');
    }
    return predecessor.runtime;
  }

  /**
   * How a durable continuation treats its predecessor's unfinished work. A cancelled predecessor's
   * tasks are cancelled, never continued; only the new prompt runs.
   */
  private durableResume(record: AgentRecord): 'continue' | 'abort' | undefined {
    if (record.runtime !== 'pi-durable') return undefined;
    const predecessorId = this.repository.findSession(record.id)?.continuedFrom;
    if (!predecessorId) return undefined;
    return this.repository.findAgent(record.ownerId, record.workspaceId, predecessorId)?.status === 'CANCELLED' ? 'abort' : 'continue';
  }

  /**
   * Runs one durable-runtime storage request against the run's claim. A store over its size cap or
   * an aggregate session byte budget ends the run as LIMIT_EXCEEDED; the cancel is not awaited, because finishing the run may need
   * further storage requests on this same chain.
   */
  private async onStorage(context: RuntimeContext, request: AgentStorageRequestRecord): Promise<void> {
    const { response, limitExceeded } = await context.session.handleStorage(request);
    if (!context.channel.isClosed) await context.channel.send(response);
    if (limitExceeded) void this.cancelOne(context.record, 'durable agent session exceeded its size limit or a session byte budget', 'LIMIT_EXCEEDED').catch(() => undefined);
  }

  private stillSpawning(record: AgentRecord): boolean {
    return this.repository.findAgent(record.ownerId, record.workspaceId, record.id)?.status === 'SPAWNING';
  }

  /** Ends an agent whose launch failed: cancels its descendants, releases its lease, and records it FAILED. */
  private async failLaunch(record: AgentRecord, message: string): Promise<void> {
    const current = this.repository.findAgent(record.ownerId, record.workspaceId, record.id);
    if (!current || current.status === 'CANCELLING' || terminalStatuses.has(current.status)) return;
    const cancelling = this.repository.transitionStatus({
      ownerId: current.ownerId, workspaceId: current.workspaceId, agentId: current.id, generation: current.generation,
      runtimeEpoch: this.epoch,
      expectedStatuses: [current.status], status: 'CANCELLING', now: this.now(), cleanupReason: message.slice(0, 2_000)
    });
    if (!cancelling) return;
    await this.cancelDescendants(cancelling, message);
    const context = this.runtimes.get(record.id);
    const cleanup = this.cleanup(cancelling, context, message, 'FAILED');
    if (context) context.cleanup = cleanup;
    await cleanup;
  }
  private status(ownerId: string, workspaceId: string, input: Record<string, unknown>): RunnerResponse {
    const record = this.lookup(ownerId, workspaceId, input);
    return success('Agent status', 'profileId' in record ? this.publicStatus(record) : this.compactedStatus(record));
  }

  private logs(ownerId: string, workspaceId: string, input: Record<string, unknown>): RunnerResponse {
    const record = this.requireAgent(ownerId, workspaceId, input.agentId as string);
    const page = this.repository.readLogs(ownerId, workspaceId, record.id, record.generation, input.cursor as string, input.limitBytes as number);
    return success('Agent logs', {
      agentId: record.id,
      ...page,
      events: page.events.map((event) => ({ ...event, timestamp: new Date(event.timestamp).toISOString() }))
    }, page.truncated);
  }

  private async message(ownerId: string, workspaceId: string, input: Record<string, unknown>): Promise<RunnerResponse> {
    if (!this.accepting) throw new HarnessError('UNAVAILABLE', 'agent mutation admission is closed', 503, true);
    const record = this.requireAgent(ownerId, workspaceId, input.agentId as string);
    const text = input.message as string;
    if (Buffer.byteLength(text, 'utf8') > this.config.limits.maxMessageBytes) {
      throw new HarnessError('LIMIT_EXCEEDED', 'agent message exceeds the configured byte limit', 413, false);
    }
    if (this.epoch !== this.repository.currentEpoch(this.store.instanceId())) {
      throw new HarnessError('CONFLICT', 'agent message lost its runtime epoch fence', 409, true);
    }
    const reserved = this.repository.reserveMessage({
      ownerId, workspaceId, agentId: record.id, generation: record.generation,
      runtimeEpoch: this.epoch,
      idempotencyKey: input.idempotencyKey as string,
      payloadHash: digest({ mode: input.mode, message: text }),
      mode: input.mode as 'steer' | 'followUp', now: this.now()
    });
    if (reserved.replayed) return success('Agent message replayed', messageData(reserved.message, true));
    const runtime = this.runtimes.get(record.id);
    if (!runtime || runtime.record.generation !== record.generation) {
      const unknown = this.repository.transitionMessage({
        ownerId, workspaceId, agentId: record.id, generation: record.generation,
        idempotencyKey: input.idempotencyKey as string, expectedState: 'RESERVED', state: 'UNKNOWN',
        now: this.now(), error: 'agent runtime channel is unavailable'
      });
      return success('Agent message outcome unknown', messageData(unknown ?? reserved.message, false));
    }
    const messageBytes = Buffer.byteLength(text, 'utf8');
    if (runtime.pendingMessages >= 64 || runtime.pendingMessageBytes + messageBytes > 512 * 1_024) {
      const rejected = this.repository.transitionMessage({
        ownerId, workspaceId, agentId: record.id, generation: record.generation,
        idempotencyKey: input.idempotencyKey as string, expectedState: 'RESERVED', state: 'REJECTED',
        now: this.now(), error: 'agent message queue capacity is exhausted'
      });
      return success('Agent message rejected', messageData(rejected ?? reserved.message, false));
    }
    runtime.pendingMessages += 1;
    runtime.pendingMessageBytes += messageBytes;
    let delivered = reserved.message;
    runtime.messageChain = runtime.messageChain.then(async () => {
      await runtime.channel.send({
        type: 'message', requestId: randomUUID(), behavior: input.mode as 'steer' | 'followUp', text
      });
      delivered = this.repository.transitionMessage({
        ownerId, workspaceId, agentId: record.id, generation: record.generation,
        idempotencyKey: input.idempotencyKey as string, expectedState: 'RESERVED', state: 'SENT', now: this.now()
      }) ?? delivered;
    }).catch((error: unknown) => {
      delivered = this.repository.transitionMessage({
        ownerId, workspaceId, agentId: record.id, generation: record.generation,
        idempotencyKey: input.idempotencyKey as string, expectedState: 'RESERVED', state: 'UNKNOWN', now: this.now(),
        error: (error instanceof Error ? error.message : 'message delivery failed').slice(0, 2_000)
      }) ?? delivered;
    }).finally(() => {
      runtime.pendingMessages -= 1;
      runtime.pendingMessageBytes -= messageBytes;
    });
    await runtime.messageChain;
    return success('Agent message accepted', messageData(delivered, false));
  }

  private async cancel(ownerId: string, workspaceId: string, agentId: string, reason: string): Promise<RunnerResponse> {
    const root = this.requireAgent(ownerId, workspaceId, agentId);
    const descendants = this.repository.descendants(ownerId, workspaceId, agentId)
      .filter((record) => !terminalStatuses.has(record.status));
    const affected = [...descendants, root];
    await this.cancelOne(root, reason, 'CANCELLED');
    const current = this.requireAgent(ownerId, workspaceId, agentId);
    return success('Agent cancellation complete', {
      agentId: root.id,
      status: current.status,
      affectedAgentIds: affected.map((record) => record.id)
    });
  }

  private list(ownerId: string, workspaceId: string, input: Record<string, unknown>): RunnerResponse {
    const page = this.repository.listAgentPage(ownerId, workspaceId, {
      limit: input.limit as number,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
      ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId as string }),
      ...(input.status === undefined ? {} : { status: input.status as AgentStatus })
    });
    return success('Agents listed', {
      agents: page.records.map((record) => this.publicStatus(record)),
      nextCursor: page.nextCursor
    });
  }

  private async onRecord(context: RuntimeContext, output: AgentOutputRecord): Promise<void> {
    if (output.type === 'event') {
      this.appendLogOrLimit(context.record, 'event', JSON.stringify(output.event));
      return;
    }
    if (output.type === 'usage') {
      this.reconcileUsage(context, output.usage);
      return;
    }
    if (output.type === 'session_message') {
      this.persistSessionMessage(context, output.seq, output.message);
      return;
    }
    if (output.type === 'tool_cancel') {
      const pending = context.proxy.get(output.requestId);
      if (pending) {
        pending.controller.abort(output.reason);
        await pending.completion;
      }
      return;
    }
    if (output.type === 'tool_request') {
      await this.proxyTool(context, output);
      return;
    }
    context.terminalSeen = true;
    this.reconcileUsage(context, output.usage);
    await this.finishTerminal(context, output.state, output.error ?? null);
  }

  /**
   * Persisting a message never fails the run: a fenced writer is ignored, and a gap, an invalid
   * message, an exceeded bound, or a store failure only leaves the session not continuable.
   */
  private persistSessionMessage(context: RuntimeContext, seq: number, message: unknown): void {
    const record = context.record;
    try {
      this.repository.appendSessionMessage({
        ownerId: record.ownerId,
        workspaceId: record.workspaceId,
        agentId: record.id,
        generation: record.generation,
        runnerEpoch: this.epoch,
        seq,
        message,
        now: this.now()
      });
    } catch {
      try {
        this.repository.discontinueSession(record.id, this.now());
      } catch {
        // The session stays as it is; the run matters more than its persisted history.
      }
    }
  }

  private async proxyTool(context: RuntimeContext, output: Extract<AgentOutputRecord, { type: 'tool_request' }>): Promise<void> {
    const record = this.requireRunnable(context.record);
    if (!record.proxyOperations.includes(output.operation)) {
      await context.channel.send(toolError(output.requestId, 'proxy operation is not granted'));
      return;
    }
    if (context.proxy.has(output.requestId)) {
      await context.channel.send(toolError(output.requestId, 'duplicate proxy request ID'));
      return;
    }
    const startedAt = this.now();
    const controller = new AbortController();
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => { settle = resolve; });
    // Registered before any await, so a cancel or cleanup finds the request while it is in flight.
    context.proxy.set(output.requestId, { controller, completion });
    try {
      await this.runProxyTool(context, record, output, controller.signal);
    } finally {
      context.proxy.delete(output.requestId);
      settle();
      this.repository.addUsage(record.ownerId, record.workspaceId, record.id, record.generation, {
        toolTimeMs: Math.max(0, this.now() - startedAt)
      }, { runnerEpoch: this.epoch });
    }
  }

  /**
   * Runs one proxied tool call against the effect ledger. A request ID the lineage has already
   * completed returns the stored result, never a second execution; a mutation whose outcome was
   * lost is reconciled from workspace state rather than issued again. A first-time call is
   * recorded as dispatched before it reaches the executor and completed, with its receipt,
   * before the model sees the result.
   */
  private async runProxyTool(
    context: RuntimeContext,
    record: AgentRecord,
    output: Extract<AgentOutputRecord, { type: 'tool_request' }>,
    signal: AbortSignal
  ): Promise<void> {
    const raw = typeof output.input === 'object' && output.input !== null && !Array.isArray(output.input)
      ? output.input as Record<string, unknown>
      : {};
    const payloadHash = effectPayloadHash(output.operation, raw);
    const replayClass = AGENT_PROXY_REPLAY_CLASS[output.operation];
    const fence: AgentEffectFence = {
      ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id,
      agentGeneration: record.generation, runnerEpoch: this.epoch
    };
    let effect: AgentEffectRecord;
    try {
      effect = this.repository.reserveEffect({
        ownerId: record.ownerId,
        workspaceId: record.workspaceId,
        agentId: record.id,
        agentGeneration: record.generation,
        runnerEpoch: this.epoch,
        requestId: output.requestId,
        kind: output.operation,
        payloadHash,
        replayClass,
        fenced: true,
        now: this.now()
      }).effect;
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'CONFLICT') {
        await context.channel.send(toolError(output.requestId, error.message, 'CONFLICT'));
        return;
      }
      throw error;
    }
    const key: AgentEffectKey = { rootAgentId: effect.rootAgentId, requestId: output.requestId, kind: output.operation };
    const call: ProxyCall = { context, record, output, raw, fence, key, signal };
    if (effect.state === 'APPLIED' || effect.state === 'REJECTED') {
      if (effect.resultJson !== null) {
        await this.sendToolText(context, output.requestId, effect.resultJson, effect.state === 'REJECTED');
        return;
      }
      if (replayClass === 'read-safe') {
        await this.executeEffect(call, [effect.state], true);
        return;
      }
      const message = `${output.operation} with this request ID already completed, but its result is no longer retained; `
        + 'it was not issued again. Inspect the workspace to see its effect.';
      await this.sendToolText(context, output.requestId, effectErrorText('EFFECT_RECEIPT_UNAVAILABLE', message, false), true);
      return;
    }
    if (effect.state === 'INTENT' || replayClass === 'read-safe') {
      // An intent never reached the executor, and a read is safe to run again.
      await this.executeEffect(call, [effect.state], false);
      return;
    }
    await this.reconcileLostEffect(call, effect);
  }

  private async executeEffect(call: ProxyCall, expectedStates: AgentEffectState[], reExecuted: boolean): Promise<void> {
    const { context, record, output, fence, key } = call;
    let toolInput: Record<string, unknown>;
    try {
      toolInput = this.parseToolInput(call);
    } catch (error) {
      const text = toolErrorText(error instanceof Error ? error.message : 'invalid tool input');
      this.repository.completeEffect({
        ...key, fence, expectedStates, state: 'REJECTED', receipt: { text: redactLease(text, context.lease) }, now: this.now()
      });
      await this.sendToolText(context, output.requestId, text, true);
      return;
    }
    let images: EffectDispatchState = { preImageSha256: null, intendedSha256: null };
    const reader = this.stateReader(record, output.requestId, call.signal);
    if (output.operation === 'files_write') images = writeImages(toolInput);
    // The target's state before a patch, delete, mkdir, or move only settles a lost outcome, which
    // only a continuation reconciles, so an agent that records no session skips that executor read.
    if (OBSERVES_TARGET_BEFORE_DISPATCH.has(output.operation) && this.repository.recordsSession(record.id)) {
      if (output.operation === 'files_apply_patch') images = await capturePatchImages(reader, toolInput);
      else images = { ...images, preEntry: await capturePreEntry(reader, output.operation, toolInput) };
    }
    if (!this.repository.dispatchEffect({ ...key, fence, expectedStates, ...images, now: this.now() })) {
      await this.sendFenceLost(context, output.requestId);
      return;
    }
    let result: RunnerResponse;
    try {
      result = await this.dependencies.toolExecutor({
        ownerId: record.ownerId, workspaceId: record.workspaceId, workspaceGeneration: record.workspaceGeneration,
        agentId: record.id, agentGeneration: record.generation, requestId: output.requestId,
        operation: output.operation, toolInput, signal: call.signal
      });
    } catch (error) {
      // The executor may have applied the effect before failing, so its outcome is unknown.
      this.repository.completeEffect({ ...key, fence, expectedStates: ['DISPATCHED'], state: 'UNKNOWN', now: this.now() });
      if (!context.channel.isClosed) {
        await context.channel.send(toolError(output.requestId, error instanceof Error ? error.message : 'proxy tool execution failed'));
      }
      return;
    }
    const serialized = JSON.stringify(reExecuted ? { ...result, replayed: 're-executed' } : result);
    const text = Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_RESULT_TEXT_BYTES ? serialized : JSON.stringify({
      ok: false, message: 'tool result exceeded the agent protocol bound',
      error: { code: 'LIMIT_EXCEEDED', message: 'tool result exceeded the agent protocol bound', retryable: false }, truncated: true
    });
    // The receipt is durable before the model sees the result, so a crash in between replays it.
    this.repository.completeEffect({
      ...key, fence, expectedStates: ['DISPATCHED'], state: result.ok ? 'APPLIED' : 'REJECTED',
      receipt: { text: redactLease(text, context.lease) }, now: this.now()
    });
    if (!this.stillRunnable(record)) {
      await this.sendFenceLost(context, output.requestId);
      return;
    }
    await this.sendToolText(context, output.requestId, text, !result.ok);
  }

  /**
   * Settles a mutation whose dispatch was recorded but whose outcome was lost. It is never issued
   * again: workspace state decides whether it applied, and an undecidable outcome stays unknown.
   */
  private async reconcileLostEffect(call: ProxyCall, effect: AgentEffectRecord): Promise<void> {
    const { context, output } = call;
    let toolInput: Record<string, unknown>;
    try {
      toolInput = this.parseToolInput(call);
    } catch {
      toolInput = {};
    }
    const settled = await this.settleLostEffect(call.record, call.key, call.fence, toolInput, effect, call.signal);
    if (!settled) {
      await this.sendFenceLost(context, output.requestId);
      return;
    }
    await this.sendToolText(context, output.requestId, settled.text, settled.isError);
  }

  /**
   * Decides a lost mutation's outcome from workspace state and records it: an applied effect gets a
   * reconciled receipt, an effect that never landed is rejected with a retryable error, and an
   * undecidable one stays unknown. Returns the result text the model receives for it, or undefined
   * when the agent lost its fence while the workspace was observed.
   */
  private async settleLostEffect(
    record: AgentRecord,
    key: AgentEffectKey,
    fence: AgentEffectFence,
    toolInput: Record<string, unknown>,
    effect: AgentEffectRecord,
    signal: AbortSignal
  ): Promise<{ outcome: 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN'; text: string; isError: boolean } | undefined> {
    const operation = key.kind as AgentProxyOperation;
    const reconciliation = await reconcileEffect(this.stateReader(record, key.requestId, signal), operation, toolInput, {
      preImageSha256: effect.preImageSha256, intendedSha256: effect.intendedSha256, preEntry: effect.preEntry
    });
    if (!this.stillRunnable(record)) return undefined;
    const expectedStates = [effect.state];
    if (reconciliation.outcome === 'APPLIED') {
      const text = reconciledResultText(operation, reconciliation.observed);
      this.repository.completeEffect({ ...key, fence, expectedStates, state: 'APPLIED', receipt: { text, reconciled: true }, now: this.now() });
      return { outcome: 'APPLIED', text, isError: false };
    }
    if (reconciliation.outcome === 'NOT_APPLIED') {
      const text = effectErrorText('EFFECT_NOT_APPLIED',
        `${operation} was interrupted and did not take effect: ${reconciliation.reason}. Issue it again as a new tool call if it is still needed.`, true);
      this.repository.completeEffect({ ...key, fence, expectedStates, state: 'REJECTED', receipt: { text }, now: this.now() });
      return { outcome: 'NOT_APPLIED', text, isError: true };
    }
    this.repository.completeEffect({ ...key, fence, expectedStates, state: 'UNKNOWN', now: this.now() });
    return { outcome: 'UNKNOWN', text: unknownEffectText(operation, reconciliation.reason), isError: true };
  }

  /**
   * The outcomes of the tool calls a continued transcript left unanswered, which the runtime uses
   * to close those calls instead of a generic interruption. Each call is found in the lineage's
   * effect ledger by the request ID the runtime proxied it under; a mutation whose outcome was lost
   * is reconciled from workspace state first, so the model learns that an applied write landed and
   * does not issue it again under a new tool call ID. A call that never reached the executor, or a
   * read that is safe to repeat, gets no entry and keeps the generic interruption.
   */
  private async danglingToolOutcomes(context: RuntimeContext, messages: readonly unknown[]): Promise<AgentToolOutcome[]> {
    const record = context.record;
    const calls = danglingToolCalls(messages);
    if (calls.length === 0) return [];
    const rootAgentId = this.repository.lineageRoot(record.id);
    const fence: AgentEffectFence = {
      ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id,
      agentGeneration: record.generation, runnerEpoch: this.epoch
    };
    const controller = new AbortController();
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => { settle = resolve; });
    // Registered like a proxied call, so a cancel during reconciliation aborts its reads.
    const registration = `reconcile:${randomUUID()}`;
    context.proxy.set(registration, { controller, completion });
    const outcomes: AgentToolOutcome[] = [];
    // The runtime matches outcomes by tool call ID, so an ID left unanswered more than once cannot
    // name one call's outcome; those calls keep the generic interruption.
    const unanswered = new Map<string, number>();
    for (const call of calls) unanswered.set(call.toolCallId, (unanswered.get(call.toolCallId) ?? 0) + 1);
    try {
      for (const call of calls) {
        if (outcomes.length >= MAX_AGENT_TOOL_OUTCOMES || controller.signal.aborted) break;
        // A cancel that waits for this launch must not wait for further workspace reads.
        if (this.repository.findAgent(record.ownerId, record.workspaceId, record.id)?.status !== 'RUNNING') break;
        if (call.toolCallId.length > MAX_AGENT_TOOL_OUTCOME_ID_LENGTH || unanswered.get(call.toolCallId) !== 1) continue;
        const parsed = AgentProxyOperationSchema.safeParse(call.name);
        if (!parsed.success) continue;
        const operation = parsed.data;
        const key: AgentEffectKey = { rootAgentId, requestId: call.requestId, kind: operation };
        const effect = this.repository.findEffect(key);
        if (!effect || effect.ownerId !== record.ownerId || effect.workspaceId !== record.workspaceId) continue;
        const outcome = await this.danglingOutcome(record, key, fence, call, effect, controller.signal);
        if (outcome) outcomes.push({ toolCallId: call.toolCallId, ...outcome, text: redactLease(outcome.text, context.lease) });
      }
    } finally {
      context.proxy.delete(registration);
      settle();
    }
    return outcomes;
  }

  private async danglingOutcome(
    record: AgentRecord,
    key: AgentEffectKey,
    fence: AgentEffectFence,
    call: DanglingToolCall,
    effect: AgentEffectRecord,
    signal: AbortSignal
  ): Promise<Omit<AgentToolOutcome, 'toolCallId'> | undefined> {
    const operation = key.kind as AgentProxyOperation;
    const readSafe = AGENT_PROXY_REPLAY_CLASS[operation] === 'read-safe';
    const raw = typeof call.arguments === 'object' && call.arguments !== null && !Array.isArray(call.arguments)
      ? call.arguments as Record<string, unknown>
      : {};
    // A recorded payload that differs from this call's arguments may belong to another call (a
    // provider reused the tool call ID) or to this call after a coercion the digest does not model,
    // so nothing recorded is returned for it, in any state, and it is never reported as not run:
    // an intent never reached the executor and a read is safe to repeat, so both keep the generic
    // interruption, and any other outcome is unknown.
    if (effectPayloadHash(operation, raw) !== effect.payloadHash) {
      if (effect.state === 'INTENT' || readSafe) return undefined;
      return { outcome: 'UNKNOWN', isError: true, text: unknownEffectText(operation, 'the recorded arguments do not match the dispatched request') };
    }
    if (effect.state === 'APPLIED' || effect.state === 'REJECTED') {
      if (effect.resultJson !== null) {
        return { outcome: effect.state, isError: effect.state === 'REJECTED', text: boundedOutcomeText(operation, effect.state, effect.resultJson) };
      }
      if (readSafe) return undefined;
      return {
        outcome: effect.state, isError: true,
        text: effectErrorText('EFFECT_RECEIPT_UNAVAILABLE', `${operation} completed before the previous run ended, but its result is no longer `
          + 'retained. It may have taken effect: inspect the target with a read before any retry.', false)
      };
    }
    // An intent never reached the executor, and a read is safe to issue again.
    if (effect.state === 'INTENT' || readSafe) return undefined;
    const toolInput = observableToolInput(operation, raw, record.workspaceId);
    // Arguments the executor would not accept cannot be used to observe the dispatched target.
    if (!toolInput) {
      return { outcome: 'UNKNOWN', isError: true, text: unknownEffectText(operation, 'the recorded arguments cannot be used to observe its target') };
    }
    try {
      return await this.settleLostEffect(record, key, fence, toolInput, effect, signal);
    } catch {
      return { outcome: 'UNKNOWN', isError: true, text: unknownEffectText(operation, 'the workspace could not be observed') };
    }
  }

  private parseToolInput(call: ProxyCall): Record<string, unknown> {
    return TOOL_SCHEMA_BY_NAME[call.output.operation].parse({ ...call.raw, workspaceId: call.record.workspaceId }) as Record<string, unknown>;
  }

  /** Reads workspace state for reconciliation through the same fenced executor path as the agent's own reads. */
  private stateReader(record: AgentRecord, requestId: string, signal: AbortSignal): EffectStateReader {
    return async (operation, input) => await this.dependencies.toolExecutor({
      ownerId: record.ownerId, workspaceId: record.workspaceId, workspaceGeneration: record.workspaceGeneration,
      agentId: record.id, agentGeneration: record.generation, requestId,
      operation, toolInput: TOOL_SCHEMA_BY_NAME[operation].parse({ ...input, workspaceId: record.workspaceId }) as Record<string, unknown>,
      signal
    });
  }

  private stillRunnable(record: AgentRecord): boolean {
    try {
      this.requireRunnable(record);
      return true;
    } catch {
      return false;
    }
  }

  private async sendFenceLost(context: RuntimeContext, requestId: string): Promise<void> {
    if (!context.channel.isClosed) await context.channel.send(toolError(requestId, 'agent tool execution lost its lifecycle fence'));
  }

  private async sendToolText(context: RuntimeContext, requestId: string, text: string, isError: boolean): Promise<void> {
    await context.channel.send({ type: 'tool_result', requestId, final: true, isError, content: [{ type: 'text', text }] });
  }

  private async cancelOne(
    record: AgentRecord,
    reason: string,
    terminal: 'CANCELLED' | 'TIMED_OUT' | 'LIMIT_EXCEEDED' | 'FAILED',
    cascade = true
  ): Promise<void> {
    const current = this.repository.findAgent(record.ownerId, record.workspaceId, record.id);
    if (!current || terminalStatuses.has(current.status)) return;
    const cancelling = current.status === 'CANCELLING' ? current : this.repository.transitionStatus({
      ownerId: current.ownerId, workspaceId: current.workspaceId, agentId: current.id, generation: current.generation,
      expectedStatuses: current.status === 'SPAWNING' ? ['SPAWNING'] : ['RUNNING'], status: 'CANCELLING',
      now: this.now(), cleanupReason: reason.slice(0, 2_000)
    });
    if (!cancelling) return;
    await this.launches.get(current.id);
    if (cascade) await this.cancelDescendants(cancelling, reason);
    const runtime = this.runtimes.get(current.id);
    if (runtime?.cleanup) return await runtime.cleanup;
    const cleanup = this.cleanup(cancelling, runtime, reason, terminal);
    if (runtime) runtime.cleanup = cleanup;
    await cleanup;
  }
  private async cancelDescendants(record: AgentRecord, reason: string): Promise<void> {
    const descendants = this.repository.descendants(record.ownerId, record.workspaceId, record.id)
      .filter((candidate) => !terminalStatuses.has(candidate.status));
    for (const descendant of descendants) await this.cancelOne(descendant, reason, 'CANCELLED', false);
  }

  private async cleanup(
    record: AgentRecord,
    runtime: RuntimeContext | undefined,
    reason: string,
    terminal: TerminalAgentStatus
  ): Promise<void> {
    clearTimeout(runtime?.deadline);
    if (runtime) runtime.cleanupTerminal = terminal;
    this.cleanupTargets.set(record.id, terminal);
    try {
      const drainErrors: unknown[] = [];
      try {
        const revocation = revocationOf(await this.gateway.revokeAndDrain(record.gatewayLeaseId));
        this.spendLedger.settle(record.gatewayLeaseId, revocation, this.now());
      } catch (error) {
        // The ledger row stays open, so the cleanup retry or the spend sweep settles it later.
        drainErrors.push(error);
      }
      if (runtime) {
        for (const pending of runtime.proxy.values()) pending.controller.abort(reason);
        await Promise.allSettled([...runtime.proxy.values()].map((pending) => pending.completion));
        if (!runtime.terminalSeen) {
          await runtime.channel.send({
            type: 'cancel', requestId: randomUUID(), reason: reason.slice(0, 1_024)
          }).catch(() => undefined);
        }
        await runtime.messageChain;
      }
      try {
        await this.launcher.cleanup(this.launchSpec(record), this.config.limits.cancellationGraceMs);
      } catch (error) {
        drainErrors.push(error);
      }
      try {
        runtime?.channel.closeInput();
        await runtime?.channel.drainWrites();
      } catch (error) {
        drainErrors.push(error);
      }
      if (drainErrors.length !== 0) {
        throw new Error(drainErrors.map((error) => safeError(error)).join('; '));
      }
      // The engine session ends only once the runtime is gone, so nothing writes to it afterwards.
      const runResumable = await this.sealRun(record, runtime, terminal);
      this.runtimes.delete(record.id);
      this.repository.clearCleanupRetry(record.ownerId, record.workspaceId, record.id, record.generation);
      const transitioned = this.repository.transitionStatus({
        ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id, generation: record.generation,
        expectedStatuses: record.status === 'CANCELLING' ? ['CANCELLING'] : [record.status],
        status: terminal, now: this.now(), terminalReason: reason.slice(0, 2_000),
        ...(terminal === 'INTERRUPTED' ? { outcomeUnknown: true } : {}),
        ...(runResumable ? { runResumable } : {})
      });
      if (!transitioned && !terminalStatuses.has(this.requireAgent(record.ownerId, record.workspaceId, record.id).status)) {
        throw new HarnessError('CONFLICT', 'agent terminal transition lost its lifecycle fence', 409, true);
      }
      this.cleanupTargets.delete(record.id);
    } catch (error) {
      const existing = this.repository.cleanupRetry(record.ownerId, record.workspaceId, record.id, record.generation);
      const attempts = (existing?.attempts ?? 0) + 1;
      const delay = Math.min(this.config.limits.cleanupRetryMaxDelayMs, 1_000 * (2 ** Math.min(attempts - 1, 20)));
      this.repository.scheduleCleanupRetry({
        ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id, agentGeneration: record.generation,
        attempts, nextAttemptAt: this.now() + delay,
        lastError: safeError(error).slice(0, 2_000), updatedAt: this.now()
      });
      throw error;
    }
  }

  /**
   * Releases a durable run's session store and reports whether it still holds unfinished work. A
   * cancelled run is never resumable: a continuation cancels its leftover tasks instead. A failure
   * to read the store only reports nothing to resume; it never keeps the agent from ending.
   */
  private async sealRun(record: AgentRecord, runtime: RuntimeContext | undefined, terminal: TerminalAgentStatus): Promise<boolean> {
    if (record.runtime !== 'pi-durable') return false;
    try {
      const sealed = runtime
        ? await runtime.session.seal()
        : await this.adapters[record.runtime].inspect(this.repository.lineageRoot(record.id));
      return sealed.resumable && terminal !== 'CANCELLED';
    } catch {
      return false;
    }
  }

  private async finishTerminal(context: RuntimeContext, state: AgentStatus, reason: string | null): Promise<void> {
    if (context.cleanup) return await context.cleanup;
    const current = this.repository.findAgent(context.record.ownerId, context.record.workspaceId, context.record.id);
    if (!current || terminalStatuses.has(current.status)) return;
    if (current.status !== 'CANCELLING') {
      const cancelling = this.repository.transitionStatus({
        ownerId: current.ownerId, workspaceId: current.workspaceId, agentId: current.id, generation: current.generation,
        expectedStatuses: [current.status], status: 'CANCELLING', now: this.now(), cleanupReason: reason ?? 'agent settled'
      });
      if (!cancelling) return;
      context.record = cancelling;
    } else context.record = current;
    await this.cancelDescendants(context.record, reason ?? `parent agent ${state.toLowerCase()}`);
    const terminal = state === 'SPAWNING' || state === 'RUNNING' || state === 'CANCELLING' ? 'FAILED' : state;
    context.cleanup = this.cleanup(context.record, context, reason ?? `agent ${terminal.toLowerCase()}`, terminal);
    await context.cleanup;
  }

  private async interrupt(record: AgentRecord, reason: string): Promise<void> {
    const current = this.repository.findAgent(record.ownerId, record.workspaceId, record.id);
    if (!current || terminalStatuses.has(current.status)) return;
    if (current.status !== 'CANCELLING') {
      const cancelling = this.repository.transitionStatus({
        ownerId: current.ownerId, workspaceId: current.workspaceId, agentId: current.id, generation: current.generation,
        expectedStatuses: [current.status], status: 'CANCELLING', now: this.now(), cleanupReason: reason.slice(0, 2_000)
      });
      if (!cancelling) return;
      await this.cancelDescendants(cancelling, reason);
      const runtime = this.runtimes.get(record.id);
      const cleanup = this.cleanup(cancelling, runtime, reason, 'INTERRUPTED');
      if (runtime) runtime.cleanup = cleanup;
      await cleanup.catch(() => undefined);
    }
  }

  private async reconcileInterrupted(record: AgentRecord): Promise<void> {
    const current = record.status === 'CANCELLING' ? record : this.repository.transitionStatus({
      ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id, generation: record.generation,
      expectedStatuses: [record.status], status: 'CANCELLING', now: this.now(), cleanupReason: 'runner restart reconciliation'
    });
    if (!current) return;
    await this.cleanup(current, undefined, 'runner restart interrupted agent execution', 'INTERRUPTED');
  }

  private async reap(): Promise<void> {
    const now = this.now();
    for (const workspace of this.store.active()) {
      const generation = workspace.status === 'REAPING'
        ? Math.max(1, workspace.generation - 1)
        : workspace.generation;
      const records = this.repository.listActiveAgents(workspace.ownerId, workspace.id, generation);
      for (const record of records) {
        if (record.status !== 'CANCELLING' && record.expiresAt <= now) {
          await this.cancelOne(record, 'agent TTL expired', 'TIMED_OUT').catch(() => undefined);
        }
      }
      for (const retry of this.repository.listCleanupRetries(workspace.ownerId, workspace.id, now, 100)) {
        const record = this.repository.findAgent(retry.ownerId, retry.workspaceId, retry.agentId);
        if (record?.status !== 'CANCELLING') continue;
        const runtime = this.runtimes.get(record.id);
        const cleanup = this.cleanup(
          record,
          runtime,
          record.cleanupReason ?? 'cleanup retry',
          runtime?.cleanupTerminal ?? this.cleanupTargets.get(record.id) ?? 'INTERRUPTED'
        );
        if (runtime) runtime.cleanup = cleanup;
        await cleanup.catch(() => undefined);
      }
    }
    this.repository.maintainClosedWorkspaces(now);
    const purgedLineages: string[] = [];
    try {
      this.repository.purgeExpiredSessions(now, 100, purgedLineages);
      this.repository.purgeExpiredReceipts(now);
    } catch {
      // A busy store only delays retention to the next tick; it must not skip the spend sweep.
    }
    try {
      // A store whose removal failed on an earlier tick, or before a restart, is still on disk and is
      // retried here, since its sessions are no longer selected for purging.
      purgedLineages.push(...this.repository.purgedDurableLineages(this.durableSessions.lineages()));
    } catch {
      // A busy store only delays the retry to the next tick.
    }
    if (purgedLineages.length > 0) await this.durableSessions.deleteLineages(purgedLineages).catch(() => undefined);
    if (now - this.lastSpendSweepAt >= SPEND_SWEEP_INTERVAL_MS) void this.sweepSpend(SPEND_SWEEP_MIN_AGE_MS);
  }

  /**
   * Settles spend ledger rows whose agent is terminal or gone but whose lease was never
   * settled, for example after a crash between issue and revoke. Revoke is idempotent and
   * the gateway keeps settlements for a day, so retrying it either finds the settlement or
   * closes the row by the conservative rules in ModelSpendLedger.settle. A revoke that fails
   * leaves the row open, still committed at its cap, for the next sweep.
   */
  private async sweepSpend(minAgeMs: number): Promise<void> {
    if (this.stopping) return;
    this.spendSweep ??= this.runSpendSweep(minAgeMs).finally(() => { this.spendSweep = undefined; });
    await this.spendSweep;
  }

  /** Never rejects: a row that cannot be read, revoked, or settled simply stays open, committed at its cap. */
  private async runSpendSweep(minAgeMs: number): Promise<void> {
    const now = this.now();
    this.lastSpendSweepAt = now;
    let open: ReturnType<ModelSpendLedger['listOpen']>;
    try {
      open = this.spendLedger.listOpen(now - minAgeMs, this.config.limits.globalActive + 100);
    } catch (error) {
      reportSpendSweepFailure('list', error);
      return;
    }
    for (const entry of open) {
      try {
        const agent = this.repository.findAgent(entry.principalId, entry.workspaceId, entry.agentId);
        if (agent && !terminalStatuses.has(agent.status)) continue;
        let revocation: AgentLeaseRevocation | undefined;
        try {
          revocation = revocationOf(await this.gateway.revokeAndDrain(entry.leaseId));
        } catch {
          // The gateway is unreachable; the next sweep retries.
          continue;
        }
        this.spendLedger.settle(entry.leaseId, revocation, this.now());
      } catch (error) {
        reportSpendSweepFailure('settle', error);
      }
    }
    try {
      this.spendLedger.prune(now);
    } catch (error) {
      reportSpendSweepFailure('prune', error);
    }
  }

  private reconcileUsage(context: RuntimeContext, usage: { input: number; output: number; cost: number }): void {
    const current = {
      input: usage.input,
      output: usage.output,
      costMicros: Math.max(0, Math.floor(usage.cost * 1_000_000))
    };
    this.repository.addUsage(context.record.ownerId, context.record.workspaceId, context.record.id, context.record.generation, {
      inputTokens: Math.max(0, current.input - context.lastUsage.input),
      outputTokens: Math.max(0, current.output - context.lastUsage.output),
      costMicros: Math.max(0, current.costMicros - context.lastUsage.costMicros),
      wallTimeMs: Math.max(0, this.now() - context.lastUsage.wallAt)
    }, { runnerEpoch: this.epoch });
    context.lastUsage = { ...current, wallAt: this.now() };
  }

  private appendLogOrLimit(record: AgentRecord, type: string, content: string): void {
    try {
      this.repository.appendLog(record.ownerId, record.workspaceId, record.id, record.generation, type, content.slice(0, 65_536), this.now());
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'LIMIT_EXCEEDED') {
        void this.cancelOne(record, error.message, 'LIMIT_EXCEEDED');
        return;
      }
      throw error;
    }
  }

  private requireRunnable(expected: AgentRecord): AgentRecord {
    const workspace = this.store.byId(expected.workspaceId);
    const record = this.repository.findAgent(expected.ownerId, expected.workspaceId, expected.id);
    const now = this.now();
    if (!workspace || workspace.ownerId !== expected.ownerId || workspace.generation !== expected.workspaceGeneration
      || workspace.status !== 'ACTIVE' || workspace.networkProfile !== 'network-none' || workspace.expiresAt <= now
      || !record || record.generation !== expected.generation || record.runtimeEpoch !== this.epoch
      || record.status !== 'RUNNING' || record.expiresAt <= now) {
      throw new HarnessError('EXPIRED', 'agent tool execution lost its lifecycle fence', 410, false);
    }
    return record;
  }

  private lookup(ownerId: string, workspaceId: string, input: Record<string, unknown>): AgentRecord | AgentTombstone {
    const record = input.agentId
      ? this.repository.findAgent(ownerId, workspaceId, input.agentId as string)
      : this.repository.findByIdempotency(ownerId, workspaceId, input.idempotencyKey as string);
    if (record) return record;
    const tombstone = input.agentId
      ? this.repository.findTombstone(ownerId, workspaceId, input.agentId as string, this.now())
      : this.repository.findTombstoneByIdempotency(ownerId, workspaceId, input.idempotencyKey as string, this.now());
    if (!tombstone) throw new HarnessError('NOT_FOUND', 'agent was not found in this workspace', 404, false);
    return tombstone;
  }
  private requireAgent(ownerId: string, workspaceId: string, agentId: string): AgentRecord {
    const record = this.repository.findAgent(ownerId, workspaceId, agentId);
    if (!record) throw new HarnessError('NOT_FOUND', 'agent was not found in this workspace', 404, false);
    return record;
  }

  // Cache prices resolve through the same defaults the gateway snapshot uses, so the
  // agent's self-reported cost never treats cached usage as free. The agent reports
  // base-tier prices only; the gateway charges long-prompt tiers.
  /**
   * A continuation runs on its predecessor's profile: the replayed transcript was produced by that
   * model, and replaying it into another provider or model is not supported. An omitted profileId
   * inherits it; a profileId that resolves to anything else is refused.
   */
  private continuationProfile(ownerId: string, workspaceId: string, continueFrom: string, requested: string | undefined): PricedAgentModelProfile {
    const predecessor = this.repository.findAgent(ownerId, workspaceId, continueFrom);
    if (!predecessor) throw new HarnessError('NOT_FOUND', 'the agent to continue was not found in this workspace', 404, false);
    let inherited: PricedAgentModelProfile;
    try {
      inherited = this.profile(predecessor.profileId, ownerId);
    } catch {
      throw new HarnessError('CONFLICT', 'the model profile of the agent to continue is no longer enabled', 409, false);
    }
    if (requested !== undefined && this.profile(requested, ownerId).id !== inherited.id) {
      throw new HarnessError('INVALID_INPUT', 'a continuation runs on the model profile of the agent it continues; omit profileId or pass that profile');
    }
    return inherited;
  }

  private profile(id: string, ownerId?: string): PricedAgentModelProfile {
    if (ownerId && this.modelProfiles) {
      const activeProfiles = this.modelProfiles.listProfiles(ownerId);
      const matched = activeProfiles.find((p: AgentModelProfileMetadata) => (p.id === id || p.activeRevisionId === id) && p.status === 'ACTIVE');
      if (matched && matched.activeRevision) {
        const rev = matched.activeRevision;
        // A missing credential resolves as `custom`, the most conservative defaults.
        const provider = this.modelProfiles.getCredentialProvider(ownerId, rev.credentialId) ?? 'custom';
        const pricing = resolveEffectivePricing(rev.pricing, provider);
        return {
          id: rev.id,
          spendProfileKey: savedProfileSpendKey(matched.id),
          revisionId: rev.id,
          displayName: matched.displayName,
          provider: rev.model,
          model: rev.model,
          apiMode: rev.apiMode,
          inputMicrosPerMillionTokens: pricing.inputMicrosPerMillionTokens,
          outputMicrosPerMillionTokens: pricing.outputMicrosPerMillionTokens,
          cacheReadMicrosPerMillionTokens: pricing.cacheReadMicrosPerMillionTokens,
          cacheWriteMicrosPerMillionTokens: pricing.cacheWriteMicrosPerMillionTokens,
          maxInputTokens: rev.limits.maxInputTokens,
          maxOutputTokens: rev.limits.maxOutputTokens,
          maxCostMicros: rev.limits.maxCostMicros,
          maxProxyOperations: rev.maxProxyOperations
        };
      }
    }
    const staticProfile = this.config.profiles.find((candidate) => candidate.id === id);
    if (!staticProfile) throw new HarnessError('INVALID_INPUT', 'unknown agent model profile');
    // The gateway charges a static profile's unknown cache prices at its input
    // price, whatever the provider, so the agent reports the same prices.
    const pricing = resolveEffectivePricing(staticProfile, { billsCacheWrites: false });
    return {
      ...staticProfile,
      cacheReadMicrosPerMillionTokens: pricing.cacheReadMicrosPerMillionTokens,
      cacheWriteMicrosPerMillionTokens: pricing.cacheWriteMicrosPerMillionTokens,
      spendProfileKey: staticProfileSpendKey(staticProfile.id),
      revisionId: null
    };
  }

  private publicStatus(record: AgentRecord) {
    return {
      agentId: record.id,
      workspaceId: record.workspaceId,
      parentAgentId: record.parentAgentId,
      profileId: record.profileId,
      proxyOperations: record.proxyOperations,
      status: record.status,
      generation: record.generation,
      createdAt: new Date(record.createdAt).toISOString(),
      startedAt: record.startedAt === null ? null : new Date(record.startedAt).toISOString(),
      terminalAt: record.terminalAt === null ? null : new Date(record.terminalAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      budget: record.budget,
      usage: this.repository.usage(record.ownerId, record.workspaceId, record.id, record.generation),
      terminalReason: record.terminalReason,
      outcomeUnknown: record.outcomeUnknown,
      ...this.sessionStatus(record),
      // Only a non-default engine is named, so the status of a coding-runtime agent is unchanged.
      ...(record.runtime === 'pi-coding' ? {} : { runtime: record.runtime })
    };
  }

  /** Session fields appear only for an agent spawned with session persistence. */
  private sessionStatus(record: AgentRecord) {
    const session = this.repository.findSession(record.id);
    if (!session) return {};
    return {
      session: {
        persisted: session.state !== 'PURGED',
        continuable: session.state === 'SEALED' && session.continuable,
        messages: session.messageCount,
        bytes: session.bytes
      },
      // A run is never resumed in place; a sealed session is continued by a new agent. Only a
      // durable agent can leave unfinished work that the continuation resumes.
      run: { resumable: record.runtime === 'pi-durable' && session.runResumable },
      continuedFrom: session.continuedFrom
    };
  }


  private compactedStatus(record: AgentTombstone) {
    return {
      agentId: record.agentId,
      workspaceId: record.workspaceId,
      status: record.status,
      generation: record.generation,
      compactedAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      compacted: true as const
    };
  }
  private launchSpec(record: AgentRecord): AgentLaunchSpec {
    return {
      ownerId: record.ownerId, workspaceId: record.workspaceId, workspaceGeneration: record.workspaceGeneration,
      agentId: record.id, agentGeneration: record.generation, containerName: record.containerName,
      networkName: record.networkName, image: this.config.image, gatewayUrl: this.config.gatewayUrl
    };
  }

  private startRecord(
    record: AgentRecord,
    prompt: string,
    profile: PricedAgentModelProfile,
    lease: string,
    session: AgentRuntimeSession,
    toolOutcomes: readonly AgentToolOutcome[]
  ): AgentStartRecord {
    const contextWindow = Math.min(2_000_000, profile.maxInputTokens + profile.maxOutputTokens);
    const base: AgentStartRecord = {
      type: 'start', requestId: randomUUID(), agentId: record.id, prompt, tools: record.proxyOperations,
      gateway: { profile: profile.id, lease },
      model: {
        id: profile.model, name: profile.displayName, api: profile.apiMode === 'responses' ? 'openai-responses' : 'openai-completions', reasoning: false,
        contextWindow, maxTokens: Math.min(record.budget.maxOutputTokens, profile.maxOutputTokens, contextWindow),
        cost: {
          input: profile.inputMicrosPerMillionTokens / 1_000_000,
          output: profile.outputMicrosPerMillionTokens / 1_000_000,
          cacheRead: profile.cacheReadMicrosPerMillionTokens / 1_000_000,
          cacheWrite: profile.cacheWriteMicrosPerMillionTokens / 1_000_000
        }
      },
      limits: {
        deadlineMs: Math.max(1_000, record.expiresAt - this.now()),
        maxEvents: this.config.limits.maxLogEventsPerAgent,
        maxOutputBytes: record.budget.maxOutputBytes,
        maxEventBytes: this.config.limits.maxLogEventBytes,
        maxToolResultBytes: MAX_TOOL_RESULT_RECORD_BYTES
      }
    };
    const start = session.startRecord(base);
    if (toolOutcomes.length === 0 || !start.session) return start;
    // Outcomes are added only while the record stays within the protocol bound; one that does not
    // fit is left out, and the runtime closes that call with the generic interruption.
    let remaining = MAX_PROTOCOL_RECORD_BYTES - Buffer.byteLength(JSON.stringify(start), 'utf8') - 1_024;
    const fitting: AgentToolOutcome[] = [];
    for (const outcome of toolOutcomes) {
      const bytes = Buffer.byteLength(JSON.stringify(outcome), 'utf8') + 1;
      if (bytes > remaining) continue;
      remaining -= bytes;
      fitting.push(outcome);
    }
    if (fitting.length > 0) start.session = { ...start.session, toolOutcomes: fitting };
    return start;
  }
}

function success(message: string, data: unknown, truncated = false): RunnerResponse {
  return { ok: true, message, data, truncated };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function spawnData(record: AgentRecord, replayed: boolean) {
  return { agentId: record.id, status: record.status, generation: record.generation, replayed };
}

function messageData(message: { agentId: string; idempotencyKey: string; state: string }, replayed: boolean) {
  return { agentId: message.agentId, idempotencyKey: message.idempotencyKey, state: message.state, replayed };
}

/**
 * A transcript call's raw arguments as the executor input the runtime dispatched for it. The
 * runtime drops optional nulls and coerces a string the schema types as a boolean or number; the
 * caller has already matched the recorded payload digest, so redoing those steps recovers the
 * dispatched input. Arguments still not accepted give undefined.
 */
function observableToolInput(operation: AgentProxyOperation, raw: Record<string, unknown>, workspaceId: string): Record<string, unknown> | undefined {
  const schema = TOOL_SCHEMA_BY_NAME[operation];
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
  const first = schema.safeParse({ ...input, workspaceId });
  if (first.success) return first.data as Record<string, unknown>;
  for (const issue of first.error.issues) {
    const key = issue.path[0];
    const value = typeof key === 'string' && issue.path.length === 1 && issue.code === 'invalid_type' ? input[key] : undefined;
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const expected = (issue as { expected?: unknown }).expected;
    if (expected === 'boolean' && (value === 'true' || value === 'false')) input[key] = value === 'true';
    else if ((expected === 'number' || expected === 'int' || expected === 'integer') && value.trim() !== '' && Number.isFinite(Number(value))) {
      input[key] = Number(value);
    }
  }
  const second = schema.safeParse({ ...input, workspaceId });
  return second.success ? second.data as Record<string, unknown> : undefined;
}

function toolErrorText(message: string, code = 'TOOL_ERROR'): string {
  return JSON.stringify({ ok: false, message, error: { code, message, retryable: false }, truncated: false });
}

function toolError(requestId: string, message: string, code?: string): AgentInputRecord {
  return { type: 'tool_result', requestId, final: true, isError: true, content: [{ type: 'text', text: toolErrorText(message, code) }] };
}

/** Receipts outlive the run, so the run's gateway lease never reaches them even if a result echoed it. */
/**
 * A stored result to close an unanswered call with, kept within the outcome bound. A result too
 * large to repeat is summarized rather than cut, since a cut JSON result would not parse.
 */
function boundedOutcomeText(operation: AgentProxyOperation, state: 'APPLIED' | 'REJECTED', text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_AGENT_TOOL_OUTCOME_TEXT_BYTES) return text;
  const message = state === 'APPLIED'
    ? `${operation} completed before the previous run ended; its result is too large to repeat here. Inspect the target with a read instead of issuing it again.`
    : `${operation} failed before the previous run ended; its error is too large to repeat here.`;
  return JSON.stringify({ ok: state === 'APPLIED', message, truncated: true });
}

function redactLease(text: string, lease: string): string {
  return lease.length >= 16 && text.includes(lease) ? text.split(lease).join('[REDACTED]') : text;
}

function reportSpendSweepFailure(stage: 'list' | 'settle' | 'prune', error: unknown): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', time: Date.now(), msg: 'model spend sweep failed', stage, error: safeError(error).slice(0, 500) })}\n`);
}

/** An older gateway, or a test double, returns nothing from a revoke. */
function revocationOf(value: AgentLeaseRevocation | void): AgentLeaseRevocation | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function safeError(error: unknown): string {
  if (error instanceof HarnessError) return error.message;
  return error instanceof Error ? error.message : 'agent operation failed';
}


function agentDepth(record: AgentRecord, records: AgentRecord[]): number {
  const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
  let depth = 0;
  let parentId = record.parentAgentId;
  while (parentId) {
    depth += 1;
    parentId = byId.get(parentId)?.parentAgentId ?? null;
  }
  return depth;
}