import { afterEach, describe, expect, it } from 'vitest';
import { emitAutomationTerminalEvent, recordEvent, withEventSavepoint } from '../src/event-outbox.js';
import {
  T0, deliveries, disableNotifications, enableNotifications, insertSubscription, insertWorkflow, notificationRows,
  openNotificationDatabase, setWorkflowState
} from './support/notification-fixtures.js';

const closers: (() => void)[] = [];
afterEach(() => {
  disableNotifications();
  for (const close of closers.splice(0)) close();
});

function open() {
  const context = openNotificationDatabase();
  closers.push(context.close);
  return context;
}

const eventCount = (database: ReturnType<typeof open>['database']) =>
  (database.prepare('SELECT count(*) AS count FROM event_outbox').get() as { count: number }).count;

describe('event outbox', () => {
  it('reports whether it wrote an event: only with a matching subscriber and only once per source', () => {
    const { database, ownerId } = open();
    const record = () => recordEvent(database, ownerId, 'automation:x:terminal', 'cloudharness.automation.completed', T0, { workflowId: 'x' }, T0);
    expect(record()).toBe(false);
    insertSubscription(database, ownerId, 'cloudharness.automation.completed');
    expect(record()).toBe(true);
    expect(record()).toBe(false);
    expect(eventCount(database)).toBe(1);
  });

  it('records the terminal event only, with no inbox rows, while notifications are off', () => {
    const { database, ownerId } = open();
    insertSubscription(database, ownerId, 'cloudharness.automation.completed');
    const workflowId = insertWorkflow(database, { ownerId });
    withEventSavepoint(database, () => {
      setWorkflowState(database, workflowId, 'COMPLETED');
      emitAutomationTerminalEvent(database, workflowId, T0);
    });
    expect(eventCount(database)).toBe(1);
    expect(notificationRows(database)).toHaveLength(0);
  });

  it('writes the terminal event and the inbox notification in the transition savepoint, and rolls both back together', () => {
    const { database, ownerId } = open();
    enableNotifications();
    insertSubscription(database, ownerId, 'cloudharness.automation.failed');
    insertSubscription(database, ownerId, 'cloudharness.notification.created');
    const rolledBack = insertWorkflow(database, { ownerId });
    expect(() => withEventSavepoint(database, () => {
      setWorkflowState(database, rolledBack, 'FAILED', 'AGENT_FAILED');
      emitAutomationTerminalEvent(database, rolledBack, T0);
      throw new Error('abort');
    })).toThrow('abort');
    expect(eventCount(database)).toBe(0);
    expect(notificationRows(database)).toHaveLength(0);

    const committed = insertWorkflow(database, { ownerId });
    withEventSavepoint(database, () => {
      setWorkflowState(database, committed, 'FAILED', 'AGENT_FAILED');
      emitAutomationTerminalEvent(database, committed, T0);
    });
    const names = (database.prepare('SELECT name FROM event_outbox ORDER BY name').all() as { name: string }[]).map((row) => row.name);
    expect(names).toEqual(['cloudharness.automation.failed', 'cloudharness.notification.created']);
    const [notification] = notificationRows(database);
    expect(notification!.kind).toBe('automation.failed');
    expect(deliveries(database, notification!.notification_id).map((row) => `${row.channel}:${row.state}`)).toEqual(['inbox:DELIVERED', 'mcp_event:PENDING']);
  });
});
