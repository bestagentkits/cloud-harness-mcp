/**
 * Agent runtime benchmark harness.
 *
 * The offline suite always runs. It drives the real AgentWorker, the real proxy tool broker and a
 * real Pi session in-process, against a scripted pi-ai faux model and an in-memory stand-in for the
 * runner's proxy tool executor, and measures the current `pi-coding` runtime on five use cases. No
 * model, network or container is involved, so every number is the cost of the runtime itself.
 *
 * The live suite runs only with RUN_AGENT_RUNTIME_BENCHMARK=live plus a gateway URL and lease, and
 * needs a registered live driver. Without the prerequisites it skips; it never fabricates numbers.
 * Results are written to AGENT_RUNTIME_BENCHMARK_OUT when set.
 *
 * Runtimes plug in through `RuntimeUnderTest`: a runtime executes one worker lifetime for a task and
 * may accept a continuation handle from an earlier lifetime. The baseline does not support
 * continuation, and records what it observes instead.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { AgentWorker } from '../../apps/agent-runtime/src/agent-worker.js';
import { ControlledResourceLoader } from '../../apps/agent-runtime/src/controlled-resources.js';
import { JsonlWriter, ProtocolError } from '../../apps/agent-runtime/src/jsonl.js';
import { BoundedOutput } from '../../apps/agent-runtime/src/output.js';
import { assertExactTools, type AgentSessionFactory, type AgentSessionLike } from '../../apps/agent-runtime/src/pi-session.js';
import type { AgentProxyOperation, OutputRecord, StartRecord, TerminalState } from '../../apps/agent-runtime/src/protocol-schemas.js';
import { createStartRecord } from '../../apps/agent-runtime/test/helpers.js';

type ModelStep = { text: string } | { toolCalls: Array<{ name: string; args: Record<string, unknown> }> };
type ScenarioSpec = {
  title: string;
  prompt: string;
  followUpPrompt?: string;
  tools: AgentProxyOperation[];
  model: ModelStep[];
  followUpModel?: ModelStep[];
  killAtToolRequest?: number;
  cancelAtToolRequest?: number;
  children?: number;
};
type ScenarioFixture = { workspace: Record<string, string>; scenarios: Record<string, ScenarioSpec> };

const fixture = JSON.parse(readFileSync(new URL('../fixtures/agent-runtime/scenarios.json', import.meta.url), 'utf8')) as ScenarioFixture;

const MUTATING = new Set<AgentProxyOperation>(['files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir']);
const REPETITIONS = Math.max(1, Number.parseInt(process.env.AGENT_RUNTIME_BENCHMARK_REPS ?? '20', 10) || 20);

/* ------------------------------------------------------------------------------------------------
 * Runtime-under-test contract
 * --------------------------------------------------------------------------------------------- */

/** How a task ends: left to finish, killed like a crashed process, or cancelled by the owner. */
type Interrupt = { atToolRequest: number; mode: 'kill' | 'cancel' };

interface TaskRun {
  prompt: string;
  tools: AgentProxyOperation[];
  model: ModelStep[];
  workspace: FakeWorkspace;
  interrupt?: Interrupt;
  /** Handle returned by an earlier lifetime of the same runtime. Runtimes that cannot continue ignore it. */
  continueFrom?: unknown;
}

interface TaskOutcome {
  state: TerminalState;
  error?: string;
  wallMs: number;
  /** Time from the start record to the first record the worker wrote. */
  firstRecordMs: number;
  modelRequests: number;
  toolRoundTrips: number;
  toolCancels: number;
  recordBytes: number;
  /** Messages the model saw on its first request, and on the last one. */
  firstRequestMessages: number;
  lastRequestMessages: number;
  lastRequestBytes: number;
  /** Messages and serialized size of the session transcript when the worker finished. */
  transcriptMessages: number;
  transcriptBytes: number;
  rssDeltaBytes: number;
  /** True when this lifetime started from a transcript supplied by an earlier lifetime. */
  continued: boolean;
  /** Whether the worker refused input after reaching a terminal state. */
  postTerminalInputRefused: boolean;
  /** Opaque value a later lifetime of the same runtime can continue from. */
  handle?: unknown;
}

interface RuntimeUnderTest {
  readonly id: string;
  readonly description: string;
  run(task: TaskRun): Promise<TaskOutcome>;
}

/* ------------------------------------------------------------------------------------------------
 * In-memory proxy tool executor
 * --------------------------------------------------------------------------------------------- */

interface Effect { operation: AgentProxyOperation; target: string; payloadHash: string }

class FakeWorkspace {
  readonly files: Map<string, string>;
  readonly effects: Effect[] = [];

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }

  /** Executes a proxy operation the way the runner would, returning the tool result text. */
  execute(operation: AgentProxyOperation, input: Record<string, unknown>): { isError: boolean; text: string } {
    const path = String(input.path ?? input.source ?? '');
    if (MUTATING.has(operation)) {
      this.effects.push({ operation, target: path, payloadHash: createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex') });
    }
    switch (operation) {
      case 'files_list': {
        const prefix = path === '' ? '' : `${path.replace(/\/$/u, '')}/`;
        return { isError: false, text: [...this.files.keys()].filter((name) => name.startsWith(prefix)).sort().join('\n') };
      }
      case 'files_read': {
        const content = this.files.get(path);
        return content === undefined ? { isError: true, text: `not found: ${path}` } : { isError: false, text: content };
      }
      case 'files_write':
        this.files.set(path, String(input.content ?? ''));
        return { isError: false, text: `wrote ${path}` };
      case 'files_apply_patch': {
        const current = this.files.get(path);
        const oldText = String(input.oldText ?? '');
        if (current === undefined || !current.includes(oldText)) return { isError: true, text: `patch does not apply: ${path}` };
        this.files.set(path, current.replace(oldText, String(input.newText ?? '')));
        return { isError: false, text: `patched ${path}` };
      }
      case 'grep_search': {
        const pattern = String(input.pattern ?? '');
        const hits = [...this.files].flatMap(([name, content]) => content.split('\n').flatMap((line, index) => (line.includes(pattern) ? [`${name}:${index + 1}:${line}`] : [])));
        return { isError: false, text: hits.join('\n') };
      }
      default:
        return { isError: false, text: `${operation} ok` };
    }
  }

  /** Mutations whose exact payload was applied more than once. */
  get duplicateEffects(): number {
    const seen = new Set<string>();
    let duplicates = 0;
    for (const effect of this.effects) {
      const key = `${effect.operation}:${effect.payloadHash}`;
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
    }
    return duplicates;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Baseline runtime: the shipped pi-coding worker, with a scripted model in place of the gateway
 * --------------------------------------------------------------------------------------------- */

const GATEWAY_PROVIDER_ID_FOR_BENCH = 'faux';
const RUNTIME_CWD = '/runtime';

function scriptedResponses(steps: ModelStep[], onRequest: (messageCount: number, bytes: number) => void): FauxResponseStep[] {
  let sequence = 0;
  return steps.map((step): FauxResponseStep => (context) => {
    onRequest(context.messages.length, Buffer.byteLength(JSON.stringify(context.messages), 'utf8'));
    if ('text' in step) return fauxAssistantMessage([fauxText(step.text)]);
    return fauxAssistantMessage(step.toolCalls.map((call) => fauxToolCall(call.name, call.args as never, { id: `call_${(sequence += 1)}` })), { stopReason: 'toolUse' });
  });
}

/**
 * Builds the same controlled Pi session as the production factory (no extensions, only the proxy
 * tools, in-memory transcript) with the gateway provider swapped for a scripted faux provider.
 */
function fauxSessionFactory(steps: ModelStep[], onRequest: (messageCount: number, bytes: number) => void, capture: (session: AgentSessionLike) => void): AgentSessionFactory {
  return async (start: StartRecord, broker) => {
    const faux = fauxProvider({ provider: GATEWAY_PROVIDER_ID_FOR_BENCH, models: [{ id: start.model.id, contextWindow: start.model.contextWindow, maxTokens: start.model.maxTokens, cost: start.model.cost }] });
    faux.setResponses(scriptedResponses(steps, onRequest));
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel(faux.provider.id, start.model.id);
    if (!model) throw new Error('faux model is unavailable');
    const { session, extensionsResult } = await createAgentSession({
      cwd: RUNTIME_CWD,
      agentDir: RUNTIME_CWD,
      model,
      modelRuntime,
      thinkingLevel: 'off',
      noTools: 'all',
      tools: start.tools,
      customTools: broker.createDefinitions(start.tools),
      resourceLoader: new ControlledResourceLoader(),
      sessionManager: SessionManager.inMemory(RUNTIME_CWD),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0, provider: { timeoutMs: start.limits.deadlineMs, maxRetries: 0, maxRetryDelayMs: 0 } },
        images: { autoResize: false, blockImages: true },
        enableSkillCommands: false,
        enableInstallTelemetry: false,
        enableAnalytics: false,
        packages: [], extensions: [], skills: [], prompts: [], themes: [],
        defaultTools: start.tools
      })
    });
    if (extensionsResult.extensions.length !== 0 || extensionsResult.errors.length !== 0) throw new Error('controlled Pi session loaded an extension');
    assertExactTools(session, start.tools);
    capture(session);
    return session;
  };
}

let agentCounter = 0;

const piCodingBaseline: RuntimeUnderTest = {
  id: 'pi-coding',
  description: 'Shipped runtime: one-shot Pi session, in-memory transcript, container-local state',
  async run(task) {
    const startRecord = createStartRecord({
      agentId: `agent_${String((agentCounter += 1)).padStart(20, '0')}`,
      prompt: task.prompt,
      tools: task.tools,
      limits: { deadlineMs: 60_000, maxEvents: 10_000, maxOutputBytes: 8 * 1024 * 1024, maxEventBytes: 16_384, maxToolResultBytes: 1024 * 1024 }
    });
    const stream = new PassThrough();
    const output = new BoundedOutput(new JsonlWriter(stream));
    let session: AgentSessionLike | undefined;
    let modelRequests = 0;
    let firstRequestMessages = 0;
    let lastRequestMessages = 0;
    let lastRequestBytes = 0;
    const worker = new AgentWorker(output, fauxSessionFactory(task.model, (messages, bytes) => {
      modelRequests += 1;
      if (modelRequests === 1) firstRequestMessages = messages;
      lastRequestMessages = messages;
      lastRequestBytes = bytes;
    }, (created) => { session = created; }));

    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();
    let firstRecordAt: number | undefined;
    let recordBytes = 0;
    let toolRoundTrips = 0;
    let toolCancels = 0;
    let terminal: Extract<OutputRecord, { type: 'terminal' }> | undefined;
    let buffered = '';
    const answered = new Set<string>();

    const stop = (mode: 'kill' | 'cancel') => {
      // Defer so the request that triggered the stop has been fully recorded first.
      setImmediate(() => {
        if (mode === 'kill') worker.interrupt(new Error('runtime received termination signal'));
        else worker.receive({ type: 'cancel', requestId: 'cancel-1', reason: 'owner cancelled' });
      });
    };

    stream.on('data', (chunk: Buffer) => {
      firstRecordAt ??= performance.now();
      recordBytes += chunk.length;
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const record = JSON.parse(line) as OutputRecord;
        if (record.type === 'terminal') terminal = record;
        else if (record.type === 'tool_cancel') toolCancels += 1;
        else if (record.type === 'tool_request') {
          toolRoundTrips += 1;
          const reached = task.interrupt && toolRoundTrips >= task.interrupt.atToolRequest;
          if (reached) {
            if (toolRoundTrips === task.interrupt!.atToolRequest) stop(task.interrupt!.mode);
            continue; // the request stays in flight: no result is ever delivered
          }
          if (answered.has(record.requestId)) continue;
          answered.add(record.requestId);
          const result = task.workspace.execute(record.operation, record.input as Record<string, unknown>);
          setImmediate(() => {
            try {
              worker.receive({ type: 'tool_result', requestId: record.requestId, final: true, isError: result.isError, content: [{ type: 'text', text: result.text }] });
            } catch {
              // The worker already reached a terminal state; the late result is dropped like the runner does.
            }
          });
        }
      }
    });

    worker.receive(startRecord);
    await worker.completion;
    const wallMs = performance.now() - startedAt;
    await new Promise((resolve) => setImmediate(resolve));

    let postTerminalInputRefused = false;
    try {
      worker.receive({ type: 'message', requestId: 'late-1', behavior: 'followUp', text: 'continue' });
    } catch (error) {
      postTerminalInputRefused = error instanceof ProtocolError;
    }

    const transcript = session ? JSON.stringify(session.messages) : '[]';
    return {
      state: terminal?.state ?? 'FAILED',
      error: terminal?.error,
      wallMs,
      firstRecordMs: (firstRecordAt ?? performance.now()) - startedAt,
      modelRequests,
      toolRoundTrips,
      toolCancels,
      recordBytes,
      firstRequestMessages,
      lastRequestMessages,
      lastRequestBytes,
      transcriptMessages: session?.messages.length ?? 0,
      transcriptBytes: Buffer.byteLength(transcript, 'utf8'),
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      continued: false,
      postTerminalInputRefused,
      handle: undefined
    };
  }
};

/* ------------------------------------------------------------------------------------------------
 * Scenarios (runtime-agnostic)
 * --------------------------------------------------------------------------------------------- */

interface ScenarioObservation {
  /** Deterministic facts about the scenario outcome; identical on every repetition. */
  facts: Record<string, string | number | boolean | null>;
  /** Timing and memory samples for this repetition, aggregated across repetitions. */
  samples: { wallMs: number; firstRecordMs: number; rssDeltaBytes: number };
  /** Counters summed across the task lifetimes of this repetition. */
  totals: { toolRoundTrips: number; toolEffects: number; recordBytes: number; modelRequests: number };
}

interface Scenario {
  id: string;
  useCase: string;
  run(runtime: RuntimeUnderTest): Promise<ScenarioObservation>;
}

function spec(id: string): ScenarioSpec {
  const found = fixture.scenarios[id];
  if (!found) throw new Error(`missing scenario fixture: ${id}`);
  return found;
}

function taskFor(scenario: ScenarioSpec, workspace: FakeWorkspace, extra: Partial<TaskRun> = {}): TaskRun {
  return { prompt: scenario.prompt, tools: scenario.tools, model: scenario.model, workspace, ...extra };
}

function observation(outcomes: TaskOutcome[], workspace: FakeWorkspace, facts: ScenarioObservation['facts']): ScenarioObservation {
  const sum = (pick: (outcome: TaskOutcome) => number) => outcomes.reduce((total, outcome) => total + pick(outcome), 0);
  return {
    facts,
    samples: { wallMs: sum((o) => o.wallMs), firstRecordMs: outcomes[0]!.firstRecordMs, rssDeltaBytes: sum((o) => o.rssDeltaBytes) },
    totals: { toolRoundTrips: sum((o) => o.toolRoundTrips), toolEffects: workspace.effects.length, recordBytes: sum((o) => o.recordBytes), modelRequests: sum((o) => o.modelRequests) }
  };
}

const SCENARIOS: Scenario[] = [
  {
    id: 'pr-review',
    useCase: 'short PR review',
    async run(runtime) {
      const scenario = spec('pr-review');
      const workspace = new FakeWorkspace(fixture.workspace);
      const outcome = await runtime.run(taskFor(scenario, workspace));
      return observation([outcome], workspace, {
        state: outcome.state,
        toolEffects: workspace.effects.length,
        contextMessagesAtEnd: outcome.transcriptMessages,
        contextBytesAtEnd: outcome.transcriptBytes,
        lastRequestMessages: outcome.lastRequestMessages,
        lastRequestBytes: outcome.lastRequestBytes,
        modelRequests: outcome.modelRequests,
        toolCancels: outcome.toolCancels
      });
    }
  },
  {
    id: 'multi-step-task',
    useCase: 'multi-step repository task',
    async run(runtime) {
      const scenario = spec('multi-step-task');
      const workspace = new FakeWorkspace(fixture.workspace);
      const outcome = await runtime.run(taskFor(scenario, workspace));
      return observation([outcome], workspace, {
        state: outcome.state,
        toolEffects: workspace.effects.length,
        contextMessagesAtEnd: outcome.transcriptMessages,
        contextBytesAtEnd: outcome.transcriptBytes,
        lastRequestMessages: outcome.lastRequestMessages,
        lastRequestBytes: outcome.lastRequestBytes,
        modelRequests: outcome.modelRequests,
        toolCancels: outcome.toolCancels
      });
    }
  },
  {
    id: 'restart-followup',
    useCase: 'follow-up after a process restart',
    async run(runtime) {
      const scenario = spec('restart-followup');
      const workspace = new FakeWorkspace(fixture.workspace);
      const first = await runtime.run(taskFor(scenario, workspace));
      // The worker process is gone: the follow-up is a new lifetime that may only use the handle.
      const second = await runtime.run({
        prompt: scenario.followUpPrompt!, tools: scenario.tools, model: scenario.followUpModel!, workspace, continueFrom: first.handle
      });
      const retained = second.firstRequestMessages > 1;
      return observation([first, second], workspace, {
        firstState: first.state,
        sameProcessFollowUpRefused: first.postTerminalInputRefused,
        firstTranscriptMessages: first.transcriptMessages,
        followUpContinued: second.continued,
        followUpFirstRequestMessages: second.firstRequestMessages,
        priorContextRetained: retained,
        followUpState: second.state,
        followUpOutcome: second.continued ? 'CONTINUED' : 'CONTEXT_LOST'
      });
    }
  },
  {
    id: 'killed-run-with-effects',
    useCase: 'deliberately killed run with read and write effects',
    async run(runtime) {
      const scenario = spec('killed-run-with-effects');
      const workspace = new FakeWorkspace(fixture.workspace);
      const killed = await runtime.run(taskFor(scenario, workspace, { interrupt: { atToolRequest: scenario.killAtToolRequest!, mode: 'kill' } }));
      const effectsAtKill = workspace.effects.length;
      // Every request still pending at termination is cancelled by the worker, so this counts requests in flight.
      const inFlightAtKill = killed.toolCancels;
      // The owner starts the same task again; the runtime may only use the handle from the killed run.
      const restarted = await runtime.run(taskFor(scenario, workspace, { continueFrom: killed.handle }));
      return observation([killed, restarted], workspace, {
        killedState: killed.state,
        reportedSuccess: killed.state === 'SUCCEEDED',
        effectsAtKill,
        inFlightAtKill,
        restartContinued: restarted.continued,
        restartState: restarted.state,
        totalEffects: workspace.effects.length,
        duplicateEffects: workspace.duplicateEffects,
        restartOutcome: restarted.continued ? 'CONTINUED' : 'REPLAYED_FROM_START'
      });
    }
  },
  {
    id: 'parent-child-cleanup',
    useCase: 'parent-child cleanup',
    async run(runtime) {
      const scenario = spec('parent-child-cleanup');
      const workspace = new FakeWorkspace(fixture.workspace);
      const lifetimes = 1 + (scenario.children ?? 0);
      // Parent and children each hold one tool call in flight when the owner cancels.
      const outcomes = await Promise.all(Array.from({ length: lifetimes }, () => runtime.run(taskFor(scenario, workspace, { interrupt: { atToolRequest: scenario.cancelAtToolRequest!, mode: 'cancel' } }))));
      return observation(outcomes, workspace, {
        agents: lifetimes,
        cancelled: outcomes.filter((outcome) => outcome.state === 'CANCELLED').length,
        toolCancelsEmitted: outcomes.reduce((total, outcome) => total + outcome.toolCancels, 0),
        toolEffects: workspace.effects.length
      });
    }
  }
];

/* ------------------------------------------------------------------------------------------------
 * Aggregation and report shape
 * --------------------------------------------------------------------------------------------- */

/** Nearest-rank percentile over a copy of the samples. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

interface ScenarioReport {
  scenario: string;
  useCase: string;
  repetitions: number;
  facts: ScenarioObservation['facts'];
  totals: ScenarioObservation['totals'];
  wallMs: { p50: number; p95: number };
  firstRecordMs: { p50: number; p95: number };
  rssDeltaBytes: { p50: number; p95: number };
}

interface RuntimeReport {
  runtime: string;
  description: string;
  scenarios: ScenarioReport[];
}

/** JSON written to AGENT_RUNTIME_BENCHMARK_OUT; the live driver emits the same shape. */
interface AgentRuntimeBenchmarkReport {
  schema: 1;
  mode: 'offline' | 'live';
  timestamp: string;
  node: string;
  repetitions: number;
  runtimes: RuntimeReport[];
}

async function measure(runtime: RuntimeUnderTest, scenario: Scenario): Promise<ScenarioReport> {
  const runs: ScenarioObservation[] = [];
  for (let index = 0; index < REPETITIONS; index += 1) runs.push(await scenario.run(runtime));
  const first = runs[0]!;
  // Serialized sizes vary by a few bytes because messages embed timestamps; every other fact must not.
  const isSize = (key: string) => /Bytes/u.test(key);
  const stable = (facts: ScenarioObservation['facts']) => Object.fromEntries(Object.entries(facts).filter(([key]) => !isSize(key)));
  for (const run of runs) {
    expect(stable(run.facts), `${runtime.id}/${scenario.id} must be deterministic across repetitions`).toEqual(stable(first.facts));
    expect({ ...run.totals, recordBytes: 0 }, `${runtime.id}/${scenario.id} counters must be deterministic`).toEqual({ ...first.totals, recordBytes: 0 });
  }
  const facts = Object.fromEntries(Object.entries(first.facts).map(([key, value]) => [key, isSize(key) ? percentile(runs.map((run) => Number(run.facts[key])), 0.5) : value]));
  const spread = (pick: (run: ScenarioObservation) => number) => {
    const values = runs.map(pick);
    return { p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)) };
  };
  return {
    scenario: scenario.id,
    useCase: scenario.useCase,
    repetitions: runs.length,
    facts,
    totals: { ...first.totals, recordBytes: percentile(runs.map((run) => run.totals.recordBytes), 0.5) },
    wallMs: spread((run) => run.samples.wallMs),
    firstRecordMs: spread((run) => run.samples.firstRecordMs),
    rssDeltaBytes: spread((run) => run.samples.rssDeltaBytes)
  };
}

async function measureRuntime(runtime: RuntimeUnderTest): Promise<RuntimeReport> {
  const scenarios: ScenarioReport[] = [];
  for (const scenario of SCENARIOS) scenarios.push(await measure(runtime, scenario));
  return { runtime: runtime.id, description: runtime.description, scenarios };
}

function summarize(report: AgentRuntimeBenchmarkReport): string {
  const lines = [`agent runtime benchmark (${report.mode}, ${report.repetitions} repetitions, node ${report.node})`];
  for (const runtime of report.runtimes) {
    lines.push(`runtime ${runtime.runtime}: ${runtime.description}`);
    for (const row of runtime.scenarios) {
      lines.push(
        `  ${row.scenario.padEnd(24)} wall p50/p95 ${row.wallMs.p50}/${row.wallMs.p95} ms | first record p50 ${row.firstRecordMs.p50} ms | `
        + `tool round trips ${row.totals.toolRoundTrips} | effects ${row.totals.toolEffects} | protocol ${row.totals.recordBytes} B | `
        + `rss delta p50 ${Math.round(row.rssDeltaBytes.p50 / 1024)} KiB`
      );
      lines.push(`    ${JSON.stringify(row.facts)}`);
    }
  }
  return lines.join('\n');
}

function publish(report: AgentRuntimeBenchmarkReport): void {
  if (process.env.AGENT_RUNTIME_BENCHMARK_OUT) writeFileSync(process.env.AGENT_RUNTIME_BENCHMARK_OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(summarize(report));
}

/* ------------------------------------------------------------------------------------------------
 * Offline suite
 * --------------------------------------------------------------------------------------------- */

describe('agent runtime benchmark (offline, scripted faux model)', () => {
  it('measures the pi-coding baseline on the five use cases', async () => {
    const baseline = await measureRuntime(piCodingBaseline);
    const byId = Object.fromEntries(baseline.scenarios.map((row) => [row.scenario, row]));

    expect(byId['pr-review']!.facts).toMatchObject({ state: 'SUCCEEDED', toolEffects: 0 });
    expect(byId['multi-step-task']!.facts).toMatchObject({ state: 'SUCCEEDED', toolEffects: 2 });
    // A completed worker refuses further input, and a fresh worker starts without the earlier transcript.
    expect(byId['restart-followup']!.facts).toMatchObject({ firstState: 'SUCCEEDED', sameProcessFollowUpRefused: true, priorContextRetained: false, followUpOutcome: 'CONTEXT_LOST' });
    // A killed run never reports success, and replaying the task from the start repeats the applied write.
    expect(byId['killed-run-with-effects']!.facts).toMatchObject({ killedState: 'INTERRUPTED', reportedSuccess: false, effectsAtKill: 1, restartOutcome: 'REPLAYED_FROM_START' });
    expect(Number(byId['killed-run-with-effects']!.facts.duplicateEffects)).toBeGreaterThan(0);
    // Every in-flight tool call of every agent is cancelled with the agent.
    expect(byId['parent-child-cleanup']!.facts).toMatchObject({ agents: 3, cancelled: 3, toolCancelsEmitted: 3 });

    publish({ schema: 1, mode: 'offline', timestamp: new Date().toISOString(), node: process.version, repetitions: REPETITIONS, runtimes: [baseline] });
  }, 300_000);
});

/* ------------------------------------------------------------------------------------------------
 * Live suite (opt-in)
 * --------------------------------------------------------------------------------------------- */

const live = process.env.RUN_AGENT_RUNTIME_BENCHMARK === 'live'
  && Boolean(process.env.AGENT_RUNTIME_BENCHMARK_GATEWAY_URL)
  && Boolean(process.env.AGENT_RUNTIME_BENCHMARK_LEASE);

/** Live drivers talk to a real gateway through the same `RuntimeUnderTest` contract. */
const LIVE_RUNTIMES: RuntimeUnderTest[] = [];

describe.skipIf(!live)('agent runtime live benchmark (real gateway)', () => {
  it('measures every registered live runtime', async () => {
    expect(LIVE_RUNTIMES.length, 'register a live RuntimeUnderTest before enabling the live benchmark').toBeGreaterThan(0);
    const runtimes: RuntimeReport[] = [];
    for (const runtime of LIVE_RUNTIMES) runtimes.push(await measureRuntime(runtime));
    publish({ schema: 1, mode: 'live', timestamp: new Date().toISOString(), node: process.version, repetitions: REPETITIONS, runtimes });
  }, 1_800_000);
});
