import { createHash } from 'node:crypto';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentEvent, UsageState } from '@earendil-works/pi-durable';
import { PROXY_OPERATIONS, type DurableRedactor, type ProxyOperation, type SafeEvent, type Usage } from './protocol.js';

const OPERATIONS: ReadonlySet<string> = new Set(PROXY_OPERATIONS);

function proxyOperation(name: string): ProxyOperation | undefined {
  return OPERATIONS.has(name) ? name as ProxyOperation : undefined;
}

function boundedEventId(value: unknown): string {
  const candidate = String(value ?? 'unknown');
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)) return candidate;
  return `id_${createHash('sha256').update(candidate).digest('hex').slice(0, 32)}`;
}

function toolResultIsError(event: Extract<AgentEvent, { type: 'tool_execution_end' }>): boolean | undefined {
  if (event.result) return event.result.isError;
  const message = event.entry?.model?.[0];
  return message && message.role === 'toolResult' ? message.isError : undefined;
}

function assistantText(message: Message | undefined): string | undefined {
  if (!message || message.role !== 'assistant') return undefined;
  return message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

/**
 * Projects durable harness events onto the caller-safe event vocabulary. Snapshots, document and
 * bookkeeping events have no caller meaning and are dropped; text is redacted and bounded.
 *
 * The harness streams an answer only as often as it commits progress, so a fast answer can arrive
 * whole in `message_start`/`message_end` with no `message_update` before it. The projector tracks
 * the text already sent for the current assistant message and emits whatever the committed message
 * adds, so callers always receive the full answer as text deltas.
 */
export class DurableEventProjector {
  readonly #redactor: DurableRedactor;
  readonly #maxEventBytes: number;
  #streamed = '';

  constructor(redactor: DurableRedactor, maxEventBytes: number) {
    this.#redactor = redactor;
    this.#maxEventBytes = maxEventBytes;
  }

  project(event: AgentEvent): SafeEvent[] {
    switch (event.type) {
      case 'message_start': {
        if (event.message.role !== 'assistant') return [];
        this.#streamed = '';
        return this.#catchUp(assistantText(event.message));
      }
      case 'message_update': {
        const text = event.changes.flatMap((change) => change.type === 'text_delta' ? [change.delta] : []).join('');
        if (!text) return [];
        this.#streamed += text;
        return this.#delta(text);
      }
      case 'message_end': {
        const text = assistantText(event.entry.model?.find((message) => message.role === 'assistant'));
        const events = this.#catchUp(text);
        if (text !== undefined) this.#streamed = '';
        return events;
      }
      default:
        return projectDurableEvent(event, this.#redactor, this.#maxEventBytes);
    }
  }

  #catchUp(text: string | undefined): SafeEvent[] {
    if (!text || !text.startsWith(this.#streamed) || text.length === this.#streamed.length) return [];
    const missing = text.slice(this.#streamed.length);
    this.#streamed = text;
    return this.#delta(missing);
  }

  #delta(text: string): SafeEvent[] {
    return [{ kind: 'text_delta', text: this.#redactor.text(text, this.#maxEventBytes) }];
  }
}

/** Stateless projection of the events that need no per-message tracking. */
export function projectDurableEvent(event: AgentEvent, redactor: DurableRedactor, maxEventBytes: number): SafeEvent[] {
  switch (event.type) {
    case 'run_start':
      return [{ kind: 'lifecycle', phase: 'started' }];
    case 'turn_start':
      return [{ kind: 'lifecycle', phase: 'turn_started' }];
    case 'turn_end':
      return [{ kind: 'lifecycle', phase: 'turn_ended' }];
    case 'run_end':
      return [{ kind: 'lifecycle', phase: 'settled' }];
    case 'tool_execution_start': {
      const name = proxyOperation(event.toolName);
      return name ? [{ kind: 'tool', phase: 'started', toolCallId: boundedEventId(event.toolCallId), name }] : [];
    }
    case 'tool_execution_update': {
      const name = proxyOperation(event.toolName);
      if (!name) return [];
      const output = event.output;
      const raw = output === undefined ? undefined : 'set' in output ? output.set : output.append;
      return [{
        kind: 'tool',
        phase: 'updated',
        toolCallId: boundedEventId(event.toolCallId),
        name,
        ...(raw ? { text: redactor.text(raw, maxEventBytes) } : {})
      }];
    }
    case 'tool_execution_end': {
      const name = proxyOperation(event.toolName);
      if (!name) return [];
      const isError = toolResultIsError(event);
      return [{
        kind: 'tool',
        phase: 'ended',
        toolCallId: boundedEventId(event.toolCallId),
        name,
        ...(isError === undefined ? {} : { isError })
      }];
    }
    case 'inbox_update':
      return [{
        kind: 'queue',
        steering: event.items.filter((item) => item.mode === 'steer').length,
        followUp: event.items.filter((item) => item.mode === 'followUp').length
      }];
    case 'auto_retry_start':
      return [{ kind: 'notice', message: redactor.text(event.errorMessage, maxEventBytes) }];
    default:
      return [];
  }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}

/** Sums every model and tool usage bucket of the session into the wire usage shape. */
export function usageFromState(state: UsageState): Usage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
    total.input += safeCount(usage.input);
    total.output += safeCount(usage.output);
    total.cacheRead += safeCount(usage.cacheRead);
    total.cacheWrite += safeCount(usage.cacheWrite);
    total.total += safeCount(usage.totalTokens);
    const cost = usage.cost.total;
    if (Number.isFinite(cost) && cost > 0) total.cost += cost;
  }
  return total;
}

/** The usage of this run alone: the session total minus what the session held when the run opened it. */
export function usageSince(current: Usage, baseline: Usage): Usage {
  const own = (value: number, base: number) => safeCount(value - base);
  const cost = current.cost - baseline.cost;
  return {
    input: own(current.input, baseline.input),
    output: own(current.output, baseline.output),
    cacheRead: own(current.cacheRead, baseline.cacheRead),
    cacheWrite: own(current.cacheWrite, baseline.cacheWrite),
    total: own(current.total, baseline.total),
    cost: Number.isFinite(cost) ? Math.min(1_000_000_000, Math.max(0, cost)) : 0
  };
}
