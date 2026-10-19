import type { DatabaseSync } from 'node:sqlite';
import type { NotificationKind, NotificationSubjectType } from '@cloud-harness/contracts';
import { eventIdForSource } from '../event-outbox.js';

/** One leased delivery handed to a channel adapter. Carries ids, the bounded title and the link only. */
export type NotificationDispatch = {
  notificationId: string;
  principalId: string;
  channel: string;
  kind: NotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  title: string;
  link: string | null;
  /** 1-based number of this send attempt. */
  attempt: number;
  /** Stable across retries and re-claims, so a channel can drop a duplicate send. */
  idempotencyKey: string;
};

/**
 * The outcome of one send. `pending` is for mirror channels whose underlying delivery has not settled
 * yet: it is checked again later and does not count as an attempt. `retry` counts an attempt and is
 * retried with backoff until the attempt cap, after which the delivery is FAILED.
 */
export type NotificationSendResult =
  | { outcome: 'delivered' }
  | { outcome: 'pending' }
  | { outcome: 'retry'; errorClass: string }
  | { outcome: 'failed'; errorClass: string }
  | { outcome: 'revoked'; errorClass: string };

/** The channel port. A new channel (for example a chat integration) implements exactly this. */
export interface NotificationAdapter {
  readonly channel: string;
  send(delivery: NotificationDispatch): Promise<NotificationSendResult>;
  /** An unhealthy channel is not claimed from, so its deliveries wait as PENDING instead of failing. */
  health(): Promise<{ ok: boolean }>;
  /** Called after a delivery of this channel was revoked while a send was in flight. */
  revoke(notificationId: string): Promise<void>;
}

/** MCP Events reasons that mean the subscription itself ended, not that a send failed. */
const SUBSCRIPTION_ENDED = new Set(['revoked', 'credential_revoked', 'subscription_inactive']);

function errorClass(value: string | null, fallback: string): string {
  return value !== null && /^[a-z0-9_]{1,40}$/u.test(value) ? value : fallback;
}

/**
 * Mirrors the MCP Events delivery of `cloudharness.notification.created`. The API egress worker owns
 * the webhook send, its retries and its lease; this adapter only reads the outcome. Delivered when any
 * subscription received the event, pending while any is still pending, revoked when every
 * subscription ended, otherwise failed with the worker's error category.
 */
export class McpEventNotificationAdapter implements NotificationAdapter {
  readonly channel = 'mcp_event';

  constructor(private readonly database: DatabaseSync) {}

  async send(delivery: NotificationDispatch): Promise<NotificationSendResult> {
    const rows = this.database.prepare(`SELECT status, last_error FROM event_deliveries WHERE event_id = ?`)
      .all(eventIdForSource(`notification:${delivery.notificationId}`)) as { status: string; last_error: string | null }[];
    if (rows.length === 0) return { outcome: 'failed', errorClass: 'event_missing' };
    if (rows.some((row) => row.status === 'PENDING')) return { outcome: 'pending' };
    if (rows.some((row) => row.status === 'DELIVERED')) return { outcome: 'delivered' };
    if (rows.every((row) => row.last_error !== null && SUBSCRIPTION_ENDED.has(row.last_error))) {
      return { outcome: 'revoked', errorClass: 'subscription_ended' };
    }
    const failed = rows.find((row) => row.last_error !== null && !SUBSCRIPTION_ENDED.has(row.last_error));
    return { outcome: 'failed', errorClass: errorClass(failed?.last_error ?? null, 'delivery_abandoned') };
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async revoke(): Promise<void> {
    // Nothing to call: the store abandons the pending MCP event deliveries in the same transaction
    // that revokes the notification delivery, so the API egress worker never sends them.
  }
}

/**
 * Mirrors an automation workflow's GitHub comment (`publish_state`). The automation engine makes the
 * GitHub call with its own idempotency key; this adapter never calls GitHub.
 */
export class GithubNotificationAdapter implements NotificationAdapter {
  readonly channel = 'github';

  constructor(private readonly database: DatabaseSync) {}

  async send(delivery: NotificationDispatch): Promise<NotificationSendResult> {
    if (delivery.subjectType !== 'automation_workflow') return { outcome: 'failed', errorClass: 'not_applicable' };
    const row = this.database.prepare('SELECT publish_state FROM automation_workflows WHERE id = ?')
      .get(delivery.subjectId) as { publish_state: string } | undefined;
    if (!row) return { outcome: 'failed', errorClass: 'workflow_missing' };
    if (row.publish_state === 'DELIVERED') return { outcome: 'delivered' };
    if (row.publish_state === 'PENDING') return { outcome: 'pending' };
    if (row.publish_state === 'FAILED') return { outcome: 'failed', errorClass: 'publish_failed' };
    return { outcome: 'failed', errorClass: 'not_published' };
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async revoke(): Promise<void> {
    // The comment belongs to the automation workflow; turning the channel off does not retract it.
  }
}
