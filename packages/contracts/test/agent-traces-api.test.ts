import { describe, expect, it } from 'vitest';
import {
  AGENT_TRACE_OPERATIONS,
  AgentTraceExportInputSchema,
  AgentTraceExportResultSchema,
  AgentTraceSpansInputSchema,
  AgentTracesListInputSchema,
  ErrorCodeSchema,
  RunnerOperationSchema,
  TOOL_SCHEMA_BY_NAME,
  TOOL_SPECS,
  TraceAttributesSchema,
  TraceSpanSchema,
  TraceSummarySchema,
  isAgentTraceOperation
} from '../src/index.js';

const traceId = `trc_${'a'.repeat(26)}`;
const spanId = `spn_${'b'.repeat(16)}`;

const summary = {
  traceId,
  agentId: `agent_${'c'.repeat(24)}`,
  workspaceId: `ws_${'d'.repeat(24)}`,
  generation: 1,
  runId: null,
  parentTraceId: null,
  workflowId: null,
  profileId: 'default',
  profileRevisionId: null,
  state: 'COMPLETED',
  finishReason: 'completed',
  startedAt: '2026-10-19T10:00:00.000Z',
  endedAt: '2026-10-19T10:00:05.000Z',
  durationMs: 5_000,
  tokens: { prompt: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: null },
  requests: 1,
  requestsWithoutUsage: 0,
  costMicros: 3,
  costProvenance: 'estimated',
  coverage: 'full',
  spanCount: 3,
  truncated: false,
  reconciliationStatus: 'reconciled',
  expiresAt: '2026-11-02T10:00:05.000Z'
};

describe('agent trace contracts', () => {
  it('publishes the four trace operations as runner operations and read-only tools', () => {
    for (const operation of AGENT_TRACE_OPERATIONS) {
      expect(RunnerOperationSchema.parse(operation)).toBe(operation);
      expect(isAgentTraceOperation(operation)).toBe(true);
      expect(TOOL_SCHEMA_BY_NAME[operation]).toBeDefined();
      expect(TOOL_SPECS.find((spec) => spec.name === operation)).toMatchObject({ readOnly: true, destructive: false, idempotent: true, openWorld: false });
    }
    expect(isAgentTraceOperation('agent_spawn')).toBe(false);
    expect(ErrorCodeSchema.parse('TRACE_EXPIRED')).toBe('TRACE_EXPIRED');
    expect(ErrorCodeSchema.parse('FEATURE_DISABLED')).toBe('FEATURE_DISABLED');
  });

  it('bounds list, span and export inputs', () => {
    expect(AgentTracesListInputSchema.parse({})).toEqual({ limit: 25 });
    expect(AgentTracesListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(AgentTracesListInputSchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);
    expect(AgentTracesListInputSchema.safeParse({ since: '2026-10-19T10:00:00Z', until: '2026-10-19T09:00:00Z' }).success).toBe(false);
    expect(AgentTracesListInputSchema.safeParse({ principalId: 'someone-else' }).success).toBe(false);
    expect(AgentTraceSpansInputSchema.parse({ traceId })).toEqual({ traceId, limit: 200 });
    expect(AgentTraceSpansInputSchema.safeParse({ traceId, limit: 501 }).success).toBe(false);
    expect(AgentTraceSpansInputSchema.safeParse({ traceId: 'trc_UPPER' }).success).toBe(false);
    expect(AgentTraceExportInputSchema.parse({ traceId })).toEqual({ traceId, format: 'json' });
    expect(AgentTraceExportInputSchema.safeParse({ traceId, format: 'xml' }).success).toBe(false);
  });

  it('keeps summaries strict and represents unknown figures as null, not zero', () => {
    expect(TraceSummarySchema.parse({ ...summary, tokens: { ...summary.tokens, prompt: null }, costMicros: null, costProvenance: 'unknown' }).costMicros).toBeNull();
    expect(TraceSummarySchema.safeParse({ ...summary, prompt: 'leaked prompt text' }).success).toBe(false);
    expect(TraceSummarySchema.safeParse({ ...summary, costMicros: -1 }).success).toBe(false);
  });

  it('accepts only allowlisted scalar span attributes and sha256 digests', () => {
    const span = {
      spanSeq: 1, spanId, parentSpanId: null, kind: 'tool_call', name: 'files_read', state: 'OK',
      startedAt: '2026-10-19T10:00:00.000Z', endedAt: '2026-10-19T10:00:00.010Z', durationMs: 10, ttftMs: null,
      tokens: { prompt: null, output: null, cacheRead: null, cacheWrite: null }, costMicros: null,
      attributes: { operation: 'files_read', brokered: true }, inputDigest: `sha256:${'e'.repeat(64)}`, errorClass: null
    };
    expect(TraceSpanSchema.parse(span)).toEqual(span);
    expect(TraceSpanSchema.safeParse({ ...span, inputDigest: '{"path":"a"}' }).success).toBe(false);
    expect(TraceSpanSchema.safeParse({ ...span, input: { path: 'a' } }).success).toBe(false);
    expect(TraceAttributesSchema.safeParse({ authorization: 'Bearer x' }).success).toBe(false);
    expect(TraceAttributesSchema.safeParse({ operation: { nested: true } }).success).toBe(false);
    expect(TraceAttributesSchema.safeParse({ preview: 'x'.repeat(513) }).success).toBe(false);
  });

  it('bounds exports to the documented formats and file names', () => {
    const result = { traceId, format: 'otlp-json', contentType: 'application/json', filename: `${traceId}.otlp.json`, content: '{}', bytes: 2, truncated: false };
    expect(AgentTraceExportResultSchema.parse(result)).toEqual(result);
    expect(AgentTraceExportResultSchema.safeParse({ ...result, filename: '../etc/passwd' }).success).toBe(false);
    expect(AgentTraceExportResultSchema.safeParse({ ...result, contentType: 'text/html' }).success).toBe(false);
  });
});
