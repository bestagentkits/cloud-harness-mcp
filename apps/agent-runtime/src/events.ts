import { createHash } from 'node:crypto';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { AgentProxyOperationSchema, type SafeEvent } from './protocol-schemas.js';
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
      return { kind: 'lifecycle', phase: 'turn_ended' };
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
