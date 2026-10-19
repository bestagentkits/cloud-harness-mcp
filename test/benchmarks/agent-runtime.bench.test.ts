/**
 * Agent runtime benchmark harness.
 *
 * The offline suite always runs. It drives the real AgentWorker, the real proxy tool broker and a
 * real Pi session in-process against a scripted pi-ai faux model, and measures each registered
 * runtime on five use cases with identical scripts, limits and tool grants:
 * - `pi-coding`: the shipped runtime; the benchmark answers proxy tools in place of the runner.
 * - `pi-coding+persisted`: the same worker with session persistence behind the real runner
 *   (`AgentManager`, `AgentStateRepository`, effect ledger) and an in-process launcher.
 * No model, network or container is involved, so every number is the cost of the runtime itself.
 *
 * The live suite runs only with RUN_AGENT_RUNTIME_BENCHMARK=live. It drives a local Compose stack
 * over MCP (see `agent-runtime/live-driver.ts`) and fails loudly when its prerequisites are
 * missing; it never fabricates numbers. Results are written to AGENT_RUNTIME_BENCHMARK_OUT when set.
 *
 * Runtimes plug in through `RuntimeUnderTest` (`agent-runtime/harness.ts`): a runtime executes one
 * worker lifetime for a task and may accept a continuation handle from an earlier lifetime.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeWorkspace, fixture, type RuntimeUnderTest, type ScenarioSpec, type TaskOutcome, type TaskRun } from './agent-runtime/harness.js';
import { runLiveBenchmark } from './agent-runtime/live-driver.js';
import { piCodingBaseline } from './agent-runtime/pi-coding.js';
import { piCodingPersisted } from './agent-runtime/pi-coding-persisted.js';

const REPETITIONS = Math.max(1, Number.parseInt(process.env.AGENT_RUNTIME_BENCHMARK_REPS ?? '20', 10) || 20);

/**
 * The opt-in durable runtime (`pi-durable`). It is registered here, with its own expectations in
 * the offline suite, once its package is wired; until then it is not measured.
 */
const PI_DURABLE_RUNTIME: RuntimeUnderTest | undefined = undefined;

/* ------------------------------------------------------------------------------------------------
 * Scenarios (runtime-agnostic)
 * --------------------------------------------------------------------------------------------- */

type Facts = Record<string, string | number | boolean | null>;

interface ScenarioObservation {
  /** Deterministic facts about the scenario outcome; identical on every repetition except sizes. */
  facts: Facts;
  /** Timing and memory samples for this repetition, aggregated across repetitions. */
  samples: { wallMs: number; firstRecordMs: number; rssDeltaBytes: number };
  /** Counters summed across the task lifetimes of this repetition. */
  totals: {
    toolRoundTrips: number; toolEffects: number; modelRequests: number; storageRows: number;
    recordBytes: number; storageBytes: number; inputTokens: number; outputTokens: number;
  };
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

/** Closes the workspace through the runtime, then summarizes the lifetimes of one repetition. */
async function observation(runtime: RuntimeUnderTest, outcomes: TaskOutcome[], workspace: FakeWorkspace, facts: Facts): Promise<ScenarioObservation> {
  const closed = await runtime.closeWorkspace?.(workspace);
  const sum = (pick: (outcome: TaskOutcome) => number) => outcomes.reduce((total, outcome) => total + pick(outcome), 0);
  return {
    facts: closed ? { ...facts, leftoverSessionRows: closed.leftoverSessionRows, leftoverEffectRows: closed.leftoverEffectRows } : facts,
    samples: { wallMs: sum((o) => o.wallMs), firstRecordMs: outcomes[0]!.firstRecordMs, rssDeltaBytes: sum((o) => o.rssDeltaBytes) },
    totals: {
      toolRoundTrips: sum((o) => o.toolRoundTrips), toolEffects: workspace.effects.length, modelRequests: sum((o) => o.modelRequests),
      storageRows: sum((o) => o.storageRows), recordBytes: sum((o) => o.recordBytes), storageBytes: sum((o) => o.storageBytes),
      inputTokens: sum((o) => o.inputTokens), outputTokens: sum((o) => o.outputTokens)
    }
  };
}

function singleRunFacts(outcome: TaskOutcome, workspace: FakeWorkspace): Facts {
  return {
    state: outcome.state,
    toolEffects: workspace.effects.length,
    contextMessagesAtEnd: outcome.transcriptMessages,
    contextBytesAtEnd: outcome.transcriptBytes,
    lastRequestMessages: outcome.lastRequestMessages,
    lastRequestBytes: outcome.lastRequestBytes,
    modelRequests: outcome.modelRequests,
    toolCancels: outcome.toolCancels
  };
}

const SCENARIOS: Scenario[] = [
  {
    id: 'pr-review',
    useCase: 'short PR review',
    async run(runtime) {
      const workspace = new FakeWorkspace(fixture.workspace);
      const outcome = await runtime.run(taskFor(spec('pr-review'), workspace));
      return await observation(runtime, [outcome], workspace, singleRunFacts(outcome, workspace));
    }
  },
  {
    id: 'multi-step-task',
    useCase: 'multi-step repository task',
    async run(runtime) {
      const workspace = new FakeWorkspace(fixture.workspace);
      const outcome = await runtime.run(taskFor(spec('multi-step-task'), workspace));
      return await observation(runtime, [outcome], workspace, singleRunFacts(outcome, workspace));
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
      const launches = first.launch && second.launch ? { first: first.launch, second: second.launch } : undefined;
      return await observation(runtime, [first, second], workspace, {
        firstState: first.state,
        sameProcessFollowUpRefused: first.postTerminalInputRefused,
        firstTranscriptMessages: first.transcriptMessages,
        followUpContinued: second.continued,
        followUpFirstRequestMessages: second.firstRequestMessages,
        priorContextRetained: second.firstRequestMessages > 1,
        // The follow-up's first request carries the whole earlier transcript plus its own prompt.
        allPriorMessagesInFirstRequest: second.firstRequestMessages >= first.transcriptMessages + 1,
        followUpNewContainer: launches ? launches.first.container !== launches.second.container : null,
        followUpNewLease: launches ? launches.first.leaseId !== launches.second.leaseId : null,
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
      // Requests still pending at termination are cancelled, so this counts requests in flight.
      const inFlightAtKill = killed.toolCancels;
      // The owner starts the same task again; the runtime may only use the handle from the killed run.
      const restarted = await runtime.run(taskFor(scenario, workspace, { continueFrom: killed.handle }));
      return await observation(runtime, [killed, restarted], workspace, {
        killedState: killed.state,
        reportedSuccess: killed.state === 'SUCCEEDED',
        effectsAtKill,
        inFlightAtKill,
        effectsUnknownAfterKill: killed.effectsUnknown ?? null,
        restartContinued: restarted.continued,
        restartState: restarted.state,
        totalEffects: workspace.effects.length,
        // Zero tolerance: a logical mutation (same operation and input) applied more than once.
        duplicateEffects: workspace.duplicateEffects,
        // Executor invocations of a logical mutation beyond the first, whether or not they applied.
        repeatedInvocations: workspace.repeatedInvocations,
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
      return await observation(runtime, outcomes, workspace, {
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
  facts: Facts;
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

/** JSON written to AGENT_RUNTIME_BENCHMARK_OUT by the offline suite. */
interface AgentRuntimeBenchmarkReport {
  schema: 1;
  mode: 'offline';
  timestamp: string;
  node: string;
  repetitions: number;
  runtimes: RuntimeReport[];
}

// Serialized sizes vary by a few bytes because messages embed timestamps, and token estimates
// follow them; they are reported as medians. Every other fact and counter must be identical.
const isVariable = (key: string) => /Bytes|Tokens/u.test(key);
const stable = <T extends object>(values: T) => Object.fromEntries(Object.entries(values).filter(([key]) => !isVariable(key)));
const median = <T extends object>(runs: T[]): T => Object.fromEntries(Object.entries(runs[0]!).map(([key, value]) => [
  key, isVariable(key) ? percentile(runs.map((run) => Number((run as Record<string, unknown>)[key])), 0.5) : value
])) as T;

async function measure(runtime: RuntimeUnderTest, scenario: Scenario): Promise<ScenarioReport> {
  const runs: ScenarioObservation[] = [];
  for (let index = 0; index < REPETITIONS; index += 1) runs.push(await scenario.run(runtime));
  const first = runs[0]!;
  for (const run of runs) {
    expect(stable(run.facts), `${runtime.id}/${scenario.id} must be deterministic across repetitions`).toEqual(stable(first.facts));
    expect(stable(run.totals), `${runtime.id}/${scenario.id} counters must be deterministic`).toEqual(stable(first.totals));
  }
  const spread = (pick: (run: ScenarioObservation) => number) => {
    const values = runs.map(pick);
    return { p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)) };
  };
  return {
    scenario: scenario.id,
    useCase: scenario.useCase,
    repetitions: runs.length,
    facts: median(runs.map((run) => run.facts)),
    totals: median(runs.map((run) => run.totals)),
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
        `  ${row.scenario.padEnd(24)} wall p50/p95 ${row.wallMs.p50}/${row.wallMs.p95} ms | first record p50/p95 ${row.firstRecordMs.p50}/${row.firstRecordMs.p95} ms | `
        + `tool round trips ${row.totals.toolRoundTrips} | effects ${row.totals.toolEffects} | protocol ${row.totals.recordBytes} B | `
        + `tokens in/out ${row.totals.inputTokens}/${row.totals.outputTokens} | storage ${row.totals.storageRows} rows ${row.totals.storageBytes} B | `
        + `rss delta p50/p95 ${Math.round(row.rssDeltaBytes.p50 / 1024)}/${Math.round(row.rssDeltaBytes.p95 / 1024)} KiB`
      );
      lines.push(`    ${JSON.stringify(row.facts)}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------------------
 * Offline suite
 * --------------------------------------------------------------------------------------------- */

describe('agent runtime benchmark (offline, scripted faux model)', () => {
  it('measures every registered runtime on the five use cases', async () => {
    const baseline = await measureRuntime(piCodingBaseline);
    const byId = (report: RuntimeReport) => Object.fromEntries(report.scenarios.map((row) => [row.scenario, row.facts]));

    const base = byId(baseline);
    expect(base['pr-review']).toMatchObject({ state: 'SUCCEEDED', toolEffects: 0 });
    expect(base['multi-step-task']).toMatchObject({ state: 'SUCCEEDED', toolEffects: 2 });
    // A completed worker refuses further input, and a fresh worker starts without the earlier transcript.
    expect(base['restart-followup']).toMatchObject({ firstState: 'SUCCEEDED', sameProcessFollowUpRefused: true, priorContextRetained: false, followUpOutcome: 'CONTEXT_LOST' });
    // A killed run never reports success, and replaying the task from the start repeats the applied write.
    expect(base['killed-run-with-effects']).toMatchObject({ killedState: 'INTERRUPTED', reportedSuccess: false, effectsAtKill: 1, restartOutcome: 'REPLAYED_FROM_START' });
    expect(Number(base['killed-run-with-effects']!.duplicateEffects)).toBeGreaterThan(0);
    // Every in-flight tool call of every agent is cancelled with the agent.
    expect(base['parent-child-cleanup']).toMatchObject({ agents: 3, cancelled: 3, toolCancelsEmitted: 3 });

    const persisted = await measureRuntime(piCodingPersisted);
    const kept = byId(persisted);
    expect(kept['pr-review']).toMatchObject({ state: 'SUCCEEDED', toolEffects: 0, leftoverSessionRows: 0, leftoverEffectRows: 0 });
    expect(kept['multi-step-task']).toMatchObject({ state: 'SUCCEEDED', toolEffects: 2, leftoverSessionRows: 0, leftoverEffectRows: 0 });
    // The follow-up is a new agent in a new container with a new lease, and its first model request
    // carries every message of the earlier transcript.
    expect(kept['restart-followup']).toMatchObject({
      firstState: 'SUCCEEDED', sameProcessFollowUpRefused: true, followUpContinued: true, priorContextRetained: true,
      allPriorMessagesInFirstRequest: true, followUpNewContainer: true, followUpNewLease: true,
      followUpState: 'SUCCEEDED', followUpOutcome: 'CONTINUED', leftoverSessionRows: 0
    });
    // Killed after the executor applied the in-flight patch and before its result returned: the run
    // is INTERRUPTED, the ledger records the patch as unknown, and the continuation repeats no
    // completed effect. Zero tolerance for an effect applied twice.
    expect(kept['killed-run-with-effects']).toMatchObject({
      killedState: 'INTERRUPTED', reportedSuccess: false, inFlightAtKill: 1, effectsUnknownAfterKill: 1,
      restartContinued: true, restartOutcome: 'CONTINUED', duplicateEffects: 0, leftoverSessionRows: 0, leftoverEffectRows: 0
    });
    expect(kept['parent-child-cleanup']).toMatchObject({ agents: 3, cancelled: 3, toolCancelsEmitted: 3, toolEffects: 0, leftoverSessionRows: 0, leftoverEffectRows: 0 });

    const runtimes = [baseline, persisted];
    if (PI_DURABLE_RUNTIME) runtimes.push(await measureRuntime(PI_DURABLE_RUNTIME));
    const report: AgentRuntimeBenchmarkReport = { schema: 1, mode: 'offline', timestamp: new Date().toISOString(), node: process.version, repetitions: REPETITIONS, runtimes };
    if (process.env.AGENT_RUNTIME_BENCHMARK_OUT && process.env.RUN_AGENT_RUNTIME_BENCHMARK !== 'live') {
      writeFileSync(process.env.AGENT_RUNTIME_BENCHMARK_OUT, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(summarize(report));
  }, 600_000);
});

/* ------------------------------------------------------------------------------------------------
 * Live suite (opt-in, local Compose stack over MCP)
 * --------------------------------------------------------------------------------------------- */

describe.skipIf(process.env.RUN_AGENT_RUNTIME_BENCHMARK !== 'live')('agent runtime live benchmark (local Compose stack)', () => {
  it('measures the live runtimes under the cumulative cost cap', async () => {
    const report = await runLiveBenchmark(process.env);
    console.log(JSON.stringify(report.summary, null, 2));
    expect(report.spentMicros).toBeLessThanOrEqual(report.costCapMicros);
  }, 4 * 60 * 60 * 1_000);
});
