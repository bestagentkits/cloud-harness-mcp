import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTracesListInputSchema, AgentTracesListResultSchema, AgentTraceSpansResultSchema, HarnessError, TraceDetailSchema } from '@cloud-harness/contracts';
import { initializeAgentTraceSchema } from '../src/agent-trace-schema.js';
import { AgentTraceStore, executeAgentTraceOperation, percentile, spanIdFor, traceIdFor } from '../src/agent-trace-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const DAY = 86_400_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { retentionDays?: number; maxTracesPerPrincipal?: number; log?: (entry: Record<string, unknown>) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-trace-store-'));
  const state = new StateStore(join(directory, 'state.db'));
  cleanups.push(() => {
    try { state.close(); } catch { /* closed */ }
    rmSync(directory, { recursive: true, force: true });
  });
  const traces = new AgentTraceStore(state.database, {
    retentionDays: options.retentionDays ?? 14,
    maxTracesPerPrincipal: options.maxTracesPerPrincipal ?? 5_000,
    log: options.log
  });
  return { state, traces };
}

let agentCounter = 0;
function agentId(): string {
  agentCounter += 1;
  return `agent_${String(agentCounter).padStart(24, '0')}`;
}

const workspaceId = `ws_${'w'.repeat(24)}`;

function addTrace(traces: AgentTraceStore, input: {
  principalId?: string; startedAt: number; endedAt?: number | null; profileId?: string; workspace?: string;
  modelCalls?: Array<{ durationMs: number | null; ttftMs: number | null }>; state?: 'COMPLETED' | 'FAILED' | 'RUNNING';
  costMicros?: number | null;
}): string {
  const id = agentId();
  const traceId = traceIdFor(id, 1);
  traces.createTrace({
    traceId, principalId: input.principalId ?? 'principal-a', workspaceId: input.workspace ?? workspaceId, agentId: id, generation: 1,
    runId: null, parentTraceId: null, workflowId: null, profileId: input.profileId ?? 'default', profileRevisionId: null,
    startedAt: input.startedAt
  });
  let seq = 1;
  for (const call of input.modelCalls ?? []) {
    traces.writeSpan({
      traceId, spanSeq: seq, spanId: spanIdFor(traceId, seq), parentSpanId: spanIdFor(traceId, 0), kind: 'model_call', name: 'model.call',
      state: call.durationMs === null ? 'UNKNOWN' : 'OK', startedAt: input.startedAt + 10,
      endedAt: call.durationMs === null ? null : input.startedAt + 10 + call.durationMs, ttftMs: call.ttftMs,
      promptTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 3,
      attributes: {}, inputDigest: null, errorClass: null
    });
    seq += 1;
  }
  if ((input.state ?? 'COMPLETED') !== 'RUNNING') {
    const endedAt = input.endedAt ?? input.startedAt + 1_000;
    traces.updateTrace(traceId, {
      state: input.state ?? 'COMPLETED', finishReason: 'completed', endedAt: endedAt ?? undefined,
      promptTokens: 10, outputTokens: 5,
      ...(input.costMicros === null ? { costMicros: null, costProvenance: 'unknown' as const } : { costMicros: input.costMicros ?? 3, costProvenance: 'estimated' as const }),
      expiresAt: traces.retentionDeadline(endedAt ?? input.startedAt)
    });
  }
  return traceId;
}

function list(traces: AgentTraceStore, principalId: string, input: Record<string, unknown>, now = Date.now()) {
  return traces.list(principalId, AgentTracesListInputSchema.parse(input), now);
}

function harnessCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof HarnessError) return error.code;
    throw error;
  }
  return undefined;
}

describe('agent trace schema', () => {
  it('is idempotent, has the documented indexes and no foreign keys', () => {
    const { state } = setup();
    initializeAgentTraceSchema(state.database);
    initializeAgentTraceSchema(state.database);
    const indexes = (state.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('agent_traces', 'agent_trace_spans')").all() as { name: string }[])
      .map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'agent_traces_principal_started_trace', 'agent_traces_principal_profile', 'agent_traces_agent', 'agent_traces_workflow',
      'agent_traces_expires', 'agent_trace_spans_kind'
    ]));
    // The list's keyset index covers the full (started_at, trace_id) cursor; the older index is gone.
    expect(indexes).not.toContain('agent_traces_principal_started');
    const columns = (state.database.prepare("PRAGMA index_info('agent_traces_principal_started_trace')").all() as { name: string }[]).map((row) => row.name);
    expect(columns).toEqual(['principal_id', 'started_at', 'trace_id']);
    expect(state.database.prepare('PRAGMA foreign_key_list(agent_traces)').all()).toEqual([]);
    expect(state.database.prepare('PRAGMA foreign_key_list(agent_trace_spans)').all()).toEqual([]);
  });

  it('keeps traces readable after their workspace row is deleted with foreign keys enforced', () => {
    const { state, traces } = setup();
    const ownerId = state.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: workspaceId, ownerId, idempotencyKey: 'workspace-key', repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
      containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
      gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
    };
    state.create(workspace);
    const traceId = addTrace(traces, { principalId: ownerId, startedAt: now - 5_000, modelCalls: [{ durationMs: 100, ttftMs: 20 }] });
    state.database.exec('PRAGMA foreign_keys = ON');
    state.database.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    expect(state.byId(workspaceId)).toBeUndefined();
    const read = traces.get(ownerId, traceId, now);
    expect(TraceDetailSchema.parse(read.trace).traceId).toBe(traceId);
    expect(traces.spans(ownerId, { traceId, limit: 10 }, now).spans).toHaveLength(1);
  });

  it('derives deterministic, contract-shaped trace and span identifiers', () => {
    const id = agentId();
    expect(traceIdFor(id, 1)).toBe(traceIdFor(id, 1));
    expect(traceIdFor(id, 1)).not.toBe(traceIdFor(id, 2));
    expect(traceIdFor(id, 1)).toMatch(/^trc_[a-z2-7]{26}$/u);
    expect(spanIdFor(traceIdFor(id, 1), 3)).toMatch(/^spn_[a-z2-7]{16}$/u);
  });
});

describe('agent trace listing', () => {
  it('pages newest first with stable cursors while new traces arrive', () => {
    const { traces } = setup();
    const base = Date.now() - 60_000;
    const ids = [0, 1, 2, 3, 4].map((offset) => addTrace(traces, { startedAt: base + offset * 1_000 }));
    const first = list(traces, 'principal-a', { limit: 2 });
    expect(AgentTracesListResultSchema.parse(first).traces.map((trace) => trace.traceId)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).not.toBeNull();
    // A concurrent writer adds a newer trace; the cursor continues where it left off.
    addTrace(traces, { startedAt: base + 30_000 });
    const second = list(traces, 'principal-a', { limit: 2, cursor: first.nextCursor });
    expect(second.traces.map((trace) => trace.traceId)).toEqual([ids[2], ids[1]]);
    const third = list(traces, 'principal-a', { limit: 2, cursor: second.nextCursor });
    expect(third.traces.map((trace) => trace.traceId)).toEqual([ids[0]]);
    expect(third.nextCursor).toBeNull();
    // Two readers paging the same listing at once do not disturb each other.
    const parallel = list(traces, 'principal-a', { limit: 2, cursor: first.nextCursor });
    expect(parallel.traces.map((trace) => trace.traceId)).toEqual([ids[2], ids[1]]);
  });

  it('binds cursors to the caller and the filter set', () => {
    const { traces } = setup();
    const base = Date.now() - 60_000;
    for (let index = 0; index < 3; index += 1) addTrace(traces, { startedAt: base + index });
    const page = list(traces, 'principal-a', { limit: 1 });
    expect(harnessCode(() => list(traces, 'principal-b', { limit: 1, cursor: page.nextCursor }))).toBe('INVALID_INPUT');
    expect(harnessCode(() => list(traces, 'principal-a', { limit: 1, state: 'FAILED', cursor: page.nextCursor }))).toBe('INVALID_INPUT');
    expect(harnessCode(() => list(traces, 'principal-a', { limit: 1, cursor: 'tc1.bm90LWpzb24tYXQtYWxs' }))).toBe('INVALID_INPUT');
  });

  it('filters by workspace, agent, profile, state and time window and never crosses principals', () => {
    const { traces } = setup();
    const base = Date.now() - 60_000;
    const mine = addTrace(traces, { startedAt: base, profileId: 'fast' });
    addTrace(traces, { startedAt: base + 1, profileId: 'slow', state: 'FAILED' });
    const theirs = addTrace(traces, { principalId: 'principal-b', startedAt: base + 2 });
    expect(list(traces, 'principal-a', { profileId: 'fast' }).traces.map((trace) => trace.traceId)).toEqual([mine]);
    expect(list(traces, 'principal-a', { state: 'FAILED' }).traces).toHaveLength(1);
    expect(list(traces, 'principal-a', { since: new Date(base + 1).toISOString() }).traces).toHaveLength(1);
    expect(list(traces, 'principal-a', { until: new Date(base + 1).toISOString() }).traces.map((trace) => trace.traceId)).toEqual([mine]);
    expect(list(traces, 'principal-a', {}).traces.map((trace) => trace.traceId)).not.toContain(theirs);
    expect(harnessCode(() => traces.get('principal-a', theirs, Date.now()))).toBe('NOT_FOUND');
    expect(harnessCode(() => traces.spans('principal-a', { traceId: theirs, limit: 10 }, Date.now()))).toBe('NOT_FOUND');
  });
});

describe('agent trace retention and quota', () => {
  it('purges finished traces past retention and reports cursors into them as TRACE_EXPIRED', async () => {
    const { traces } = setup({ retentionDays: 1 });
    const now = Date.now();
    const old = addTrace(traces, { startedAt: now - 3 * DAY, endedAt: now - 3 * DAY + 1_000 });
    const older = addTrace(traces, { startedAt: now - 3 * DAY - 10, endedAt: now - 3 * DAY });
    const fresh = addTrace(traces, { startedAt: now - 1_000 });
    const running = addTrace(traces, { startedAt: now - 3 * DAY + 5, state: 'RUNNING' });
    // Read at a time before expiry to obtain a cursor anchored on the old trace.
    const before = now - 3 * DAY + 2_000;
    const page = list(traces, 'principal-a', { limit: 1, until: new Date(now - 2 * DAY).toISOString() }, before);
    expect(page.traces[0]?.traceId).toBe(running);
    const page2 = list(traces, 'principal-a', { limit: 1, until: new Date(now - 2 * DAY).toISOString(), cursor: page.nextCursor }, before);
    expect(page2.traces[0]?.traceId).toBe(old);
    const spanPage = traces.spans('principal-a', { traceId: old, limit: 1 }, before);
    expect(spanPage.nextCursor).toBeNull();

    // Expired but not yet purged: reads already report expiry.
    expect(harnessCode(() => traces.get('principal-a', old, now))).toBe('TRACE_EXPIRED');
    expect(await traces.purgeExpired(now)).toBe(2);
    expect(traces.findTrace(old)).toBeUndefined();
    expect(traces.findTrace(older)).toBeUndefined();
    expect(traces.findTrace(fresh)).toBeDefined();
    // A running trace is never purged on retention alone.
    expect(traces.findTrace(running)).toBeDefined();
    expect(harnessCode(() => list(traces, 'principal-a', { limit: 1, until: new Date(now - 2 * DAY).toISOString(), cursor: page2.nextCursor }, now)))
      .toBe('TRACE_EXPIRED');
    expect(harnessCode(() => traces.get('principal-a', old, now))).toBe('NOT_FOUND');
  });

  it('reports a span cursor whose trace was purged as TRACE_EXPIRED', async () => {
    const { traces } = setup({ retentionDays: 1 });
    const now = Date.now();
    const traceId = addTrace(traces, {
      startedAt: now - 3 * DAY, endedAt: now - 3 * DAY + 1_000,
      modelCalls: [{ durationMs: 10, ttftMs: 1 }, { durationMs: 10, ttftMs: 1 }, { durationMs: 10, ttftMs: 1 }]
    });
    const page = traces.spans('principal-a', { traceId, limit: 1 }, now - 3 * DAY + 2_000);
    expect(AgentTraceSpansResultSchema.parse(page).nextCursor).not.toBeNull();
    await traces.purgeExpired(now);
    expect(harnessCode(() => traces.spans('principal-a', { traceId, limit: 1, cursor: page.nextCursor ?? undefined }, now))).toBe('TRACE_EXPIRED');
  });

  it('purges in bounded batches and yields to the event loop between them', async () => {
    const { state, traces } = setup({ retentionDays: 1 });
    const now = Date.now();
    const expired = Array.from({ length: 7 }, (_, index) => addTrace(traces, {
      startedAt: now - 3 * DAY + index, endedAt: now - 3 * DAY + index + 1, modelCalls: [{ durationMs: 5, ttftMs: 1 }]
    }));
    const fresh = addTrace(traces, { startedAt: now - 1_000 });
    const batches: number[] = [];
    const run = state.database.prepare.bind(state.database);
    const yieldBetween = vi.fn(async () => {
      batches.push((run('SELECT COUNT(*) AS count FROM agent_traces').get() as { count: number }).count);
    });
    expect(await traces.purgeExpired(now, { batchSize: 3, yieldBetween })).toBe(7);
    // Batches of 3, 3 and 1: a yield after each full batch, none after the last.
    expect(yieldBetween).toHaveBeenCalledTimes(2);
    expect(batches).toEqual([5, 2]);
    for (const traceId of expired) expect(traces.findTrace(traceId)).toBeUndefined();
    expect(traces.findTrace(fresh)).toBeDefined();
    expect(state.database.prepare('SELECT COUNT(*) AS count FROM agent_trace_spans WHERE trace_id <> ?').get(fresh)).toEqual({ count: 0 });
  });

  it('stops a purge between batches once aborted', async () => {
    const { traces } = setup({ retentionDays: 1 });
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) addTrace(traces, { startedAt: now - 3 * DAY + index, endedAt: now - 3 * DAY + index + 1 });
    const already = new AbortController();
    already.abort();
    expect(await traces.purgeExpired(now, { signal: already.signal })).toBe(0);
    const controller = new AbortController();
    expect(await traces.purgeExpired(now, { batchSize: 2, signal: controller.signal, yieldBetween: async () => { controller.abort(); } })).toBe(2);
    expect(await traces.purgeExpired(now)).toBe(3);
  });

  it('evicts an excess larger than one batch in bounded batches after the cap is lowered', () => {
    const { state, traces } = setup({ maxTracesPerPrincipal: 5_000 });
    const base = Date.now() - 600_000;
    // One outer transaction keeps the seeding fast; the eviction below runs outside it.
    state.database.exec('BEGIN');
    for (let index = 0; index < 1_210; index += 1) addTrace(traces, { startedAt: base + index });
    state.database.exec('COMMIT');
    const lowered = new AgentTraceStore(state.database, { retentionDays: 14, maxTracesPerPrincipal: 10 });
    const deletes = vi.spyOn(lowered as unknown as { deleteTraces: (ids: readonly string[]) => void }, 'deleteTraces');
    const fresh = addTrace(lowered, { startedAt: base + 5_000 });
    // 1,210 + 1 against a cap of 10: 1,201 victims, at most 500 per statement.
    expect(deletes.mock.calls.map(([ids]) => ids.length)).toEqual([500, 500, 201]);
    expect(state.database.prepare("SELECT COUNT(*) AS count FROM agent_traces WHERE principal_id = 'principal-a'").get()).toEqual({ count: 10 });
    expect(lowered.findTrace(fresh)).toBeDefined();
  });

  it('enforces the quota only when a trace row is actually inserted', () => {
    const { traces } = setup({ maxTracesPerPrincipal: 10 });
    const base = Date.now() - 60_000;
    const ids = Array.from({ length: 10 }, (_, index) => addTrace(traces, { startedAt: base + index }));
    const quota = vi.spyOn(traces, 'enforceQuota');
    const existing = traces.findTrace(ids[9]!)!;
    // A replayed begin of an existing trace inserts nothing and evicts nothing.
    expect(traces.createTrace({
      traceId: ids[9]!, principalId: 'principal-a', workspaceId, agentId: existing.agentId, generation: 1,
      runId: null, parentTraceId: null, workflowId: null, profileId: 'default', profileRevisionId: null, startedAt: base + 9
    })).toBe(false);
    expect(quota).not.toHaveBeenCalled();
    expect(traces.findTrace(ids[0]!)).toBeDefined();
  });

  it('keeps a principal under its trace quota by evicting its oldest finished traces only', () => {
    const { traces } = setup({ maxTracesPerPrincipal: 10 });
    const base = Date.now() - 60_000;
    const ids = Array.from({ length: 10 }, (_, index) => addTrace(traces, { startedAt: base + index }));
    const other = addTrace(traces, { principalId: 'principal-b', startedAt: base - 10 });
    const newest = addTrace(traces, { startedAt: base + 100 });
    expect(traces.findTrace(ids[0]!)).toBeUndefined();
    expect(traces.findTrace(ids[1]!)).toBeDefined();
    expect(traces.findTrace(newest)).toBeDefined();
    expect(traces.findTrace(other)).toBeDefined();
    expect(list(traces, 'principal-a', { limit: 100 }).traces).toHaveLength(10);
  });
});

describe('agent trace aggregates', () => {
  it('reports p50/p95 and TTFT only over spans with both timestamps', () => {
    const { traces } = setup();
    const base = Date.now() - 60_000;
    addTrace(traces, { startedAt: base, modelCalls: [{ durationMs: 100, ttftMs: 10 }, { durationMs: 200, ttftMs: null }, { durationMs: null, ttftMs: null }] });
    addTrace(traces, { startedAt: base + 1, modelCalls: [{ durationMs: 300, ttftMs: 30 }] });
    const summary = list(traces, 'principal-a', {}).summary!;
    expect(summary.modelLatency).toEqual({ samples: 3, p50Ms: 200, p95Ms: 300 });
    expect(summary.ttft).toEqual({ samples: 2, p50Ms: 10, p95Ms: 30 });
    expect(summary.traces).toBe(2);
    expect(summary.tokens.prompt).toBe(20);
    expect(summary.costMicros).toBe(6);

    // A window in which no trace has a known cost reports null, not $0.
    const unknownCost = setup().traces;
    addTrace(unknownCost, { startedAt: base, costMicros: null });
    expect(list(unknownCost, 'principal-a', {}).summary).toMatchObject({ costMicros: null, unknownCostTraces: 1 });

    const empty = setup().traces;
    addTrace(empty, { startedAt: base, modelCalls: [{ durationMs: null, ttftMs: null }] });
    const emptySummary = list(empty, 'principal-a', {}).summary!;
    expect(emptySummary.modelLatency).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
    expect(emptySummary.ttft).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
  });

  it('reports per-profile cohorts only from 20 traces, otherwise insufficient_sample', () => {
    const { traces } = setup();
    const base = Date.now() - 600_000;
    for (let index = 0; index < 20; index += 1) {
      addTrace(traces, { startedAt: base + index, profileId: 'big', modelCalls: [{ durationMs: (index + 1) * 10, ttftMs: index + 1 }] });
    }
    for (let index = 0; index < 3; index += 1) addTrace(traces, { startedAt: base + 100 + index, profileId: 'small', modelCalls: [{ durationMs: 5, ttftMs: 1 }] });
    const summary = list(traces, 'principal-a', {}).summary!;
    const big = summary.cohorts.find((cohort) => cohort.profileId === 'big');
    const small = summary.cohorts.find((cohort) => cohort.profileId === 'small');
    expect(big).toMatchObject({ traces: 20, status: 'ok', modelLatency: { samples: 20, p50Ms: 100, p95Ms: 190 } });
    expect(small).toEqual({ profileId: 'small', traces: 3, status: 'insufficient_sample', modelLatency: null, ttft: null });
  });

  it('uses the nearest-rank percentile', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });
});

describe('agent trace list summary', () => {
  it('computes the summary only for a first page that asks for it', () => {
    const { traces } = setup();
    const base = Date.now() - 60_000;
    for (let index = 0; index < 3; index += 1) addTrace(traces, { startedAt: base + index });
    const first = list(traces, 'principal-a', { limit: 1 });
    expect(first.summary).toMatchObject({ traces: 3 });
    expect(list(traces, 'principal-a', { limit: 1, cursor: first.nextCursor }).summary).toBeNull();
    expect(list(traces, 'principal-a', { limit: 1, includeSummary: false }).summary).toBeNull();
    // Leaving the summary out does not change the cursor's filter binding.
    const bare = list(traces, 'principal-a', { limit: 1, includeSummary: false });
    expect(list(traces, 'principal-a', { limit: 1, cursor: bare.nextCursor }).traces).toHaveLength(1);
  });
});

describe('agent trace operations', () => {
  it('reads a span kind this build does not know as an unknown run-level span', () => {
    const { state, traces } = setup();
    const traceId = addTrace(traces, { startedAt: Date.now() - 10_000, modelCalls: [{ durationMs: 10, ttftMs: 1 }] });
    state.database.prepare("UPDATE agent_trace_spans SET kind = 'future_kind' WHERE trace_id = ?").run(traceId);
    const [span] = traces.spans('principal-a', { traceId, limit: 10 }, Date.now()).spans;
    expect(span).toMatchObject({ kind: 'agent_run', state: 'UNKNOWN' });
  });

  it('fails closed with INTERNAL_ERROR when a result falls outside its public schema', () => {
    const log = vi.fn();
    const { traces } = setup({ log });
    const traceId = addTrace(traces, { startedAt: Date.now() - 10_000 });
    vi.spyOn(traces, 'get').mockReturnValue({ trace: { traceId, unexpected: 'field', profileId: 42 } } as unknown as ReturnType<AgentTraceStore['get']>);
    let caught: unknown;
    try {
      executeAgentTraceOperation(traces, 'principal-a', 'agent_trace_get', { traceId }, { now: Date.now(), maxSpans: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe('INTERNAL_ERROR');
    expect((caught as HarnessError).message).not.toContain('unexpected');
    // The failure is logged with issue paths and codes only, never the offending values.
    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0]![0] as { operation: string; issues: Array<{ path: string; code: string }> };
    expect(entry.operation).toBe('agent_trace_get');
    expect(entry.issues.map((issue) => issue.path)).toContain('trace.profileId');
    expect(JSON.stringify(entry)).not.toContain('field');
    expect(JSON.stringify(entry)).not.toContain('42');
    // A valid result passes through unchanged.
    vi.restoreAllMocks();
    const ok = executeAgentTraceOperation(traces, 'principal-a', 'agent_trace_get', { traceId }, { now: Date.now(), maxSpans: 10 });
    expect((ok.data as { trace: { traceId: string } }).trace.traceId).toBe(traceId);
  });

  it('reports FEATURE_DISABLED when traces are off', () => {
    expect(harnessCode(() => executeAgentTraceOperation(undefined, 'principal-a', 'agent_traces_list', { limit: 25 }, { now: Date.now(), maxSpans: 10 })))
      .toBe('FEATURE_DISABLED');
  });

  it('exports bounded json, csv and otlp-json documents', () => {
    const { traces } = setup();
    const traceId = addTrace(traces, { startedAt: Date.now() - 10_000, modelCalls: [{ durationMs: 100, ttftMs: 10 }] });
    for (const format of ['json', 'csv', 'otlp-json'] as const) {
      const result = executeAgentTraceOperation(traces, 'principal-a', 'agent_trace_export', { traceId, format }, { now: Date.now(), maxSpans: 100 });
      const data = result.data as { content: string; contentType: string; filename: string };
      expect(data.filename.startsWith(traceId)).toBe(true);
      if (format === 'csv') {
        expect(data.contentType).toBe('text/csv');
        expect(data.content.split('\r\n')[0]).toContain('trace_id,span_seq');
      } else {
        const parsed = JSON.parse(data.content) as Record<string, unknown>;
        expect(format === 'json' ? parsed.trace : parsed.resourceSpans).toBeDefined();
      }
    }
  });
});
