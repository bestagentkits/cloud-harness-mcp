import { afterEach, describe, expect, it } from 'vitest';
import { emitNotification } from '../src/notifications/notification-emitter.js';
import { NOTIFICATION_RETENTION_MS, NotificationStore, NotificationStoreError } from '../src/notifications/notification-store.js';
import { T0, deliveries, disableNotifications, enableNotifications, openNotificationDatabase } from './support/notification-fixtures.js';

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
  it('leases a delivery to one holder and reclaims it only after the lease expires', () => {
    const { store, emit, clock, database } = setup();
    const id = emit();
    const [first] = store.claim(['fake_chat'], 10, 30_000);
    expect(first).toMatchObject({ notificationId: id, channel: 'fake_chat', attempts: 0 });
    expect(store.claim(['fake_chat'], 10, 30_000)).toEqual([]);
    expect(deliveries(database, id).find((row) => row.channel === 'fake_chat')!.state).toBe('CLAIMED');
    clock.now += 30_000;
    const [second] = store.claim(['fake_chat'], 10, 30_000);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    // The first holder's late report is refused; only the current lease settles the delivery.
    expect(store.report(id, 'fake_chat', first!.leaseToken, { state: 'DELIVERED', attempts: 1, nextAttemptAt: clock.now, errorClass: null })).toBe(false);
    expect(store.report(id, 'fake_chat', second!.leaseToken, { state: 'DELIVERED', attempts: 1, nextAttemptAt: clock.now, errorClass: null })).toBe(true);
    expect(store.report(id, 'fake_chat', second!.leaseToken, { state: 'FAILED', attempts: 2, nextAttemptAt: clock.now, errorClass: 'x' })).toBe(false);
    expect(store.deliveryState(id, 'fake_chat')).toBe('DELIVERED');
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
    expect(store.markRead(ownerId, { all: true })).toBe(1);
    expect(store.unreadCount(otherId)).toBe(1);
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
