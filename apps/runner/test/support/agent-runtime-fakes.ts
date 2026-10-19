import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { vi } from 'vitest';
import { RunnerAgentsConfigSchema, type AgentStatus, type RunnerAgentsConfig, type RunnerResponse } from '@cloud-harness/contracts';
import { AgentManager, type AgentManagerDependencies } from '../../src/agent-manager.js';
import type { AgentGatewayControl, AgentLeaseGrant, AgentLeaseRevocation, AgentLeaseSettlement } from '../../src/agent-gateway-control.js';
import type { AgentLaunchSpec, AgentLauncher, AgentRuntimeProcess } from '../../src/agent-launcher.js';
import { AgentStateRepository } from '../../src/agent-state-repository.js';
import { ModelSpendLedger } from '../../src/model-spend-ledger.js';
import { StateStore, type WorkspaceRecord } from '../../src/state-store.js';

/**
 * Scripted doubles of the agent runtime boundary: a launcher whose process streams the test writes
 * protocol records into, and a gateway that issues leases and returns scripted settlements. They let
 * a test drive AgentManager through turns, usage, tools, settlements and terminal states without
 * Docker, a model provider or a real Pi session.
 */

export const TEST_AGENTS_CONFIG: RunnerAgentsConfig = RunnerAgentsConfigSchema.parse({
  image: 'cloud-harness-agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  profiles: [{
    id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
    maxProxyOperations: ['files_read', 'files_write']
  }],
  limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600 }
});

export type ScriptedSettlement = Partial<Omit<AgentLeaseSettlement, 'leaseId'>>;

export class ScriptedGateway implements AgentGatewayControl {
  readonly issued: AgentLeaseGrant[] = [];
  readonly revoked: string[] = [];
  /** Settlements returned on revoke, by lease id. `defaultSettlement` applies to any other lease. */
  readonly settlements = new Map<string, ScriptedSettlement>();
  defaultSettlement: ScriptedSettlement | undefined;
  failIssue = false;
  failRevoke = false;
  /** Unset models an older gateway that reports neither a boot id nor a settlement. */
  bootId: string | undefined = 'gateway-boot-test';

  async issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant> {
    if (this.failIssue) throw new Error('injected lease issue failure');
    const grant = { ...input, lease: `bearer_${'x'.repeat(48)}`, ...(this.bootId ? { gatewayBootId: this.bootId } : {}) };
    this.issued.push(grant);
    return grant;
  }

  async revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation | void> {
    this.revoked.push(leaseId);
    if (this.failRevoke) throw new Error('injected lease revoke failure');
    if (this.bootId === undefined) return;
    const settlement = this.settlements.get(leaseId) ?? this.defaultSettlement;
    if (!settlement) return { revoked: false, gatewayBootId: this.bootId };
    return { revoked: true, gatewayBootId: this.bootId, settlement: settlementOf(leaseId, settlement) };
  }

  async cancelAndDrain(): Promise<void> {}
}

export function settlementOf(leaseId: string, overrides: ScriptedSettlement = {}): AgentLeaseSettlement {
  return {
    leaseId, reason: 'revoked', settledAt: 1, initialInputTokens: 10_000, initialOutputTokens: 2_000, initialCostMicros: 1_000_000,
    costMicros: 0, overrunCostMicros: 0, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    reasoningTokens: 0, requests: 0, requestsWithoutUsage: 0, ...overrides
  };
}

export type ScriptedProcess = {
  spec: AgentLaunchSpec;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exit: (code: number | null) => void;
};

export class ScriptedLauncher implements AgentLauncher {
  readonly processes: ScriptedProcess[] = [];
  readonly cleanups: Array<Pick<AgentLaunchSpec, 'containerName' | 'networkName'>> = [];
  failCleanup = false;

  async reconcile(): Promise<void> {}

  async launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    this.processes.push({ spec, stdin, stdout, stderr, exit: (code) => exited.resolve({ code, signal: null }) });
    const process = { stdin, stdout, stderr } as unknown as ChildProcessWithoutNullStreams;
    return { process, exited: exited.promise };
  }

  async cleanup(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>): Promise<void> {
    this.cleanups.push(spec);
    if (this.failCleanup) throw new Error('injected cleanup failure');
  }

  async inspect(): Promise<{ container: boolean; network: boolean }> {
    return { container: false, network: false };
  }

  /** The scripted process of an agent; throws when the agent was never launched. */
  processFor(agentId: string): ScriptedProcess {
    const found = this.processes.find((candidate) => candidate.spec.agentId === agentId);
    if (!found) throw new Error(`agent ${agentId} was not launched`);
    return found;
  }
}

/** Cumulative usage, as the runtime reports it on every usage and terminal record. */
export type CumulativeUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number };

function usageRecord(usage: CumulativeUsage) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return { input: usage.input, output: usage.output, cacheRead, cacheWrite, total: usage.input + usage.output + cacheRead + cacheWrite, cost: usage.cost };
}

export type ScriptedTool = { toolCallId: string; operation: 'files_read' | 'files_write'; input: Record<string, unknown>; isError?: boolean };

export type ScriptedTurn = {
  textDeltas?: string[];
  tools?: ScriptedTool[];
  outcome?: string;
  errorClass?: string;
  /** Cumulative usage after the turn; omitted models a provider that reported no usage. */
  usage?: CumulativeUsage;
  /** Emits an auto-retry notice after the turn, as the runtime does before retrying a failed call. */
  retryNotice?: boolean;
};

/** Builds the protocol records the runtime emits for one model turn, in the runtime's order. */
export class RecordScript {
  private sequence = 0;
  private lastUsage: CumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  readonly records: Record<string, unknown>[] = [];

  private event(event: Record<string, unknown>): this {
    this.records.push({ type: 'event', sequence: ++this.sequence, event });
    return this;
  }

  turn(turn: ScriptedTurn): this {
    this.event({ kind: 'lifecycle', phase: 'turn_started' });
    for (const text of turn.textDeltas ?? []) this.event({ kind: 'text_delta', text });
    for (const tool of turn.tools ?? []) {
      this.event({ kind: 'tool', phase: 'started', toolCallId: tool.toolCallId, name: tool.operation });
      this.records.push({ type: 'tool_request', requestId: `req-${tool.toolCallId}`, toolCallId: tool.toolCallId, operation: tool.operation, input: tool.input });
      this.event({ kind: 'tool', phase: 'ended', toolCallId: tool.toolCallId, name: tool.operation, isError: tool.isError === true });
    }
    this.event({
      kind: 'lifecycle', phase: 'turn_ended',
      ...(turn.outcome === undefined ? {} : { outcome: turn.outcome }),
      ...(turn.errorClass === undefined ? {} : { errorClass: turn.errorClass })
    });
    if (turn.usage) this.lastUsage = turn.usage;
    this.records.push({ type: 'usage', sequence: ++this.sequence, usage: usageRecord(this.lastUsage) });
    if (turn.retryNotice) this.event({ kind: 'notice', message: 'retrying after provider error' });
    return this;
  }

  /** Starts a turn that never ends, as when the stream terminates mid-turn. */
  openTurn(textDeltas: string[] = []): this {
    this.event({ kind: 'lifecycle', phase: 'turn_started' });
    for (const text of textDeltas) this.event({ kind: 'text_delta', text });
    return this;
  }

  terminal(state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LIMIT_EXCEEDED' | 'INTERRUPTED', error?: string): this {
    this.records.push({ type: 'terminal', state, usage: usageRecord(this.lastUsage), ...(error ? { error } : {}) });
    return this;
  }

  lines(): string {
    return this.records.map((record) => `${JSON.stringify(record)}\n`).join('');
  }
}

/** A monotonically increasing clock: every read advances by `stepMs`, so durations are never zero. */
export function steppingClock(start = Date.now(), stepMs = 5): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => { current += stepMs; return current; },
    advance: (ms) => { current += ms; }
  };
}

type HarnessDependencies = Partial<Omit<AgentManagerDependencies, 'repository' | 'launcher' | 'gateway' | 'toolExecutor' | 'spendLedger'>>;

export type AgentHarnessOptions = {
  config?: RunnerAgentsConfig;
  ownerId?: string;
  now?: () => number;
  /** Extra manager dependencies, or a factory over the harness state store for dependencies that need its database. */
  dependencies?: HarnessDependencies | ((store: StateStore) => HarnessDependencies);
  toolExecutor?: AgentManagerDependencies['toolExecutor'];
};

export type AgentHarness = ReturnType<typeof createAgentHarness>;

/** A temporary state store with one network-disabled workspace and an AgentManager over the scripted doubles. */
export function createAgentHarness(options: AgentHarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-harness-'));
  const store = new StateStore(join(directory, 'state.db'));
  const config = options.config ?? TEST_AGENTS_CONFIG;
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: options.ownerId ?? 'owner' });
  const created = Date.now();
  const workspace: WorkspaceRecord = {
    id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: created, lastActivityAt: created, expiresAt: created + 600_000, hardExpiresAt: created + 3_600_000,
    gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
  store.create(workspace);
  const repository = new AgentStateRepository(store.database, config.limits);
  const launcher = new ScriptedLauncher();
  const gateway = new ScriptedGateway();
  const toolExecutor = vi.fn(options.toolExecutor ?? (async (): Promise<RunnerResponse> => ({ ok: true, message: 'done', data: { content: 'ok' }, truncated: false })));
  const spendLedger = new ModelSpendLedger(store.database, { log: () => undefined });
  const manager = new AgentManager(config, store, {
    ...(typeof options.dependencies === 'function' ? options.dependencies(store) : options.dependencies),
    repository, launcher, gateway, toolExecutor, spendLedger,
    ...(options.now ? { now: options.now } : {})
  });
  let spawnCount = 0;

  const harness = {
    directory, store, config, ownerId, workspace, repository, launcher, gateway, toolExecutor, spendLedger, manager,
    async spawn(overrides: Record<string, unknown> = {}): Promise<string> {
      spawnCount += 1;
      const response = await manager.dispatch(ownerId, workspace, 'agent_spawn', {
        workspaceId: workspace.id, prompt: 'inspect the repository', idempotencyKey: `spawn-key-${spawnCount}`,
        profileId: 'default', proxyOperations: ['files_read', 'files_write'], ttlSeconds: 60, maxOutputBytes: 262_144,
        maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
        ...overrides
      });
      if (!response.ok) throw new Error(`spawn failed: ${response.message}`);
      return (response.data as { agentId: string }).agentId;
    },
    status(agentId: string): AgentStatus | undefined {
      return repository.findAgent(ownerId, workspace.id, agentId)?.status;
    },
    async waitForStatus(agentId: string, status: AgentStatus | AgentStatus[]): Promise<void> {
      const wanted = Array.isArray(status) ? status : [status];
      await vi.waitFor(() => {
        const current = harness.status(agentId);
        if (!current || !wanted.includes(current)) throw new Error(`agent is ${current ?? 'missing'}, waiting for ${wanted.join('|')}`);
      }, { timeout: 5_000, interval: 5 });
    },
    /** Writes the script's records into the agent's runtime stdout. */
    send(agentId: string, script: RecordScript | string): void {
      launcher.processFor(agentId).stdout.write(typeof script === 'string' ? script : script.lines());
    },
    async cancel(agentId: string, reason = 'cancelled by owner'): Promise<RunnerResponse> {
      return await manager.dispatch(ownerId, workspace, 'agent_cancel', { workspaceId: workspace.id, agentId, reason });
    },
    close(): void {
      try { store.close(); } catch { /* already closed */ }
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  return harness;
}
