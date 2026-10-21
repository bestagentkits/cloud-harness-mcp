import { afterEach, describe, expect, it } from 'vitest';
import { eventIdForSource } from '../src/event-outbox.js';
import { emitNotification } from '../src/notifications/notification-emitter.js';
import {
  NOTIFICATION_HARD_CUTOFF_MS, NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_RETENTION_MS, NOTIFICATION_RETRY_DELAYS_MS, NotificationStore,
  NotificationStoreError
} from '../src/notifications/notification-store.js';
import {
  T0, deliveries, disableNotifications, enableNotifications, insertSubscription, openNotificationDatabase
} from './support/notification-fixtures.js';

const closers: (() => void)[] = [];
afterEach(() => {
  disableNotifications();
  for (const close of closers.splice(0)) close();
});

function setup() {
  const context = openNotificationDatabase();
  closers.push(context.close);
  const clock = { now: T0 };
  const store = new NotificationStore(context.database, () => clock.now);
  enableNotifications(['fake_chat']);
  let sequence = 0;
  const emit = (principalId = context.ownerId, kind: 'agent.failed' | 'agent.completed' = 'agent.failed', at = clock.now) => {
    sequence += 1;
    return emitNotification(context.database, {
      principalId, kind, subjectType: 'agent', subjectId: `agent_${String(sequence).padStart(24, '0')}`, transition: 'terminal',
      title: `Agent ${sequence}`, link: null, occurredAt: at
    }, at)!;
  };
  return { ...context, clock, store, emit };
}

describe('notification store', () => {
  it('leases a delivery to one holder and re-leases it only after the lost lease backs off', () => {
    const { store, emit, clock, database } = setup();
    const id = emit();
    const fakeChat = () => deliveries(database, id).find((row) => row.channel === 'fake_chat')!;
    const [first] = store.claim(['fake_chat'], 10, 30_000);
    expect(first).toMatchObject({ notificationId: id, channel: 'fake_chat', attempts: 0 });
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
    expect(fakeChat().state).toBe('CLAIMED');
    clock.now += 30_000;
    // The expired lease counts as a failed attempt and waits out the first retry delay.
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
    expect(fakeChat()).toMatchObject({ state: 'PENDING', attempts: 1, last_error_class: 'lease_lost' });
    clock.now += NOTIFICATION_RETRY_DELAYS_MS[0] - 1;
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
    clock.now += 1;
    const [second] = store.claim(['fake_chat'], 10, 30_000);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    expect(second!.attempts).toBe(1);
    // The first holder's late report is refused; only the current lease settles the delivery.
    expect(store.report(id, 'fake_chat', first!.leaseToken, { state: 'DELIVERED', attempts: 1, nextAttemptAt: clock.now, errorClass: null })).toBe(false);
    expect(store.report(id, 'fake_chat', second!.leaseToken, { state: 'DELIVERED', attempts: 1, nextAttemptAt: clock.now, errorClass: null })).toBe(true);
    expect(store.report(id, 'fake_chat', second!.leaseToken, { state: 'FAILED', attempts: 2, nextAttemptAt: clock.now, errorClass: 'x' })).toBe(false);
    expect(store.deliveryState(id, 'fake_chat')).toBe('DELIVERED');
  });

  it('fails a delivery whose dispatcher crashes on every attempt once the lost leases reach the cap', () => {
    const { store, emit, clock, database } = setup();
    const id = emit();
    const fakeChat = () => deliveries(database, id).find((row) => row.channel === 'fake_chat')!;
    let leases = 0;
    // Each pass leases the delivery, "crashes" without reporting, and lets the lease and backoff lapse.
    for (let pass = 0; pass < NOTIFICATION_MAX_ATTEMPTS + 3; pass += 1) {
      leases += store.claim(['fake_chat'], 10, 30_000).length;
      clock.now += 30_000;
      store.claim(['fake_chat'], 10, 30_000);
      clock.now += Math.max(...NOTIFICATION_RETRY_DELAYS_MS);
    }
    expect(leases).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect(fakeChat()).toMatchObject({ state: 'FAILED', attempts: NOTIFICATION_MAX_ATTEMPTS, last_error_class: 'lease_lost' });
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
  });

  it('does not claim a delivery before its next attempt time or for another channel', () => {
    const { store, emit, clock } = setup();
    const id = emit();
    const [claimed] = store.claim(['fake_chat'], 10, 30_000);
    store.report(id, 'fake_chat', claimed!.leaseToken, { state: 'PENDING', attempts: 1, nextAttemptAt: clock.now + 5_000, errorClass: 'http_429' });
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
    expect(store.claim(['other'], 10, 30_000)).toEqual([]);
    clock.now += 5_000;
    expect(store.claim(['fake_chat'], 10, 30_000)).toHaveLength(1);
  });

  it('pages the inbox newest first with an opaque cursor and filters unread', () => {
    const { store, emit, clock, ownerId } = setup();
    const ids = [emit(), emit(), emit()];
    clock.now += 1;
    ids.push(emit());
    const first = store.list(ownerId, { limit: 2, unreadOnly: false });
    expect(first.notifications.map((entry) => entry.notificationId)).toHaveLength(2);
    expect(first.notifications[0]!.notificationId).toBe(ids[3]);
    const second = store.list(ownerId, { limit: 2, unreadOnly: false, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.notifications, ...second.notifications].map((entry) => entry.notificationId))).toEqual(new Set(ids));
    expect(first.notifications[0]!.deliveries.map((delivery) => delivery.channel)).toEqual(['inbox', 'fake_chat']);
    store.markRead(ownerId, { notificationIds: [ids[0]!] });
    expect(store.list(ownerId, { limit: 10, unreadOnly: true }).notifications).toHaveLength(3);
    expect(store.unreadCount(ownerId)).toBe(3);
    expect(() => store.list(ownerId, { limit: 2, unreadOnly: false, cursor: 'bm90LWEtY3Vyc29y' })).toThrow(NotificationStoreError);
  });

  it('never reads or marks another principal\'s notification', () => {
    const { store, emit, ownerId, otherId } = setup();
    const mine = emit(ownerId);
    const theirs = emit(otherId);
    expect(store.list(ownerId, { limit: 10, unreadOnly: false }).notifications.map((entry) => entry.notificationId)).toEqual([mine]);
    expect(() => store.markRead(ownerId, { notificationIds: [mine, theirs] })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    // The refused request changed nothing, including the caller's own notification.
    expect(store.unreadCount(ownerId)).toBe(1);
    expect(store.unreadCount(otherId)).toBe(1);
    // Another principal's later rows do not widen the watermark into their inbox either.
    const through = store.list(otherId, { limit: 10, unreadOnly: false }).readThrough!;
    expect(store.markRead(ownerId, { all: true, through })).toBe(1);
    expect(store.unreadCount(otherId)).toBe(1);
  });

  it('marks all read only through the list watermark, leaving rows written later unread whatever their transition time', () => {
    const { store, emit, clock, ownerId, otherId } = setup();
    expect(store.list(ownerId, { limit: 10, unreadOnly: false }).readThrough).toBeNull();
    emit(ownerId, 'agent.failed', T0 + 1_000);
    const { readThrough } = store.list(ownerId, { limit: 10, unreadOnly: false });
    // Written after the owner loaded the list, but for a transition that happened earlier.
    const lateWritten = emit(ownerId, 'agent.failed', T0);
    emit(otherId, 'agent.failed', T0);
    clock.now = T0 + 2_000;
    expect(store.markRead(ownerId, { all: true, through: readThrough! })).toBe(1);
    expect(store.list(ownerId, { limit: 10, unreadOnly: true }).notifications.map((entry) => entry.notificationId)).toEqual([lateWritten]);
    expect(() => store.markRead(ownerId, { all: true, through: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('fills preference defaults and revokes pending and leased deliveries when a channel is turned off', () => {
    const { store, emit, ownerId, otherId, database } = setup();
    expect(store.preferences(ownerId).every((preference) => preference.enabled)).toBe(true);
    expect(store.preferences(ownerId)).toHaveLength(12);
    const pending = emit(ownerId, 'agent.failed');
    const leased = emit(ownerId, 'agent.failed');
    const otherKind = emit(ownerId, 'agent.completed');
    const otherPrincipal = emit(otherId, 'agent.failed');
    const claimed = store.claim(['fake_chat'], 10, 30_000).find((entry) => entry.notificationId === leased)!;
    const revoked = store.setPreferences(ownerId, [{ channel: 'fake_chat', kind: 'agent.failed', enabled: false }]);
    expect(revoked).toBe(2);
    expect(store.deliveryState(pending, 'fake_chat')).toBe('REVOKED');
    expect(store.deliveryState(leased, 'fake_chat')).toBe('REVOKED');
    expect(store.deliveryState(otherKind, 'fake_chat')).not.toBe('REVOKED');
    expect(store.deliveryState(otherPrincipal, 'fake_chat')).not.toBe('REVOKED');
    expect(store.report(leased, 'fake_chat', claimed.leaseToken, { state: 'DELIVERED', attempts: 1, nextAttemptAt: T0, errorClass: null })).toBe(false);
    expect(deliveries(database, pending).find((row) => row.channel === 'fake_chat')!.last_error_class).toBe('preference_disabled');
    expect(deliveries(database, pending).find((row) => row.channel === 'inbox')!.state).toBe('DELIVERED');
  });

  it('revokes at claim time when a preference was stored directly', () => {
    const { store, emit, ownerId, database, clock } = setup();
    const id = emit(ownerId, 'agent.failed');
    database.prepare("INSERT INTO notification_preferences VALUES (?, 'fake_chat', 'agent.failed', 0, ?)").run(ownerId, clock.now);
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
    expect(store.deliveryState(id, 'fake_chat')).toBe('REVOKED');
  });

  it('abandons the pending MCP event webhook when the mcp_event channel is turned off', () => {
    const { store, ownerId, database, clock } = setup();
    enableNotifications(['mcp_event']);
    insertSubscription(database, ownerId, 'cloudharness.notification.created');
    const emitAgent = (subject: string) => emitNotification(database, {
      principalId: ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: subject, transition: 'terminal',
      title: 'Agent failed', link: null, occurredAt: clock.now
    }, clock.now)!;
    const event = (notificationId: string) => database.prepare(`SELECT status, last_error, lease_token FROM event_deliveries
      WHERE event_id = ?`).get(eventIdForSource(`notification:${notificationId}`)) as { status: string; last_error: string | null; lease_token: string | null };

    const viaPreferences = emitAgent('agent_pref');
    expect(event(viaPreferences).status).toBe('PENDING');
    expect(store.setPreferences(ownerId, [{ channel: 'mcp_event', kind: 'agent.failed', enabled: false }])).toBe(1);
    expect(event(viaPreferences)).toEqual({ status: 'ABANDONED', last_error: 'preference_disabled', lease_token: null });

    // A preference stored behind the store's back is caught at claim time, with the same effect.
    database.prepare("DELETE FROM notification_preferences WHERE principal_id = ?").run(ownerId);
    const viaClaim = emitAgent('agent_claim');
    expect(event(viaClaim).status).toBe('PENDING');
    database.prepare("INSERT INTO notification_preferences VALUES (?, 'mcp_event', 'agent.failed', 0, ?)").run(ownerId, clock.now);
    expect(store.claim(['mcp_event'], 10, 30_000)).toEqual([]);
    expect(store.deliveryState(viaClaim, 'mcp_event')).toBe('REVOKED');
    expect(event(viaClaim)).toEqual({ status: 'ABANDONED', last_error: 'preference_disabled', lease_token: null });
  });

  it('fails a delivery still open past the hard cutoff so it no longer pins its notification', () => {
    const { store, emit, clock, ownerId, database } = setup();
    const stuck = emit(ownerId, 'agent.failed', T0);
    store.claim(['fake_chat'], 10, 30_000);
    clock.now = T0 + NOTIFICATION_RETENTION_MS + 1;
    expect(store.purge()).toBe(0);
    expect(store.deliveryState(stuck, 'fake_chat')).toBe('CLAIMED');
    clock.now = T0 + NOTIFICATION_HARD_CUTOFF_MS + 1;
    expect(store.purge()).toBe(1);
    expect(deliveries(database, stuck)).toEqual([]);
    expect(store.list(ownerId, { limit: 10, unreadOnly: false }).notifications).toEqual([]);
  });

  it('purges settled notifications past retention and beyond the per-principal cap, keeping pending ones', () => {
    const { store, emit, clock, ownerId, database } = setup();
    const old = emit(ownerId, 'agent.failed', T0);
    const [claimed] = store.claim(['fake_chat'], 10, 30_000);
    store.report(old, 'fake_chat', claimed!.leaseToken, { state: 'DELIVERED', attempts: 1, nextAttemptAt: T0, errorClass: null });
    const stillPending = emit(ownerId, 'agent.failed', T0);
    clock.now = T0 + NOTIFICATION_RETENTION_MS + 1;
    expect(store.purge()).toBe(1);
    expect(store.list(ownerId, { limit: 10, unreadOnly: false }).notifications.map((entry) => entry.notificationId)).toEqual([stillPending]);
    expect(deliveries(database, old)).toEqual([]);
  });
});
