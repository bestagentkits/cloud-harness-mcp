import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TraceErrorClassSchema,
  type TraceAttributes,
  type TraceErrorClass,
  type TraceReconciliation,
  type TraceSpanKind,
  type TraceSpanState,
  type TraceState
} from '@cloud-harness/contracts';
import type { AgentLeaseSettlement } from './agent-gateway-control.js';
import { spanIdFor, traceIdFor, type AgentTraceStore, type SpanWrite } from './agent-trace-store.js';

/** The agent terminal statuses a run can end with. */
export type TraceTerminalStatus = 'CANCELLED' | 'TIMED_OUT' | 'LIMIT_EXCEEDED' | 'INTERRUPTED' | 'FAILED' | 'SUCCEEDED';

export type TraceRunKey = { agentId: string; generation: number };

export type TraceRunStart = TraceRunKey & {
  principalId: string;
  workspaceId: string;
  parent: TraceRunKey | null;
  profileId: string | null;
  profileRevisionId: string | null;
  at: number;
};

/** One reconcileUsage step: the deltas charged to the agent usage ledger plus the runtime's cumulative cache counters. */
export type TraceUsageDelta = {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  cacheReadTotal?: number | undefined;
  cacheWriteTotal?: number | undefined;
};

export type TraceLedgerTotals = { inputTokens: number; outputTokens: number; costMicros: number };

/**
 * One budget event of a run, recorded as a `budget` span: the spawn's cost reservation, the gateway
 * lease issue, and the run limit that ended it. The settlement against the reservation is recorded
 * from `settled` when the trace finishes.
 */
export type TraceBudgetEvent =
  | { phase: 'reserve'; reservedCostMicros: number; at: number }
  | { phase: 'lease_issue'; outcome: 'issued' | 'refused' | 'unknown'; startedAt: number; endedAt: number }
  | { phase: 'limit'; limit: 'output_bytes'; at: number };

export type TraceFinish = {
  terminal: TraceTerminalStatus;
  reason: string;
  ledger: TraceLedgerTotals | null;
  at: number;
};

/** The surface AgentManager drives. Implementations must never throw into the agent lifecycle. */
export interface AgentTraceHooks {
  begin(start: TraceRunStart): void;
  observeEvent(key: TraceRunKey, event: unknown, at: number): void;
  observeUsage(key: TraceRunKey, usage: TraceUsageDelta, at: number): void;
  toolRequested(key: TraceRunKey, request: { requestId: string; toolCallId?: string | undefined; operation: string; input: unknown }, at: number): void;
  toolCompleted(key: TraceRunKey, requestId: string, outcome: { ok: boolean }, at: number): void;
  budget(key: TraceRunKey, event: TraceBudgetEvent): void;
  settled(key: TraceRunKey, settlement: AgentLeaseSettlement | undefined, at: number): void;
  finish(key: TraceRunKey, finish: TraceFinish): void;
  markIncomplete(key: TraceRunKey, reason: string, at: number): void;
  /** Marks the run's trace partial after a hook failed outside the recorder. */
  degrade(key: TraceRunKey, error: unknown): void;
}

export type AgentTraceRecorderOptions = {
  maxSpansPerTrace: number;
  previewBytes: number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
};

/** Spans reserved for the truncation marker and the gateway and budget settlement spans written at finish. */
const RESERVED_SPANS = 3;
const MAX_SPAN_NAME = 128;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /authorization|api[-_]?key|token|lease|secret|credential|cookie|password|passwd|private[-_]?key|session|header|env/iu;
/**
 * Every quantifier is bounded, so each pattern does bounded work per start position and a string is
 * matched in linear time. Strings are also cut to REDACT_MAX_CHARS before matching.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4096}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/gu,
  /\b(bearer|basic)\s{1,8}[A-Za-z0-9._~+/=-]{6,1024}/giu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,512}/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,255}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}/gu,
  /\b([A-Za-z0-9_]{0,64}(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]{0,64})\s{0,8}[=:]\s{0,8}("[^"]{0,512}"|'[^']{0,512}'|[^\s,;&]{1,512})/giu
];
/**
 * Longest string prefix the redactor matches. Redaction feeds only the preview, which is at most 512
 * bytes of the serialized input, so a cut at this length always falls outside what can be stored.
 */
const REDACT_MAX_CHARS = 4_096;
/** Characters of string content one preview redaction visits before it stops descending. */
const PREVIEW_SCAN_CHARS = 16_384;
/** Longest key the sensitive-key test reads. */
const KEY_TEST_CHARS = 128;
const MAX_DIGEST_DEPTH = 64;

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.length > KEY_TEST_CHARS ? key.slice(0, KEY_TEST_CHARS) : key);
}

/**
 * Removes credential-shaped content from a value for the optional preview. Sensitive keys lose their
 * values entirely and secret-shaped substrings are replaced. The walk is bounded: it visits at most
 * PREVIEW_SCAN_CHARS of string content and matches at most REDACT_MAX_CHARS of each string, so its
 * cost does not grow with the size of the input.
 */
export function redactTraceValue(value: unknown, depth = 0, budget: { chars: number } = { chars: PREVIEW_SCAN_CHARS }): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (budget.chars <= 0) return '[TRUNCATED]';
  if (typeof value === 'string') {
    budget.chars -= Math.min(value.length, REDACT_MAX_CHARS);
    return redactTraceText(value);
  }
  if (depth >= 8) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, 256)) {
      if (budget.chars <= 0) break;
      items.push(redactTraceValue(item, depth + 1, budget));
    }
    return items;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort().slice(0, 256)) {
      if (budget.chars <= 0) break;
      budget.chars -= Math.min(key.length, KEY_TEST_CHARS);
      output[key] = sensitiveKey(key) ? REDACTED : redactTraceValue((value as Record<string, unknown>)[key], depth + 1, budget);
    }
    return output;
  }
  return null;
}

export function redactTraceText(text: string): string {
  let output = text.length > REDACT_MAX_CHARS ? `${text.slice(0, REDACT_MAX_CHARS)}[TRUNCATED]` : text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match: string, prefix: unknown) => {
      if (typeof prefix === 'string' && /^(?:bearer|basic)$/iu.test(prefix)) return `${prefix} ${REDACTED}`;
      if (typeof prefix === 'string' && prefix.length > 0 && match.startsWith(prefix)) return `${prefix}=${REDACTED}`;
      return REDACTED;
    });
  }
  return output;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  return new TextDecoder().decode(encoded.subarray(0, maxBytes)).replace(/�+$/u, '');
}

/**
 * Canonical form for the input digest: keys sorted, values of credential-named keys dropped. No
 * pattern is matched against values, so the digest costs one linear pass however large the input.
 */
function digestForm(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= MAX_DIGEST_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => digestForm(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sensitiveKey(key) ? REDACTED : digestForm((value as Record<string, unknown>)[key], depth + 1);
    }
    return output;
  }
  return null;
}

/**
 * `sha256:` digest of the canonical (sorted-key) JSON of the input, with the values of
 * credential-named keys removed. Only the one-way digest is stored, never the input.
 */
export function traceInputDigest(input: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(digestForm(input, 0)) ?? 'null').digest('hex')}`;
}

const LifecycleEventSchema = z.object({
  kind: z.literal('lifecycle'),
  phase: z.string(),
  outcome: z.string().max(32).optional(),
  errorClass: z.string().max(32).optional()
}).passthrough();
const ToolEventSchema = z.object({
  kind: z.literal('tool'),
  phase: z.string(),
  toolCallId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  isError: z.boolean().optional()
}).passthrough();
const KindSchema = z.object({ kind: z.string() }).passthrough();

type ModelSpan = {
  seq: number;
  spanId: string;
  startedAt: number;
  ttftMs: number | null;
  responseEndedAt: number | null;
  endedAt: number | null;
  outcome: string | null;
  errorClass: TraceErrorClass | null;
  retryCount: number;
  turn: number;
};

type ToolSpan = {
  seq: number;
  spanId: string;
  parentSpanId: string;
  name: string;
  startedAt: number;
  toolCallId: string | null;
  requestId: string | null;
  inputDigest: string | null;
  preview: string | null;
  brokeredOk: boolean | null;
  closed: boolean;
};

type Run = {
  traceId: string;
  rootSpanId: string;
  startedAt: number;
  nextSeq: number;
  written: number;
  truncated: boolean;
  dropped: number;
  markerSeq: number | null;
  model: ModelSpan | null;
  awaitingUsage: ModelSpan | null;
  lastModel: SpanWrite | null;
  tools: Map<string, ToolSpan>;
  proxies: Map<string, ToolSpan>;
  pendingRetries: number;
  turn: number;
  totals: { input: number; output: number; costMicros: number; cacheRead: number; cacheWrite: number; usageSeen: boolean };
  lastCache: { read: number; write: number };
  usageMissing: boolean;
  unknownSpans: boolean;
  unattributedUsage: boolean;
  settlement: AgentLeaseSettlement | undefined;
  settledAt: number | null;
  reservedCostMicros: number | null;
  limitRecorded: boolean;
  degraded: boolean;
};

function errorClassOf(value: string | undefined): TraceErrorClass | null {
  if (value === undefined) return null;
  const parsed = TraceErrorClassSchema.safeParse(value);
  return parsed.success ? parsed.data : 'other';
}

function traceStateOf(terminal: TraceTerminalStatus, settlement: AgentLeaseSettlement | undefined): TraceState {
  switch (terminal) {
    case 'SUCCEEDED': return 'COMPLETED';
    case 'CANCELLED': return 'CANCELLED';
    case 'TIMED_OUT': return settlement?.reason === 'expired' ? 'EXPIRED' : 'TIMED_OUT';
    case 'LIMIT_EXCEEDED': return 'FAILED';
    case 'INTERRUPTED': return 'FAILED';
    case 'FAILED': return settlement?.reason === 'expired' ? 'EXPIRED' : 'FAILED';
  }
}

function finishReasonOf(terminal: TraceTerminalStatus, state: TraceState): string {
  if (state === 'EXPIRED') return 'lease_expired';
  switch (terminal) {
    case 'SUCCEEDED': return 'completed';
    case 'CANCELLED': return 'cancelled';
    case 'TIMED_OUT': return 'timed_out';
    case 'LIMIT_EXCEEDED': return 'limit_exceeded';
    case 'INTERRUPTED': return 'runtime_exited';
    case 'FAILED': return 'failed';
  }
}

function rootStateOf(state: TraceState): TraceSpanState {
  if (state === 'COMPLETED' || state === 'CANCELLED') return 'OK';
  if (state === 'INCOMPLETE') return 'UNKNOWN';
  return 'ERROR';
}

/**
 * Records one trace per agent run generation. Observations update in-memory span state and the
 * store is written only at span boundaries, so text deltas cost no writes. Every public method is
 * guarded: a storage failure degrades the trace to partial coverage, is logged once per trace, and
 * never reaches the agent lifecycle.
 */
export class AgentTraceRecorder implements AgentTraceHooks {
  private readonly runs = new Map<string, Run>();
  private readonly loggedFailures = new Set<string>();
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(
    private readonly store: AgentTraceStore,
    private readonly options: AgentTraceRecorderOptions
  ) {
    this.log = options.log ?? ((entry) => { process.stderr.write(`${JSON.stringify(entry)}\n`); });
  }

  /** Number of runs with in-memory state; open runs only. */
  get openRuns(): number {
    return this.runs.size;
  }

  begin(start: TraceRunStart): void {
    const traceId = traceIdFor(start.agentId, start.generation);
    this.guard(traceId, () => {
      const created = this.store.createTrace({
        traceId,
        principalId: start.principalId,
        workspaceId: start.workspaceId,
        agentId: start.agentId,
        generation: start.generation,
        runId: null,
        parentTraceId: start.parent ? traceIdFor(start.parent.agentId, start.parent.generation) : null,
        workflowId: null,
        profileId: start.profileId,
        profileRevisionId: start.profileRevisionId,
        startedAt: start.at
      });
      if (!created) {
        this.attach(traceId);
        return;
      }
      const run = this.newRun(traceId, start.at, 0);
      this.runs.set(traceId, run);
      this.writeSpan(run, {
        seq: 0, spanId: run.rootSpanId, parentSpanId: null, kind: 'agent_run', name: 'agent.run', state: 'OPEN',
        startedAt: start.at, endedAt: null
      });
    });
  }

  observeEvent(key: TraceRunKey, event: unknown, at: number): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      const run = this.runs.get(traceId);
      if (!run) return;
      const kind = KindSchema.safeParse(event);
      if (!kind.success) return;
      switch (kind.data.kind) {
        case 'lifecycle': {
          const lifecycle = LifecycleEventSchema.safeParse(event);
          if (!lifecycle.success) return;
          if (lifecycle.data.phase === 'turn_started') this.openModel(run, at);
          else if (lifecycle.data.phase === 'turn_ended') this.endTurn(run, lifecycle.data.outcome, lifecycle.data.errorClass, at);
          return;
        }
        case 'text_delta':
          if (run.model && run.model.ttftMs === null) run.model.ttftMs = Math.max(0, at - run.model.startedAt);
          return;
        case 'tool': {
          const tool = ToolEventSchema.safeParse(event);
          if (!tool.success) return;
          if (tool.data.phase === 'started') this.startTool(run, tool.data.toolCallId, tool.data.name, at);
          else if (tool.data.phase === 'ended') this.endTool(run, tool.data.toolCallId, tool.data.isError === true, at);
          return;
        }
        case 'notice':
          // The runtime projects only the model client's automatic retry as a notice.
          run.pendingRetries += 1;
          return;
        default:
          return;
      }
    });
  }

  observeUsage(key: TraceRunKey, usage: TraceUsageDelta): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      const run = this.runs.get(traceId);
      if (!run) return;
      const cacheRead = usage.cacheReadTotal === undefined ? 0 : Math.max(0, usage.cacheReadTotal - run.lastCache.read);
      const cacheWrite = usage.cacheWriteTotal === undefined ? 0 : Math.max(0, usage.cacheWriteTotal - run.lastCache.write);
      if (usage.cacheReadTotal !== undefined) run.lastCache.read = Math.max(run.lastCache.read, usage.cacheReadTotal);
      if (usage.cacheWriteTotal !== undefined) run.lastCache.write = Math.max(run.lastCache.write, usage.cacheWriteTotal);
      run.totals.input += usage.inputTokens;
      run.totals.output += usage.outputTokens;
      run.totals.costMicros += usage.costMicros;
      run.totals.cacheRead += cacheRead;
      run.totals.cacheWrite += cacheWrite;
      // Any positive figure is a report: a call can be billed (cost) with zero counted tokens.
      const reported = usage.inputTokens > 0 || usage.outputTokens > 0 || usage.costMicros > 0;
      if (reported) run.totals.usageSeen = true;
      const delta = { input: usage.inputTokens, output: usage.outputTokens, cost: usage.costMicros, cacheRead, cacheWrite };
      if (run.awaitingUsage) {
        this.closeModel(run, run.awaitingUsage, reported ? delta : null);
        run.awaitingUsage = null;
        return;
      }
      if (!reported) return;
      // Usage reported outside a model turn (for example at agent end) belongs to the latest call.
      if (run.lastModel) {
        const last = run.lastModel;
        last.promptTokens = (last.promptTokens ?? 0) + delta.input;
        last.outputTokens = (last.outputTokens ?? 0) + delta.output;
        last.costMicros = (last.costMicros ?? 0) + delta.cost;
        last.cacheReadTokens = (last.cacheReadTokens ?? 0) + delta.cacheRead;
        last.cacheWriteTokens = (last.cacheWriteTokens ?? 0) + delta.cacheWrite;
        this.store.writeSpan(last);
      } else {
        run.unattributedUsage = true;
      }
    });
  }

  toolRequested(key: TraceRunKey, request: { requestId: string; toolCallId?: string | undefined; operation: string; input: unknown }, at: number): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      const run = this.runs.get(traceId);
      if (!run) return;
      const inputDigest = traceInputDigest(request.input);
      const preview = this.preview(request.input);
      // Bind the brokered request to the runtime's open tool span for the same operation, so one
      // tool call is one span; an older runtime without tool events gets a span of its own.
      const byCallId = request.toolCallId === undefined ? undefined : run.tools.get(request.toolCallId);
      const bound = byCallId && !byCallId.closed && byCallId.requestId === null
        ? byCallId
        : [...run.tools.values()].find((tool) => !tool.closed && tool.requestId === null && tool.name === request.operation);
      if (bound) {
        bound.requestId = request.requestId;
        bound.inputDigest = inputDigest;
        bound.preview = preview;
        run.proxies.set(request.requestId, bound);
        return;
      }
      const seq = this.allocate(run, at);
      if (seq === null) return;
      const tool: ToolSpan = {
        seq, spanId: spanIdFor(traceId, seq), parentSpanId: (run.model ?? run.awaitingUsage)?.spanId ?? run.rootSpanId,
        name: request.operation.slice(0, MAX_SPAN_NAME), startedAt: at, toolCallId: null, requestId: request.requestId,
        inputDigest, preview, brokeredOk: null, closed: false
      };
      run.proxies.set(request.requestId, tool);
      this.writeTool(run, tool, 'OPEN', null, null);
    });
  }

  toolCompleted(key: TraceRunKey, requestId: string, outcome: { ok: boolean }, at: number): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      const run = this.runs.get(traceId);
      if (!run) return;
      const tool = run.proxies.get(requestId);
      if (!tool) return;
      run.proxies.delete(requestId);
      tool.brokeredOk = outcome.ok;
      // A span bound to a runtime tool event is closed by that event; a standalone one closes here.
      if (tool.toolCallId === null) {
        tool.closed = true;
        this.writeTool(run, tool, outcome.ok ? 'OK' : 'ERROR', at, outcome.ok ? null : 'tool');
      }
    });
  }

  budget(key: TraceRunKey, event: TraceBudgetEvent): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      const run = this.runs.get(traceId);
      if (!run) return;
      if (event.phase === 'reserve') {
        run.reservedCostMicros = event.reservedCostMicros;
        this.writeBudget(run, 'reserve', 'OK', event.at, event.at, { reserved_cost_micros: event.reservedCostMicros });
      } else if (event.phase === 'lease_issue') {
        const state: TraceSpanState = event.outcome === 'issued' ? 'OK' : (event.outcome === 'refused' ? 'ERROR' : 'UNKNOWN');
        this.writeBudget(run, 'lease_issue', state, event.startedAt, event.endedAt, { outcome: event.outcome });
      } else {
        // Every later write past the limit fails the same way; the run records the limit once.
        if (run.limitRecorded) return;
        run.limitRecorded = true;
        this.writeBudget(run, 'limit', 'ERROR', event.at, event.at, { limit: event.limit });
      }
    });
  }

  settled(key: TraceRunKey, settlement: AgentLeaseSettlement | undefined, at: number): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      const run = this.runs.get(traceId) ?? this.attach(traceId);
      if (!run) return;
      run.settledAt = at;
      if (settlement) run.settlement = settlement;
    });
  }

  finish(key: TraceRunKey, finish: TraceFinish): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      // The run ends here whatever the stored trace says, so its in-memory state never outlives it.
      const live = this.runs.get(traceId);
      this.runs.delete(traceId);
      const existing = this.store.findTrace(traceId);
      // A finished trace is final; only a running or restart-interrupted one is closed here.
      if (!existing || (existing.state !== 'RUNNING' && existing.state !== 'INCOMPLETE')) return;
      if (existing.state === 'INCOMPLETE' && existing.reconciliation !== null) return;
      const run = live ?? this.attach(traceId);
      this.runs.delete(traceId);
      if (!run) return;
      const at = finish.at;
      if (run.awaitingUsage) {
        this.closeModel(run, run.awaitingUsage, null);
        run.awaitingUsage = null;
      }
      if (run.model) {
        run.unknownSpans = true;
        this.writeModel(run, run.model, 'UNKNOWN', at, null, { usage_missing: true });
        run.model = null;
      }
      for (const tool of run.tools.values()) {
        if (tool.closed) continue;
        tool.closed = true;
        run.unknownSpans = true;
        this.writeTool(run, tool, 'UNKNOWN', at, null);
      }
      for (const tool of run.proxies.values()) {
        if (tool.closed) continue;
        tool.closed = true;
        run.unknownSpans = true;
        this.writeTool(run, tool, 'UNKNOWN', at, null);
      }
      const settlement = run.settlement;
      // The gateway's promptTokens is the whole prompt, cached tokens included; trace and span
      // `prompt` figures are uncached input, so the cached share is taken out here. The
      // reconciliation keeps the gateway's own total.
      const uncachedPrompt = settlement
        ? Math.max(0, settlement.promptTokens - settlement.cacheReadTokens - settlement.cacheWriteTokens)
        : null;
      if (run.settledAt !== null) {
        // The budget view of the settlement: what the lease reserved against what it actually cost.
        const seq = run.nextSeq;
        run.nextSeq += 1;
        const attributes: TraceAttributes = {};
        if (run.reservedCostMicros !== null) attributes.reserved_cost_micros = run.reservedCostMicros;
        if (settlement) {
          attributes.settled_cost_micros = settlement.costMicros;
          attributes.overrun_cost_micros = settlement.overrunCostMicros;
          attributes.settlement_reason = settlement.reason;
        }
        const settledAt = Math.max(run.startedAt, run.settledAt);
        this.store.writeSpan({
          traceId, spanSeq: seq, spanId: spanIdFor(traceId, seq), parentSpanId: run.rootSpanId, kind: 'budget',
          name: 'budget.settle', state: settlement ? 'OK' : 'UNKNOWN', startedAt: settledAt, endedAt: settledAt, ttftMs: null,
          promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
          attributes, inputDigest: null, errorClass: null
        });
        run.written += 1;
      }
      if (settlement) {
        const seq = run.nextSeq;
        run.nextSeq += 1;
        this.store.writeSpan({
          traceId, spanSeq: seq, spanId: spanIdFor(traceId, seq), parentSpanId: run.rootSpanId, kind: 'gateway',
          name: 'gateway.settlement', state: 'OK', startedAt: run.startedAt, endedAt: Math.max(run.startedAt, at), ttftMs: null,
          promptTokens: uncachedPrompt, outputTokens: settlement.outputTokens,
          cacheReadTokens: settlement.cacheReadTokens, cacheWriteTokens: settlement.cacheWriteTokens,
          costMicros: settlement.costMicros,
          attributes: {
            requests: settlement.requests,
            requests_without_usage: settlement.requestsWithoutUsage,
            reasoning_tokens: settlement.reasoningTokens,
            overrun_cost_micros: settlement.overrunCostMicros,
            settlement_reason: settlement.reason
          },
          inputDigest: null, errorClass: null
        });
        run.written += 1;
      }
      if (run.markerSeq !== null) {
        this.store.writeSpan({
          traceId, spanSeq: run.markerSeq, spanId: spanIdFor(traceId, run.markerSeq), parentSpanId: run.rootSpanId,
          kind: 'agent_run', name: 'trace.truncated', state: 'UNKNOWN', startedAt: run.startedAt, endedAt: at, ttftMs: null,
          promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
          attributes: { marker: 'truncated', dropped_spans: run.dropped }, inputDigest: null, errorClass: null
        });
      }
      const incomplete = existing.state === 'INCOMPLETE';
      const state: TraceState = incomplete ? 'INCOMPLETE' : traceStateOf(finish.terminal, settlement);
      this.store.writeSpan({
        traceId, spanSeq: 0, spanId: run.rootSpanId, parentSpanId: null, kind: 'agent_run', name: 'agent.run',
        state: rootStateOf(state), startedAt: run.startedAt, endedAt: Math.max(run.startedAt, at), ttftMs: null,
        promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
        attributes: { terminal_status: finish.terminal }, inputDigest: null, errorClass: state === 'FAILED' ? 'other' : null
      });
      const sums = this.store.modelSpanSums(traceId);
      const reasons: TraceReconciliation['reasons'] = [];
      const ledger = finish.ledger;
      if (!ledger) reasons.push('usage_unavailable');
      else {
        if (sums.inputTokens !== ledger.inputTokens) reasons.push('input_tokens_mismatch');
        if (sums.outputTokens !== ledger.outputTokens) reasons.push('output_tokens_mismatch');
        if (Math.abs(sums.costMicros - ledger.costMicros) > sums.modelSpans) reasons.push('cost_out_of_tolerance');
      }
      if (!settlement) reasons.push('settlement_unavailable');
      if (run.unattributedUsage) reasons.push('unattributed_usage');
      if (run.degraded || this.loggedFailures.has(traceId)) reasons.push('recorder_degraded');
      const mismatch = reasons.some((reason) => reason === 'input_tokens_mismatch' || reason === 'output_tokens_mismatch'
        || reason === 'cost_out_of_tolerance' || reason === 'usage_unavailable' || reason === 'recorder_degraded');
      const reconciliation: TraceReconciliation = {
        status: mismatch ? 'unreconciled' : 'reconciled',
        reasons,
        toleranceMicros: sums.modelSpans,
        ledger,
        spans: { inputTokens: sums.inputTokens, outputTokens: sums.outputTokens, costMicros: sums.costMicros },
        gateway: settlement ? {
          promptTokens: settlement.promptTokens, cacheReadTokens: settlement.cacheReadTokens, cacheWriteTokens: settlement.cacheWriteTokens,
          outputTokens: settlement.outputTokens, reasoningTokens: settlement.reasoningTokens, requests: settlement.requests,
          requestsWithoutUsage: settlement.requestsWithoutUsage, costMicros: settlement.costMicros
        } : null
      };
      const usageSeen = run.totals.usageSeen || sums.inputTokens > 0 || sums.outputTokens > 0;
      const totals = run.totals.usageSeen ? run.totals : {
        input: sums.inputTokens, output: sums.outputTokens, costMicros: sums.costMicros, cacheRead: run.totals.cacheRead, cacheWrite: run.totals.cacheWrite
      };
      const partial = incomplete || run.degraded || existing.coverage === 'partial' || run.truncated || run.usageMissing
        || run.unknownSpans || !settlement || settlement.requestsWithoutUsage > 0;
      this.store.updateTrace(traceId, {
        state,
        finishReason: incomplete ? (existing.finishReason ?? 'runner_restart') : finishReasonOf(finish.terminal, state),
        endedAt: existing.endedAt ?? Math.max(run.startedAt, at),
        promptTokens: usageSeen ? totals.input : uncachedPrompt,
        outputTokens: usageSeen ? totals.output : (settlement?.outputTokens ?? null),
        cacheReadTokens: usageSeen ? totals.cacheRead : (settlement?.cacheReadTokens ?? null),
        cacheWriteTokens: usageSeen ? totals.cacheWrite : (settlement?.cacheWriteTokens ?? null),
        reasoningTokens: settlement?.reasoningTokens ?? null,
        requests: settlement?.requests ?? null,
        requestsWithoutUsage: settlement?.requestsWithoutUsage ?? null,
        costMicros: usageSeen ? totals.costMicros : (settlement ? settlement.costMicros : null),
        costProvenance: usageSeen ? 'estimated' : (settlement ? 'gateway_settlement' : 'unknown'),
        reconciliation,
        coverage: partial ? 'partial' : 'full',
        truncated: run.truncated,
        expiresAt: this.store.retentionDeadline(Math.max(run.startedAt, at))
      });
    });
  }

  markIncomplete(key: TraceRunKey, reason: string, at: number): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    this.guard(traceId, () => {
      this.runs.delete(traceId);
      this.store.markIncomplete(traceId, at, reason.slice(0, 64));
    });
  }

  degrade(key: TraceRunKey, error: unknown): void {
    const traceId = traceIdFor(key.agentId, key.generation);
    const run = this.runs.get(traceId);
    if (run) run.degraded = true;
    this.reportFailure(traceId, error);
    try {
      this.store.markPartial(traceId);
    } catch {
      // Storage is unavailable; the in-memory flag still downgrades the trace at finish.
    }
  }

  private guard(traceId: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      const run = this.runs.get(traceId);
      if (run) run.degraded = true;
      this.reportFailure(traceId, error);
      try {
        this.store.markPartial(traceId);
      } catch {
        // Storage is unavailable; the in-memory flag still downgrades the trace at finish.
      }
    }
  }

  private reportFailure(traceId: string, error: unknown): void {
    if (this.loggedFailures.has(traceId)) return;
    this.loggedFailures.add(traceId);
    if (this.loggedFailures.size > 10_000) this.loggedFailures.clear();
    this.log({
      level: 'warn', time: Date.now(), msg: 'agent trace recording degraded', traceId,
      error: (error instanceof Error ? error.message : 'trace recording failed').slice(0, 300)
    });
  }

  /** Rebuilds minimal state for a trace this process did not start, for example after a restart. */
  private attach(traceId: string): Run | undefined {
    const existing = this.runs.get(traceId);
    if (existing) return existing;
    const row = this.store.findTrace(traceId);
    if (!row || (row.state !== 'RUNNING' && row.state !== 'INCOMPLETE')) return undefined;
    const run = this.newRun(traceId, row.startedAt, this.store.nextSpanSeq(traceId));
    run.written = row.spanCount;
    run.truncated = row.truncated;
    // A running trace this process never observed has lost its in-memory span state.
    run.degraded = row.state === 'RUNNING';
    this.runs.set(traceId, run);
    return run;
  }

  private newRun(traceId: string, startedAt: number, nextSeq: number): Run {
    return {
      traceId, rootSpanId: spanIdFor(traceId, 0), startedAt, nextSeq: Math.max(1, nextSeq), written: 0,
      truncated: false, dropped: 0, markerSeq: null, model: null, awaitingUsage: null, lastModel: null,
      tools: new Map(), proxies: new Map(), pendingRetries: 0, turn: 0,
      totals: { input: 0, output: 0, costMicros: 0, cacheRead: 0, cacheWrite: 0, usageSeen: false },
      lastCache: { read: 0, write: 0 }, usageMissing: false, unknownSpans: false, unattributedUsage: false,
      settlement: undefined, settledAt: null, reservedCostMicros: null, limitRecorded: false, degraded: false
    };
  }

  /** Allocates the next span sequence, or null once the cap is reached (writing the marker once). */
  private allocate(run: Run, at: number): number | null {
    if (run.truncated) {
      run.dropped += 1;
      return null;
    }
    if (run.written >= this.options.maxSpansPerTrace - RESERVED_SPANS) {
      run.truncated = true;
      run.dropped += 1;
      run.markerSeq = run.nextSeq;
      run.nextSeq += 1;
      run.written += 1;
      this.store.writeSpan({
        traceId: run.traceId, spanSeq: run.markerSeq, spanId: spanIdFor(run.traceId, run.markerSeq), parentSpanId: run.rootSpanId,
        kind: 'agent_run', name: 'trace.truncated', state: 'UNKNOWN', startedAt: Math.max(run.startedAt, at), endedAt: null,
        ttftMs: null, promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
        attributes: { marker: 'truncated', dropped_spans: run.dropped }, inputDigest: null, errorClass: null
      });
      this.store.updateTrace(run.traceId, { truncated: true, coverage: 'partial' });
      return null;
    }
    const seq = run.nextSeq;
    run.nextSeq += 1;
    run.written += 1;
    return seq;
  }

  private writeSpan(run: Run, span: { seq: number; spanId: string; parentSpanId: string | null; kind: TraceSpanKind; name: string; state: TraceSpanState; startedAt: number; endedAt: number | null }): void {
    if (span.seq === 0) run.written += 1;
    this.store.writeSpan({
      traceId: run.traceId, spanSeq: span.seq, spanId: span.spanId, parentSpanId: span.parentSpanId, kind: span.kind,
      name: span.name, state: span.state, startedAt: span.startedAt, endedAt: span.endedAt, ttftMs: null,
      promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
      attributes: {}, inputDigest: null, errorClass: null
    });
  }

  private writeBudget(run: Run, phase: 'reserve' | 'lease_issue' | 'limit', state: TraceSpanState, startedAt: number, endedAt: number, attributes: TraceAttributes): void {
    const seq = this.allocate(run, startedAt);
    if (seq === null) return;
    const start = Math.max(run.startedAt, startedAt);
    this.store.writeSpan({
      traceId: run.traceId, spanSeq: seq, spanId: spanIdFor(run.traceId, seq), parentSpanId: run.rootSpanId, kind: 'budget',
      name: `budget.${phase}`, state, startedAt: start, endedAt: Math.max(start, endedAt), ttftMs: null,
      promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
      attributes, inputDigest: null, errorClass: state === 'ERROR' ? 'budget' : null
    });
  }

  private openModel(run: Run, at: number): void {
    if (run.awaitingUsage) {
      this.closeModel(run, run.awaitingUsage, null);
      run.awaitingUsage = null;
    }
    if (run.model) {
      // A new turn began without the previous one ending: its outcome is unknown.
      run.unknownSpans = true;
      this.writeModel(run, run.model, 'UNKNOWN', at, null, {});
      run.model = null;
    }
    run.turn += 1;
    const retries = run.pendingRetries;
    run.pendingRetries = 0;
    const seq = this.allocate(run, at);
    if (seq === null) return;
    const model: ModelSpan = {
      seq, spanId: spanIdFor(run.traceId, seq), startedAt: at, ttftMs: null, responseEndedAt: null, endedAt: null,
      outcome: null, errorClass: null, retryCount: retries, turn: run.turn
    };
    run.model = model;
    this.writeModel(run, model, 'OPEN', null, null, {});
  }

  private endTurn(run: Run, outcome: string | undefined, errorClass: string | undefined, at: number): void {
    const model = run.model;
    if (!model) return;
    run.model = null;
    model.endedAt = model.responseEndedAt ?? at;
    model.outcome = outcome ?? 'unknown';
    model.errorClass = outcome === 'error' || outcome === 'aborted' || errorClass !== undefined
      ? (errorClassOf(errorClass) ?? (outcome === 'aborted' ? 'aborted' : 'other'))
      : null;
    run.awaitingUsage = model;
  }

  private closeModel(run: Run, model: ModelSpan, usage: { input: number; output: number; cost: number; cacheRead: number; cacheWrite: number } | null): void {
    const failed = model.errorClass !== null;
    const unknownOutcome = model.outcome === null || model.outcome === 'unknown';
    if (!usage && !failed) run.usageMissing = true;
    const state: TraceSpanState = failed ? 'ERROR' : (unknownOutcome && !usage ? 'UNKNOWN' : 'OK');
    if (state === 'UNKNOWN') run.unknownSpans = true;
    const attributes: TraceAttributes = {};
    if (!usage && !failed) attributes.usage_missing = true;
    this.writeModel(run, model, state, model.endedAt, usage, attributes);
  }

  private writeModel(
    run: Run,
    model: ModelSpan,
    state: TraceSpanState,
    endedAt: number | null,
    usage: { input: number; output: number; cost: number; cacheRead: number; cacheWrite: number } | null,
    extra: TraceAttributes
  ): void {
    const attributes: TraceAttributes = { turn: model.turn, ...extra };
    if (model.outcome !== null) attributes.outcome = model.outcome.slice(0, 32);
    if (model.retryCount > 0) attributes.retry_count = model.retryCount;
    const span: SpanWrite = {
      traceId: run.traceId, spanSeq: model.seq, spanId: model.spanId, parentSpanId: run.rootSpanId, kind: 'model_call',
      name: 'model.call', state, startedAt: model.startedAt, endedAt: endedAt === null ? null : Math.max(model.startedAt, endedAt),
      ttftMs: model.ttftMs,
      promptTokens: usage?.input ?? null, outputTokens: usage?.output ?? null,
      cacheReadTokens: usage?.cacheRead ?? null, cacheWriteTokens: usage?.cacheWrite ?? null,
      costMicros: usage?.cost ?? null,
      attributes, inputDigest: null, errorClass: state === 'ERROR' ? (model.errorClass ?? 'other') : null
    };
    this.store.writeSpan(span);
    if (state !== 'OPEN') run.lastModel = span;
  }

  private startTool(run: Run, toolCallId: string, name: string, at: number): void {
    if (run.tools.has(toolCallId)) return;
    // The model's response is complete once it asks for a tool; the call's latency ends here.
    if (run.model && run.model.responseEndedAt === null) run.model.responseEndedAt = at;
    const seq = this.allocate(run, at);
    if (seq === null) return;
    const tool: ToolSpan = {
      seq, spanId: spanIdFor(run.traceId, seq), parentSpanId: run.model?.spanId ?? run.rootSpanId,
      name: name.slice(0, MAX_SPAN_NAME), startedAt: at, toolCallId, requestId: null, inputDigest: null, preview: null,
      brokeredOk: null, closed: false
    };
    run.tools.set(toolCallId, tool);
    this.writeTool(run, tool, 'OPEN', null, null);
  }

  private endTool(run: Run, toolCallId: string, isError: boolean, at: number): void {
    const tool = run.tools.get(toolCallId);
    if (!tool || tool.closed) return;
    tool.closed = true;
    if (tool.requestId !== null) run.proxies.delete(tool.requestId);
    this.writeTool(run, tool, isError ? 'ERROR' : 'OK', at, isError ? 'tool' : null);
  }

  private writeTool(run: Run, tool: ToolSpan, state: TraceSpanState, endedAt: number | null, errorClass: TraceErrorClass | null): void {
    const attributes: TraceAttributes = { operation: tool.name };
    if (tool.toolCallId !== null) attributes.tool_call_id = tool.toolCallId;
    if (tool.requestId !== null) {
      attributes.request_id = tool.requestId;
      attributes.brokered = true;
    }
    if (tool.brokeredOk !== null) attributes.outcome = tool.brokeredOk ? 'ok' : 'error';
    if (tool.preview !== null) attributes.preview = tool.preview;
    this.store.writeSpan({
      traceId: run.traceId, spanSeq: tool.seq, spanId: tool.spanId, parentSpanId: tool.parentSpanId, kind: 'tool_call',
      name: tool.name, state, startedAt: tool.startedAt, endedAt: endedAt === null ? null : Math.max(tool.startedAt, endedAt),
      ttftMs: null, promptTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicros: null,
      attributes, inputDigest: tool.inputDigest, errorClass
    });
  }

  private preview(input: unknown): string | null {
    const bytes = Math.min(512, Math.max(0, this.options.previewBytes));
    if (bytes === 0) return null;
    return truncateUtf8(JSON.stringify(redactTraceValue(input)) ?? '', bytes);
  }
}
