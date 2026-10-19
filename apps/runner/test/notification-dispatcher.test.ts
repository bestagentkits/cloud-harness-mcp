import { afterEach, describe, expect, it } from 'vitest';
import { eventIdForSource } from '../src/event-outbox.js';
import { GithubNotificationAdapter, McpEventNotificationAdapter, type NotificationDispatch } from '../src/notifications/notification-adapters.js';
import { NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_RETRY_DELAYS_MS, NotificationDispatcher } from '../src/notifications/notification-dispatcher.js';
import { emitNotification } from '../src/notifications/notification-emitter.js';
import { NotificationStore } from '../src/notifications/notification-store.js';
import { FakeNotificationAdapter } from './support/fake-notification-adapter.js';
import {
  T0, deliveries, disableNotifications, enableNotifications, insertSubscription, insertWorkflow, openNotificationDatabase
} from './support/notification-fixtures.js';

const closers: (() => void)[] = [];
afterEach(() => {
  disableNotifications();
  for (const close of closers.splice(0)) close();
});

function setup(fake = new FakeNotificationAdapter()) {
  const context = openNotificationDatabase();
  closers.push(context.close);
  const clock = { now: T0 };
  const store = new NotificationStore(context.database, () => clock.now);
  const dispatcher = new NotificationDispatcher({ store, adapters: [fake], now: () => clock.now });
  enableNotifications(dispatcher.channels());
  const id = emitNotification(context.database, {
    principalId: context.ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: `agent_${'c'.repeat(24)}`,
    transition: 'terminal', title: 'Agent run failed', link: '/dashboard/agents/x'
  }, clock.now)!;
  const row = () => deliveries(context.database, id).find((delivery) => delivery.channel === fake.channel)!;
  return { ...context, clock, store, dispatcher, fake, id, row };
}

describe('notification dispatcher', () => {
  it('retries a 429 with backoff and then delivers, counting both attempts', async () => {
    const { dispatcher, fake, clock, row } = setup();
    fake.respondWith(429, 200);
    expect(await dispatcher.tick()).toMatchObject({ claimed: 1, retried: 1 });
    expect(row()).toMatchObject({ state: 'PENDING', attempts: 1, last_error_class: 'http_429' });
    expect(await dispatcher.tick()).toMatchObject({ claimed: 0 });
    clock.now += NOTIFICATION_RETRY_DELAYS_MS[0];
    expect(await dispatcher.tick()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(row()).toMatchObject({ state: 'DELIVERED', attempts: 2, last_error_class: null });
    expect(fake.sends.map((send) => send.attempt)).toEqual([1, 2]);
    expect(new Set(fake.sends.map((send) => send.idempotencyKey)).size).toBe(1);
    expect(fake.sends[0]).toMatchObject({ title: 'Agent run failed', link: '/dashboard/agents/x', kind: 'agent.failed' });
  });

  it('fails a delivery that keeps answering 500 once the attempt cap is reached', async () => {
    const { dispatcher, fake, clock, row } = setup();
    fake.fallback = 500;
    for (const delay of NOTIFICATION_RETRY_DELAYS_MS) {
      await dispatcher.tick();
      clock.now += delay;
    }
    expect(await dispatcher.tick()).toMatchObject({ failed: 1 });
    expect(row()).toMatchObject({ state: 'FAILED', attempts: NOTIFICATION_MAX_ATTEMPTS, last_error_class: 'http_5xx' });
    clock.now += 86_400_000;
    await dispatcher.tick();
    expect(fake.sends).toHaveLength(NOTIFICATION_MAX_ATTEMPTS);
  });

  it('fails at once on a non-retryable 4xx and retries a thrown transport error', async () => {
    const thrown = setup(new FakeNotificationAdapter().respondWith('throw'));
    await thrown.dispatcher.tick();
    expect(thrown.row()).toMatchObject({ state: 'PENDING', attempts: 1, last_error_class: 'adapter_error' });
    const rejected = setup(new FakeNotificationAdapter().respondWith(403));
    await rejected.dispatcher.tick();
    expect(rejected.row()).toMatchObject({ state: 'FAILED', attempts: 1, last_error_class: 'http_4xx' });
  });

  it('leaves deliveries of an unhealthy channel pending without counting an attempt', async () => {
    const { dispatcher, fake, row } = setup();
    fake.healthy = false;
    expect(await dispatcher.tick()).toMatchObject({ claimed: 0 });
    expect(row()).toMatchObject({ state: 'PENDING', attempts: 0 });
    fake.healthy = true;
    await dispatcher.tick();
    expect(row()).toMatchObject({ state: 'DELIVERED', attempts: 1 });
  });

  it('stops a send revoked mid-flight: the late report is dropped, the adapter is told, nothing is sent again', async () => {
    const { dispatcher, fake, store, ownerId, id, row, clock } = setup();
    const release = fake.hold();
    const inFlight = dispatcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(row().state).toBe('CLAIMED');
    expect(store.setPreferences(ownerId, [{ channel: 'fake_chat', kind: 'agent.failed', enabled: false }])).toBe(1);
    release();
    expect(await inFlight).toMatchObject({ lost: 1 });
    expect(row()).toMatchObject({ state: 'REVOKED', last_error_class: 'preference_disabled' });
    expect(fake.revocations).toEqual([id]);
    clock.now += 3_600_000;
    await dispatcher.tick();
    expect(fake.sends).toHaveLength(1);
  });

  it('only applies retention while notifications are turned off', async () => {
    const { dispatcher, fake, row } = setup();
    dispatcher.start(3_600_000, { purgeOnly: true });
    try {
      expect(await dispatcher.tick()).toMatchObject({ claimed: 0 });
      expect(fake.sends).toHaveLength(0);
      expect(row()).toMatchObject({ state: 'PENDING', attempts: 0 });
    } finally {
      await dispatcher.stop();
    }
  });

  it('never overlaps its own ticks', async () => {
    const { dispatcher, fake } = setup();
    const release = fake.hold();
    const first = dispatcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await dispatcher.tick()).toMatchObject({ claimed: 0 });
    release();
    expect(await first).toMatchObject({ delivered: 1 });
    expect(fake.sends).toHaveLength(1);
  });
});

describe('mirror channel adapters', () => {
  const dispatch = (notificationId: string, subjectId = 'x', subjectType: NotificationDispatch['subjectType'] = 'automation_workflow'): NotificationDispatch => ({
    notificationId, principalId: 'p', channel: 'mirror', kind: 'automation.completed', subjectType, subjectId, title: 't', link: null, attempt: 1, idempotencyKey: 'k'
  });

  it('maps MCP event deliveries onto the notification channel state', async () => {
    const { database, ownerId } = setup();
    const adapter = new McpEventNotificationAdapter(database);
    const notificationId = `ntf_${'e'.repeat(32)}`;
    const eventId = eventIdForSource(`notification:${notificationId}`);
    expect(await adapter.send(dispatch(notificationId))).toEqual({ outcome: 'failed', errorClass: 'event_missing' });
    database.prepare(`INSERT INTO event_outbox (id, owner_id, source_key, name, occurred_at, payload_json, created_at)
      VALUES (?, ?, 's', 'cloudharness.notification.created', ?, '{}', ?)`).run(eventId, ownerId, T0, T0);
    const insert = database.prepare(`INSERT INTO event_deliveries (id, event_id, subscription_id, status, attempts, next_attempt_at, created_at, last_error)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`);
    insert.run('dlv_1', eventId, insertSubscription(database, ownerId, 'cloudharness.notification.created'), 'PENDING', T0, T0, null);
    insert.run('dlv_2', eventId, insertSubscription(database, ownerId, 'cloudharness.notification.created', { kind: 'agent.failed' }), 'ABANDONED', T0, T0, 'revoked');
    expect(await adapter.send(dispatch(notificationId))).toEqual({ outcome: 'pending' });
    database.prepare("UPDATE event_deliveries SET status = 'ABANDONED', last_error = 'http_5xx' WHERE id = 'dlv_1'").run();
    expect(await adapter.send(dispatch(notificationId))).toEqual({ outcome: 'failed', errorClass: 'http_5xx' });
    database.prepare("UPDATE event_deliveries SET last_error = 'subscription_inactive' WHERE id = 'dlv_1'").run();
    expect(await adapter.send(dispatch(notificationId))).toEqual({ outcome: 'revoked', errorClass: 'subscription_ended' });
    database.prepare("UPDATE event_deliveries SET status = 'DELIVERED', last_error = NULL WHERE id = 'dlv_1'").run();
    expect(await adapter.send(dispatch(notificationId))).toEqual({ outcome: 'delivered' });
  });

  it('mirrors an automation workflow publish_state without calling GitHub', async () => {
    const { database, ownerId } = setup();
    const adapter = new GithubNotificationAdapter(database);
    const workflowId = insertWorkflow(database, { ownerId, publishState: 'PENDING' });
    expect(await adapter.send(dispatch('n', workflowId))).toEqual({ outcome: 'pending' });
    database.prepare("UPDATE automation_workflows SET publish_state = 'DELIVERED' WHERE id = ?").run(workflowId);
    expect(await adapter.send(dispatch('n', workflowId))).toEqual({ outcome: 'delivered' });
    database.prepare("UPDATE automation_workflows SET publish_state = 'FAILED' WHERE id = ?").run(workflowId);
    expect(await adapter.send(dispatch('n', workflowId))).toEqual({ outcome: 'failed', errorClass: 'publish_failed' });
    expect(await adapter.send(dispatch('n', 'wfl_missing'))).toEqual({ outcome: 'failed', errorClass: 'workflow_missing' });
    expect(await adapter.send(dispatch('n', 'x', 'agent'))).toEqual({ outcome: 'failed', errorClass: 'not_applicable' });
  });
});
