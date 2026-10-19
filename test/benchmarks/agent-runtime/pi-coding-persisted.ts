/**
 * `pi-coding+persisted`: the shipped worker with session persistence, behind the real runner.
 *
 * Each task is an `agent_spawn` through a real `AgentManager` on a real `AgentStateRepository`
 * (SQLite state store in a temporary directory). The launcher starts the real `AgentWorker`
 * in-process instead of a container: the runner writes the start record (with its `session` log)
 * to the worker's stdin and reads its stdout, exactly as it would a container's stdio. So session
 * persistence, continuation admission and replay, the effect ledger with its receipts, and the
 * runner's kill and cancel handling are the product code paths. Only Docker, the model gateway
 * (a lease-only double) and the executor (the shared in-memory workspace) are replaced.
 *
 * A continuation (`continueFrom`) always runs on a freshly started runner over the same state
 * database, like a follow-up after a process restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentProxyOperationSchema, RunnerAgentsConfigSchema, type RunnerResponse } from '@cloud-harness/contracts';
import { AgentWorker } from '../../../apps/agent-runtime/src/agent-worker.js';
import { InputRecordQueue, JsonlWriter, ProtocolError } from '../../../apps/agent-runtime/src/jsonl.js';
import { BoundedOutput } from '../../../apps/agent-runtime/src/output.js';
import type { AgentSessionLike } from '../../../apps/agent-runtime/src/pi-session.js';
import type { TerminalState } from '../../../apps/agent-runtime/src/protocol-schemas.js';
import type { AgentGatewayControl, AgentLeaseGrant, AgentLeaseRevocation, GatewaySnapshotSync } from '../../../apps/runner/src/agent-gateway-control.js';
import type { AgentLaunchSpec, AgentLauncher, AgentRuntimeProcess } from '../../../apps/runner/src/agent-launcher.js';
import { AgentManager, type AgentToolExecutor } from '../../../apps/runner/src/agent-manager.js';
import { AgentStateRepository } from '../../../apps/runner/src/agent-state-repository.js';
import { ModelSpendLedger } from '../../../apps/runner/src/model-spend-ledger.js';
import { StateStore, type WorkspaceRecord } from '../../../apps/runner/src/state-store.js';
import {
  BENCH_LIMITS, ModelRequestCounter, WorkerRecordObserver, fauxSessionFactory,
  type FakeWorkspace, type Interrupt, type ModelStep, type RuntimeUnderTest, type TaskOutcome, type TaskRun, type WorkspaceCloseReport
} from './harness.js';
import { refusesInputAfterTerminal } from './pi-coding.js';

const PROFILE_ID = 'bench';
const LEASE = `bearer_${'x'.repeat(48)}`;
const TERMINAL = new Set<string>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']);
const SETTLE_TIMEOUT_MS = 30_000;

// The same model limits as the baseline start record: a 32,000-token window, 4,096 output tokens,
// and prices of 1 and 2 per token.
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_INPUT_TOKENS = 32_000 - MAX_OUTPUT_TOKENS;
const MAX_COST_MICROS = 1_000_000_000;

const config = RunnerAgentsConfigSchema.parse({
  image: 'cloud-harness-agent:bench',
  gatewayUrl: 'http://model-gateway:3210',
  sessionPersistenceEnabled: true,
  profiles: [{
    id: PROFILE_ID, displayName: 'Benchmark', provider: 'faux', model: 'bench-model',
    inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000,
    maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, maxCostMicros: MAX_COST_MICROS,
    maxProxyOperations: AgentProxyOperationSchema.options
  }],
  limits: {
    minTtlSeconds: 30, maxTtlSeconds: 3_600,
    maxOutputBytesPerAgent: BENCH_LIMITS.maxOutputBytes,
    maxLogEventsPerAgent: BENCH_LIMITS.maxEvents,
    maxLogEventBytes: BENCH_LIMITS.maxEventBytes
  }
});

/** A lease-only gateway: issues and revokes leases, holds no snapshot, settles nothing. */
class LeaseOnlyGateway implements AgentGatewayControl {
  async gatewayContainer(): Promise<string> { return 'model-gateway'; }
  async issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant> {
    return { ...input, lease: LEASE };
  }
  async revokeAndDrain(): Promise<AgentLeaseRevocation | void> {}
  async cancelAndDrain(): Promise<void> {}
  async queryDigest() {
    return { gatewayBootId: 'bench', snapshotDigest: '', activeProfileCount: 1, activeCredentialCount: 0, activeLeaseCount: 0 };
  }
  // Static profiles only: the runner never needs a dynamic snapshot here, so nothing is pushed.
  async syncSnapshot(): Promise<GatewaySnapshotSync> {
    return { gatewayBootId: 'bench', gatewayDigest: '', expectedDigest: '', pushed: false };
  }
}

type Stall = { operation: string; when: 'before' | 'after'; reached: () => void };

/** What `run` asks of the next launch: the model script, any interrupt, and when the task started. */
interface LaunchPlan {
  steps: ModelStep[];
  interrupt?: Interrupt | undefined;
  startedAt: number;
  onInterrupt: (worker: InProcessWorker) => void;
  launched: PromiseWithResolvers<InProcessWorker>;
}

/** One worker "container": the real AgentWorker wired to stdio streams the runner owns. */
class InProcessWorker {
  readonly model = new ModelRequestCounter();
  readonly observer: WorkerRecordObserver;
  readonly worker: AgentWorker;
  readonly exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly process: ChildProcessWithoutNullStreams;
  /** Requests held at a point in the executor, by request ID. */
  readonly stalls = new Map<string, Stall>();
  session: AgentSessionLike | undefined;
  /**
   * In-flight tool calls cancelled with the run, by request ID: calls the runner aborted before their
   * result reached the worker, and cancellations the worker delivered to the runner.
   */
  readonly cancelledRequests = new Set<string>();
  killed = false;
  control: Promise<unknown> = Promise.resolve();

  constructor(readonly spec: AgentLaunchSpec, plan: LaunchPlan) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const workerOut = new PassThrough();
    const writer = new JsonlWriter(workerOut);
    this.worker = new AgentWorker(new BoundedOutput(writer), fauxSessionFactory(plan.steps, this.model.onRequest, (created) => { this.session = created; }));
    this.process = { stdin, stdout, stderr: new PassThrough() } as unknown as ChildProcessWithoutNullStreams;

    // The worker's output reaches the runner only through this observer, in order, so a stall is
    // registered before the runner reads the request it applies to, and nothing passes after a kill.
    this.observer = new WorkerRecordObserver((record, line) => {
      if (this.killed) return;
      if (record.type === 'tool_cancel') this.cancelledRequests.add(record.requestId);
      if (record.type === 'tool_request' && plan.interrupt && this.observer.toolRoundTrips === plan.interrupt.atToolRequest) {
        const interrupt = plan.interrupt;
        this.stalls.set(record.requestId, {
          operation: record.operation,
          // A kill lands after the executor applied the effect and before its result returned;
          // an owner cancel lands while the call is still waiting to run.
          when: interrupt.mode === 'kill' ? 'after' : 'before',
          reached: () => setImmediate(() => plan.onInterrupt(this))
        });
      }
      stdout.write(`${line}\n`);
    }, plan.startedAt);
    workerOut.on('data', (chunk: Buffer) => this.observer.feed(chunk));

    // The runtime entry point's input handling: validated JSONL records, and EOF interrupts.
    const decoder = new InputRecordQueue();
    let inputClosed = false;
    const failInput = (error: unknown) => {
      if (inputClosed) return;
      inputClosed = true;
      this.worker.interrupt(error instanceof Error ? error : new ProtocolError('protocol input failed'));
    };
    stdin.on('data', (chunk: Buffer) => {
      if (inputClosed) return;
      try {
        decoder.feed(chunk);
        for (let record = decoder.shift(); record; record = decoder.shift()) this.worker.receive(record);
      } catch (error) {
        failInput(error);
      }
    });
    stdin.on('end', () => failInput(new ProtocolError('protocol input closed before terminal state')));

    void this.worker.completion.then(async () => {
      inputClosed = true;
      await writer.close();
      // A process that exits on its own closes its stdout; a killed one already did.
      if (!this.killed) {
        stdout.end();
        this.exited.resolve({ code: 0, signal: null });
      }
    });
  }

  /** Ends the worker like a SIGKILL: no further output reaches the runner and the process exits. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.worker.interrupt(new Error('runtime received termination signal'));
    (this.process.stdout as PassThrough).end();
    this.exited.resolve({ code: null, signal: 'SIGKILL' });
  }
}

class InProcessLauncher implements AgentLauncher {
  readonly #plans: LaunchPlan[] = [];
  readonly byAgent = new Map<string, InProcessWorker>();

  expect(plan: LaunchPlan): void {
    this.#plans.push(plan);
  }

  async reconcile(): Promise<void> {}

  async launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess> {
    const plan = this.#plans.shift();
    if (!plan) throw new Error('benchmark launcher has no plan for this launch');
    const worker = new InProcessWorker(spec, plan);
    this.byAgent.set(spec.agentId, worker);
    plan.launched.resolve(worker);
    return { process: worker.process, exited: worker.exited.promise };
  }

  async cleanup(): Promise<void> {}

  async inspect(): Promise<{ container: boolean; network: boolean }> {
    return { container: false, network: false };
  }
}

function workspaceRecord(ownerId: string): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${'b'.repeat(24)}`, ownerId, idempotencyKey: 'bench-workspace',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 3_600_000, hardExpiresAt: now + 7_200_000,
    gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
}

async function settle(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`benchmark runner did not settle: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** One runner state database and the runner processes that use it, for one workspace. */
class PersistedRunner {
  readonly directory = mkdtempSync(join(tmpdir(), 'agent-runtime-bench-'));
  readonly store = new StateStore(join(this.directory, 'state.db'));
  readonly ownerId = this.store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  readonly record = workspaceRecord(this.ownerId);
  readonly launcher = new InProcessLauncher();
  repository!: AgentStateRepository;
  manager!: AgentManager;
  #started = false;
  #spawnLock: Promise<unknown> = Promise.resolve();
  #spawns = 0;

  constructor(readonly workspace: FakeWorkspace) {
    this.store.create(this.record);
    this.#boot();
  }

  readonly executor: AgentToolExecutor = async ({ agentId, requestId, operation, toolInput, signal }): Promise<RunnerResponse> => {
    const worker = this.launcher.byAgent.get(agentId);
    const stall = worker?.stalls.get(requestId);
    if (!worker || !stall || stall.operation !== operation) return this.workspace.execute(operation, toolInput);
    worker.stalls.delete(requestId);
    // Held until the runner aborts the call, which is what ends it.
    const held = () => new Promise<never>((_, reject) => {
      const abort = () => { worker.cancelledRequests.add(requestId); reject(new Error('tool call aborted')); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      stall.reached();
    });
    if (stall.when === 'before') return await held();
    this.workspace.execute(operation, toolInput);
    return await held();
  };

  #boot(): void {
    this.repository = new AgentStateRepository(this.store.database, config.limits, this.store.instanceId());
    this.manager = new AgentManager(config, this.store, {
      repository: this.repository, launcher: this.launcher, gateway: new LeaseOnlyGateway(), toolExecutor: this.executor,
      spendLedger: new ModelSpendLedger(this.store.database, { log: () => undefined })
    });
  }

  /** Replaces the runner process with a new one on the same state, as a restart does. */
  async restart(): Promise<void> {
    if (this.#started) await this.manager.stop();
    else this.manager.fence();
    this.#boot();
    await this.manager.start();
    this.#started = true;
  }

  /** Spawns one agent and waits for its worker; spawns are serialized so each takes its own plan. */
  async spawn(task: TaskRun, plan: Omit<LaunchPlan, 'launched' | 'startedAt'>, continueFrom?: string): Promise<{ agentId: string; worker: InProcessWorker; startedAt: number }> {
    const run = this.#spawnLock.then(async () => {
      const launched = Promise.withResolvers<InProcessWorker>();
      const startedAt = performance.now();
      this.launcher.expect({ ...plan, startedAt, launched });
      const response = await this.manager.dispatch(this.ownerId, this.record, 'agent_spawn', {
        workspaceId: this.record.id, prompt: task.prompt, idempotencyKey: `bench-spawn-${String((this.#spawns += 1)).padStart(6, '0')}`,
        ...(continueFrom ? { continueFrom } : { profileId: PROFILE_ID }),
        proxyOperations: task.tools, ttlSeconds: Math.ceil(BENCH_LIMITS.deadlineMs / 1_000), maxOutputBytes: BENCH_LIMITS.maxOutputBytes,
        maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, maxCostMicros: MAX_COST_MICROS, repositoryContext: 'none'
      });
      if (!response.ok) throw new Error(`benchmark spawn failed: ${response.message}`);
      const agentId = (response.data as { agentId: string }).agentId;
      return { agentId, worker: await launched.promise, startedAt };
    });
    this.#spawnLock = run.catch(() => undefined);
    return await run;
  }

  status(agentId: string): string | undefined {
    return this.repository.findAgent(this.ownerId, this.record.id, agentId)?.status;
  }

  cancel(agentId: string): Promise<RunnerResponse> {
    return this.manager.dispatch(this.ownerId, this.record, 'agent_cancel', { workspaceId: this.record.id, agentId, reason: 'owner cancelled' });
  }

  /** Session and receipt state the runner holds for one agent. */
  storage(agentId: string): { rows: number; bytes: number } {
    const database = this.store.database;
    const session = database.prepare('SELECT count(*) AS rows, coalesce(sum(bytes), 0) AS bytes FROM agent_session_messages WHERE agent_id = ?').get(agentId) as { rows: number; bytes: number };
    const head = database.prepare('SELECT count(*) AS rows FROM agent_sessions WHERE agent_id = ?').get(agentId) as { rows: number };
    const effects = database.prepare('SELECT count(*) AS rows, coalesce(sum(length(result_json)), 0) AS bytes FROM agent_effects WHERE agent_id = ?').get(agentId) as { rows: number; bytes: number };
    return { rows: session.rows + head.rows + effects.rows, bytes: session.bytes + effects.bytes };
  }

  unknownEffects(agentId: string): number {
    const root = this.repository.lineageRoot(agentId) ?? agentId;
    return (this.store.database.prepare("SELECT count(*) AS count FROM agent_effects WHERE root_agent_id = ? AND state = 'UNKNOWN'").get(root) as { count: number }).count;
  }

  /** Closes the workspace through the runner and counts the session and effect rows left behind. */
  async close(): Promise<WorkspaceCloseReport> {
    await this.manager.stopWorkspace(this.ownerId, this.record.id, 'workspace closed');
    const database = this.store.database;
    const count = (sql: string) => (database.prepare(sql).get(this.ownerId, this.record.id) as { count: number }).count;
    const report = {
      leftoverSessionRows: count('SELECT count(*) AS count FROM agent_sessions WHERE owner_id = ? AND workspace_id = ?')
        + (database.prepare('SELECT count(*) AS count FROM agent_session_messages m JOIN agents a ON a.id = m.agent_id WHERE a.owner_id = ? AND a.workspace_id = ?').get(this.ownerId, this.record.id) as { count: number }).count,
      leftoverEffectRows: count('SELECT count(*) AS count FROM agent_effects WHERE owner_id = ? AND workspace_id = ?')
    };
    await this.dispose();
    return report;
  }

  async dispose(): Promise<void> {
    if (this.#started) await this.manager.stop().catch(() => undefined);
    else this.manager.fence();
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

type PersistedHandle = { runner: PersistedRunner; agentId: string };

const runners = new WeakMap<FakeWorkspace, PersistedRunner>();

function runnerFor(workspace: FakeWorkspace): PersistedRunner {
  let runner = runners.get(workspace);
  if (!runner) {
    runner = new PersistedRunner(workspace);
    runners.set(workspace, runner);
  }
  return runner;
}

function isHandle(value: unknown): value is PersistedHandle {
  return typeof value === 'object' && value !== null && (value as PersistedHandle).runner instanceof PersistedRunner;
}

export const piCodingPersisted: RuntimeUnderTest = {
  id: 'pi-coding+persisted',
  description: 'pi-coding with session persistence behind the real runner: session log, continueFrom replay, effect receipts',
  async run(task): Promise<TaskOutcome> {
    const previous = isHandle(task.continueFrom) ? task.continueFrom : undefined;
    const runner = previous?.runner ?? runnerFor(task.workspace);
    if (previous) await runner.restart();

    const rssBefore = process.memoryUsage().rss;
    const { agentId, worker, startedAt } = await runner.spawn(task, {
      steps: task.model,
      interrupt: task.interrupt,
      onInterrupt: (target) => {
        if (task.interrupt?.mode === 'kill') target.kill();
        else target.control = runner.cancel(target.spec.agentId);
      }
    }, previous?.agentId);

    await settle(() => TERMINAL.has(runner.status(agentId) ?? ''), `agent ${agentId} reaching a terminal status`);
    const wallMs = performance.now() - startedAt;
    await worker.control;
    await worker.worker.completion;
    await new Promise((resolve) => setImmediate(resolve));
    const record = runner.repository.findAgent(runner.ownerId, runner.record.id, agentId)!;
    const storage = runner.storage(agentId);
    const transcript = worker.session ? JSON.stringify(worker.session.messages) : '[]';
    return {
      state: record.status as TerminalState,
      error: record.terminalReason ?? undefined,
      wallMs,
      firstRecordMs: (worker.observer.firstRecordAt ?? performance.now()) - startedAt,
      modelRequests: worker.model.requests,
      toolRoundTrips: worker.observer.toolRoundTrips,
      toolCancels: worker.cancelledRequests.size,
      recordBytes: worker.observer.recordBytes,
      firstRequestMessages: worker.model.firstMessages,
      lastRequestMessages: worker.model.lastMessages,
      lastRequestBytes: worker.model.lastBytes,
      transcriptMessages: worker.session?.messages.length ?? 0,
      transcriptBytes: Buffer.byteLength(transcript, 'utf8'),
      inputTokens: worker.observer.inputTokens,
      outputTokens: worker.observer.outputTokens,
      storageRows: storage.rows,
      storageBytes: storage.bytes,
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      continued: previous !== undefined && runner.repository.findSession(agentId)?.continuedFrom === previous.agentId,
      postTerminalInputRefused: refusesInputAfterTerminal(worker.worker),
      launch: { container: worker.spec.containerName, leaseId: record.gatewayLeaseId },
      effectsUnknown: runner.unknownEffects(agentId),
      handle: { runner, agentId } satisfies PersistedHandle
    };
  },
  async closeWorkspace(workspace) {
    const runner = runners.get(workspace);
    if (!runner) return { leftoverSessionRows: 0, leftoverEffectRows: 0 };
    runners.delete(workspace);
    return await runner.close();
  }
};
