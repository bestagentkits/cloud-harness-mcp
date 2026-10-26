import { z } from 'zod';
import { AgentIdSchema, WorkspaceIdSchema } from './identifiers.js';
import { AutomationWorkflowIdSchema } from './automations-api.js';

/**
 * Durable agent traces: one trace per agent run generation, made of bounded spans recorded by the
 * runner at span boundaries. Traces carry identifiers, timings, token and cost figures, outcomes and
 * digests only. Prompts, model output, raw tool arguments, headers and environment values are never
 * part of these shapes; every object is strict so an extra field cannot ride along.
 */

/**
 * Span kinds. `action` spans record brokered coding actions, `decision` spans the advisor consult behind
 * one of them, and `approval` spans an owner approval of one (requested, then decided); `workflow` is
 * reserved for a later producer.
 */
export const TRACE_SPAN_KINDS = [
  'agent_run', 'model_call', 'tool_call', 'gateway', 'budget', 'hook',
  'workflow', 'action', 'decision', 'approval'
] as const;
export const TraceSpanKindSchema = z.enum(TRACE_SPAN_KINDS);
export type TraceSpanKind = z.infer<typeof TraceSpanKindSchema>;

export const TRACE_STATES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'EXPIRED', 'INCOMPLETE'] as const;
export const TraceStateSchema = z.enum(TRACE_STATES);
export type TraceState = z.infer<typeof TraceStateSchema>;

export const TRACE_SPAN_STATES = ['OPEN', 'OK', 'ERROR', 'UNKNOWN'] as const;
export const TraceSpanStateSchema = z.enum(TRACE_SPAN_STATES);
export type TraceSpanState = z.infer<typeof TraceSpanStateSchema>;

export const TraceCostProvenanceSchema = z.enum(['estimated', 'gateway_settlement', 'unknown']);
export type TraceCostProvenance = z.infer<typeof TraceCostProvenanceSchema>;
export const TraceCoverageSchema = z.enum(['full', 'partial']);
export type TraceCoverage = z.infer<typeof TraceCoverageSchema>;

/** Bounded classification of a failed model call or tool call; never the provider's raw message. */
export const TRACE_ERROR_CLASSES = [
  'auth', 'rate_limit', 'server', 'timeout', 'network', 'context_length', 'aborted', 'invalid_request', 'tool', 'budget', 'other'
] as const;
export const TraceErrorClassSchema = z.enum(TRACE_ERROR_CLASSES);
export type TraceErrorClass = z.infer<typeof TraceErrorClassSchema>;

/** `trc_` followed by 26 lowercase base32 characters of sha256(agentId|generation). */
export const TraceIdSchema = z.string().regex(/^trc_[a-z2-7]{26}$/u, 'invalid trace identifier');
export type TraceId = z.infer<typeof TraceIdSchema>;
/** Span identifiers are unique within their trace. */
export const TraceSpanIdSchema = z.string().regex(/^spn_[a-z2-7]{16}$/u, 'invalid span identifier');

/**
 * Opaque, versioned page cursor. The runner encodes the page position, the filter fingerprint and
 * the anchor's retention deadline, so a cursor that outlives its anchor is reported as
 * `TRACE_EXPIRED` instead of silently skipping purged records.
 */
export const TraceCursorSchema = z.string().regex(/^tc1\.[A-Za-z0-9_-]{8,240}$/u, 'invalid trace cursor');

export const TRACE_EXPORT_FORMATS = ['json', 'csv', 'otlp-json'] as const;
export const TraceExportFormatSchema = z.enum(TRACE_EXPORT_FORMATS);
export type TraceExportFormat = z.infer<typeof TraceExportFormatSchema>;

/** Upper bound of one export document, in UTF-8 bytes. */
export const MAX_TRACE_EXPORT_BYTES = 4 * 1024 * 1024;

const isoTimestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nullableCount = count.nullable();
const durationMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

/**
 * Token counts. `prompt` is uncached input tokens only, on every path: cache reads and cache writes are
 * counted separately, so a model call's whole prompt is `prompt + cacheRead + cacheWrite`.
 */
export const TraceTokensSchema = z.object({
  prompt: nullableCount,
  cacheRead: nullableCount,
  cacheWrite: nullableCount,
  output: nullableCount,
  reasoning: nullableCount
}).strict();

export const TraceReconciliationStatusSchema = z.enum(['pending', 'reconciled', 'unreconciled']);
export const TRACE_RECONCILIATION_REASONS = [
  'input_tokens_mismatch', 'output_tokens_mismatch', 'cost_out_of_tolerance',
  'usage_unavailable', 'settlement_unavailable', 'unattributed_usage', 'recorder_degraded'
] as const;

export const TraceReconciliationSchema = z.object({
  status: TraceReconciliationStatusSchema,
  /** Reasons explain an `unreconciled` status, or a partial coverage that still reconciled. */
  reasons: z.array(z.enum(TRACE_RECONCILIATION_REASONS)).max(TRACE_RECONCILIATION_REASONS.length),
  /** Allowed cost difference: one micro-dollar of floor rounding per model call. */
  toleranceMicros: count,
  /** The agent usage ledger (`agent_status.usage`) at the end of the run. */
  ledger: z.object({ inputTokens: count, outputTokens: count, costMicros: count }).strict().nullable(),
  /** The sums over the trace's model_call spans. */
  spans: z.object({ inputTokens: count, outputTokens: count, costMicros: count }).strict(),
  /** The model gateway's measured settlement of the run's lease, when it was available. */
  gateway: z.object({
    promptTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    outputTokens: count,
    reasoningTokens: count,
    requests: count,
    requestsWithoutUsage: count,
    costMicros: count
  }).strict().nullable()
}).strict();
export type TraceReconciliation = z.infer<typeof TraceReconciliationSchema>;

export const TraceSummarySchema = z.object({
  traceId: TraceIdSchema,
  agentId: AgentIdSchema,
  workspaceId: WorkspaceIdSchema,
  generation: z.number().int().min(1),
  runId: z.string().max(128).nullable(),
  parentTraceId: TraceIdSchema.nullable(),
  workflowId: AutomationWorkflowIdSchema.nullable(),
  profileId: z.string().max(128).nullable(),
  profileRevisionId: z.string().max(128).nullable(),
  state: TraceStateSchema,
  finishReason: z.string().max(64).nullable(),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp.nullable(),
  durationMs,
  tokens: TraceTokensSchema,
  requests: nullableCount,
  requestsWithoutUsage: nullableCount,
  costMicros: nullableCount,
  costProvenance: TraceCostProvenanceSchema,
  coverage: TraceCoverageSchema,
  spanCount: count,
  truncated: z.boolean(),
  reconciliationStatus: TraceReconciliationStatusSchema,
  expiresAt: isoTimestamp
}).strict();
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

/** Latency percentiles are reported only over spans with both a start and an end timestamp. */
export const TraceLatencySchema = z.object({
  samples: count,
  p50Ms: durationMs,
  p95Ms: durationMs
}).strict();

export const TraceDetailSchema = TraceSummarySchema.extend({
  reconciliation: TraceReconciliationSchema,
  modelCalls: count,
  toolCalls: count,
  errors: count,
  modelLatency: TraceLatencySchema,
  ttft: TraceLatencySchema
}).strict();
export type TraceDetail = z.infer<typeof TraceDetailSchema>;

/** Span attributes come from a fixed allowlist of scalar fields; values are bounded scalars. */
export const TRACE_ATTRIBUTE_KEYS = [
  'operation', 'tool_call_id', 'request_id', 'outcome', 'retry_count', 'retried', 'brokered',
  'requests', 'requests_without_usage', 'reasoning_tokens', 'overrun_cost_micros', 'settlement_reason',
  'terminal_status', 'marker', 'dropped_spans', 'preview', 'usage_missing', 'turn',
  'reserved_cost_micros', 'settled_cost_micros', 'limit',
  'action_id', 'action_class', 'decision', 'reason_code', 'action_state', 'branch', 'commit_sha', 'pr_number', 'workflow_step',
  'approval_id', 'decision_id', 'advisor_effect', 'risk', 'confidence', 'fallback_reason'
] as const;
export const TraceAttributeKeySchema = z.enum(TRACE_ATTRIBUTE_KEYS);
export const TraceAttributeValueSchema = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
export const TraceAttributesSchema = z.partialRecord(TraceAttributeKeySchema, TraceAttributeValueSchema);
export type TraceAttributes = z.infer<typeof TraceAttributesSchema>;

export const TraceSpanSchema = z.object({
  spanSeq: z.number().int().min(0),
  spanId: TraceSpanIdSchema,
  parentSpanId: TraceSpanIdSchema.nullable(),
  kind: TraceSpanKindSchema,
  name: z.string().min(1).max(128),
  state: TraceSpanStateSchema,
  startedAt: isoTimestamp,
  endedAt: isoTimestamp.nullable(),
  durationMs,
  ttftMs: durationMs,
  tokens: z.object({ prompt: nullableCount, output: nullableCount, cacheRead: nullableCount, cacheWrite: nullableCount }).strict(),
  costMicros: nullableCount,
  attributes: TraceAttributesSchema,
  /** `sha256:` digest of the canonical tool input with credential-named key values removed; the input itself is never stored. */
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
  errorClass: TraceErrorClassSchema.nullable()
}).strict();
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const TraceCohortSchema = z.object({
  profileId: z.string().max(128).nullable(),
  traces: count,
  status: z.enum(['ok', 'insufficient_sample']),
  modelLatency: TraceLatencySchema.nullable(),
  ttft: TraceLatencySchema.nullable()
}).strict();

/** Minimum per-profile cohort size before percentiles are reported. */
export const TRACE_COHORT_MIN_SAMPLES = 20;

export const TraceListSummarySchema = z.object({
  traces: count,
  byState: z.partialRecord(TraceStateSchema, count),
  tokens: TraceTokensSchema,
  /** Sum over traces with a known cost; null when no trace in the window has one. */
  costMicros: nullableCount,
  /** Traces whose cost is unknown are counted here and excluded from `costMicros`. */
  unknownCostTraces: count,
  errorTraces: count,
  partialTraces: count,
  unreconciledTraces: count,
  modelLatency: TraceLatencySchema,
  ttft: TraceLatencySchema,
  cohorts: z.array(TraceCohortSchema).max(50),
  /** True when aggregates were computed over the most recent bounded sample of the window. */
  sampled: z.boolean()
}).strict();
export type TraceListSummary = z.infer<typeof TraceListSummarySchema>;

const traceFilters = {
  workspaceId: WorkspaceIdSchema.optional().describe('Only traces of this workspace; traces outlive their workspace.'),
  agentId: AgentIdSchema.optional(),
  profileId: z.string().min(1).max(128).optional(),
  state: TraceStateSchema.optional(),
  workflowId: AutomationWorkflowIdSchema.optional(),
  since: isoTimestamp.optional().describe('Inclusive lower bound on the trace start time.'),
  until: isoTimestamp.optional().describe('Exclusive upper bound on the trace start time.')
};

export const AgentTracesListInputSchema = z.object({
  ...traceFilters,
  cursor: TraceCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  includeSummary: z.boolean().default(true).describe('Compute the KPI summary for the filtered window. It is computed only for the first page (no cursor); later pages and a false value return null.')
}).strict().refine((input) => input.since === undefined || input.until === undefined || Date.parse(input.since) < Date.parse(input.until), {
  message: 'since must be before until', path: ['since']
});
export const AgentTraceGetInputSchema = z.object({ traceId: TraceIdSchema }).strict();
export const AgentTraceSpansInputSchema = z.object({
  traceId: TraceIdSchema,
  kind: TraceSpanKindSchema.optional(),
  cursor: TraceCursorSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200)
}).strict();
export const AgentTraceExportInputSchema = z.object({
  traceId: TraceIdSchema,
  format: TraceExportFormatSchema.default('json')
}).strict();

export const AgentTracesListResultSchema = z.object({
  traces: z.array(TraceSummarySchema).max(100),
  /** The window's KPI summary; null on a cursor page or when `includeSummary` is false. */
  summary: TraceListSummarySchema.nullable(),
  nextCursor: TraceCursorSchema.nullable()
}).strict();
export const AgentTraceGetResultSchema = z.object({ trace: TraceDetailSchema }).strict();
export const AgentTraceSpansResultSchema = z.object({
  traceId: TraceIdSchema,
  spans: z.array(TraceSpanSchema).max(500),
  nextCursor: TraceCursorSchema.nullable()
}).strict();
export const AgentTraceExportResultSchema = z.object({
  traceId: TraceIdSchema,
  format: TraceExportFormatSchema,
  contentType: z.enum(['application/json', 'text/csv']),
  filename: z.string().regex(/^trc_[a-z2-7]{26}\.(?:json|csv|otlp\.json)$/u),
  content: z.string().max(MAX_TRACE_EXPORT_BYTES),
  bytes: count,
  truncated: z.boolean()
}).strict();

export type AgentTracesListInput = z.infer<typeof AgentTracesListInputSchema>;
export type AgentTraceSpansInput = z.infer<typeof AgentTraceSpansInputSchema>;
export type AgentTraceExportInput = z.infer<typeof AgentTraceExportInputSchema>;
export type AgentTracesListResult = z.infer<typeof AgentTracesListResultSchema>;
export type AgentTraceGetResult = z.infer<typeof AgentTraceGetResultSchema>;
export type AgentTraceSpansResult = z.infer<typeof AgentTraceSpansResultSchema>;
export type AgentTraceExportResult = z.infer<typeof AgentTraceExportResultSchema>;

export const AGENT_TRACE_OPERATIONS = ['agent_traces_list', 'agent_trace_get', 'agent_trace_spans', 'agent_trace_export'] as const;
export type AgentTraceOperation = typeof AGENT_TRACE_OPERATIONS[number];
export function isAgentTraceOperation(operation: string): operation is AgentTraceOperation {
  return (AGENT_TRACE_OPERATIONS as readonly string[]).includes(operation);
}

export const AGENT_TRACE_RESULT_SCHEMAS = {
  agent_traces_list: AgentTracesListResultSchema,
  agent_trace_get: AgentTraceGetResultSchema,
  agent_trace_spans: AgentTraceSpansResultSchema,
  agent_trace_export: AgentTraceExportResultSchema
} as const;
