import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AgentProxyOperationSchema,
  HarnessError,
  TOOL_SCHEMA_BY_NAME,
  type AgentBudget,
  type AgentModelProfile,
  type AgentProxyOperation,
  type AgentStatus,
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
import { DockerAgentGatewayControl, type AgentGatewayControl } from './agent-gateway-control.js';
import { DockerAgentLauncher, type AgentLaunchSpec, type AgentLauncher, type AgentRuntimeProcess } from './agent-launcher.js';
import { AgentProtocolChannel, type AgentInputRecord, type AgentOutputRecord } from './agent-protocol.js';
import type { StateStore, WorkspaceRecord } from './state-store.js';

const AGENT_OPERATIONS: Readonly<Partial<Record<RunnerOperation, true>>> = {
  agent_spawn: true,
  agent_status: true,
  agent_logs: true,
  agent_message: true,
  agent_cancel: true,
  agent_list: true
};
const terminalStatuses = new Set<AgentStatus>(AGENT_TERMINAL_STATUSES);
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

export type AgentManagerDependencies = {
  repository?: AgentStateRepository;
  gateway?: AgentGatewayControl;
  launcher?: AgentLauncher;
  toolExecutor: AgentToolExecutor;
  now?: () => number;
};

export class AgentManager {
  private readonly repository: AgentStateRepository;
  private readonly gateway: AgentGatewayControl;
  private readonly launcher: AgentLauncher;
  private readonly runtimes = new Map<string, RuntimeContext>();
  private readonly launches = new Map<string, Promise<void>>();
  private readonly cleanupTargets = new Map<string, TerminalAgentStatus>();
  private readonly now: () => number;
  private accepting = true;
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly config: RunnerAgentsConfig,
    private readonly store: StateStore,
    private readonly dependencies: AgentManagerDependencies
  ) {
    this.repository = dependencies.repository ?? new AgentStateRepository(store.database, config.limits);
    this.gateway = dependencies.gateway ?? new DockerAgentGatewayControl();
    this.launcher = dependencies.launcher ?? new DockerAgentLauncher(this.gateway, store.instanceId());
    this.now = dependencies.now ?? Date.now;
  }

  static isPublicOperation(operation: RunnerOperation): boolean {
    return AGENT_OPERATIONS[operation] === true;
  }
  fence(): void {
    this.accepting = false;
  }

  async start(): Promise<void> {
    this.accepting = false;
    await this.launcher.reconcile?.();
    for (const workspace of this.store.active()) {
      if (workspace.status !== 'ACTIVE') continue;
      const records = this.repository.prepareWorkspaceStartupRepair(workspace.ownerId, workspace.id, workspace.generation, this.now());
      records.sort((left, right) => agentDepth(right, records) - agentDepth(left, records));
      for (const record of records) await this.reconcileInterrupted(record);
      this.repository.openWorkspaceAdmission(workspace.ownerId, workspace.id, workspace.generation, this.now());
    }
    this.repository.maintainClosedWorkspaces(this.now());
    this.accepting = true;
    this.reaper = setInterval(() => { void this.reap().catch(() => undefined); }, 1_000);
    this.reaper.unref();
  }

  async stop(): Promise<void> {
    this.fence();
    clearInterval(this.reaper);
    await Promise.allSettled(this.store.active().map(async (workspace) => {
      const generation = workspace.status === 'REAPING'
        ? Math.max(1, workspace.generation - 1)
        : workspace.generation;
      this.repository.closeWorkspaceAdmission(workspace.ownerId, workspace.id, generation, this.now());
      await this.stopWorkspace(workspace.ownerId, workspace.id, generation, 'runner stopping');
    }));
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
      case 'agent_cancel': return await this.cancel(ownerId, workspace.id, validated.agentId as string, 'cancelled by owner');
      case 'agent_list': return this.list(ownerId, workspace.id, validated);
      default: throw new HarnessError('INVALID_INPUT', 'unsupported agent operation');
    }
  }

  async stopWorkspace(ownerId: string, workspaceId: string, generation: number, reason: string): Promise<void> {
    this.repository.closeWorkspaceAdmission(ownerId, workspaceId, generation, this.now());
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
    if (!this.accepting) throw new HarnessError('UNAVAILABLE', 'agent mutation admission is closed', 503, true);
    if (workspace.ownerId !== ownerId || workspace.status !== 'ACTIVE' || workspace.expiresAt <= this.now()) {
      throw new HarnessError('NOT_FOUND', 'workspace was not found', 404, false);
    }
    if (workspace.networkMode !== 'none') {
      throw new HarnessError('CONFLICT', 'agents require a network-disabled workspace', 409, false);
    }
    const profile = this.profile(input.profileId as string);
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
    const reservation = this.repository.reserveSpawn({
      id: agentId,
      ownerId,
      workspaceId: workspace.id,
      workspaceGeneration: workspace.generation,
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId as string } : {}),
      idempotencyKey: input.idempotencyKey as string,
      payloadHash,
      promptHash: createHash('sha256').update(prompt).digest('hex'),
      profileId: profile.id,
      proxyOperations: tools,
      budget,
      containerName: `ch-agent-${suffix}`,
      networkName: `ch-agent-net-${suffix}`,
      gatewayLeaseId,
      now,
      expiresAt: Math.min(workspace.expiresAt, now + budget.ttlSeconds * 1_000)
    });
    if (reservation.replayed) {
      return success('Agent spawn replayed', spawnData(reservation.record, true));
    }
    const launch = this.launch(reservation.record, prompt, profile)
      .finally(() => this.launches.delete(reservation.record.id));
    this.launches.set(reservation.record.id, launch);
    void launch.catch(() => undefined);
    return success('Agent spawn accepted', spawnData(reservation.record, false));
  }

  private async launch(record: AgentRecord, prompt: string, profile: AgentModelProfile): Promise<void> {
    const spec = this.launchSpec(record);
    try {
      const grant = await this.gateway.issue({
        leaseId: record.gatewayLeaseId,
        agentId: record.id,
        profileId: record.profileId,
        ttlMs: Math.max(1_000, record.expiresAt - this.now()),
        maxInputTokens: record.budget.maxInputTokens,
        maxOutputTokens: record.budget.maxOutputTokens,
        maxCostMicros: record.budget.maxCostMicros
      });
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
        ownerId: record.ownerId, workspaceId: record.workspaceId, agentId: record.id, generation: record.generation,
        expectedStatuses: ['SPAWNING'], status: 'RUNNING', now: this.now()
      });
      if (!running) throw new HarnessError('CONFLICT', 'agent launch lost its lifecycle fence', 409, true);
      context.record = running;
      const deadlineMs = Math.max(1_000, running.expiresAt - this.now());
      context.deadline = setTimeout(() => { void this.cancelOne(running, 'agent TTL expired', 'TIMED_OUT'); }, deadlineMs);
      context.deadline.unref();
      await channel.send(this.startRecord(running, prompt, profile, lease));
      void runtime.exited.then(({ code }) => {
        if (!context.terminalSeen) void this.interrupt(running, `agent runtime exited before terminal record (${code ?? 'signal'})`);
      }).catch((error: unknown) => { void this.interrupt(running, error instanceof Error ? error.message : 'agent runtime failed'); });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent launch failed';
      const current = this.repository.findAgent(record.ownerId, record.workspaceId, record.id);
      if (!current || current.status === 'CANCELLING' || terminalStatuses.has(current.status)) return;
      const cancelling = this.repository.transitionStatus({
        ownerId: current.ownerId, workspaceId: current.workspaceId, agentId: current.id, generation: current.generation,
        expectedStatuses: [current.status], status: 'CANCELLING', now: this.now(), cleanupReason: message.slice(0, 2_000)
      });
      if (!cancelling) return;
      await this.cancelDescendants(cancelling, message);
      const context = this.runtimes.get(record.id);
      const cleanup = this.cleanup(cancelling, context, message, 'FAILED');
      if (context) context.cleanup = cleanup;
      await cleanup;
    }
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
    const reserved = this.repository.reserveMessage({
      ownerId, workspaceId, agentId: record.id, generation: record.generation,
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
    const controller = new AbortController();
    const startedAt = this.now();
    const completion = (async () => {
      try {
        const raw = typeof output.input === 'object' && output.input !== null && !Array.isArray(output.input)
          ? output.input as Record<string, unknown>
          : {};
        const toolInput = TOOL_SCHEMA_BY_NAME[output.operation].parse({ ...raw, workspaceId: record.workspaceId }) as Record<string, unknown>;
        const result = await this.dependencies.toolExecutor({
          ownerId: record.ownerId, workspaceId: record.workspaceId, workspaceGeneration: record.workspaceGeneration,
          agentId: record.id, agentGeneration: record.generation, requestId: output.requestId,
          operation: output.operation, toolInput, signal: controller.signal
        });
        this.requireRunnable(record);
        const serialized = JSON.stringify(result);
        const text = Buffer.byteLength(serialized, 'utf8') <= 131_072 ? serialized : JSON.stringify({
          ok: false, message: 'tool result exceeded the agent protocol bound',
          error: { code: 'LIMIT_EXCEEDED', message: 'tool result exceeded the agent protocol bound', retryable: false }, truncated: true
        });
        await context.channel.send({
          type: 'tool_result', requestId: output.requestId, final: true, isError: !result.ok,
          content: [{ type: 'text', text }]
        });
      } catch (error) {
        await context.channel.send(toolError(output.requestId, safeError(error))).catch(() => undefined);
      } finally {
        this.repository.addUsage(record.ownerId, record.workspaceId, record.id, record.generation, {
          toolTimeMs: Math.max(0, this.now() - startedAt)
        });
        context.proxy.delete(output.requestId);
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
      if (runtime) {
        await runtime.messageChain;
        if (!runtime.terminalSeen) {
          await runtime.channel.send({
            type: 'cancel', requestId: randomUUID(), reason: reason.slice(0, 1_024)
          }).catch(() => undefined);
        }
        for (const pending of runtime.proxy.values()) pending.controller.abort(reason);
        await Promise.allSettled([...runtime.proxy.values()].map((pending) => pending.completion));
      }
      const drainErrors: unknown[] = [];
      try {
        await this.gateway.revokeAndDrain(record.gatewayLeaseId);
      } catch (error) {
        drainErrors.push(error);
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
    });
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
      || workspace.status !== 'ACTIVE' || workspace.networkMode !== 'none' || workspace.expiresAt <= now
      || !record || record.generation !== expected.generation || record.status !== 'RUNNING' || record.expiresAt <= now) {
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

  private profile(id: string): AgentModelProfile {
    const profile = this.config.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new HarnessError('INVALID_INPUT', 'unknown agent model profile');
    return profile;
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

  private startRecord(record: AgentRecord, prompt: string, profile: AgentModelProfile, lease: string): AgentInputRecord {
    const contextWindow = Math.min(2_000_000, profile.maxInputTokens + profile.maxOutputTokens);
    return {
      type: 'start', requestId: randomUUID(), agentId: record.id, prompt, tools: record.proxyOperations,
      gateway: { profile: profile.id, lease },
      model: {
        id: profile.model, name: profile.displayName, api: 'openai-completions', reasoning: false,
        contextWindow, maxTokens: Math.min(record.budget.maxOutputTokens, profile.maxOutputTokens, contextWindow),
        cost: {
          input: profile.inputMicrosPerMillionTokens / 1_000_000,
          output: profile.outputMicrosPerMillionTokens / 1_000_000,
          cacheRead: 0,
          cacheWrite: 0
        }
      },
      limits: {
        deadlineMs: Math.max(1_000, record.expiresAt - this.now()),
        maxEvents: this.config.limits.maxLogEventsPerAgent,
        maxOutputBytes: record.budget.maxOutputBytes,
        maxEventBytes: this.config.limits.maxLogEventBytes,
        maxToolResultBytes: 262_144
      }
    };
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

function toolError(requestId: string, message: string): AgentInputRecord {
  return {
    type: 'tool_result', requestId, final: true, isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, message, error: { code: 'TOOL_ERROR', message, retryable: false }, truncated: false }) }]
  };
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