import { createHash } from 'node:crypto';
import {
  MAX_TRACE_EXPORT_BYTES,
  type AgentTraceExportResult,
  type TraceDetail,
  type TraceExportFormat,
  type TraceSpan
} from '@cloud-harness/contracts';

/**
 * Pull-only trace export. Each format is rendered from the already-redacted trace DTOs, so an
 * export can contain nothing the read tools would not return. Nothing here opens a connection:
 * pushing to an external collector is deliberately out of scope.
 */

const CSV_COLUMNS = [
  'trace_id', 'span_seq', 'span_id', 'parent_span_id', 'kind', 'name', 'state', 'started_at', 'ended_at', 'duration_ms',
  'ttft_ms', 'prompt_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_micros', 'error_class',
  'input_digest', 'attributes_json'
] as const;

/** Quotes every cell and neutralizes spreadsheet formula prefixes. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/u.test(text) && typeof value === 'string') text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function renderCsv(trace: TraceDetail, spans: readonly TraceSpan[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const span of spans) {
    lines.push([
      trace.traceId, span.spanSeq, span.spanId, span.parentSpanId, span.kind, span.name, span.state, span.startedAt,
      span.endedAt, span.durationMs, span.ttftMs, span.tokens.prompt, span.tokens.output, span.tokens.cacheRead,
      span.tokens.cacheWrite, span.costMicros, span.errorClass, span.inputDigest, JSON.stringify(span.attributes)
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function renderJson(trace: TraceDetail, spans: readonly TraceSpan[]): string {
  return JSON.stringify({ schema: 'cloud-harness.agent-trace/v1', trace, spans }, null, 2);
}

function hexId(value: string, bytes: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, bytes * 2);
}

function unixNanos(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`;
}

type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
type OtlpAttribute = { key: string; value: OtlpValue };

function attribute(key: string, value: string | number | boolean | null | undefined): OtlpAttribute[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'boolean') return [{ key, value: { boolValue: value } }];
  if (typeof value === 'number') {
    return [{ key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }];
  }
  return [{ key, value: { stringValue: value } }];
}

/** OTLP span kinds: 1 internal, 3 client. Model and tool calls leave the agent; the rest is internal. */
function otlpKind(kind: TraceSpan['kind']): number {
  return kind === 'model_call' || kind === 'tool_call' || kind === 'gateway' ? 3 : 1;
}

function renderOtlp(trace: TraceDetail, spans: readonly TraceSpan[]): string {
  const traceHex = hexId(trace.traceId, 16);
  return JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [
          ...attribute('service.name', 'cloud-harness-agent'),
          ...attribute('cloudharness.trace_id', trace.traceId),
          ...attribute('cloudharness.agent_id', trace.agentId),
          ...attribute('cloudharness.workspace_id', trace.workspaceId),
          ...attribute('cloudharness.agent_generation', trace.generation),
          ...attribute('cloudharness.profile_id', trace.profileId),
          ...attribute('cloudharness.profile_revision_id', trace.profileRevisionId),
          ...attribute('cloudharness.trace_state', trace.state),
          ...attribute('cloudharness.coverage', trace.coverage),
          ...attribute('cloudharness.cost_micros', trace.costMicros),
          ...attribute('cloudharness.cost_provenance', trace.costProvenance)
        ]
      },
      scopeSpans: [{
        scope: { name: 'cloud-harness-mcp.agent-traces', version: '1' },
        spans: spans.map((span) => ({
          traceId: traceHex,
          spanId: hexId(span.spanId, 8),
          ...(span.parentSpanId === null ? {} : { parentSpanId: hexId(span.parentSpanId, 8) }),
          name: span.name,
          kind: otlpKind(span.kind),
          startTimeUnixNano: unixNanos(span.startedAt),
          // OTLP requires an end time; an open or unknown span ends where it started and keeps its state attribute.
          endTimeUnixNano: unixNanos(span.endedAt ?? span.startedAt),
          attributes: [
            ...attribute('cloudharness.span.kind', span.kind),
            ...attribute('cloudharness.span.state', span.state),
            ...attribute('cloudharness.span.seq', span.spanSeq),
            ...attribute('gen_ai.usage.input_tokens', span.tokens.prompt),
            ...attribute('gen_ai.usage.output_tokens', span.tokens.output),
            ...attribute('cloudharness.usage.cache_read_tokens', span.tokens.cacheRead),
            ...attribute('cloudharness.usage.cache_write_tokens', span.tokens.cacheWrite),
            ...attribute('cloudharness.cost_micros', span.costMicros),
            ...attribute('cloudharness.ttft_ms', span.ttftMs),
            ...attribute('cloudharness.input_digest', span.inputDigest),
            ...attribute('error.type', span.errorClass),
            ...Object.entries(span.attributes).flatMap(([key, value]) => attribute(`cloudharness.${key}`, value))
          ],
          status: span.state === 'ERROR' ? { code: 2 } : span.state === 'OK' ? { code: 1 } : { code: 0 }
        }))
      }]
    }]
  });
}

const RENDERERS: Record<TraceExportFormat, (trace: TraceDetail, spans: readonly TraceSpan[]) => string> = {
  json: renderJson,
  csv: renderCsv,
  'otlp-json': renderOtlp
};

/** Renders the export, dropping trailing spans (and flagging truncation) when it would exceed the bound. */
export function renderTraceExport(
  trace: TraceDetail,
  spans: readonly TraceSpan[],
  format: TraceExportFormat,
  maxBytes = MAX_TRACE_EXPORT_BYTES
): AgentTraceExportResult {
  const render = RENDERERS[format];
  let kept = spans.length;
  let content = render(trace, spans);
  while (Buffer.byteLength(content, 'utf8') > maxBytes && kept > 0) {
    kept = Math.floor(kept / 2);
    content = render(trace, spans.slice(0, kept));
  }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error('trace export header exceeds the export bound');
  }
  const extension = format === 'csv' ? 'csv' : format === 'otlp-json' ? 'otlp.json' : 'json';
  return {
    traceId: trace.traceId,
    format,
    contentType: format === 'csv' ? 'text/csv' : 'application/json',
    filename: `${trace.traceId}.${extension}`,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    truncated: kept < spans.length || trace.truncated
  };
}
