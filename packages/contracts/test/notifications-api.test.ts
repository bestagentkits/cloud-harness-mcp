import { describe, expect, it } from 'vitest';
import {
  CONFIGURABLE_NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  NotificationCreatedPayloadSchema,
  NotificationLinkSchema,
  NotificationSummarySchema,
  NotificationsRunnerDataSchemas,
  NotificationsRunnerRequestSchema,
  RunnerConfigSchema
} from '../src/index.js';

const principal = { kind: 'owner', ownerId: 'owner' } as const;
const request = (operation: string, input: unknown) => ({ version: 1, principal, operation, input });
const ID = `ntf_${'a'.repeat(32)}`;

describe('notifications contract', () => {
  it('names the six notification kinds and keeps the inbox out of the configurable channels', () => {
    expect(NOTIFICATION_KINDS).toEqual([
      'automation.completed', 'automation.failed', 'agent.completed', 'agent.failed', 'workflow.waiting_for_human', 'approval.decided'
    ]);
    expect(CONFIGURABLE_NOTIFICATION_CHANNELS).toEqual(['mcp_event', 'github']);
  });

  it('accepts only relative Dashboard links', () => {
    expect(NotificationLinkSchema.safeParse('/dashboard/automations/runs/wfl_1').success).toBe(true);
    for (const link of ['https://evil.example.com/', '//evil.example.com', '/dashboard/../api', '/api/v1/x', 'javascript:alert(1)', '/dashboard/a?b=c']) {
      expect(NotificationLinkSchema.safeParse(link).success, link).toBe(false);
    }
  });

  it('requires a principal selector and never accepts a principal in the input', () => {
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_list', {})).success).toBe(true);
    expect(NotificationsRunnerRequestSchema.safeParse({ version: 1, operation: 'inbox_list', input: {} }).success).toBe(false);
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_list', { principalId: 'someone' })).success).toBe(false);
    const parsed = NotificationsRunnerRequestSchema.parse(request('inbox_list', {}));
    expect(parsed.input).toEqual({ limit: 50, unreadOnly: false });
  });

  it('bounds mark-read and preference writes', () => {
    // Mark-all is always bounded by the insertion watermark of a list the owner saw.
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { all: true, through: 42 })).success).toBe(true);
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { all: true })).success).toBe(false);
    for (const through of [0, -1, 1.5, '42']) {
      expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { all: true, through })).success, String(through)).toBe(false);
    }
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { notificationIds: [ID], through: 42 })).success).toBe(false);
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { notificationIds: [ID] })).success).toBe(true);
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { notificationIds: [] })).success).toBe(false);
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { notificationIds: Array(101).fill(ID) })).success).toBe(false);
    expect(NotificationsRunnerRequestSchema.safeParse(request('inbox_mark_read', { notificationIds: ['ntf_bad'] })).success).toBe(false);
    expect(NotificationsRunnerRequestSchema.safeParse(request('preferences_put', {
      preferences: [{ channel: 'mcp_event', kind: 'agent.failed', enabled: false }]
    })).success).toBe(true);
    // The inbox itself cannot be turned off.
    expect(NotificationsRunnerRequestSchema.safeParse(request('preferences_put', {
      preferences: [{ channel: 'inbox', kind: 'agent.failed', enabled: false }]
    })).success).toBe(false);
  });

  it('keeps summaries strict and their titles bounded', () => {
    const summary = {
      notificationId: ID, kind: 'automation.failed', subjectType: 'automation_workflow', subjectId: 'wfl_1', title: 'Automation failed',
      link: '/dashboard/automations/runs/wfl_1', createdAt: '2026-10-20T00:00:00.000Z', readAt: null,
      deliveries: [{ channel: 'inbox', state: 'DELIVERED', attempts: 0, lastErrorClass: null, updatedAt: '2026-10-20T00:00:00.000Z' }]
    };
    expect(NotificationSummarySchema.safeParse(summary).success).toBe(true);
    expect(NotificationSummarySchema.safeParse({ ...summary, title: 'x'.repeat(161) }).success).toBe(false);
    expect(NotificationSummarySchema.safeParse({ ...summary, prompt: 'leak' }).success).toBe(false);
    expect(NotificationsRunnerDataSchemas.inbox_list.safeParse({ notifications: [summary], nextCursor: null, unread: 1, readThrough: 1 }).success).toBe(true);
    expect(NotificationsRunnerDataSchemas.inbox_list.safeParse({ notifications: [], nextCursor: null, unread: 0, readThrough: null }).success).toBe(true);
  });

  it('holds the MCP event payload to the same link and subject bounds as the inbox', () => {
    const payload = {
      notificationId: ID, kind: 'agent.failed', subjectType: 'agent', subjectId: 'agent_1', title: 'Agent run ended: failed',
      link: '/dashboard/agents/agent_1', createdAt: '2026-10-20T00:00:00.000Z'
    };
    expect(NotificationCreatedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(NotificationCreatedPayloadSchema.safeParse({ ...payload, link: null }).success).toBe(true);
    for (const link of ['https://evil.example.com/', '/dashboard/../api']) {
      expect(NotificationCreatedPayloadSchema.safeParse({ ...payload, link }).success, link).toBe(false);
    }
    expect(NotificationCreatedPayloadSchema.safeParse({ ...payload, subjectId: '' }).success).toBe(false);
    expect(NotificationCreatedPayloadSchema.safeParse({ ...payload, subjectId: 'x'.repeat(101) }).success).toBe(false);
  });

  it('defaults NOTIFICATIONS_ENABLED to off', () => {
    const shape = RunnerConfigSchema.innerType?.() ?? RunnerConfigSchema;
    const field = (shape as unknown as { shape: Record<string, { safeParse: (value: unknown) => { data?: unknown } }> }).shape.notificationsEnabled!;
    expect(field.safeParse(undefined).data).toBe(false);
    expect(field.safeParse('true').data).toBe(true);
    expect(field.safeParse('yes').data).toBe(false);
  });
});
