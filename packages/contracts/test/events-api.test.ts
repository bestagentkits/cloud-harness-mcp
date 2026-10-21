import { describe, expect, it } from 'vitest';
import {
  MCP_EVENT_DEFINITIONS,
  MCP_EVENT_NAMES,
  MCP_EVENTS_ERROR_CODES,
  McpEventsRunnerRequestSchema,
  WebhookSecretSchema
} from '../src/index.js';

describe('MCP Events contract', () => {
  it('defines exactly the four terminal-state events with strict filters', () => {
    expect(MCP_EVENT_DEFINITIONS.map((definition) => definition.name)).toEqual([...MCP_EVENT_NAMES]);
    for (const definition of MCP_EVENT_DEFINITIONS) {
      expect(definition.arguments.safeParse({}).success).toBe(true);
      expect(definition.arguments.safeParse({ unexpected: 1 }).success).toBe(false);
    }
  });

  it('defines the notification event with a kind filter and an ids-only payload', () => {
    const definition = MCP_EVENT_DEFINITIONS.find((entry) => entry.name === 'cloudharness.notification.created');
    expect(MCP_EVENT_NAMES.at(-1)).toBe('cloudharness.notification.created');
    expect(definition?.arguments.safeParse({ kind: 'automation.failed' }).success).toBe(true);
    expect(definition?.arguments.safeParse({ kind: 'not-a-kind' }).success).toBe(false);
    const payload = {
      notificationId: `ntf_${'a'.repeat(32)}`, kind: 'agent.failed', subjectType: 'agent', subjectId: `agent_${'b'.repeat(24)}`,
      title: 'Agent run failed', link: '/dashboard/agents/x', createdAt: '2026-10-20T00:00:00.000Z'
    };
    expect(definition?.payload.safeParse(payload).success).toBe(true);
    expect(definition?.payload.safeParse({ ...payload, prompt: 'leak' }).success).toBe(false);
  });

  it('accepts only whsec_ secrets carrying 24 to 64 bytes', () => {
    expect(WebhookSecretSchema.safeParse(`whsec_${Buffer.alloc(24).toString('base64')}`).success).toBe(true);
    expect(WebhookSecretSchema.safeParse(`whsec_${Buffer.alloc(64).toString('base64')}`).success).toBe(true);
    expect(WebhookSecretSchema.safeParse(`whsec_${Buffer.alloc(23).toString('base64')}`).success).toBe(false);
    expect(WebhookSecretSchema.safeParse(`whsec_${Buffer.alloc(65).toString('base64')}`).success).toBe(false);
    expect(WebhookSecretSchema.safeParse(Buffer.alloc(32).toString('base64')).success).toBe(false);
    expect(WebhookSecretSchema.safeParse('whsec_not*base64!').success).toBe(false);
  });

  it('keeps the events error codes in one distinct block', () => {
    const codes = Object.values(MCP_EVENTS_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => code <= -32000 && code >= -32099)).toBe(true);
  });

  it('requires a principal for subscription operations but not for the delivery queue', () => {
    expect(McpEventsRunnerRequestSchema.safeParse({ version: 1, operation: 'events_subscriptions_list', input: {} }).success).toBe(false);
    expect(McpEventsRunnerRequestSchema.safeParse({ version: 1, operation: 'events_delivery_claim', input: { limit: 10, leaseMs: 60_000 } }).success).toBe(true);
  });
});
