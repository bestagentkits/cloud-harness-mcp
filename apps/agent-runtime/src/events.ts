import { createHash } from 'node:crypto';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { AgentProxyOperationSchema, TurnOutcomeSchema, type SafeEvent } from './protocol-schemas.js';
import type { Redactor } from './redaction.js';

function boundedEventId(value: unknown): string {
  const candidate = String(value ?? 'unknown');
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)) return candidate;
  return `id_${createHash('sha256').update(candidate).digest('hex').slice(0, 32)}`;
}

function toolUpdateText(value: unknown, redactor: Redactor, maxBytes: number): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (!('content' in value) || !Array.isArray(value.content)) {
    return redactor.text(JSON.stringify(redactor.value(value, maxBytes)), maxBytes);
  }
  const texts = value.content.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('type' in item) || !('text' in item)) return [];
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  });
  return texts.length === 0 ? undefined : redactor.text(texts.join(''), maxBytes);
}

type TurnOutcome = Extract<SafeEvent, { kind: 'lifecycle' }>['outcome'];
type TurnErrorClass = Extract<SafeEvent, { kind: 'lifecycle' }>['errorClass'];

/**
 * Maps a provider error message to a bounded class. Only the class leaves the runtime; the message,
 * which may quote request content, does not. A Model Gateway budget refusal is recognised by the
 * refusal code the gateway puts in its error envelope (see `BUDGET_REFUSAL_CODE` in the gateway),
 * not by keywords, so it is never mistaken for provider throttling.
 */
export function classifyModelError(message: string): NonNullable<TurnErrorClass> {
  if (/\bbudget_exceeded\b/u.test(message)) return 'budget';
  if (/context[\s_-]{0,3}(?:length|window)|maximum context|too many tokens|prompt is too long/iu.test(message)) return 'context_length';
  if (/\b429\b|rate[\s_-]?limit|too many requests|quota/iu.test(message)) return 'rate_limit';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid[\s_-]api[\s_-]key|authentication/iu.test(message)) return 'auth';
  if (/timed?[\s_-]?out|timeout|deadline exceeded/iu.test(message)) return 'timeout';
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/iu.test(message)) return 'server';
  if (/econnreset|econnrefused|enotfound|socket hang up|fetch failed|network|terminated/iu.test(message)) return 'network';
  if (/\b400\b|\b422\b|bad request|invalid request/iu.test(message)) return 'invalid_request';
  return 'other';
}

/** The bounded outcome of a model turn, read from its assistant message when there is one. */
export function turnOutcome(message: unknown): { outcome?: NonNullable<TurnOutcome>; errorClass?: NonNullable<TurnErrorClass> } {
  if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'assistant' || !('stopReason' in message)) {
    return {};
  }
  const parsed = TurnOutcomeSchema.safeParse(message.stopReason);
  const outcome = parsed.success ? parsed.data : 'unknown';
  if (outcome === 'aborted') return { outcome, errorClass: 'aborted' };
  if (outcome !== 'error') return { outcome };
  const errorMessage = 'errorMessage' in message && typeof message.errorMessage === 'string' ? message.errorMessage : '';
  return { outcome, errorClass: classifyModelError(errorMessage) };
}

export function projectAgentEvent(
  event: AgentSessionEvent,
  redactor: Redactor,
  maxEventBytes: number
): SafeEvent | undefined {
  switch (event.type) {
    case 'agent_start':
      return { kind: 'lifecycle', phase: 'started' };
    case 'turn_start':
      return { kind: 'lifecycle', phase: 'turn_started' };
    case 'turn_end':
      return { kind: 'lifecycle', phase: 'turn_ended', ...turnOutcome(event.message) };
    case 'agent_settled':
      return { kind: 'lifecycle', phase: 'settled' };
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (update.type !== 'text_delta') return undefined;
      return { kind: 'text_delta', text: redactor.text(update.delta, maxEventBytes) };
    }
    case 'tool_execution_start': {
      const operation = AgentProxyOperationSchema.safeParse(event.toolName);
      if (!operation.success) return undefined;
      return { kind: 'tool', phase: 'started', toolCallId: boundedEventId(event.toolCallId), name: operation.data };
    }
    case 'tool_execution_update': {
      const operation = AgentProxyOperationSchema.safeParse(event.toolName);
      if (!operation.success) return undefined;
      return {
        kind: 'tool',
        phase: 'updated',
        toolCallId: boundedEventId(event.toolCallId),
        name: operation.data,
        text: toolUpdateText(event.partialResult, redactor, maxEventBytes)
      };
    }
    case 'tool_execution_end': {
      const operation = AgentProxyOperationSchema.safeParse(event.toolName);
      if (!operation.success) return undefined;
      return {
        kind: 'tool',
        phase: 'ended',
        toolCallId: boundedEventId(event.toolCallId),
        name: operation.data,
        isError: event.isError
      };
    }
    case 'queue_update':
      return { kind: 'queue', steering: event.steering.length, followUp: event.followUp.length };
    case 'auto_retry_start':
      return { kind: 'notice', message: redactor.text(event.errorMessage, maxEventBytes) };
    default:
      return undefined;
  }
}
