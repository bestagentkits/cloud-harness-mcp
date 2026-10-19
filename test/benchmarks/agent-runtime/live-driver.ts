/**
 * Live agent runtime benchmark driver for a LOCAL Compose stack.
 *
 * It talks to the stack's loopback ingress over MCP with the owner bearer from the environment,
 * opens one disposable network-disabled workspace, seeds the benchmark fixture files, and runs
 * scenarios (a) `pr-review`, (c) `restart-followup` and (d) `killed-run-with-effects` for each
 * selected runtime and repetition with real agents on a real model profile. It reads launcher
 * timings, usage and cost from `agent_status`, events from `agent_logs`, and aggregate spend from
 * `model_spend_summary` (the runner's spend ledger), and refuses to spawn an agent whose cost cap
 * could take the cumulative spend of this run past the configured cap.
 *
 * Environment (validated before anything is called):
 * - RUN_AGENT_RUNTIME_BENCHMARK=live
 * - AGENT_RUNTIME_BENCHMARK_MCP_URL: loopback MCP endpoint, default http://127.0.0.1:3100/mcp
 * - AGENT_RUNTIME_BENCHMARK_MCP_BEARER_TOKEN, else MCP_BEARER_TOKEN: the local owner bearer (never printed)
 * - AGENT_RUNTIME_BENCHMARK_PROFILE_ID: an active model profile id (required)
 * - AGENT_RUNTIME_BENCHMARK_MAX_COST_USD: cumulative cap for this run, default 5
 * - AGENT_RUNTIME_BENCHMARK_AGENT_MAX_COST_USD: per-agent cost cap, default 0.25
 * - AGENT_RUNTIME_BENCHMARK_REPS: repetitions, default 3
 * - AGENT_RUNTIME_BENCHMARK_RUNTIMES: comma list, default "pi-coding,pi-coding+persisted"
 * - AGENT_RUNTIME_BENCHMARK_AGENT_TTL_SECONDS: per-agent TTL, default 300
 * - AGENT_RUNTIME_BENCHMARK_REPOSITORY_URL / _REF: repository for the disposable workspace
 * - AGENT_RUNTIME_BENCHMARK_OUT: path of the JSON report
 *
 * Scenario (d) kills the agent's container with `docker kill`, matched by the runner's
 * `cloud-harness.agent-container` and `cloud-harness.agent=<agentId>` labels and refused unless
 * exactly one container matches; it needs the Docker CLI of the host that runs the stack.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, type ScenarioSpec } from './harness.js';

const execFileAsync = promisify(execFile);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const AGENT_ID = /^agent_[A-Za-z0-9_-]{20,80}$/u;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MUTATIONS = new Set(['files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']);
const LIVE_SCENARIOS = ['pr-review', 'restart-followup', 'killed-run-with-effects'] as const;
type LiveScenarioId = typeof LIVE_SCENARIOS[number];
const MICROS_PER_USD = 1_000_000;
const POLL_MS = 1_000;

/**
 * How each runtime is selected on spawn. `pi-durable` is filled in when its spawn selector exists;
 * until then asking for it fails before anything is spawned.
 */
const LIVE_RUNTIMES: Record<string, { continues: boolean; spawnOptions: Record<string, unknown> } | undefined> = {
  'pi-coding': { continues: false, spawnOptions: {} },
  'pi-coding+persisted': { continues: true, spawnOptions: {} },
  'pi-durable': undefined
};

export interface LiveConfig {
  endpoint: URL;
  token: string;
  profileId: string;
  costCapMicros: number;
  agentCapMicros: number;
  repetitions: number;
  runtimes: string[];
  ttlSeconds: number;
  repositoryUrl: string;
  repositoryRef: string | undefined;
  out: string | undefined;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/** Validates the environment at the boundary; nothing is called before this passes. */
export function liveConfig(env: NodeJS.ProcessEnv): LiveConfig {
  if (env.RUN_AGENT_RUNTIME_BENCHMARK !== 'live') throw new Error('RUN_AGENT_RUNTIME_BENCHMARK=live is required');
  const endpoint = new URL(env.AGENT_RUNTIME_BENCHMARK_MCP_URL ?? 'http://127.0.0.1:3100/mcp');
  if (!['http:', 'https:'].includes(endpoint.protocol) || !LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Error('AGENT_RUNTIME_BENCHMARK_MCP_URL must be a loopback http(s) URL of a local Compose stack');
  }
  const token = env.AGENT_RUNTIME_BENCHMARK_MCP_BEARER_TOKEN ?? env.MCP_BEARER_TOKEN ?? '';
  if (token.length < 32) throw new Error('AGENT_RUNTIME_BENCHMARK_MCP_BEARER_TOKEN or MCP_BEARER_TOKEN must hold the local owner bearer');
  const profileId = env.AGENT_RUNTIME_BENCHMARK_PROFILE_ID ?? '';
  if (!PROFILE_ID.test(profileId)) throw new Error('AGENT_RUNTIME_BENCHMARK_PROFILE_ID must name an active model profile');
  const costCapMicros = Math.floor(positiveNumber(env, 'AGENT_RUNTIME_BENCHMARK_MAX_COST_USD', 5) * MICROS_PER_USD);
  const agentCapMicros = Math.floor(positiveNumber(env, 'AGENT_RUNTIME_BENCHMARK_AGENT_MAX_COST_USD', 0.25) * MICROS_PER_USD);
  if (agentCapMicros > costCapMicros) throw new Error('the per-agent cost cap cannot exceed the cumulative cap');
  const repetitions = Math.floor(positiveNumber(env, 'AGENT_RUNTIME_BENCHMARK_REPS', 3));
  const runtimes = (env.AGENT_RUNTIME_BENCHMARK_RUNTIMES ?? 'pi-coding,pi-coding+persisted').split(',').map((id) => id.trim()).filter(Boolean);
  for (const id of runtimes) {
    if (!(id in LIVE_RUNTIMES)) throw new Error(`unknown live runtime: ${id}`);
    if (!LIVE_RUNTIMES[id]) throw new Error(`live runtime ${id} has no spawn selector yet`);
  }
  if (runtimes.length === 0) throw new Error('AGENT_RUNTIME_BENCHMARK_RUNTIMES selects no runtime');
  const ttlSeconds = Math.floor(positiveNumber(env, 'AGENT_RUNTIME_BENCHMARK_AGENT_TTL_SECONDS', 300));
  if (ttlSeconds < 30) throw new Error('AGENT_RUNTIME_BENCHMARK_AGENT_TTL_SECONDS must be at least 30');
  const customRepository = env.AGENT_RUNTIME_BENCHMARK_REPOSITORY_URL;
  return {
    endpoint, token, profileId, costCapMicros, agentCapMicros, repetitions, runtimes, ttlSeconds,
    repositoryUrl: customRepository ?? 'https://github.com/bestagentkits/cloud-harness-mcp.git',
    repositoryRef: env.AGENT_RUNTIME_BENCHMARK_REPOSITORY_REF ?? (customRepository ? undefined : 'test-fixture-v1'),
    out: env.AGENT_RUNTIME_BENCHMARK_OUT || undefined
  };
}

/* ------------------------------------------------------------------------------------------------
 * MCP access
 * --------------------------------------------------------------------------------------------- */

class McpTools {
  readonly #client = new Client({ name: 'cloud-harness-agent-runtime-benchmark', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  async connect(config: LiveConfig): Promise<void> {
    await this.#client.connect(new StreamableHTTPClientTransport(config.endpoint, {
      requestInit: { headers: { authorization: `Bearer ${config.token}` } }
    }));
  }

  /** Calls one tool and returns its `data`, or throws with the tool's error code and message. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.#client.callTool({ name, arguments: args });
    const structured = result.structuredContent as { ok?: unknown; data?: unknown; message?: unknown; error?: { code?: unknown } } | undefined;
    if (result.isError || structured?.ok !== true) {
      throw new Error(`${name} failed: ${String(structured?.error?.code ?? 'ERROR')} ${String(structured?.message ?? '')}`.trim());
    }
    return structured.data as T;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

type AgentStatus = {
  agentId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  terminalAt: string | null;
  terminalReason: string | null;
  outcomeUnknown: boolean;
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  session?: { persisted: boolean; continuable: boolean; messages: number; bytes: number };
  continuedFrom?: string | null;
};
type LogEvent = { timestamp: string; type: string; content: string };
type SpendWindow = { scope: string; period: string; estimatedSettledMicros: number; estimatedReservedMicros: number; estimatedUnreconciledMicros: number };

/* ------------------------------------------------------------------------------------------------
 * Measurements
 * --------------------------------------------------------------------------------------------- */

export interface LiveAgentSample {
  agentId: string;
  role: 'task' | 'follow-up' | 'killed' | 'restart';
  status: string;
  terminalReason: string | null;
  /** createdAt to startedAt: admission, lease and the real launcher until the container runs. */
  coldStartMs: number | null;
  /** createdAt to terminalAt. */
  wallMs: number | null;
  /** createdAt to the agent's first log event. */
  firstEventMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  sessionMessages: number | null;
  sessionBytes: number | null;
  continuedFrom: string | null;
  /** Successful mutating tool calls the agent's events report, by tool name. */
  mutations: Record<string, number>;
}

export interface LiveRun {
  runtime: string;
  scenario: LiveScenarioId;
  repetition: number;
  agents: LiveAgentSample[];
  /** The task, or for (c) and (d) the follow-up or restart, ended SUCCEEDED. */
  succeeded: boolean;
  /** (c) the follow-up continued the earlier session; (d) the killed run ended INTERRUPTED, never success. */
  facts: Record<string, string | number | boolean | null>;
}

export interface LiveSummaryRow {
  runtime: string;
  scenario: LiveScenarioId;
  runs: number;
  successRate: number;
  recoveryRate: number | null;
  coldStartMs: { p50: number | null; p95: number | null };
  wallMs: { p50: number | null; p95: number | null };
  firstEventMs: { p50: number | null; p95: number | null };
  inputTokensMedian: number | null;
  outputTokensMedian: number | null;
  sessionBytesMedian: number | null;
  repeatedMutations: number;
  costMicros: number;
  costPerSuccessUsd: number | null;
}

export interface LiveBenchmarkReport {
  schema: 1;
  mode: 'live';
  timestamp: string;
  node: string;
  endpoint: string;
  profileId: string;
  repetitions: number;
  costCapMicros: number;
  agentCapMicros: number;
  /** Spend ledger delta (settled, reserved and unreconciled) from the start of this run. */
  spentMicros: number;
  /** Why the matrix stopped early, or null when it completed. */
  aborted: string | null;
  runs: LiveRun[];
  summary: LiveSummaryRow[];
}

const elapsed = (from: string, to: string | null | undefined) => (to ? Date.parse(to) - Date.parse(from) : null);

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

function parseEvent(event: LogEvent): { kind?: string; phase?: string; name?: string; isError?: boolean } | undefined {
  if (event.type !== 'event') return undefined;
  try {
    return JSON.parse(event.content) as { kind?: string; phase?: string; name?: string; isError?: boolean };
  } catch {
    return undefined;
  }
}

class CostCapExceeded extends Error {}

/* ------------------------------------------------------------------------------------------------
 * Driver
 * --------------------------------------------------------------------------------------------- */

class LiveDriver {
  readonly #tools = new McpTools();
  #workspaceId: string | undefined;
  #spendBaseline = 0;
  spentMicros = 0;
  readonly #spawned = new Set<string>();

  constructor(readonly config: LiveConfig) {}

  async open(): Promise<void> {
    await this.#tools.connect(this.config);
    this.#spendBaseline = await this.#spendTotal();
    const opened = await this.#tools.call<{ workspaceId: string }>('workspace_open', {
      repositoryUrl: this.config.repositoryUrl,
      ...(this.config.repositoryRef ? { ref: this.config.repositoryRef } : {}),
      idempotencyKey: `agent-runtime-bench-${randomUUID()}`,
      networkProfile: 'network-none'
    });
    this.#workspaceId = opened.workspaceId;
  }

  async close(): Promise<void> {
    const workspaceId = this.#workspaceId;
    try {
      if (workspaceId) {
        for (const agentId of this.#spawned) {
          await this.#tools.call('agent_cancel', { workspaceId, agentId, reason: 'benchmark finished' }).catch(() => undefined);
        }
        await this.#tools.call('workspace_close', { workspaceId });
        this.#workspaceId = undefined;
      }
    } finally {
      await this.#tools.close().catch(() => undefined);
    }
  }

  get workspaceId(): string {
    if (!this.#workspaceId) throw new Error('benchmark workspace is not open');
    return this.#workspaceId;
  }

  /** Principal-wide month spend from the runner's spend ledger: settled, reserved and unreconciled. */
  async #spendTotal(): Promise<number> {
    const data = await this.#tools.call<{ summary: { windows: SpendWindow[] } }>('model_spend_summary', { period: 'month' });
    const window = data.summary.windows.find((candidate) => candidate.scope === 'principal' && candidate.period === 'month');
    if (!window) throw new Error('model_spend_summary returned no principal month window');
    return window.estimatedSettledMicros + window.estimatedReservedMicros + window.estimatedUnreconciledMicros;
  }

  async refreshSpend(): Promise<void> {
    this.spentMicros = Math.max(0, (await this.#spendTotal()) - this.#spendBaseline);
  }

  /** Resets the fixture files so every run starts from the same workspace content. */
  async seed(): Promise<void> {
    const workspaceId = this.workspaceId;
    await this.#tools.call('files_delete', { workspaceId, path: 'CHANGELOG.md' }).catch(() => undefined);
    for (const [path, content] of Object.entries(fixture.workspace)) {
      await this.#tools.call('files_write', { workspaceId, path, content });
    }
  }

  /** Spawns one agent unless its cost cap could take this run past the cumulative cap. */
  async spawn(runtimeId: string, prompt: string, tools: string[], continueFrom?: string): Promise<string> {
    await this.refreshSpend();
    if (this.spentMicros + this.config.agentCapMicros > this.config.costCapMicros) {
      throw new CostCapExceeded(`spawning another agent could exceed the cost cap (spent ${this.spentMicros} of ${this.config.costCapMicros} micro-USD)`);
    }
    const runtime = LIVE_RUNTIMES[runtimeId]!;
    const spawned = await this.#tools.call<{ agentId: string }>('agent_spawn', {
      workspaceId: this.workspaceId,
      prompt,
      idempotencyKey: `agent-runtime-bench-${randomUUID()}`,
      ...(continueFrom ? { continueFrom } : { profileId: this.config.profileId }),
      proxyOperations: tools,
      ttlSeconds: this.config.ttlSeconds,
      maxCostMicros: this.config.agentCapMicros,
      repositoryContext: 'none',
      ...runtime.spawnOptions
    });
    if (!AGENT_ID.test(spawned.agentId)) throw new Error('agent_spawn returned an invalid agent id');
    this.#spawned.add(spawned.agentId);
    return spawned.agentId;
  }

  async status(agentId: string): Promise<AgentStatus> {
    return await this.#tools.call<AgentStatus>('agent_status', { workspaceId: this.workspaceId, agentId });
  }

  async logs(agentId: string): Promise<LogEvent[]> {
    const events: LogEvent[] = [];
    let cursor = '0';
    for (let page = 0; page < 200; page += 1) {
      const data = await this.#tools.call<{ events: LogEvent[]; nextCursor: string; hasMore?: boolean }>('agent_logs', { workspaceId: this.workspaceId, agentId, cursor, limitBytes: 262_144 });
      events.push(...data.events);
      if (data.events.length === 0 || data.nextCursor === cursor || data.hasMore === false) break;
      cursor = data.nextCursor;
    }
    return events;
  }

  /** Polls until the agent is terminal; `onPoll` may act on the agent while it runs. */
  async untilTerminal(agentId: string, onPoll?: () => Promise<boolean>): Promise<AgentStatus> {
    const deadline = Date.now() + (this.config.ttlSeconds + 120) * 1_000;
    let acted = false;
    for (;;) {
      const status = await this.status(agentId);
      if (TERMINAL.has(status.status)) {
        this.#spawned.delete(agentId);
        await this.refreshSpend();
        return status;
      }
      if (Date.now() > deadline) throw new Error(`agent ${agentId} did not reach a terminal status`);
      if (onPoll && !acted) acted = await onPoll();
      await new Promise((resolve) => setTimeout(resolve, acted ? POLL_MS : POLL_MS / 4));
    }
  }

  async sample(agentId: string, role: LiveAgentSample['role'], status: AgentStatus): Promise<LiveAgentSample> {
    const events = await this.logs(agentId);
    const mutations: Record<string, number> = {};
    for (const event of events) {
      const parsed = parseEvent(event);
      if (parsed?.kind === 'tool' && parsed.phase === 'ended' && parsed.isError === false && parsed.name && MUTATIONS.has(parsed.name)) {
        mutations[parsed.name] = (mutations[parsed.name] ?? 0) + 1;
      }
    }
    return {
      agentId, role, status: status.status, terminalReason: status.terminalReason,
      coldStartMs: elapsed(status.createdAt, status.startedAt),
      wallMs: elapsed(status.createdAt, status.terminalAt),
      firstEventMs: elapsed(status.createdAt, events[0]?.timestamp),
      inputTokens: status.usage.inputTokens, outputTokens: status.usage.outputTokens, costMicros: status.usage.costMicros,
      sessionMessages: status.session?.messages ?? null, sessionBytes: status.session?.bytes ?? null,
      continuedFrom: status.continuedFrom ?? null,
      mutations
    };
  }

  /** Kills the agent's container once its events show a completed mutation; true once killed. */
  async killAfterFirstMutation(agentId: string): Promise<boolean> {
    const applied = (await this.logs(agentId)).some((event) => {
      const parsed = parseEvent(event);
      return parsed?.kind === 'tool' && parsed.phase === 'ended' && parsed.isError === false && parsed.name !== undefined && MUTATIONS.has(parsed.name);
    });
    if (!applied) return false;
    const { stdout } = await execFileAsync('docker', ['ps', '-q', '--filter', 'label=cloud-harness.agent-container=true', '--filter', `label=cloud-harness.agent=${agentId}`], { timeout: 15_000 });
    const containers = stdout.split(/\s+/u).filter(Boolean);
    if (containers.length !== 1) throw new Error(`expected exactly one container for ${agentId}, found ${containers.length}`);
    await execFileAsync('docker', ['kill', containers[0]!], { timeout: 15_000 });
    return true;
  }
}

function scenarioSpec(id: LiveScenarioId): ScenarioSpec {
  const spec = fixture.scenarios[id];
  if (!spec) throw new Error(`missing scenario fixture: ${id}`);
  return spec;
}

async function runScenario(driver: LiveDriver, runtimeId: string, scenario: LiveScenarioId, repetition: number): Promise<LiveRun> {
  const spec = scenarioSpec(scenario);
  const continues = LIVE_RUNTIMES[runtimeId]!.continues;
  await driver.seed();
  if (scenario === 'pr-review') {
    const agentId = await driver.spawn(runtimeId, spec.prompt, spec.tools);
    const task = await driver.sample(agentId, 'task', await driver.untilTerminal(agentId));
    return { runtime: runtimeId, scenario, repetition, agents: [task], succeeded: task.status === 'SUCCEEDED', facts: { state: task.status } };
  }
  if (scenario === 'restart-followup') {
    const firstId = await driver.spawn(runtimeId, spec.prompt, spec.tools);
    const first = await driver.sample(firstId, 'task', await driver.untilTerminal(firstId));
    const followId = await driver.spawn(runtimeId, spec.followUpPrompt!, spec.tools, continues ? firstId : undefined);
    const follow = await driver.sample(followId, 'follow-up', await driver.untilTerminal(followId));
    return {
      runtime: runtimeId, scenario, repetition, agents: [first, follow], succeeded: follow.status === 'SUCCEEDED',
      facts: { firstState: first.status, followUpState: follow.status, followUpContinued: follow.continuedFrom === firstId }
    };
  }
  const killedId = await driver.spawn(runtimeId, spec.prompt, spec.tools);
  let killedAt: number | null = null;
  const killedStatus = await driver.untilTerminal(killedId, async () => {
    const done = await driver.killAfterFirstMutation(killedId);
    if (done) killedAt = Date.now();
    return done;
  });
  const killed = await driver.sample(killedId, 'killed', killedStatus);
  const restartId = await driver.spawn(runtimeId, spec.prompt, spec.tools, continues ? killedId : undefined);
  const restart = await driver.sample(restartId, 'restart', await driver.untilTerminal(restartId));
  const repeated = Object.entries(restart.mutations).reduce((total, [name, count]) => total + Math.min(count, killed.mutations[name] ?? 0), 0);
  return {
    runtime: runtimeId, scenario, repetition, agents: [killed, restart], succeeded: restart.status === 'SUCCEEDED',
    facts: {
      killDelivered: killedAt !== null,
      killedState: killed.status,
      reportedSuccess: killed.status === 'SUCCEEDED',
      restartState: restart.status,
      restartContinued: restart.continuedFrom === killedId,
      // Mutating tools the killed run completed that the restart completed again (observational).
      repeatedMutations: repeated
    }
  };
}

function summarize(runs: LiveRun[]): LiveSummaryRow[] {
  const groups = new Map<string, LiveRun[]>();
  for (const run of runs) {
    const key = `${run.runtime}\u0000${run.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) => {
    const agents = group.flatMap((run) => run.agents);
    const numbers = (pick: (agent: LiveAgentSample) => number | null) => agents.map(pick).filter((value): value is number => value !== null);
    const spread = (pick: (agent: LiveAgentSample) => number | null) => ({ p50: percentile(numbers(pick), 0.5), p95: percentile(numbers(pick), 0.95) });
    const successes = group.filter((run) => run.succeeded).length;
    const costMicros = agents.reduce((total, agent) => total + agent.costMicros, 0);
    const recovered = group[0]!.scenario === 'pr-review' ? null : group.filter((run) => run.succeeded
      && (run.scenario !== 'killed-run-with-effects' || run.facts.reportedSuccess === false)).length / group.length;
    return {
      runtime: group[0]!.runtime,
      scenario: group[0]!.scenario,
      runs: group.length,
      successRate: successes / group.length,
      recoveryRate: recovered,
      coldStartMs: spread((agent) => agent.coldStartMs),
      wallMs: spread((agent) => agent.wallMs),
      firstEventMs: spread((agent) => agent.firstEventMs),
      inputTokensMedian: percentile(numbers((agent) => agent.inputTokens), 0.5),
      outputTokensMedian: percentile(numbers((agent) => agent.outputTokens), 0.5),
      sessionBytesMedian: percentile(numbers((agent) => agent.sessionBytes), 0.5),
      repeatedMutations: group.reduce((total, run) => total + Number(run.facts.repeatedMutations ?? 0), 0),
      costMicros,
      costPerSuccessUsd: successes === 0 ? null : costMicros / successes / MICROS_PER_USD
    };
  });
}

/** Runs the live matrix against a local stack and writes the JSON report when an output path is set. */
export async function runLiveBenchmark(env: NodeJS.ProcessEnv): Promise<LiveBenchmarkReport> {
  const config = liveConfig(env);
  const driver = new LiveDriver(config);
  const runs: LiveRun[] = [];
  let aborted: string | null = null;
  try {
    await driver.open();
    matrix: for (const runtime of config.runtimes) {
      for (const scenario of LIVE_SCENARIOS) {
        for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
          try {
            runs.push(await runScenario(driver, runtime, scenario, repetition));
          } catch (error) {
            if (error instanceof CostCapExceeded) {
              aborted = error.message;
              break matrix;
            }
            throw error;
          }
        }
      }
    }
  } finally {
    await driver.refreshSpend().catch(() => undefined);
    await driver.close();
  }
  const report: LiveBenchmarkReport = {
    schema: 1, mode: 'live', timestamp: new Date().toISOString(), node: process.version,
    endpoint: config.endpoint.origin + config.endpoint.pathname, profileId: config.profileId, repetitions: config.repetitions,
    costCapMicros: config.costCapMicros, agentCapMicros: config.agentCapMicros, spentMicros: driver.spentMicros,
    aborted, runs, summary: summarize(runs)
  };
  if (config.out) writeFileSync(config.out, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
