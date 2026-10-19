import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTracesListInputSchema, HarnessError, TraceSpanSchema, type TraceSpan } from '@cloud-harness/contracts';
import type { AgentLeaseSettlement } from '../src/agent-gateway-control.js';
import { AgentTraceRecorder, redactTraceText, redactTraceValue, traceInputDigest, type TraceRunKey } from '../src/agent-trace-recorder.js';
import { renderTraceExport } from '../src/agent-trace-export.js';
import { AgentTraceStore, traceIdFor } from '../src/agent-trace-store.js';
import { StateStore } from '../src/state-store.js';
import { settlementOf } from './support/agent-runtime-fakes.js';

const PRINCIPAL = 'principal-a';
const WORKSPACE = `ws_${'w'.repeat(24)}`;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let counter = 0;
function nextAgent(): TraceRunKey {
  counter += 1;
  return { agentId: `agent_${String(counter).padStart(24, '0')}`, generation: 1 };
}

function setup(options: { maxSpansPerTrace?: number; previewBytes?: number; retentionDays?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-trace-recorder-'));
  const state = new StateStore(join(directory, 'state.db'));
  cleanups.push(() => {
    try { state.close(); } catch { /* closed */ }
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new AgentTraceStore(state.database, { retentionDays: options.retentionDays ?? 14, maxTracesPerPrincipal: 5_000 });
  const log = vi.fn();
  const recorder = new AgentTraceRecorder(store, {
    maxSpansPerTrace: options.maxSpansPerTrace ?? 2_000, previewBytes: options.previewBytes ?? 0, log
  });
  let clock = Date.now() - 60_000;
  const tick = (ms = 10) => { clock += ms; return clock; };

  function begin(key: TraceRunKey = nextAgent(), parent: TraceRunKey | null = null): TraceRunKey {
    recorder.begin({ ...key, principalId: PRINCIPAL, workspaceId: WORKSPACE, parent, profileId: 'default', profileRevisionId: 'rev_1', at: tick() });
    return key;
  }
  const event = (key: TraceRunKey, value: Record<string, unknown>) => recorder.observeEvent(key, value, tick());
  const usage = (key: TraceRunKey, input: number, output: number, cost: number) =>
    recorder.observeUsage(key, { inputTokens: input, outputTokens: output, costMicros: cost }, tick());

  /** One model turn with optional tools, exactly as AgentManager forwards it. */
  function turn(key: TraceRunKey, options: {
    tools?: Array<{ id: string; operation: string; input?: unknown; isError?: boolean }>; outcome?: string; errorClass?: string;
    usage?: [number, number, number] | null; deltas?: number;
  } = {}) {
    event(key, { kind: 'lifecycle', phase: 'turn_started' });
    for (let index = 0; index < (options.deltas ?? 1); index += 1) event(key, { kind: 'text_delta', text: 'x' });
    for (const tool of options.tools ?? []) {
      event(key, { kind: 'tool', phase: 'started', toolCallId: tool.id, name: tool.operation });
      recorder.toolRequested(key, { requestId: `req-${tool.id}`, toolCallId: tool.id, operation: tool.operation, input: tool.input ?? {} }, tick());
      recorder.toolCompleted(key, `req-${tool.id}`, { ok: tool.isError !== true }, tick());
      event(key, { kind: 'tool', phase: 'ended', toolCallId: tool.id, name: tool.operation, isError: tool.isError === true });
    }
    event(key, {
      kind: 'lifecycle', phase: 'turn_ended', outcome: options.outcome ?? 'stop',
      ...(options.errorClass ? { errorClass: options.errorClass } : {})
    });
    const reported = options.usage === undefined ? [100, 20, 50] as const : options.usage;
    usage(key, reported?.[0] ?? 0, reported?.[1] ?? 0, reported?.[2] ?? 0);
  }

  function settle(key: TraceRunKey, overrides: Partial<AgentLeaseSettlement> = {}) {
    recorder.settled(key, settlementOf('lease-1', overrides), tick());
  }

  function finish(key: TraceRunKey, terminal: Parameters<AgentTraceRecorder['finish']>[1]['terminal'], ledger: { inputTokens: number; outputTokens: number; costMicros: number } | null) {
    recorder.finish(key, { terminal, reason: terminal.toLowerCase(), ledger, at: tick() });
  }

  function read(key: TraceRunKey) {
    const traceId = traceIdFor(key.agentId, key.generation);
    const now = clock + 1;
    const { trace } = store.get(PRINCIPAL, traceId, now);
    const spans = store.spans(PRINCIPAL, { traceId, limit: 500 }, now).spans.map((span) => TraceSpanSchema.parse(span));
    return { trace, spans, byKind: (kind: TraceSpan['kind']) => spans.filter((span) => span.kind === kind) };
  }

  return { state, store, recorder, log, tick, begin, event, usage, turn, settle, finish, read };
}

describe('agent trace recorder failure matrix', () => {
  it('records two model calls and two tools in one trace with the profile revision', () => {
    const t = setup();
    const key = t.begin();
    t.turn(key, {
      outcome: 'toolUse', usage: [100, 20, 50],
      tools: [{ id: 'call-1', operation: 'files_read', input: { path: 'a.ts' } }, { id: 'call-2', operation: 'files_write', input: { path: 'b.ts' } }]
    });
    t.turn(key, { outcome: 'stop', usage: [200, 40, 90] });
    t.settle(key, { promptTokens: 300, outputTokens: 60, costMicros: 140, requests: 2 });
    t.finish(key, 'SUCCEEDED', { inputTokens: 300, outputTokens: 60, costMicros: 140 });

    const { trace, spans, byKind } = t.read(key);
    expect(trace).toMatchObject({
      state: 'COMPLETED', finishReason: 'completed', profileId: 'default', profileRevisionId: 'rev_1', coverage: 'full',
      tokens: { prompt: 300, output: 60 }, costMicros: 140, costProvenance: 'estimated', requests: 2,
      modelCalls: 2, toolCalls: 2, errors: 0, reconciliationStatus: 'reconciled'
    });
    expect(trace.reconciliation).toMatchObject({ status: 'reconciled', reasons: [], spans: { inputTokens: 300, outputTokens: 60, costMicros: 140 } });
    const models = byKind('model_call');
    expect(models.map((span) => span.state)).toEqual(['OK', 'OK']);
    expect(models.map((span) => span.tokens.prompt)).toEqual([100, 200]);
    expect(models.every((span) => span.durationMs !== null && span.ttftMs !== null)).toBe(true);
    const tools = byKind('tool_call');
    expect(tools.map((span) => [span.name, span.state, span.parentSpanId])).toEqual([
      ['files_read', 'OK', models[0]!.spanId], ['files_write', 'OK', models[0]!.spanId]
    ]);
    expect(tools.every((span) => span.inputDigest?.startsWith('sha256:'))).toBe(true);
    expect(tools[0]!.attributes).toMatchObject({ brokered: true, request_id: 'req-call-1', tool_call_id: 'call-1', outcome: 'ok' });
    expect(byKind('gateway')).toHaveLength(1);
    expect(spans.find((span) => span.spanSeq === 0)).toMatchObject({ kind: 'agent_run', state: 'OK' });
    expect(t.recorder.openRuns).toBe(0);
  });

  it.each([
    ['auth', '401'], ['rate_limit', '429'], ['server', '500']
  ])('marks a failed model call with error class %s (%s) and counts retries once', (errorClass) => {
    const t = setup();
    const key = t.begin();
    t.turn(key, { outcome: 'error', errorClass, usage: [0, 0, 0] });
    t.event(key, { kind: 'notice', message: 'retrying' });
    t.turn(key, { outcome: 'stop', usage: [80, 10, 30] });
    t.settle(key, { promptTokens: 80, outputTokens: 10, costMicros: 30, requests: 2, requestsWithoutUsage: 0 });
    t.finish(key, 'SUCCEEDED', { inputTokens: 80, outputTokens: 10, costMicros: 30 });

    const { trace, byKind } = t.read(key);
    const models = byKind('model_call');
    expect(models.map((span) => span.state)).toEqual(['ERROR', 'OK']);
    expect(models[0]).toMatchObject({ errorClass, tokens: { prompt: null, output: null }, costMicros: null });
    expect(models[1]!.attributes.retry_count).toBe(1);
    expect(models[0]!.attributes.retry_count).toBeUndefined();
    // The retry is an attribute of the next call, not a second charge.
    expect(trace).toMatchObject({ state: 'COMPLETED', tokens: { prompt: 80, output: 10 }, costMicros: 30, errors: 1, reconciliationStatus: 'reconciled' });
  });

  it('leaves tokens null when usage is missing and takes requests without usage from the settlement', () => {
    const t = setup();
    const key = t.begin();
    t.turn(key, { outcome: 'stop', usage: null });
    t.settle(key, { promptTokens: 0, outputTokens: 0, costMicros: 0, requests: 1, requestsWithoutUsage: 1 });
    t.finish(key, 'SUCCEEDED', { inputTokens: 0, outputTokens: 0, costMicros: 0 });

    const { trace, byKind } = t.read(key);
    expect(byKind('model_call')[0]).toMatchObject({ state: 'OK', tokens: { prompt: null, output: null }, attributes: { usage_missing: true } });
    expect(trace).toMatchObject({ state: 'COMPLETED', coverage: 'partial', requestsWithoutUsage: 1, costProvenance: 'gateway_settlement' });
  });

  it('reports a stream that ended mid-turn as an UNKNOWN span in a FAILED trace', () => {
    const t = setup();
    const key = t.begin();
    t.turn(key, { usage: [10, 1, 1] });
    t.event(key, { kind: 'lifecycle', phase: 'turn_started' });
    t.event(key, { kind: 'text_delta', text: 'partial' });
    t.event(key, { kind: 'tool', phase: 'started', toolCallId: 'call-x', name: 'files_read' });
    t.settle(key, { promptTokens: 30, outputTokens: 5, costMicros: 4, requests: 2 });
    t.finish(key, 'FAILED', { inputTokens: 10, outputTokens: 1, costMicros: 1 });

    const { trace, byKind } = t.read(key);
    expect(byKind('model_call').map((span) => span.state)).toEqual(['OK', 'UNKNOWN']);
    expect(byKind('tool_call').map((span) => span.state)).toEqual(['UNKNOWN']);
    expect(trace).toMatchObject({ state: 'FAILED', finishReason: 'failed', coverage: 'partial', tokens: { prompt: 10, output: 1 } });
    expect(byKind('agent_run').find((span) => span.spanSeq === 0)?.state).toBe('ERROR');
  });

  it.each([
    ['CANCELLED', 'revoked', 'CANCELLED', 'cancelled'],
    ['TIMED_OUT', 'revoked', 'TIMED_OUT', 'timed_out'],
    ['TIMED_OUT', 'expired', 'EXPIRED', 'lease_expired'],
    ['FAILED', 'expired', 'EXPIRED', 'lease_expired'],
    ['INTERRUPTED', 'revoked', 'FAILED', 'runtime_exited'],
    ['LIMIT_EXCEEDED', 'revoked', 'FAILED', 'limit_exceeded']
  ] as const)('maps a %s run settled as %s to a partial %s trace', (terminal, reason, state, finishReason) => {
    const t = setup();
    const key = t.begin();
    t.turn(key, { usage: [10, 2, 3] });
    t.event(key, { kind: 'lifecycle', phase: 'turn_started' });
    t.settle(key, { reason, promptTokens: 10, outputTokens: 2, costMicros: 3, requests: 2 });
    t.finish(key, terminal, { inputTokens: 10, outputTokens: 2, costMicros: 3 });
    const { trace, byKind } = t.read(key);
    expect(trace).toMatchObject({ state, finishReason, coverage: 'partial', tokens: { prompt: 10, output: 2 }, costMicros: 3 });
    expect(trace.endedAt).not.toBeNull();
    expect(byKind('model_call').map((span) => span.state)).toEqual(['OK', 'UNKNOWN']);
  });

  it('marks a crashed run INCOMPLETE with open spans UNKNOWN and keeps it INCOMPLETE through a later finish', () => {
    const t = setup();
    const key = t.begin();
    t.turn(key, { usage: [10, 2, 3], tools: [{ id: 'call-1', operation: 'files_read' }] });
    t.event(key, { kind: 'lifecycle', phase: 'turn_started' });
    t.recorder.markIncomplete(key, 'runner_restart', t.tick());
    expect(t.read(key).trace).toMatchObject({ state: 'INCOMPLETE', coverage: 'partial', finishReason: 'runner_restart' });
    expect(t.read(key).byKind('model_call').map((span) => span.state)).toEqual(['OK', 'UNKNOWN']);

    // A fresh recorder (the restarted runner) settles and finishes the interrupted run.
    const restarted = new AgentTraceRecorder(t.store, { maxSpansPerTrace: 2_000, previewBytes: 0, log: () => undefined });
    restarted.settled(key, settlementOf('lease-1', { promptTokens: 10, outputTokens: 2, costMicros: 3, requests: 2 }), t.tick());
    restarted.finish(key, { terminal: 'INTERRUPTED', reason: 'runner restarted', ledger: { inputTokens: 10, outputTokens: 2, costMicros: 3 }, at: t.tick() });
    const { trace, spans } = t.read(key);
    expect(trace).toMatchObject({ state: 'INCOMPLETE', coverage: 'partial', finishReason: 'runner_restart', tokens: { prompt: 10, output: 2 } });
    expect(spans.filter((span) => span.state === 'OPEN')).toEqual([]);
    expect(spans.find((span) => span.spanSeq === 0)?.state).toBe('UNKNOWN');
    expect(trace.reconciliation.status).toBe('reconciled');
  });

  it('links a nested child agent to its parent without double counting', () => {
    const t = setup();
    const parent = t.begin();
    const child = t.begin(nextAgent(), parent);
    t.turn(parent, { usage: [100, 10, 20] });
    t.turn(child, { usage: [50, 5, 10] });
    t.settle(child, { promptTokens: 50, outputTokens: 5, costMicros: 10, requests: 1 });
    t.finish(child, 'SUCCEEDED', { inputTokens: 50, outputTokens: 5, costMicros: 10 });
    t.settle(parent, { promptTokens: 100, outputTokens: 10, costMicros: 20, requests: 1 });
    t.finish(parent, 'SUCCEEDED', { inputTokens: 100, outputTokens: 10, costMicros: 20 });

    const parentTrace = t.read(parent).trace;
    const childTrace = t.read(child).trace;
    expect(childTrace.parentTraceId).toBe(parentTrace.traceId);
    expect(parentTrace.parentTraceId).toBeNull();
    expect(parentTrace.tokens.prompt).toBe(100);
    expect(childTrace.tokens.prompt).toBe(50);
    const { summary } = t.store.list(PRINCIPAL, AgentTracesListInputSchema.parse({}), Date.now());
    expect(summary).toMatchObject({ traces: 2, tokens: { prompt: 150, output: 15 }, costMicros: 30 });
  });

  it('caps spans with a single truncation marker and no unbounded growth', () => {
    const t = setup({ maxSpansPerTrace: 16 });
    const key = t.begin();
    for (let index = 0; index < 30; index += 1) t.turn(key, { usage: [1, 1, 1] });
    t.settle(key, { promptTokens: 30, outputTokens: 30, costMicros: 30, requests: 30 });
    t.finish(key, 'SUCCEEDED', { inputTokens: 30, outputTokens: 30, costMicros: 30 });
    const { trace, spans } = t.read(key);
    expect(trace.truncated).toBe(true);
    expect(trace.coverage).toBe('partial');
    expect(spans.length).toBeLessThanOrEqual(16);
    expect(trace.spanCount).toBe(spans.length);
    const markers = spans.filter((span) => span.name === 'trace.truncated');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.attributes.dropped_spans).toBeGreaterThan(0);
    // Totals still come from every usage report, not only the recorded spans.
    expect(trace.tokens.prompt).toBe(30);
  });

  it('expires and purges a finished trace past retention', () => {
    const t = setup({ retentionDays: 1 });
    const key = t.begin();
    t.turn(key);
    t.settle(key);
    t.finish(key, 'SUCCEEDED', { inputTokens: 100, outputTokens: 20, costMicros: 50 });
    const traceId = traceIdFor(key.agentId, key.generation);
    const later = Date.now() + 2 * 86_400_000;
    expect(() => t.store.get(PRINCIPAL, traceId, later)).toThrowError(HarnessError);
    expect(t.store.purgeExpired(later)).toBe(1);
    expect(t.store.findTrace(traceId)).toBeUndefined();
    expect(t.state.database.prepare('SELECT COUNT(*) AS count FROM agent_trace_spans WHERE trace_id = ?').get(traceId)).toEqual({ count: 0 });
  });

  it('stores tool inputs only as digests by default and redacts previews when enabled', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const input = { path: 'notes.md', content: `token=${secret}`, headers: { authorization: `Bearer ${secret}` } };
    for (const previewBytes of [0, 256]) {
      const t = setup({ previewBytes });
      const key = t.begin();
      t.turn(key, { outcome: 'toolUse', tools: [{ id: 'call-1', operation: 'files_write', input }] });
      t.settle(key);
      t.finish(key, 'SUCCEEDED', { inputTokens: 100, outputTokens: 20, costMicros: 50 });
      const tool = t.read(key).byKind('tool_call')[0]!;
      expect(tool.inputDigest).toBe(traceInputDigest(input));
      if (previewBytes === 0) expect(tool.attributes.preview).toBeUndefined();
      else expect(String(tool.attributes.preview)).toContain('[REDACTED]');
      const dump = JSON.stringify(t.state.database.prepare('SELECT * FROM agent_trace_spans').all())
        + JSON.stringify(t.state.database.prepare('SELECT * FROM agent_traces').all());
      expect(dump).not.toContain(secret);
      const traceId = traceIdFor(key.agentId, key.generation);
      for (const format of ['json', 'csv', 'otlp-json'] as const) {
        const exported = t.store.exportable(PRINCIPAL, traceId, Date.now(), 100);
        expect(renderTraceExport(exported.trace, exported.spans, format, 4 * 1024 * 1024).content).not.toContain(secret);
      }
    }
    expect(redactTraceText(`Authorization: Bearer ${secret}`)).not.toContain(secret);
    expect(redactTraceValue({ apiKey: 'plain', nested: { password: 'x' } })).toEqual({ apiKey: '[REDACTED]', nested: { password: '[REDACTED]' } });
  });

  it('writes O(turns) spans, not O(text deltas)', () => {
    const count = (deltas: number) => {
      const t = setup();
      const writes = vi.spyOn(t.store, 'writeSpan');
      const key = t.begin();
      for (let index = 0; index < 3; index += 1) t.turn(key, { deltas });
      t.settle(key);
      t.finish(key, 'SUCCEEDED', { inputTokens: 300, outputTokens: 60, costMicros: 150 });
      return writes.mock.calls.length;
    };
    const few = count(1);
    expect(count(500)).toBe(few);
    expect(few).toBeLessThanOrEqual(3 * 2 + 3);
  });
});

describe('agent trace recorder resilience', () => {
  it('never throws into the lifecycle when the store fails, and downgrades the trace', () => {
    const t = setup();
    const key = t.begin();
    const failure = vi.spyOn(t.store, 'writeSpan').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => t.turn(key)).not.toThrow();
    failure.mockRestore();
    t.settle(key);
    t.finish(key, 'SUCCEEDED', { inputTokens: 100, outputTokens: 20, costMicros: 50 });
    const { trace } = t.read(key);
    expect(trace.coverage).toBe('partial');
    expect(trace.reconciliation.reasons).toContain('recorder_degraded');
    expect(t.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(t.log.mock.calls)).toContain('agent trace recording degraded');
  });

  it('marks unreconciled totals when the spans disagree with the usage ledger', () => {
    const t = setup();
    const key = t.begin();
    t.turn(key, { usage: [100, 20, 50] });
    t.settle(key, { promptTokens: 100, outputTokens: 20, costMicros: 50, requests: 1 });
    t.finish(key, 'SUCCEEDED', { inputTokens: 120, outputTokens: 20, costMicros: 60 });
    const { trace } = t.read(key);
    expect(trace.reconciliationStatus).toBe('unreconciled');
    expect(trace.reconciliation.reasons).toEqual(expect.arrayContaining(['input_tokens_mismatch', 'cost_out_of_tolerance']));
  });

  it('ignores events of unknown runs and malformed events', () => {
    const t = setup();
    const key = nextAgent();
    expect(() => t.event(key, { kind: 'lifecycle', phase: 'turn_started' })).not.toThrow();
    const started = t.begin();
    expect(() => t.recorder.observeEvent(started, 'not-an-object', t.tick())).not.toThrow();
    expect(() => t.event(started, { kind: 'tool', phase: 'started' })).not.toThrow();
    expect(t.log).not.toHaveBeenCalled();
  });
});
