import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AgentProxyOperationSchema,
  BROKERED_ONLY_PROXY_OPERATIONS,
  HarnessError,
  composeAgentBootstrapPrompt,
  resolveEffectivePricing,
  TOOL_SCHEMA_BY_NAME,
  type AgentBudget,
  type AgentModelProfile,
  type AgentModelProfileMetadata,
  type AgentProxyOperation,
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
  type AgentRecord,
  type AgentTombstone
} from './agent-state-repository.js';
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
  MAX_TOOL_RESULT_RECORD_BYTES,
  MAX_TOOL_RESULT_TEXT_BYTES,
  type AgentInputRecord,
  type AgentOutputRecord
} from './agent-protocol.js';
import { DockerAgentLauncher, type AgentLaunchSpec, type AgentLauncher, type AgentRuntimeProcess } from './agent-launcher.js';
import type { StateStore, WorkspaceRecord } from './state-store.js';
import type { AgentTraceHooks } from './agent-trace-recorder.js';

/** A profile whose cache prices are resolved to the concrete prices the agent reports. */
type PricedAgentModelProfile = AgentModelProfile & {
  cacheReadMicrosPerMillionTokens: number;
  cacheWriteMicrosPerMillionTokens: number;
  /** The ledger key of the stable profile: a saved profile's id, or the static profile's id, namespaced. */
  spendProfileKey: string;
  revisionId: string | null;
};

const BROKERED_ONLY: ReadonlySet<AgentProxyOperation> = new Set(BROKERED_ONLY_PROXY_OPERATIONS);

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
/** Mirrors the agent runtime's `start` record prompt bound (`apps/agent-runtime/src/protocol-schemas.ts`). */
const AGENT_START_PROMPT_MAX_BYTES = 256 * 1024;
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
  /** The run's ledger usage when the request arrived, for budget re-checks at execution. */
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  signal: AbortSignal;
}) => Promise<RunnerResponse>;
type RuntimeContext = {
  record: AgentRecord;
  process: AgentRuntimeProcess;
  channel: AgentProtocolChannel;
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
  now?: (() => number) | undefined;
  /** Durable trace recording; absent when agent traces are disabled. Its failures never fail an agent. */
  traceRecorder?: AgentTraceHooks | undefined;
  /** Resolves the automation workflow that owns a workspace, so its runs' traces carry the workflow id. */
  workflowFor?: ((ownerId: string, workspaceId: string) => string | null) | undefined;
  /**
   * Whether this workspace's agents may be granted the brokered-only proxy operations (commands and Git
   * reads). Absent means never: only a coding workflow's broker can execute them.
   */
  permitsBrokeredOperations?: ((ownerId: string, workspaceId: string) => boolean) | undefined;
};

export class AgentManager {
  private readonly repository: AgentStateRepository;
  private readonly gateway: AgentGatewayControl;
  private readonly launcher: AgentLauncher;
  private readonly modelProfiles?: ModelProfileStateRepository | undefined;
  private readonly spendLedger: ModelSpendLedger;
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
  }

  private async stopWorkspaceForShutdown(workspace: WorkspaceRecord): Promise<void> {
    this.repository.closeWorkspaceAdmission(workspace.ownerId, workspace.id, this.now());
    await this.stopWorkspace(workspace.ownerId, workspace.id, 'runner stopping');
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

  async stopWorkspace(ownerId: string, workspaceId: string, reason: string, generation?: number): Promise<void> {
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
    const profile = this.profile(input.profileId as string, ownerId);
    const dashboardManaged = this.modelProfiles !== undefined
      && (profile.id.startsWith('rev_') || this.config.profiles.every((p) => p.id !== profile.id));
    if (dashboardManaged) await this.ensureGatewaySynced();
    const tools = AgentProxyOperationSchema.array().parse(input.proxyOperations);
    if (tools.some((operation) => !profile.maxProxyOperations.includes(operation))) {
      throw new HarnessError('INVALID_INPUT', 'requested proxy operation exceeds the selected profile');
    }
    if (tools.some((operation) => BROKERED_ONLY.has(operation)) && this.dependencies.permitsBrokeredOperations?.(ownerId, workspace.id) !== true) {
      throw new HarnessError('FORBIDDEN', 'exec_run, git_status and git_diff are available only to a coding workflow agent', 403, false);
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
      now,
      expiresAt: Math.min(workspace.expiresAt, now + budget.ttlSeconds * 1_000),
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
    const parentAgentId = reservation.record.parentAgentId;
    this.traced(reservation.record, (traces) => traces.begin({
      agentId: reservation.record.id,
      generation: reservation.record.generation,
      principalId: ownerId,
      workspaceId: workspace.id,
      parent: parentAgentId
        ? { agentId: parentAgentId, generation: this.repository.findAgent(ownerId, workspace.id, parentAgentId)?.generation ?? 1 }
        : null,
      profileId: profile.spendProfileKey.replace(/^(?:profile|static):/u, ''),
      profileRevisionId: profile.revisionId,
      workflowId: this.dependencies.workflowFor?.(ownerId, workspace.id) ?? null,
      at: now
    }));
    this.traced(reservation.record, (traces) => traces.budget(traceKey(reservation.record), {
      phase: 'reserve', reservedCostMicros: budget.maxCostMicros, at: now
    }));
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
  private async bootstrapPrompt(record: AgentRecord, prompt: string, repositoryContext: AgentRepositoryContext): Promise<string> {
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
      budgetBytes: Math.max(0, Math.min(
        Math.floor(record.budget.maxInputTokens / 4) - promptBytes,
        AGENT_START_PROMPT_MAX_BYTES - promptBytes - 1_024
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
      // Guidance is composed before any lease or container exists, so an agent never starts its
      // first turn without the repository's applicable guidance, and a failed scan costs nothing.
      const initialPrompt = await this.bootstrapPrompt(record, prompt, repositoryContext);
      if (!this.stillSpawning(record)) return;
      // From here the lease may exist in the gateway, so an unsettled row is charged its whole cap.
      leaseMayExist = true;
      this.spendLedger.markIssuing(record.gatewayLeaseId);
      let grant: Awaited<ReturnType<AgentGatewayControl['issue']>>;
      const issueStartedAt = this.now();
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
        const refused = isDefiniteIssueRefusal(error);
        this.traced(record, (traces) => traces.budget(traceKey(record), {
          phase: 'lease_issue', outcome: refused ? 'refused' : 'unknown', startedAt: issueStartedAt, endedAt: this.now()
        }));
        if (refused) this.spendLedger.releaseRefusedIssue(record.gatewayLeaseId, this.now());
        throw error;
      }
      this.traced(record, (traces) => traces.budget(traceKey(record), {
        phase: 'lease_issue', outcome: 'issued', startedAt: issueStartedAt, endedAt: this.now()
      }));
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
        (error) => { void this.interrupt(record, error.message); }
      );
      const context: RuntimeContext = {
        record, process: runtime, channel, proxy: new Map(),
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
      await channel.send(this.startRecord(running, initialPrompt, profile, lease));
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
      await this.failLaunch(record, error instanceof Error ? error.message : 'agent launch failed');
    }
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
      this.traced(context.record, (traces) => traces.observeEvent(traceKey(context.record), output.event, this.now()));
      return;
    }
    if (output.type === 'usage') {
      this.reconcileUsage(context, output.usage);
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
    const raw = typeof output.input === 'object' && output.input !== null && !Array.isArray(output.input)
      ? output.input as Record<string, unknown>
      : {};
    const payloadHash = createHash('sha256').update(JSON.stringify({ operation: output.operation, input: raw })).digest('hex');
    const effectReservation = this.repository.reserveEffect({
      ownerId: record.ownerId,
      workspaceId: record.workspaceId,
      agentId: record.id,
      agentGeneration: record.generation,
      runnerEpoch: this.epoch,
      requestId: output.requestId,
      kind: output.operation,
      payloadHash,
      now: startedAt
    });
    if (effectReservation.replayed && effectReservation.effect.state !== 'INTENT') {
      await context.channel.send({
        type: 'tool_result', requestId: output.requestId, final: true, isError: effectReservation.effect.state === 'REJECTED',
        content: [{ type: 'text', text: JSON.stringify({ ok: effectReservation.effect.state === 'APPLIED', message: 'replayed effect' }) }]
      });
      return;
    }
    this.repository.transitionEffect({
      agentId: record.id,
      agentGeneration: record.generation,
      requestId: output.requestId,
      kind: output.operation,
      expectedState: 'INTENT',
      state: 'DISPATCHED',
      runnerEpoch: this.epoch,
      now: startedAt
    });
    this.traced(record, (traces) => traces.toolRequested(traceKey(record), {
      requestId: output.requestId, toolCallId: output.toolCallId, operation: output.operation, input: raw
    }, startedAt));
    const controller = new AbortController();
    const completion = (async () => {
      let isOk = false;
      try {
        const toolInput = TOOL_SCHEMA_BY_NAME[output.operation].parse({ ...raw, workspaceId: record.workspaceId }) as Record<string, unknown>;
        const usage = this.repository.usage(record.ownerId, record.workspaceId, record.id, record.generation);
        const result = await this.dependencies.toolExecutor({
          ownerId: record.ownerId, workspaceId: record.workspaceId, workspaceGeneration: record.workspaceGeneration,
          agentId: record.id, agentGeneration: record.generation, requestId: output.requestId,
          operation: output.operation, toolInput,
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros },
          signal: controller.signal
        });
        this.requireRunnable(record);
        isOk = result.ok;
        const serialized = JSON.stringify(result);
        const text = Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_RESULT_TEXT_BYTES ? serialized : JSON.stringify({
          ok: false, message: 'tool result exceeded the agent protocol bound',
          error: { code: 'LIMIT_EXCEEDED', message: 'tool result exceeded the agent protocol bound', retryable: false }, truncated: true
        });
        await context.channel.send({
          type: 'tool_result', requestId: output.requestId, final: true, isError: !result.ok,
          content: [{ type: 'text', text }]
        });
      } catch (error) {
        if (!context.channel.isClosed) {
          const message = error instanceof Error ? error.message : 'proxy tool execution failed';
          await context.channel.send(toolError(output.requestId, message));
        }
      } finally {
        context.proxy.delete(output.requestId);
        this.repository.transitionEffect({
          agentId: record.id,
          agentGeneration: record.generation,
          requestId: output.requestId,
          kind: output.operation,
          expectedState: 'DISPATCHED',
          state: isOk ? 'APPLIED' : 'REJECTED',
          runnerEpoch: this.epoch,
          now: this.now()
        });
        this.repository.addUsage(record.ownerId, record.workspaceId, record.id, record.generation, {
          toolTimeMs: Math.max(0, this.now() - startedAt)
        });
        this.traced(record, (traces) => traces.toolCompleted(traceKey(record), output.requestId, { ok: isOk }, this.now()));
      }
    })();
    context.proxy.set(output.requestId, { controller, completion });
    await completion;
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
        this.traced(record, (traces) => traces.settled(traceKey(record), revocation?.settlement, this.now()));
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
      this.runtimes.delete(record.id);
      this.repository.clearCleanupRetry(record.ownerId, record.workspaceId, record.id, record.generation);
      const transitioned = this.repository.transitionStatus({
        ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id, generation: record.generation,
        expectedStatuses: record.status === 'CANCELLING' ? ['CANCELLING'] : [record.status],
        status: terminal, now: this.now(), terminalReason: reason.slice(0, 2_000),
        ...(terminal === 'INTERRUPTED' ? { outcomeUnknown: true } : {})
      });
      if (!transitioned && !terminalStatuses.has(this.requireAgent(record.ownerId, record.workspaceId, record.id).status)) {
        throw new HarnessError('CONFLICT', 'agent terminal transition lost its lifecycle fence', 409, true);
      }
      if (transitioned) {
        this.traced(record, (traces) => traces.finish(traceKey(record), {
          terminal, reason, ledger: this.ledgerTotals(record), at: this.now()
        }));
      }
      this.cleanupTargets.delete(record.id);
    } catch (error) {
      const existing = this.repository.cleanupRetry(record.ownerId, record.workspaceId, record.id, record.generation);
      const { cleanupRetryLimit, cleanupRetryMaxDelayMs } = this.config.limits;
      // Past the limit the backoff stops growing, not the retries: the container may still exist.
      const exhausted = (existing?.attempts ?? 0) >= cleanupRetryLimit;
      const attempts = Math.min((existing?.attempts ?? 0) + 1, cleanupRetryLimit);
      const delay = exhausted
        ? cleanupRetryMaxDelayMs
        : Math.min(cleanupRetryMaxDelayMs, 1_000 * (2 ** Math.min(attempts - 1, 20)));
      this.repository.scheduleCleanupRetry({
        ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id, agentGeneration: record.generation,
        attempts, nextAttemptAt: this.now() + delay,
        lastError: safeError(error).slice(0, 2_000), updatedAt: this.now()
      });
      throw error;
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
    this.traced(current, (traces) => traces.markIncomplete(traceKey(current), 'runner_restart', this.now()));
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

  private reconcileUsage(
    context: RuntimeContext,
    usage: { input: number; output: number; cost: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }
  ): void {
    const current = {
      input: usage.input,
      output: usage.output,
      costMicros: Math.max(0, Math.floor(usage.cost * 1_000_000))
    };
    const delta = {
      inputTokens: Math.max(0, current.input - context.lastUsage.input),
      outputTokens: Math.max(0, current.output - context.lastUsage.output),
      costMicros: Math.max(0, current.costMicros - context.lastUsage.costMicros)
    };
    this.repository.addUsage(context.record.ownerId, context.record.workspaceId, context.record.id, context.record.generation, {
      ...delta,
      wallTimeMs: Math.max(0, this.now() - context.lastUsage.wallAt)
    });
    context.lastUsage = { ...current, wallAt: this.now() };
    // The trace receives exactly the deltas charged to the usage ledger, so the two reconcile.
    this.traced(context.record, (traces) => traces.observeUsage(traceKey(context.record), {
      ...delta, cacheReadTotal: usage.cacheRead, cacheWriteTotal: usage.cacheWrite
    }, this.now()));
  }

  /**
   * Runs one trace hook. A trace failure is contained here: it downgrades the trace to partial
   * coverage and is never allowed to change the agent's lifecycle.
   */
  private traced(record: { id: string; generation: number }, hook: (traces: AgentTraceHooks) => void): void {
    const traces = this.dependencies.traceRecorder;
    if (!traces) return;
    try {
      hook(traces);
    } catch (error) {
      try {
        traces.degrade(traceKey(record), error);
      } catch {
        // The recorder itself is unavailable; the agent continues untraced.
      }
    }
  }

  private ledgerTotals(record: AgentRecord): { inputTokens: number; outputTokens: number; costMicros: number } | null {
    try {
      const usage = this.repository.usage(record.ownerId, record.workspaceId, record.id, record.generation);
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: usage.costMicros };
    } catch {
      return null;
    }
  }

  private appendLogOrLimit(record: AgentRecord, type: string, content: string): void {
    try {
      this.repository.appendLog(record.ownerId, record.workspaceId, record.id, record.generation, type, content.slice(0, 65_536), this.now());
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'LIMIT_EXCEEDED') {
        this.traced(record, (traces) => traces.budget(traceKey(record), { phase: 'limit', limit: 'output_bytes', at: this.now() }));
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
      outcomeUnknown: record.outcomeUnknown
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

  private startRecord(record: AgentRecord, prompt: string, profile: PricedAgentModelProfile, lease: string): AgentInputRecord {
    const contextWindow = Math.min(2_000_000, profile.maxInputTokens + profile.maxOutputTokens);
    return {
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
  }
}

function traceKey(record: { id: string; generation: number }): { agentId: string; generation: number } {
  return { agentId: record.id, generation: record.generation };
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

function toolError(requestId: string, message: string): AgentInputRecord {
  return {
    type: 'tool_result', requestId, final: true, isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, message, error: { code: 'TOOL_ERROR', message, retryable: false }, truncated: false }) }]
  };
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