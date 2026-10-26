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
    // What the OpenAI SDK reports for a gateway refusal: status and envelope message only.
    ['429 budget_exceeded: model budget exhausted', 'budget'],
    // What the Anthropic SDK reports: status and the serialized envelope.
    ['429 {"error":{"code":"model_budget_exhausted","type":"budget_exceeded","message":"budget_exceeded: model budget exhausted"}}', 'budget'],
    ['429 Too Many Requests', 'rate_limit'],
    ['429 Rate limit reached for requests', 'rate_limit'],
    ['429 You exceeded your current quota, please check your plan and billing details', 'rate_limit'],
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

  it('reports a gateway budget refusal as budget, not as provider throttling', () => {
    const refused = projectAgentEvent(turnEnd({
      role: 'assistant', stopReason: 'error', errorMessage: '429 budget_exceeded: model budget exhausted'
    }), redactor, 4_096);
    expect(refused).toEqual({ kind: 'lifecycle', phase: 'turn_ended', outcome: 'error', errorClass: 'budget' });
    expect(SafeEventSchema.parse(refused)).toEqual(refused);
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
