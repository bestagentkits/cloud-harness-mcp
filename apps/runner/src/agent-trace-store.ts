import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';
import {
  AGENT_TRACE_RESULT_SCHEMAS,
  HarnessError,
  TRACE_COHORT_MIN_SAMPLES,
  TraceAttributesSchema,
  TraceErrorClassSchema,
  TraceReconciliationSchema,
  TraceSpanKindSchema,
  type AgentTraceGetResult,
  type AgentTraceSpansResult,
  type AgentTracesListInput,
  type AgentTracesListResult,
  type TraceAttributes,
  type TraceCostProvenance,
  type TraceCoverage,
  type TraceDetail,
  type TraceErrorClass,
  type TraceListSummary,
  type TraceReconciliation,
  type TraceSpan,
  type TraceSpanKind,
  type TraceSpanState,
  type TraceState,
  type TraceSummary,
  type AgentTraceOperation,
  type RunnerResponse,
  type TraceExportFormat
} from '@cloud-harness/contracts';
import { renderTraceExport } from './agent-trace-export.js';

const DAY_MS = 86_400_000;
/** A trace still RUNNING this long after its retention deadline is an orphan and is purged anyway. */
const RUNNING_ORPHAN_GRACE_MS = 7 * DAY_MS;
/** List aggregates cover at most this many of the newest traces in the filter window. */
const SUMMARY_TRACE_SAMPLE = 1_000;
/** And at most this many model_call spans of those traces. */
const SUMMARY_SPAN_SAMPLE = 20_000;
/** Traces removed per purge transaction; the purge yields to the event loop between batches. */
const PURGE_BATCH_DEFAULT = 200;
const PURGE_BATCH_MAX = 500;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export type AgentTraceStoreOptions = {
  retentionDays: number;
  maxTracesPerPrincipal: number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
};

export type NewTraceRow = {
  traceId: string;
  principalId: string;
  workspaceId: string;
  agentId: string;
  generation: number;
  runId: string | null;
  parentTraceId: string | null;
  workflowId: string | null;
  profileId: string | null;
  profileRevisionId: string | null;
  startedAt: number;
};

export type TraceRow = NewTraceRow & {
  state: TraceState;
  finishReason: string | null;
  endedAt: number | null;
  promptTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  requests: number | null;
  requestsWithoutUsage: number | null;
  costMicros: number | null;
  costProvenance: TraceCostProvenance;
  reconciliation: TraceReconciliation | null;
  coverage: TraceCoverage;
  spanCount: number;
  truncated: boolean;
  expiresAt: number;
};

export type TraceTotalsPatch = Partial<Pick<TraceRow,
  'state' | 'finishReason' | 'endedAt' | 'promptTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'
  | 'reasoningTokens' | 'requests' | 'requestsWithoutUsage' | 'costMicros' | 'costProvenance' | 'reconciliation'
  | 'coverage' | 'truncated' | 'expiresAt'>>;

export type SpanWrite = {
  traceId: string;
  spanSeq: number;
  spanId: string;
  parentSpanId: string | null;
  kind: TraceSpanKind;
  name: string;
  state: TraceSpanState;
  startedAt: number;
  endedAt: number | null;
  ttftMs: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costMicros: number | null;
  attributes: TraceAttributes;
  inputDigest: string | null;
  errorClass: TraceErrorClass | null;
};

export type ModelSpanSums = { inputTokens: number; outputTokens: number; costMicros: number; modelSpans: number };

type TraceDbRow = {
  trace_id: string; principal_id: string; workspace_id: string; agent_id: string; generation: number;
  run_id: string | null; parent_trace_id: string | null; workflow_id: string | null; profile_id: string | null;
  profile_revision_id: string | null; state: TraceState; finish_reason: string | null; started_at: number;
  ended_at: number | null; prompt_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  output_tokens: number | null; reasoning_tokens: number | null; requests: number | null; requests_without_usage: number | null;
  cost_micros: number | null; cost_provenance: TraceCostProvenance; reconciliation_json: string | null;
  coverage: TraceCoverage; span_count: number; truncated: number; expires_at: number;
};

type SpanDbRow = {
  trace_id: string; span_seq: number; span_id: string; parent_span_id: string | null; kind: string; name: string;
  state: TraceSpanState; started_at: number; ended_at: number | null; ttft_ms: number | null; prompt_tokens: number | null;
  output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; cost_micros: number | null;
  attributes_json: string; input_digest: string | null; error_class: string | null;
};

type ListCursor = { k: 'l'; s: number; t: string; p: string; f: string };
type SpanCursor = { k: 's'; t: string; q: number; p: string; f: string };

/** Lowercase RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(buffer << (5 - bits)) & 31];
  return output;
}

/** Deterministic, so a restarted runner re-attaches to the same trace for the same agent run. */
export function traceIdFor(agentId: string, generation: number): string {
  return `trc_${base32(createHash('sha256').update(`${agentId}|${generation}`).digest()).slice(0, 26)}`;
}

export function spanIdFor(traceId: string, spanSeq: number): string {
  return `spn_${base32(createHash('sha256').update(`${traceId}|${spanSeq}`).digest()).slice(0, 16)}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 12);
}

function encodeCursor(cursor: ListCursor | SpanCursor): string {
  return `tc1.${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

function decodeCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new HarnessError('INVALID_INPUT', 'trace cursor is malformed', 400, false);
  }
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function durationOf(startedAt: number, endedAt: number | null): number | null {
  return endedAt === null ? null : Math.max(0, endedAt - startedAt);
}

/** Nearest-rank percentile over an ascending array; null for an empty sample. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function latency(values: number[]): { samples: number; p50Ms: number | null; p95Ms: number | null } {
  const sorted = [...values].sort((left, right) => left - right);
  return { samples: sorted.length, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

function sumNullable(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) if (value !== null) total = (total ?? 0) + value;
  return total;
}

function parseAttributes(raw: string): TraceAttributes {
  try {
    const parsed = TraceAttributesSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function parseReconciliation(raw: string | null): TraceReconciliation | null {
  if (raw === null) return null;
  try {
    const parsed = TraceReconciliationSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toRow(row: TraceDbRow): TraceRow {
  return {
    traceId: row.trace_id, principalId: row.principal_id, workspaceId: row.workspace_id, agentId: row.agent_id,
    generation: row.generation, runId: row.run_id, parentTraceId: row.parent_trace_id, workflowId: row.workflow_id,
    profileId: row.profile_id, profileRevisionId: row.profile_revision_id, state: row.state, finishReason: row.finish_reason,
    startedAt: row.started_at, endedAt: row.ended_at, promptTokens: row.prompt_tokens, cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens, outputTokens: row.output_tokens, reasoningTokens: row.reasoning_tokens,
    requests: row.requests, requestsWithoutUsage: row.requests_without_usage, costMicros: row.cost_micros,
    costProvenance: row.cost_provenance, reconciliation: parseReconciliation(row.reconciliation_json), coverage: row.coverage,
    spanCount: row.span_count, truncated: row.truncated === 1, expiresAt: row.expires_at
  };
}

function summaryOf(row: TraceRow): TraceSummary {
  return {
    traceId: row.traceId,
    agentId: row.agentId as TraceSummary['agentId'],
    workspaceId: row.workspaceId as TraceSummary['workspaceId'],
    generation: row.generation,
    runId: row.runId,
    parentTraceId: row.parentTraceId,
    workflowId: row.workflowId,
    profileId: row.profileId,
    profileRevisionId: row.profileRevisionId,
    state: row.state,
    finishReason: row.finishReason,
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: isoOrNull(row.endedAt),
    durationMs: durationOf(row.startedAt, row.endedAt),
    tokens: {
      prompt: row.promptTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens,
      output: row.outputTokens, reasoning: row.reasoningTokens
    },
    requests: row.requests,
    requestsWithoutUsage: row.requestsWithoutUsage,
    costMicros: row.costMicros,
    costProvenance: row.costProvenance,
    coverage: row.coverage,
    spanCount: row.spanCount,
    truncated: row.truncated,
    reconciliationStatus: row.state === 'RUNNING' ? 'pending' : (row.reconciliation?.status ?? 'unreconciled'),
    expiresAt: new Date(row.expiresAt).toISOString()
  };
}

export function spanOf(row: SpanDbRow): TraceSpan {
  const kind = TraceSpanKindSchema.safeParse(row.kind);
  const errorClass = TraceErrorClassSchema.safeParse(row.error_class);
  return {
    spanSeq: row.span_seq,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    // A kind this build does not know reads as an unknown run-level span, never as another known kind.
    kind: kind.success ? kind.data : 'agent_run',
    name: row.name,
    state: kind.success ? row.state : 'UNKNOWN',
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: isoOrNull(row.ended_at),
    durationMs: durationOf(row.started_at, row.ended_at),
    ttftMs: row.ttft_ms,
    tokens: { prompt: row.prompt_tokens, output: row.output_tokens, cacheRead: row.cache_read_tokens, cacheWrite: row.cache_write_tokens },
    costMicros: row.cost_micros,
    attributes: parseAttributes(row.attributes_json),
    inputDigest: row.input_digest !== null && /^sha256:[a-f0-9]{64}$/u.test(row.input_digest) ? row.input_digest : null,
    errorClass: errorClass.success ? errorClass.data : null
  };
}

/**
 * Durable storage of agent traces and spans. Every read is scoped by principal; a trace of another
 * principal is reported exactly like a missing one. Cursors are bound to the caller and the filter
 * set, and a cursor whose anchor was removed by retention or quota reports TRACE_EXPIRED.
 */
export class AgentTraceStore {
  private readonly retentionMs: number;
  constructor(
    private readonly database: DatabaseSync,
    private readonly options: AgentTraceStoreOptions
  ) {
    this.retentionMs = options.retentionDays * DAY_MS;
  }

  retentionDeadline(from: number): number {
    return from + this.retentionMs;
  }

  /** Creates the trace if absent. Returns false when it already existed (a deterministic re-attach). */
  createTrace(row: NewTraceRow): boolean {
    const result = this.database.prepare(`INSERT OR IGNORE INTO agent_traces(
        trace_id, principal_id, workspace_id, agent_id, generation, run_id, parent_trace_id, workflow_id, profile_id,
        profile_revision_id, state, started_at, cost_provenance, coverage, span_count, truncated, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, 'unknown', 'full', 0, 0, ?)`).run(
      row.traceId, row.principalId, row.workspaceId, row.agentId, row.generation, row.runId, row.parentTraceId,
      row.workflowId, row.profileId, row.profileRevisionId, row.startedAt, this.retentionDeadline(row.startedAt)
    );
    if (Number(result.changes) !== 1) return false;
    // Only a newly inserted trace counts against the quota; a re-attach changes nothing. The new
    // trace is RUNNING, so eviction never removes it.
    this.enforceQuota(row.principalId);
    return true;
  }

  findTrace(traceId: string): TraceRow | undefined {
    const row = this.database.prepare('SELECT * FROM agent_traces WHERE trace_id = ?').get(traceId) as TraceDbRow | undefined;
    return row ? toRow(row) : undefined;
  }

  updateTrace(traceId: string, patch: TraceTotalsPatch): void {
    const columns: Record<keyof TraceTotalsPatch, string> = {
      state: 'state', finishReason: 'finish_reason', endedAt: 'ended_at', promptTokens: 'prompt_tokens',
      cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens', outputTokens: 'output_tokens',
      reasoningTokens: 'reasoning_tokens', requests: 'requests', requestsWithoutUsage: 'requests_without_usage',
      costMicros: 'cost_micros', costProvenance: 'cost_provenance', reconciliation: 'reconciliation_json',
      coverage: 'coverage', truncated: 'truncated', expiresAt: 'expires_at'
    };
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof TraceTotalsPatch, TraceTotalsPatch[keyof TraceTotalsPatch]][]) {
      if (value === undefined) continue;
      assignments.push(`${columns[key]} = ?`);
      if (key === 'reconciliation') values.push(value === null ? null : JSON.stringify(TraceReconciliationSchema.parse(value)));
      else if (key === 'truncated') values.push(value ? 1 : 0);
      else values.push(value as SQLInputValue);
    }
    if (assignments.length === 0) return;
    this.database.prepare(`UPDATE agent_traces SET ${assignments.join(', ')} WHERE trace_id = ?`).run(...values, traceId);
  }

  /** Marks the trace partial without touching anything else; used when recording degraded. */
  markPartial(traceId: string): void {
    this.database.prepare("UPDATE agent_traces SET coverage = 'partial' WHERE trace_id = ?").run(traceId);
  }

  /** Inserts or replaces one span. A new span increments the trace's span count in the same transaction. */
  writeSpan(span: SpanWrite): void {
    const attributes = JSON.stringify(TraceAttributesSchema.parse(span.attributes));
    this.database.exec('SAVEPOINT agent_trace_span');
    try {
      const existing = this.database.prepare('SELECT 1 AS present FROM agent_trace_spans WHERE trace_id = ? AND span_seq = ?')
        .get(span.traceId, span.spanSeq) as { present: number } | undefined;
      this.database.prepare(`INSERT OR REPLACE INTO agent_trace_spans(
          trace_id, span_seq, span_id, parent_span_id, kind, name, state, started_at, ended_at, ttft_ms, prompt_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, attributes_json, input_digest, error_class)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        span.traceId, span.spanSeq, span.spanId, span.parentSpanId, span.kind, span.name.slice(0, 128), span.state,
        span.startedAt, span.endedAt, span.ttftMs, span.promptTokens, span.outputTokens, span.cacheReadTokens,
        span.cacheWriteTokens, span.costMicros, attributes, span.inputDigest, span.errorClass
      );
      if (!existing) this.database.prepare('UPDATE agent_traces SET span_count = span_count + 1 WHERE trace_id = ?').run(span.traceId);
      this.database.exec('RELEASE agent_trace_span');
    } catch (error) {
      this.database.exec('ROLLBACK TO agent_trace_span');
      this.database.exec('RELEASE agent_trace_span');
      throw error;
    }
  }

  nextSpanSeq(traceId: string): number {
    const row = this.database.prepare('SELECT MAX(span_seq) AS seq FROM agent_trace_spans WHERE trace_id = ?').get(traceId) as { seq: number | null };
    return row.seq === null ? 0 : row.seq + 1;
  }

  /** Reads the trace's spans in sequence order, unscoped; for the recorder's own bookkeeping only. */
  spanRows(traceId: string, limit: number): TraceSpan[] {
    return (this.database.prepare('SELECT * FROM agent_trace_spans WHERE trace_id = ? ORDER BY span_seq LIMIT ?')
      .all(traceId, limit) as SpanDbRow[]).map(spanOf);
  }

  modelSpanSums(traceId: string): ModelSpanSums {
    const row = this.database.prepare(`SELECT COALESCE(SUM(prompt_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cost_micros), 0) AS cost, COUNT(*) AS spans
      FROM agent_trace_spans WHERE trace_id = ? AND kind = 'model_call'`).get(traceId) as { input: number; output: number; cost: number; spans: number };
    return { inputTokens: row.input, outputTokens: row.output, costMicros: row.cost, modelSpans: row.spans };
  }

  /**
   * Closes every OPEN span as UNKNOWN and, unless the trace already ended, marks it INCOMPLETE with
   * partial coverage. Used when a runner restart finds a run it can no longer observe.
   */
  markIncomplete(traceId: string, at: number, finishReason: string): void {
    this.database.exec('SAVEPOINT agent_trace_incomplete');
    try {
      this.database.prepare("UPDATE agent_trace_spans SET state = 'UNKNOWN', ended_at = COALESCE(ended_at, ?) WHERE trace_id = ? AND state = 'OPEN'")
        .run(at, traceId);
      this.database.prepare(`UPDATE agent_traces SET state = 'INCOMPLETE', coverage = 'partial', finish_reason = ?,
          ended_at = COALESCE(ended_at, ?), expires_at = ?
        WHERE trace_id = ? AND state = 'RUNNING'`).run(finishReason, at, this.retentionDeadline(at), traceId);
      this.database.exec('RELEASE agent_trace_incomplete');
    } catch (error) {
      this.database.exec('ROLLBACK TO agent_trace_incomplete');
      this.database.exec('RELEASE agent_trace_incomplete');
      throw error;
    }
  }

  /**
   * Removes expired traces and their spans in bounded batches: one transaction per batch, yielding to
   * the event loop between batches so a large backlog never blocks the runner. Returns the number of
   * traces removed.
   */
  async purgeExpired(now: number, options: { batchSize?: number; yieldBetween?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<number> {
    const batchSize = Math.max(1, Math.min(PURGE_BATCH_MAX, options.batchSize ?? PURGE_BATCH_DEFAULT));
    const yieldBetween = options.yieldBetween ?? (() => new Promise<void>((resolve) => { setImmediate(resolve); }));
    const select = this.database.prepare(`SELECT trace_id FROM agent_traces
      WHERE expires_at <= ? AND (state <> 'RUNNING' OR expires_at <= ?) ORDER BY expires_at LIMIT ?`);
    let removed = 0;
    for (;;) {
      // An abort (runner shutdown) stops between batches, never inside one.
      if (options.signal?.aborted) return removed;
      const expired = (select.all(now, now - RUNNING_ORPHAN_GRACE_MS, batchSize) as { trace_id: string }[]).map((row) => row.trace_id);
      if (expired.length === 0) return removed;
      this.deleteTraces(expired);
      removed += expired.length;
      if (expired.length < batchSize) return removed;
      await yieldBetween();
    }
  }

  /**
   * Keeps a principal below its trace quota by removing its oldest finished traces. The excess can be
   * large after an operator lowers the cap, so it is removed in bounded batches (one transaction and
   * one bounded IN list each), never in one statement past SQLite's variable limit.
   */
  enforceQuota(principalId: string, incoming = 0): number {
    const row = this.database.prepare('SELECT COUNT(*) AS total FROM agent_traces WHERE principal_id = ?').get(principalId) as { total: number };
    let excess = row.total + incoming - this.options.maxTracesPerPrincipal;
    const select = this.database.prepare(`SELECT trace_id FROM agent_traces WHERE principal_id = ? AND state <> 'RUNNING'
      ORDER BY started_at, trace_id LIMIT ?`);
    let removed = 0;
    while (excess > 0) {
      const victims = (select.all(principalId, Math.min(excess, PURGE_BATCH_MAX)) as { trace_id: string }[]).map((victim) => victim.trace_id);
      if (victims.length === 0) break;
      this.deleteTraces(victims);
      removed += victims.length;
      excess -= victims.length;
    }
    return removed;
  }

  /** Logs a result that failed its public schema: the failing paths and issue codes only, never values. */
  reportContractViolation(operation: string, issues: readonly { path: readonly PropertyKey[]; code: string }[]): void {
    const log = this.options.log ?? ((entry: Record<string, unknown>) => { process.stderr.write(`${JSON.stringify(entry)}\n`); });
    log({
      level: 'error', time: Date.now(), msg: 'agent trace result outside its contract', operation,
      issues: issues.slice(0, 20).map((issue) => ({ path: issue.path.map((part) => (typeof part === 'symbol' ? '?' : String(part).slice(0, 64))).join('.'), code: issue.code }))
    });
  }

  /** Deletes a bounded set of traces and their spans in one transaction. */
  private deleteTraces(traceIds: readonly string[]): void {
    const placeholders = traceIds.map(() => '?').join(', ');
    this.database.exec('SAVEPOINT agent_trace_delete');
    try {
      this.database.prepare(`DELETE FROM agent_trace_spans WHERE trace_id IN (${placeholders})`).run(...traceIds);
      this.database.prepare(`DELETE FROM agent_traces WHERE trace_id IN (${placeholders})`).run(...traceIds);
      this.database.exec('RELEASE agent_trace_delete');
    } catch (error) {
      this.database.exec('ROLLBACK TO agent_trace_delete');
      this.database.exec('RELEASE agent_trace_delete');
      throw error;
    }
  }

  // ---- owner-scoped reads ----

  private owned(principalId: string, traceId: string): TraceRow | undefined {
    const row = this.database.prepare('SELECT * FROM agent_traces WHERE trace_id = ? AND principal_id = ?')
      .get(traceId, principalId) as TraceDbRow | undefined;
    return row ? toRow(row) : undefined;
  }

  list(principalId: string, input: AgentTracesListInput, now: number): AgentTracesListResult {
    const filters = {
      workspaceId: input.workspaceId ?? null, agentId: input.agentId ?? null, profileId: input.profileId ?? null,
      state: input.state ?? null, workflowId: input.workflowId ?? null, since: input.since ?? null, until: input.until ?? null
    };
    const filterPrint = fingerprint(filters);
    const principalPrint = fingerprint(principalId);
    const where: string[] = ['principal_id = ?', 'expires_at > ?'];
    const values: SQLInputValue[] = [principalId, now];
    if (filters.workspaceId !== null) { where.push('workspace_id = ?'); values.push(filters.workspaceId); }
    if (filters.agentId !== null) { where.push('agent_id = ?'); values.push(filters.agentId); }
    if (filters.profileId !== null) { where.push('(profile_id = ? OR profile_revision_id = ?)'); values.push(filters.profileId, filters.profileId); }
    if (filters.state !== null) { where.push('state = ?'); values.push(filters.state); }
    if (filters.workflowId !== null) { where.push('workflow_id = ?'); values.push(filters.workflowId); }
    if (filters.since !== null) { where.push('started_at >= ?'); values.push(Date.parse(filters.since)); }
    if (filters.until !== null) { where.push('started_at < ?'); values.push(Date.parse(filters.until)); }
    const windowWhere = [...where];
    const windowValues = [...values];

    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor) as Partial<ListCursor>;
      if (cursor.k !== 'l' || typeof cursor.s !== 'number' || typeof cursor.t !== 'string') {
        throw new HarnessError('INVALID_INPUT', 'trace cursor is malformed', 400, false);
      }
      if (cursor.p !== principalPrint) throw new HarnessError('INVALID_INPUT', 'trace cursor belongs to another caller', 400, false);
      if (cursor.f !== filterPrint) throw new HarnessError('INVALID_INPUT', 'trace cursor was issued for different filters', 400, false);
      const anchor = this.owned(principalId, cursor.t);
      if (!anchor || anchor.expiresAt <= now) {
        throw new HarnessError('TRACE_EXPIRED', 'the trace page this cursor continues from was removed by retention; restart the listing without a cursor', 410, false, { resumeAction: 'restart_without_cursor' });
      }
      where.push('(started_at, trace_id) < (?, ?)');
      values.push(cursor.s, cursor.t);
    }
    const rows = (this.database.prepare(`SELECT * FROM agent_traces WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC, trace_id DESC LIMIT ?`).all(...values, input.limit + 1) as TraceDbRow[]).map(toRow);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor = rows.length > input.limit && last
      ? encodeCursor({ k: 'l', s: last.startedAt, t: last.traceId, p: principalPrint, f: filterPrint })
      : null;
    // The summary covers the whole window, so only the first page computes it, and only on request.
    const wantSummary = input.cursor === undefined && input.includeSummary !== false;
    return {
      traces: page.map(summaryOf),
      summary: wantSummary ? this.summary(windowWhere, windowValues) : null,
      nextCursor
    };
  }

  private summary(where: string[], values: SQLInputValue[]): TraceListSummary {
    const sample = (this.database.prepare(`SELECT * FROM agent_traces WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC, trace_id DESC LIMIT ?`).all(...values, SUMMARY_TRACE_SAMPLE + 1) as TraceDbRow[]).map(toRow);
    const sampled = sample.length > SUMMARY_TRACE_SAMPLE;
    const traces = sample.slice(0, SUMMARY_TRACE_SAMPLE);
    const byState: TraceListSummary['byState'] = {};
    for (const trace of traces) byState[trace.state] = (byState[trace.state] ?? 0) + 1;
    const known = traces.filter((trace) => trace.costMicros !== null);
    const spans = this.modelSpanTimings(traces.map((trace) => trace.traceId));
    const profileOf = new Map(traces.map((trace) => [trace.traceId, trace.profileId]));
    const cohorts = new Map<string | null, { traces: number; durations: number[]; ttfts: number[] }>();
    for (const trace of traces) {
      const cohort = cohorts.get(trace.profileId) ?? { traces: 0, durations: [], ttfts: [] };
      cohort.traces += 1;
      cohorts.set(trace.profileId, cohort);
    }
    const durations: number[] = [];
    const ttfts: number[] = [];
    for (const span of spans.rows) {
      const cohort = cohorts.get(profileOf.get(span.trace_id) ?? null);
      if (span.ended_at !== null) {
        const duration = Math.max(0, span.ended_at - span.started_at);
        durations.push(duration);
        cohort?.durations.push(duration);
      }
      if (span.ttft_ms !== null) {
        ttfts.push(span.ttft_ms);
        cohort?.ttfts.push(span.ttft_ms);
      }
    }
    return {
      traces: traces.length,
      byState,
      tokens: {
        prompt: sumNullable(traces.map((trace) => trace.promptTokens)),
        cacheRead: sumNullable(traces.map((trace) => trace.cacheReadTokens)),
        cacheWrite: sumNullable(traces.map((trace) => trace.cacheWriteTokens)),
        output: sumNullable(traces.map((trace) => trace.outputTokens)),
        reasoning: sumNullable(traces.map((trace) => trace.reasoningTokens))
      },
      costMicros: known.length === 0 ? null : known.reduce((total, trace) => total + (trace.costMicros ?? 0), 0),
      unknownCostTraces: traces.length - known.length,
      errorTraces: traces.filter((trace) => trace.state === 'FAILED' || trace.state === 'TIMED_OUT' || trace.state === 'EXPIRED').length,
      partialTraces: traces.filter((trace) => trace.coverage === 'partial').length,
      unreconciledTraces: traces.filter((trace) => trace.state !== 'RUNNING' && trace.reconciliation?.status !== 'reconciled').length,
      modelLatency: latency(durations),
      ttft: latency(ttfts),
      cohorts: [...cohorts.entries()]
        .sort((left, right) => right[1].traces - left[1].traces)
        .slice(0, 50)
        .map(([profileId, cohort]) => cohort.traces >= TRACE_COHORT_MIN_SAMPLES
          ? { profileId, traces: cohort.traces, status: 'ok' as const, modelLatency: latency(cohort.durations), ttft: latency(cohort.ttfts) }
          : { profileId, traces: cohort.traces, status: 'insufficient_sample' as const, modelLatency: null, ttft: null }),
      sampled: sampled || spans.capped
    };
  }

  private modelSpanTimings(traceIds: string[]): { rows: Pick<SpanDbRow, 'trace_id' | 'started_at' | 'ended_at' | 'ttft_ms'>[]; capped: boolean } {
    const rows: Pick<SpanDbRow, 'trace_id' | 'started_at' | 'ended_at' | 'ttft_ms'>[] = [];
    let capped = false;
    for (let offset = 0; offset < traceIds.length && !capped; offset += 200) {
      const chunk = traceIds.slice(offset, offset + 200);
      const found = this.database.prepare(`SELECT trace_id, started_at, ended_at, ttft_ms FROM agent_trace_spans
        WHERE kind = 'model_call' AND trace_id IN (${chunk.map(() => '?').join(', ')}) LIMIT ?`)
        .all(...chunk, SUMMARY_SPAN_SAMPLE - rows.length + 1) as Pick<SpanDbRow, 'trace_id' | 'started_at' | 'ended_at' | 'ttft_ms'>[];
      for (const row of found) {
        if (rows.length >= SUMMARY_SPAN_SAMPLE) { capped = true; break; }
        rows.push(row);
      }
    }
    return { rows, capped };
  }

  get(principalId: string, traceId: string, now: number): AgentTraceGetResult {
    const row = this.requireOwned(principalId, traceId, now);
    return { trace: this.detailOf(row) };
  }

  detailOf(row: TraceRow): TraceDetail {
    const counts = this.database.prepare(`SELECT
        SUM(CASE WHEN kind = 'model_call' THEN 1 ELSE 0 END) AS model_calls,
        SUM(CASE WHEN kind = 'tool_call' THEN 1 ELSE 0 END) AS tool_calls,
        SUM(CASE WHEN state = 'ERROR' THEN 1 ELSE 0 END) AS errors
      FROM agent_trace_spans WHERE trace_id = ?`).get(row.traceId) as { model_calls: number | null; tool_calls: number | null; errors: number | null };
    const timings = this.modelSpanTimings([row.traceId]).rows;
    const sums = this.modelSpanSums(row.traceId);
    const reconciliation: TraceReconciliation = row.reconciliation ?? {
      status: row.state === 'RUNNING' ? 'pending' : 'unreconciled',
      reasons: row.state === 'RUNNING' ? [] : ['usage_unavailable'],
      toleranceMicros: sums.modelSpans,
      ledger: null,
      spans: { inputTokens: sums.inputTokens, outputTokens: sums.outputTokens, costMicros: sums.costMicros },
      gateway: null
    };
    return {
      ...summaryOf(row),
      reconciliation,
      modelCalls: counts.model_calls ?? 0,
      toolCalls: counts.tool_calls ?? 0,
      errors: counts.errors ?? 0,
      modelLatency: latency(timings.flatMap((span) => span.ended_at === null ? [] : [Math.max(0, span.ended_at - span.started_at)])),
      ttft: latency(timings.flatMap((span) => span.ttft_ms === null ? [] : [span.ttft_ms]))
    };
  }

  spans(principalId: string, input: { traceId: string; kind?: TraceSpanKind | undefined; cursor?: string | undefined; limit: number }, now: number): AgentTraceSpansResult {
    const principalPrint = fingerprint(principalId);
    const filterPrint = fingerprint(input.kind ?? null);
    let after = -1;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor) as Partial<SpanCursor>;
      if (cursor.k !== 's' || typeof cursor.q !== 'number' || typeof cursor.t !== 'string') {
        throw new HarnessError('INVALID_INPUT', 'trace cursor is malformed', 400, false);
      }
      if (cursor.p !== principalPrint) throw new HarnessError('INVALID_INPUT', 'trace cursor belongs to another caller', 400, false);
      if (cursor.t !== input.traceId || cursor.f !== filterPrint) {
        throw new HarnessError('INVALID_INPUT', 'trace cursor was issued for a different trace or filter', 400, false);
      }
      const anchor = this.owned(principalId, input.traceId);
      if (!anchor || anchor.expiresAt <= now) {
        throw new HarnessError('TRACE_EXPIRED', 'the trace this cursor pages through was removed by retention', 410, false, { resumeAction: 'restart_without_cursor' });
      }
      after = cursor.q;
    }
    this.requireOwned(principalId, input.traceId, now);
    const kindClause = input.kind === undefined ? '' : ' AND kind = ?';
    const rows = this.database.prepare(`SELECT * FROM agent_trace_spans WHERE trace_id = ? AND span_seq > ?${kindClause}
      ORDER BY span_seq LIMIT ?`).all(...[input.traceId, after, ...(input.kind === undefined ? [] : [input.kind]), input.limit + 1]) as SpanDbRow[];
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      traceId: input.traceId,
      spans: page.map(spanOf),
      nextCursor: rows.length > input.limit && last
        ? encodeCursor({ k: 's', t: input.traceId, q: last.span_seq, p: principalPrint, f: filterPrint })
        : null
    };
  }

  /** Every span of an owned trace, bounded; for export. */
  exportable(principalId: string, traceId: string, now: number, maxSpans: number): { trace: TraceDetail; spans: TraceSpan[] } {
    const row = this.requireOwned(principalId, traceId, now);
    return { trace: this.detailOf(row), spans: this.spanRows(row.traceId, maxSpans) };
  }

  private requireOwned(principalId: string, traceId: string, now: number): TraceRow {
    const row = this.owned(principalId, traceId);
    if (!row) throw new HarnessError('NOT_FOUND', 'trace was not found', 404, false);
    if (row.expiresAt <= now) {
      throw new HarnessError('TRACE_EXPIRED', 'trace passed its retention period', 410, false);
    }
    return row;
  }
}

/**
 * Runs one of the four owner-scoped trace read operations. `store` is undefined when agent traces are
 * disabled, which every operation reports as FEATURE_DISABLED. Input was already validated against
 * the public tool schema by the caller.
 */
export function executeAgentTraceOperation(
  store: AgentTraceStore | undefined,
  principalId: string,
  operation: AgentTraceOperation,
  input: Record<string, unknown>,
  options: { now: number; maxSpans: number }
): RunnerResponse {
  if (!store) {
    throw new HarnessError('FEATURE_DISABLED', 'agent traces are not enabled on this instance; the operator sets AGENT_TRACES_ENABLED=true', 409, false);
  }
  switch (operation) {
    case 'agent_traces_list': {
      const data = traceResult(store, operation, store.list(principalId, input as AgentTracesListInput, options.now));
      return { ok: true, message: `Listed ${data.traces.length} agent traces`, data, truncated: data.nextCursor !== null };
    }
    case 'agent_trace_get':
      return { ok: true, message: 'Agent trace', data: traceResult(store, operation, store.get(principalId, input.traceId as string, options.now)), truncated: false };
    case 'agent_trace_spans': {
      const data = traceResult(store, operation, store.spans(principalId, {
        traceId: input.traceId as string,
        kind: input.kind as TraceSpanKind | undefined,
        cursor: input.cursor as string | undefined,
        limit: input.limit as number
      }, options.now));
      return { ok: true, message: `Listed ${data.spans.length} trace spans`, data, truncated: data.nextCursor !== null };
    }
    case 'agent_trace_export': {
      const { trace, spans } = store.exportable(principalId, input.traceId as string, options.now, options.maxSpans);
      const data = traceResult(store, operation, renderTraceExport(trace, spans, input.format as TraceExportFormat));
      return { ok: true, message: `Exported agent trace as ${data.format}`, data, truncated: data.truncated };
    }
  }
}

/**
 * Parses a trace result against the operation's strict public result schema, so a field the schema
 * does not list fails the call instead of reaching the caller.
 */
function traceResult<Operation extends AgentTraceOperation>(
  store: AgentTraceStore,
  operation: Operation,
  data: unknown
): z.infer<(typeof AGENT_TRACE_RESULT_SCHEMAS)[Operation]> {
  const parsed = AGENT_TRACE_RESULT_SCHEMAS[operation].safeParse(data);
  if (!parsed.success) {
    store.reportContractViolation(operation, parsed.error.issues);
    throw new HarnessError('INTERNAL_ERROR', `${operation} produced a result outside its contract`, 500, false);
  }
  return parsed.data as z.infer<(typeof AGENT_TRACE_RESULT_SCHEMAS)[Operation]>;
}