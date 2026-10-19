import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { classifyModelError, projectAgentEvent, turnOutcome } from '../src/events.js';
import { SafeEventSchema } from '../src/protocol-schemas.js';
import { createRedactor } from '../src/redaction.js';

function turnEnd(message: Record<string, unknown>): AgentSessionEvent {
  return { type: 'turn_end', message, toolResults: [] } as unknown as AgentSessionEvent;
}

describe('turn outcome projection', () => {
  const redactor = createRedactor(['super-secret-value']);

  it('reports a successful turn outcome without an error class', () => {
    const projected = projectAgentEvent(turnEnd({ role: 'assistant', stopReason: 'toolUse', content: [] }), redactor, 4_096);
    expect(projected).toEqual({ kind: 'lifecycle', phase: 'turn_ended', outcome: 'toolUse' });
    expect(SafeEventSchema.parse(projected)).toEqual(projected);
  });

  it('classifies provider failures into a bounded class and never forwards the error text', () => {
    const projected = projectAgentEvent(turnEnd({
      role: 'assistant', stopReason: 'error', errorMessage: '429 Too Many Requests for key super-secret-value'
    }), redactor, 4_096);
    expect(projected).toEqual({ kind: 'lifecycle', phase: 'turn_ended', outcome: 'error', errorClass: 'rate_limit' });
    expect(JSON.stringify(projected)).not.toContain('super-secret-value');
    expect(SafeEventSchema.parse(projected)).toEqual(projected);
  });

  it.each([
    ['401 Unauthorized', 'auth'],
    ['Invalid API key provided', 'auth'],
    ['500 Internal Server Error', 'server'],
    ['503 Service Unavailable', 'server'],
    ['request timed out after 60s', 'timeout'],
    ['fetch failed: ECONNRESET', 'network'],
    ['This model maximum context length is 8192 tokens', 'context_length'],
    ['400 Bad Request', 'invalid_request'],
    ['something odd', 'other']
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyModelError(message)).toBe(expected);
  });

  it('marks aborted turns and tolerates messages without a stop reason', () => {
    expect(turnOutcome({ role: 'assistant', stopReason: 'aborted' })).toEqual({ outcome: 'aborted', errorClass: 'aborted' });
    expect(turnOutcome({ role: 'assistant', stopReason: 'brand-new-reason' })).toEqual({ outcome: 'unknown' });
    expect(turnOutcome({ role: 'user', content: 'hi' })).toEqual({});
    expect(turnOutcome(undefined)).toEqual({});
    expect(projectAgentEvent(turnEnd({ role: 'user' }), redactor, 4_096)).toEqual({ kind: 'lifecycle', phase: 'turn_ended' });
  });

  it('keeps accepting lifecycle events from older runtimes without the new fields', () => {
    expect(SafeEventSchema.safeParse({ kind: 'lifecycle', phase: 'turn_ended' }).success).toBe(true);
    expect(SafeEventSchema.safeParse({ kind: 'lifecycle', phase: 'turn_ended', errorClass: 'free text' }).success).toBe(false);
  });
});
