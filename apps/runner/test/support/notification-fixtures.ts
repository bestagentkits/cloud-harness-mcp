import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initializeAutomationSchema } from '../../src/automation-schema.js';
import { configureNotifications } from '../../src/notifications/notification-emitter.js';
import { StateStore } from '../../src/state-store.js';

export const T0 = Date.parse('2026-10-20T00:00:00Z');

/** A real state database with the automation tables, two principals and a cleanup function. */
export function openNotificationDatabase(path?: string) {
  const directory = path ? undefined : mkdtempSync(join(tmpdir(), 'cloud-harness-notifications-'));
  const file = path ?? join(directory!, 'state.db');
  const store = new StateStore(file);
  initializeAutomationSchema(store.database);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const otherId = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.example.com', subject: 'someone-else' });
  return {
    store,
    database: store.database,
    path: file,
    ownerId,
    otherId,
    close: () => {
      try { store.close(); } catch { /* already closed */ }
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** Turns notifications on (or off) for a test and resets the module switch afterwards. */
export function enableNotifications(channels: readonly string[] = ['mcp_event', 'github'], onError?: (error: unknown) => void): void {
  configureNotifications({ enabled: true, channels, ...(onError ? { onError } : {}) });
}

export function disableNotifications(): void {
  configureNotifications({ enabled: false });
}

let workflowSequence = 0;
/** Inserts an automation workflow row directly, as the automation engine would have. */
export function insertWorkflow(database: DatabaseSync, options: {
  ownerId: string; state?: string; publishState?: 'NONE' | 'PENDING' | 'DELIVERED' | 'FAILED'; agentId?: string | null; errorCode?: string | null;
}): string {
  workflowSequence += 1;
  const id = `wfl_${workflowSequence.toString(16).padStart(32, '0')}`;
  database.prepare(`INSERT INTO automation_workflows (id, owner_id, rule_id, rule_generation, rule_snapshot_json, connection_id, delivery_id,
      event_type, repository, resource_number, resource_url, resource_key, label, prompt, state, agent_id, error_code, publish_state,
      next_attempt_at, created_at, updated_at, terminal_at)
    VALUES (?, ?, ?, 1, '{}', 'con_x', ?, 'github.issue.label_added', 'acme/widgets', 7, 'https://github.com/acme/widgets/issues/7',
      ?, 'claude', 'prompt text that must never reach a notification', ?, ?, ?, ?, ?, ?, ?, ?)`)
    // The resource key is unique per row: the engine allows one active workflow per resource.
    .run(id, options.ownerId, `arl_${'1'.repeat(32)}`, `delivery-${workflowSequence}`, `acme/widgets#7:${workflowSequence}`, options.state ?? 'RUNNING', options.agentId ?? null,
      options.errorCode ?? null, options.publishState ?? 'NONE', T0, T0, T0, null);
  return id;
}

/** Moves a workflow to a terminal state, as `AutomationService.finish` does, without the event hook. */
export function setWorkflowState(database: DatabaseSync, id: string, state: string, errorCode: string | null = null): void {
  database.prepare('UPDATE automation_workflows SET state = ?, error_code = ?, terminal_at = ? WHERE id = ?').run(state, errorCode, T0, id);
}

let subscriptionSequence = 0;
/** An active MCP event subscription row, inserted directly (no keyring needed for fan-out). */
export function insertSubscription(database: DatabaseSync, ownerId: string, name: string, args: Record<string, unknown> = {}): string {
  subscriptionSequence += 1;
  const id = `sub_${subscriptionSequence.toString(16).padStart(32, '0')}`;
  database.prepare(`INSERT INTO event_subscriptions (id, owner_id, name, arguments_json, url, state, secret_generation,
    secret_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'https://hooks.example.com/x', 'ACTIVE', 1, '{}', ?, ?, ?)`)
    .run(id, ownerId, name, JSON.stringify(args), T0 + 86_400_000, T0, T0);
  return id;
}

export type DeliveryRow = { notification_id: string; channel: string; state: string; attempts: number; last_error_class: string | null };

export function deliveries(database: DatabaseSync, notificationId?: string): DeliveryRow[] {
  return (notificationId
    ? database.prepare('SELECT notification_id, channel, state, attempts, last_error_class FROM notification_deliveries WHERE notification_id = ? ORDER BY channel').all(notificationId)
    : database.prepare('SELECT notification_id, channel, state, attempts, last_error_class FROM notification_deliveries ORDER BY notification_id, channel').all()) as DeliveryRow[];
}

export type NotificationRow = { notification_id: string; kind: string; title: string; payload_json: string; principal_id: string };

export function notificationRows(database: DatabaseSync): NotificationRow[] {
  return database.prepare('SELECT notification_id, kind, title, payload_json, principal_id FROM notifications ORDER BY created_at, notification_id')
    .all() as NotificationRow[];
}
