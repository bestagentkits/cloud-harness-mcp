import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { AgentProxyOperationSchema, RunnerAgentsConfigSchema, type RunnerResponse } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputRecordSchema } from '../../agent-runtime/src/protocol-schemas.js';
import { createRedactor } from '../../agent-runtime/src/redaction.js';
import { AgentManager, type AgentToolExecutor } from '../../runner/src/agent-manager.js';
import type { AgentGatewayControl, AgentLeaseGrant, AgentLeaseRevocation } from '../../runner/src/agent-gateway-control.js';
import type { AgentLaunchSpec, AgentLauncher, AgentRuntimeProcess } from '../../runner/src/agent-launcher.js';
import { AgentStateRepository } from '../../runner/src/agent-state-repository.js';
import { DurableSessionStore } from '../../runner/src/durable-session-store.js';
import { ModelSpendLedger } from '../../runner/src/model-spend-ledger.js';
import { StateStore, type WorkspaceRecord } from '../../runner/src/state-store.js';
import { runDurableWorker } from '../src/durable-worker.js';
import type { DurableInputRecord, DurableStartRecord, DurableWorker } from '../src/protocol.js';

const ALL_OPERATIONS = AgentProxyOperationSchema.options;
const LEASE = `bearer_${'x'.repeat(48)}`;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function agentsConfig(overrides: { durableRuntimeEnabled?: boolean; sessionPersistenceEnabled?: boolean } = {}, limits: Record<string, number> = {}) {
  return RunnerAgentsConfigSchema.parse({
    image: 'cloud-harness-agent:test',
    gatewayUrl: 'http://model-gateway:3210',
    durableRuntimeEnabled: true,
    sessionPersistenceEnabled: false,
    ...overrides,
    profiles: [{
      id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
      inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
      maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
      maxProxyOperations: ALL_OPERATIONS
    }],
    limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600, ...limits }
  });
}

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* a handle may still close */ }
  }
});

class FakeGateway implements AgentGatewayControl {
  readonly issued: Array<Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>> = [];
  readonly revoked: string[] = [];
  async issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant> {
    this.issued.push(input);
    return { ...input, lease: LEASE };
  }
  async revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation | void> {
    this.revoked.push(leaseId);
  }
  async cancelAndDrain(): Promise<void> {}
}

type Launch = {
  spec: AgentLaunchSpec;
  /** Every record the runner sent, parsed by the worker's own input schema. */
  received: Array<Record<string, unknown>>;
  /** Every record the worker sent back. */
  sent: Array<Record<string, unknown>>;
  worker?: DurableWorker;
  dead: boolean;
};

/**
 * Runs each launched agent in process: a durable start record starts the real durable worker,
 * wired to the runner over JSONL streams exactly as the container's stdio would carry them, with a
 * scripted model. Any other start record is only recorded.
 */
class InProcessLauncher implements AgentLauncher {
  readonly launches: Launch[] = [];
  readonly #responses: FauxResponseStep[][];

  constructor(responses: FauxResponseStep[][]) {
    this.#responses = responses;
  }

  async reconcile(): Promise<void> {}
  async launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess> {
    const index = this.launches.length;
    const launch: Launch = { spec, received: [], sent: [], dead: false };
    this.launches.push(launch);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const write = (record: unknown) => {
      if (launch.dead) return;
      const encoded = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
      launch.sent.push(encoded);
      stdout.write(`${JSON.stringify(encoded)}\n`);
    };
    let buffered = '';
    stdin.on('data', (chunk: Buffer) => {
      if (launch.dead) return;
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const record = InputRecordSchema.parse(JSON.parse(line)) as Record<string, unknown>;
        launch.received.push(record);
        if (launch.worker) {
          const worker = launch.worker;
          // Like the entry point, input after the terminal record is refused; here it is only dropped.
          queueMicrotask(() => { if (!launch.dead) { try { worker.receive(record as DurableInputRecord); } catch { /* after terminal */ } } });
        } else if (record.type === 'start' && record.runtime === 'pi-durable') {
          launch.worker = this.#start(record as unknown as DurableStartRecord, this.#responses[index] ?? [], write);
        }
      }
    });
    const process = { stdin, stdout, stderr: new PassThrough() } as unknown as ChildProcessWithoutNullStreams;
    return { process, exited: Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>().promise };
  }
  async cleanup(): Promise<void> {}
  async inspect(): Promise<{ container: boolean; network: boolean }> {
    return { container: false, network: false };
  }

  /** The container dies where it stands: nothing more reaches the runner or the worker. */
  kill(index: number): void {
    this.launches[index]!.dead = true;
  }

  #start(start: DurableStartRecord, responses: FauxResponseStep[], write: (record: unknown) => void): DurableWorker {
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] });
    faux.setResponses(responses);
    const models = createModels();
    models.setProvider(faux.provider);
    const worker = runDurableWorker({
      gatewayBaseUrl: 'http://model-gateway.invalid/v1',
      redactor: createRedactor(),
      configureOutput: () => undefined,
      isOutputLimitError: () => false,
      emit: async (record) => write(record),
      sendStorage: async (record) => write(record),
      terminal: async (state, usage, error) => write({ type: 'terminal', state, usage, ...(error ? { error } : {}) })
    }, start, { models, model: { provider: 'faux', modelId: 'faux-model' }, storage: { requestTimeoutMs: 2_000 } });
    return worker;
  }
}

type Interruption = { operation: string; gate: PromiseWithResolvers<void> };

/** An in-memory workspace behind the agent tool executor that counts the writes it applies. */
class FakeWorkspace {
  readonly files = new Map<string, string>();
  readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  readonly applied: string[] = [];
  interruption?: Interruption;

  readonly executor: AgentToolExecutor = async ({ operation, toolInput, signal }) => {
    this.calls.push({ operation, input: toolInput });
    const interruption = this.interruption?.operation === operation ? this.interruption : undefined;
    if (interruption) this.interruption = undefined;
    const ok = (message: string, data: unknown): RunnerResponse => ({ ok: true, message, data, truncated: false });
    const path = toolInput.path as string;
    let result: RunnerResponse;
    if (operation === 'files_write') {
      this.files.set(path, toolInput.content as string);
      this.applied.push(operation);
      result = ok('File written', { path, sha256: sha256(toolInput.content as string) });
    } else {
      const content = this.files.get(path) ?? '';
      result = ok(`Read ${content.length} bytes`, { path, content, sha256: sha256(content), bytesReturned: content.length, totalBytes: content.length, eof: true });
    }
    // Stalls after the effect, as a runner that dies before the result reaches the agent.
    if (interruption) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(new Error('tool call aborted'));
        signal.addEventListener('abort', () => reject(new Error('tool call aborted')), { once: true });
        void interruption.gate.promise.then(resolve);
      });
    }
    return result;
  };

  stallAfter(operation: string): PromiseWithResolvers<void> {
    const gate = Promise.withResolvers<void>();
    this.interruption = { operation, gate };
    return gate;
  }

  executions(operation: string): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }
}

function workspaceRecord(ownerId: string): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
    gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
}

type Runner = {
  manager: AgentManager;
  launcher: InProcessLauncher;
  repository: AgentStateRepository;
  gateway: FakeGateway;
  sessions: DurableSessionStore;
};

type RunnerOptions = {
  responses?: FauxResponseStep[][];
  durableRuntimeEnabled?: boolean;
  sessionPersistenceEnabled?: boolean;
  maxLineageBytes?: number;
  limits?: Record<string, number>;
  now?: () => number;
};

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'durable-continuation-'));
  directories.push(directory);
  const store = new StateStore(join(directory, 'state.db'));
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const record = workspaceRecord(ownerId);
  store.create(record);
  const fs = new FakeWorkspace();
  const sessionsDir = join(directory, 'agent-sessions');
  /** Starts a runner process on the shared state, as a restart would. */
  const runner = (options: RunnerOptions = {}): Runner => {
    const config = agentsConfig({
      ...(options.durableRuntimeEnabled === undefined ? {} : { durableRuntimeEnabled: options.durableRuntimeEnabled }),
      ...(options.sessionPersistenceEnabled === undefined ? {} : { sessionPersistenceEnabled: options.sessionPersistenceEnabled })
    }, options.limits);
    const repository = new AgentStateRepository(store.database, config.limits, store.instanceId());
    const launcher = new InProcessLauncher(options.responses ?? []);
    const gateway = new FakeGateway();
    const sessions = new DurableSessionStore({
      stateDir: sessionsDir, enabled: config.durableRuntimeEnabled, rate: { burst: 100_000, perSecond: 100_000 },
      ...(options.maxLineageBytes ? { maxLineageBytes: options.maxLineageBytes } : {})
    });
    const manager = new AgentManager(config, store, {
      repository, launcher, gateway, toolExecutor: fs.executor, durableSessions: sessions,
      spendLedger: new ModelSpendLedger(store.database, { log: vi.fn() }), ...(options.now ? { now: options.now } : {})
    });
    cleanups.push(async () => await manager.stop());
    return { manager, launcher, repository, gateway, sessions };
  };
  cleanups.push(async () => { store.close(); });
  return { store, record, fs, runner, sessionsDir };
}

type Context = ReturnType<typeof setup>;

function spawnInput(context: Context, idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: context.record.id, prompt: 'edit the repository', idempotencyKey, profileId: 'default',
    proxyOperations: ALL_OPERATIONS, ttlSeconds: 60, maxOutputBytes: 262_144,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, ...overrides
  };
}

async function spawn(context: Context, runner: Runner, idempotencyKey: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await runner.manager.dispatch(context.record.ownerId, context.record, 'agent_spawn', spawnInput(context, idempotencyKey, overrides));
  return (response.data as { agentId: string }).agentId;
}

function agent(context: Context, runner: Runner, agentId: string) {
  return runner.repository.findAgent(context.record.ownerId, context.record.id, agentId);
}

async function status(context: Context, runner: Runner, agentId: string): Promise<Record<string, unknown>> {
  const response = await runner.manager.dispatch(context.record.ownerId, context.record, 'agent_status', { workspaceId: context.record.id, agentId });
  return response.data as Record<string, unknown>;
}

async function settled(context: Context, runner: Runner, agentId: string): Promise<string> {
  await vi.waitFor(() => expect(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'])
    .toContain(agent(context, runner, agentId)?.status), { timeout: 20_000, interval: 25 });
  return agent(context, runner, agentId)!.status;
}

function toolRequests(launch: Launch | undefined, operation?: string): Array<Record<string, unknown>> {
  return (launch?.sent ?? []).filter((record) => record.type === 'tool_request' && (operation === undefined || record.operation === operation));
}

const lineageFile = (context: Context, lineageRootId: string) => join(context.sessionsDir, `${lineageRootId}.sqlite`);

describe('durable agent runtime through the runner', () => {
  it('resumes a run killed mid-write in a continuation without writing again, with correct receipts and fresh budget', async () => {
    const context = setup();
    const { fs, record } = context;
    fs.files.set('README.md', '# readme\n');
    const first = context.runner({
      responses: [[
        fauxAssistantMessage(fauxToolCall('files_read', { path: 'README.md' }, { id: 'call-read' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxToolCall('files_write', { path: 'out.txt', content: 'new content' }, { id: 'call-write' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('done before the crash')
      ]]
    });
    fs.stallAfter('files_write');
    const agentId = await spawn(context, first, 'durable-kill', { runtime: 'pi-durable' });
    await vi.waitFor(() => expect(fs.applied).toEqual(['files_write']), { timeout: 20_000, interval: 25 });
    const [writeRequest] = toolRequests(first.launcher.launches[0], 'files_write');
    const [readRequest] = toolRequests(first.launcher.launches[0], 'files_read');
    expect(writeRequest?.requestId).toMatch(/^durable-task-\d+$/);

    // The runner and its agent container die together; the next runner reconciles the agent.
    first.launcher.kill(0);
    await first.sessions.close();
    const second = context.runner({
      responses: [[fauxAssistantMessage('the write was interrupted; nothing else to do'), fauxAssistantMessage('continued'), fauxAssistantMessage('continued')]]
    });
    await second.manager.start();
    expect(agent(context, second, agentId)).toMatchObject({ status: 'INTERRUPTED', outcomeUnknown: true, runtime: 'pi-durable' });
    const predecessorStatus = await status(context, second, agentId);
    expect(predecessorStatus).toMatchObject({ runtime: 'pi-durable', run: { resumable: true } });
    const writeKey = { rootAgentId: agentId, requestId: writeRequest!.requestId as string, kind: 'files_write' };
    expect(second.repository.findEffect(writeKey)).toMatchObject({ state: 'UNKNOWN' });
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: readRequest!.requestId as string, kind: 'files_read' }))
      .toMatchObject({ state: 'APPLIED' });
    const usageBefore = second.repository.usage(record.ownerId, record.id, agentId, 1);

    // The continuation inherits the engine, resumes the unfinished run, and never writes again.
    const successorId = await spawn(context, second, 'durable-continue', { continueFrom: agentId, prompt: 'finish up' });
    expect(await settled(context, second, successorId)).toBe('SUCCEEDED');
    const start = second.launcher.launches[0]!.received.find((item) => item.type === 'start')!;
    expect(start).toMatchObject({ runtime: 'pi-durable', durableResume: 'continue' });
    // The engine settles its interrupted calls itself on resume; it never receives a replayed transcript.
    expect(start).not.toHaveProperty('session');
    expect(fs.applied).toEqual(['files_write']);
    expect(fs.executions('files_write')).toBe(1);
    expect(toolRequests(second.launcher.launches[0], 'files_write')).toEqual([]);
    expect(fs.files.get('out.txt')).toBe('new content');
    expect(second.repository.findEffect(writeKey)).toMatchObject({ state: 'UNKNOWN', agentId });

    // Each run holds its own lease with its own caps; the predecessor's usage stays its own.
    expect(second.gateway.issued).toHaveLength(1);
    expect(second.gateway.issued[0]).toMatchObject({ agentId: successorId });
    expect(second.gateway.issued[0]!.leaseId).not.toBe(first.gateway.issued[0]!.leaseId);
    expect(second.repository.usage(record.ownerId, record.id, agentId, 1)).toEqual(usageBefore);
    expect((await status(context, second, successorId))).toMatchObject({ runtime: 'pi-durable', continuedFrom: agentId, run: { resumable: false } });

    // The lease never reaches the session store, which is one database for the whole lineage.
    expect(existsSync(lineageFile(context, successorId))).toBe(false);
    await second.sessions.close();
    const bytes = readFileSync(lineageFile(context, agentId));
    expect(bytes.includes(Buffer.from(LEASE))).toBe(false);
    expect(bytes.includes(Buffer.from('bearer_'))).toBe(false);
  }, 60_000);

  it('lets only one of two racing continuations claim the lineage', async () => {
    const context = setup();
    const first = context.runner({ responses: [[fauxAssistantMessage('first answer')], [fauxAssistantMessage('continued')], [fauxAssistantMessage('continued')]] });
    const agentId = await spawn(context, first, 'race-root', { runtime: 'pi-durable' });
    expect(await settled(context, first, agentId)).toBe('SUCCEEDED');
    expect((await status(context, first, agentId))).toMatchObject({ run: { resumable: false } });

    const results = await Promise.allSettled([
      spawn(context, first, 'race-continue-a', { continueFrom: agentId }),
      spawn(context, first, 'race-continue-b', { continueFrom: agentId })
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ code: 'CONFLICT' });
    const successorId = (winners[0] as PromiseFulfilledResult<string>).value;
    expect(await settled(context, first, successorId)).toBe('SUCCEEDED');
    expect(first.launcher.launches).toHaveLength(2);
    // The loser can no longer claim the store at the winner's position.
    await expect(first.sessions.claim(agentId, `agent_${'z'.repeat(24)}`, first.repository.currentEpoch(context.store.instanceId()), 1))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  }, 60_000);

  it('cancels a cancelled predecessor\'s unfinished work instead of continuing it', async () => {
    const context = setup();
    const { fs, record } = context;
    fs.files.set('README.md', '# readme\n');
    const runner = context.runner({
      responses: [
        [fauxAssistantMessage(fauxToolCall('files_read', { path: 'README.md' }, { id: 'call-read' }), { stopReason: 'toolUse' })],
        [fauxAssistantMessage('starting over')]
      ]
    });
    const stalled = fs.stallAfter('files_read');
    const agentId = await spawn(context, runner, 'cancel-root', { runtime: 'pi-durable' });
    await vi.waitFor(() => expect(fs.executions('files_read')).toBe(1), { timeout: 20_000, interval: 25 });
    await runner.manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
    stalled.resolve();
    expect(agent(context, runner, agentId)?.status).toBe('CANCELLED');
    expect(await status(context, runner, agentId)).toMatchObject({ run: { resumable: false } });

    const successorId = await spawn(context, runner, 'cancel-continue', { continueFrom: agentId, prompt: 'start over' });
    expect(await settled(context, runner, successorId)).toBe('SUCCEEDED');
    expect(runner.launcher.launches[1]!.received.find((item) => item.type === 'start')).toMatchObject({ durableResume: 'abort' });
    expect(fs.executions('files_read')).toBe(1);
  }, 60_000);

  it('ends a run whose session store outgrows its cap as limit exceeded', async () => {
    const context = setup();
    const runner = context.runner({ maxLineageBytes: 1, responses: [[fauxAssistantMessage('never committed')]] });
    const agentId = await spawn(context, runner, 'cap-root', { runtime: 'pi-durable' });
    expect(await settled(context, runner, agentId)).toBe('LIMIT_EXCEEDED');
  }, 60_000);

  it('counts a lineage\'s session store toward the aggregate session budgets until its workspace closes', async () => {
    const context = setup();
    const { record } = context;
    const first = context.runner({ responses: [[fauxAssistantMessage('answer')]] });
    const agentId = await spawn(context, first, 'budget-root', { runtime: 'pi-durable' });
    expect(await settled(context, first, agentId)).toBe('SUCCEEDED');
    expect(first.sessions.lineageBytes(agentId)).toBeGreaterThan(0);
    await first.manager.stop();
    // Closing checkpoints the write-ahead log; the store is re-measured, so it counts what is on disk.
    const bytes = first.sessions.lineageBytes(agentId);
    const wal = `${lineageFile(context, agentId)}-wal`;
    expect(bytes).toBe(statSync(lineageFile(context, agentId)).size + (existsSync(wal) ? statSync(wal).size : 0));
    expect(first.sessions.totalBytes()).toBe(bytes);

    // A restarted runner measures the stores on disk before it admits anything. Its workspace budget
    // holds exactly this store; the owner and instance budgets hold one byte less than two of them.
    const second = context.runner({
      responses: [[fauxAssistantMessage('never committed')]],
      limits: { maxSessionBytes: bytes, workspaceSessionBytes: bytes, principalSessionBytes: bytes * 2 - 1, globalSessionBytes: bytes * 2 - 1 }
    });
    await second.manager.start();
    const otherWorkspace = `ws_${'v'.repeat(24)}`;
    expect(second.repository.exceededSessionBudget(record.ownerId, record.id, 0)).toBeUndefined();
    expect(second.repository.exceededSessionBudget(record.ownerId, record.id, 1)).toBe('workspace');
    expect(second.repository.exceededSessionBudget(record.ownerId, otherWorkspace, bytes)).toBe('principal');
    expect(second.repository.exceededSessionBudget('other-owner', otherWorkspace, bytes - 1)).toBeUndefined();
    expect(second.repository.exceededSessionBudget('other-owner', otherWorkspace, bytes)).toBe('instance');

    // A new lineage in the full workspace cannot commit, so its run ends as limit exceeded.
    const blockedId = await spawn(context, second, 'budget-blocked', { runtime: 'pi-durable' });
    expect(await settled(context, second, blockedId)).toBe('LIMIT_EXCEEDED');
    expect(agent(context, second, blockedId)?.terminalReason).toMatch(/size limit/);
    // The full workspace refuses a continuation at admission, and the predecessor stays continuable.
    expect(second.sessions.lineageBytes(blockedId)).toBeGreaterThan(0);
    await expect(spawn(context, second, 'budget-continue', { continueFrom: agentId })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', retryable: false });
    expect(second.repository.findSuccessor(agentId)).toBeUndefined();

    // Closing the workspace deletes its stores and frees the budgets.
    await second.manager.stopWorkspace(record.ownerId, record.id, 'workspace closed');
    expect(existsSync(lineageFile(context, agentId))).toBe(false);
    expect(second.sessions.totalBytes()).toBe(0);
    expect(second.repository.exceededSessionBudget(record.ownerId, record.id, bytes)).toBeUndefined();
  }, 60_000);

  it('deletes a lineage\'s session store when its workspace closes', async () => {
    const context = setup();
    const runner = context.runner({ responses: [[fauxAssistantMessage('answer')]] });
    const agentId = await spawn(context, runner, 'close-root', { runtime: 'pi-durable' });
    expect(await settled(context, runner, agentId)).toBe('SUCCEEDED');
    expect(existsSync(lineageFile(context, agentId))).toBe(true);
    await runner.manager.stopWorkspace(context.record.ownerId, context.record.id, 'workspace closed');
    expect(existsSync(lineageFile(context, agentId))).toBe(false);
  }, 60_000);

  it('deletes a lineage\'s session store once retention purges every session of it', async () => {
    let now = Date.now();
    const context = setup();
    const runner = context.runner({ responses: [[fauxAssistantMessage('answer')]], now: () => now });
    const agentId = await spawn(context, runner, 'retention-root', { runtime: 'pi-durable' });
    expect(await settled(context, runner, agentId)).toBe('SUCCEEDED');
    expect(existsSync(lineageFile(context, agentId))).toBe(true);
    now += agentsConfig().limits.sessionRetentionMs + 1;
    await (runner.manager as unknown as { reap(): Promise<void> }).reap();
    expect(existsSync(lineageFile(context, agentId))).toBe(false);
  }, 60_000);

  it('refuses the durable engine while it is off, and refuses to switch engines on a continuation', async () => {
    const context = setup();
    const { record } = context;
    const off = context.runner({ durableRuntimeEnabled: false, sessionPersistenceEnabled: true });
    await expect(spawn(context, off, 'off-durable', { runtime: 'pi-durable' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(off.launcher.launches).toHaveLength(0);

    const on = context.runner({ responses: [[fauxAssistantMessage('answer')]], sessionPersistenceEnabled: true });
    const durableId = await spawn(context, on, 'on-durable', { runtime: 'pi-durable' });
    expect(await settled(context, on, durableId)).toBe('SUCCEEDED');
    await expect(spawn(context, on, 'switch-to-coding', { continueFrom: durableId, runtime: 'pi-coding' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // With the engine off again, a durable agent is not continued and nothing resumes on its own.
    await expect(spawn(context, off, 'off-continue', { continueFrom: durableId })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(off.launcher.launches).toHaveLength(0);

    const codingId = await spawn(context, on, 'coding-agent', {});
    await vi.waitFor(() => expect(on.launcher.launches).toHaveLength(2));
    await expect(spawn(context, on, 'switch-to-durable', { continueFrom: codingId, runtime: 'pi-durable' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await on.manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId: codingId });
  }, 60_000);

  it('leaves the default engine\'s start record and status unchanged', async () => {
    const context = setup();
    const runner = context.runner();
    const agentId = await spawn(context, runner, 'default-engine');
    await vi.waitFor(() => expect(runner.launcher.launches[0]?.received.some((item) => item.type === 'start')).toBe(true));
    const start = runner.launcher.launches[0]!.received.find((item) => item.type === 'start')!;
    expect(start).not.toHaveProperty('runtime');
    expect(start).not.toHaveProperty('durableResume');
    expect(start).not.toHaveProperty('session');
    expect(agent(context, runner, agentId)?.runtime).toBe('pi-coding');
    const current = await status(context, runner, agentId);
    expect(current).not.toHaveProperty('runtime');
    expect(current).not.toHaveProperty('run');
    expect(existsSync(context.sessionsDir)).toBe(false);
  });
});
