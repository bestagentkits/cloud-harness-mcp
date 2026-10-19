import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  NOTIFICATION_LIMITS,
  NotificationLinkSchema,
  type NotificationKind,
  type NotificationSubjectType
} from '@cloud-harness/contracts';
import { recordEvent, withEventSavepoint } from '../event-outbox.js';
import { redactTraceText } from '../agent-trace-recorder.js';
import { insertNotification, insertNotificationDelivery, notificationPreferenceEnabled } from './notification-store.js';

/**
 * Writes inbox notifications in the same savepoint as the transition that caused them. Every emitter
 * here is a no-op while notifications are off, and a failure is caught, counted and logged inside a
 * nested savepoint, so a failed notification never rolls back the transition it describes. The one
 * exception is an error after which SQLite has already rolled back the enclosing transaction: that
 * error is re-thrown, because the transition is lost either way.
 *
 * Channels: `inbox` is always written and starts DELIVERED. `mcp_event` records the
 * `cloudharness.notification.created` MCP event through the existing subscription path and gets a
 * delivery row only when a subscription received it. `github` mirrors an automation workflow's own
 * comment publication and gets a row only when that workflow publishes. Any other registered channel
 * (a NotificationAdapter) gets a PENDING row. A channel the owner turned off gets no row.
 */

export const NOTIFICATION_CREATED_EVENT = 'cloudharness.notification.created' as const;
const DEFAULT_PUSH_CHANNELS: readonly string[] = ['mcp_event', 'github'];
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const TRANSITION = /^[A-Za-z0-9_.:-]{1,80}$/u;

type NotificationRuntime = {
  enabled: boolean;
  channels: readonly string[];
  onError: (error: unknown) => void;
};

let runtime: NotificationRuntime = { enabled: false, channels: DEFAULT_PUSH_CHANNELS, onError: () => undefined };
let emitFailures = 0;

/**
 * Process-wide switch, set once at startup from NOTIFICATIONS_ENABLED. `channels` names the push
 * channels with a registered adapter (the inbox is implicit); emitters live behind transition code
 * that cannot take extra parameters, which is why this is module state rather than an argument.
 */
export function configureNotifications(options: { enabled: boolean; channels?: readonly string[]; onError?: (error: unknown) => void }): void {
  runtime = {
    enabled: options.enabled,
    channels: [...new Set(options.channels ?? DEFAULT_PUSH_CHANNELS)].filter((channel) => channel !== 'inbox'),
    onError: options.onError ?? (() => undefined)
  };
}

export function notificationsEnabled(): boolean {
  return runtime.enabled;
}

/** Emissions that failed and were skipped since startup; the parent transitions still committed. */
export function notificationEmitFailures(): number {
  return emitFailures;
}

export type NotificationEmission = {
  principalId: string;
  kind: NotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  /** Names the transition, so `<principal>:<subject>:<transition>` identifies one logical notification. */
  transition: string;
  title: string;
  link: string | null;
  occurredAt?: number;
  /** The automation workflow whose `publish_state` the github channel mirrors. */
  githubWorkflowId?: string;
};

/** The notification id for a dedupe key: one logical notification maps to exactly one id. */
export function notificationIdFor(dedupeKey: string): string {
  return `ntf_${createHash('sha256').update(dedupeKey, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Titles are redacted for credential shapes, stripped of control characters and bounded. */
export function boundedNotificationTitle(value: string): string {
  const cleaned = redactTraceText(value).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (cleaned.length === 0) return 'Notification';
  // The contract bounds titles in UTF-16 code units (string length), so the cut is measured the same
  // way, never splitting a surrogate pair, and leaves one unit for the ellipsis.
  if (cleaned.length <= NOTIFICATION_LIMITS.maxTitleChars) return cleaned;
  let bounded = '';
  for (const char of cleaned) {
    if (bounded.length + char.length > NOTIFICATION_LIMITS.maxTitleChars - 1) break;
    bounded += char;
  }
  return `${bounded}…`;
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function githubMirrorApplies(database: DatabaseSync, workflowId: string | undefined): boolean {
  if (workflowId === undefined || !tableExists(database, 'automation_workflows')) return false;
  const row = database.prepare('SELECT publish_state FROM automation_workflows WHERE id = ?').get(workflowId) as { publish_state: string } | undefined;
  return row !== undefined && row.publish_state !== 'NONE';
}

function write(database: DatabaseSync, input: NotificationEmission, now: number): string | null {
  if (!SUBJECT_ID.test(input.subjectId)) throw new Error('notification subject id is invalid');
  if (!TRANSITION.test(input.transition)) throw new Error('notification transition is invalid');
  const dedupeKey = `${input.principalId}:${input.subjectType}:${input.subjectId}:${input.transition}`;
  const notificationId = notificationIdFor(dedupeKey);
  const createdAt = input.occurredAt ?? now;
  const link = input.link !== null && NotificationLinkSchema.safeParse(input.link).success ? input.link : null;
  const payload = {
    notificationId,
    kind: input.kind,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    title: boundedNotificationTitle(input.title),
    link,
    createdAt: new Date(createdAt).toISOString()
  };
  const inserted = insertNotification(database, {
    notificationId, principalId: input.principalId, kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId,
    dedupeKey, title: payload.title, payloadJson: JSON.stringify(payload), createdAt
  });
  if (!inserted) return null;
  insertNotificationDelivery(database, notificationId, 'inbox', 'DELIVERED', now);
  for (const channel of runtime.channels) {
    if (!notificationPreferenceEnabled(database, input.principalId, channel, input.kind)) continue;
    if (channel === 'mcp_event') {
      if (recordEvent(database, input.principalId, `notification:${notificationId}`, NOTIFICATION_CREATED_EVENT, createdAt, payload, now)) {
        insertNotificationDelivery(database, notificationId, channel, 'PENDING', now);
      }
      continue;
    }
    if (channel === 'github') {
      if (githubMirrorApplies(database, input.githubWorkflowId)) insertNotificationDelivery(database, notificationId, channel, 'PENDING', now);
      continue;
    }
    insertNotificationDelivery(database, notificationId, channel, 'PENDING', now);
  }
  return notificationId;
}

/**
 * Records one logical notification and its channel deliveries. Must run on the connection, and inside
 * the savepoint, of the transition it describes. Returns the new notification id, or null when
 * notifications are off, the notification already existed, or the write failed (counted and logged).
 */
export function emitNotification(database: DatabaseSync, input: NotificationEmission, now: number): string | null {
  if (!runtime.enabled) return null;
  const outer = database.isTransaction;
  try {
    return withEventSavepoint(database, () => write(database, input, now));
  } catch (error) {
    // SQLite rolls the whole transaction back on some errors (SQLITE_FULL, IOERR, NOMEM). The parent
    // transition is then already lost, and swallowing the error would let the caller's following
    // writes autocommit outside it, so the error is the caller's to handle.
    if (outer && !database.isTransaction) throw error;
    recordFailure(error);
    return null;
  }
}

function recordFailure(error: unknown): void {
  emitFailures += 1;
  try { runtime.onError(error); } catch { /* a logger failure must not abort the transition either */ }
}

type AutomationNotificationRow = {
  id: string; owner_id: string; state: string; repository: string; resource_number: number;
  error_code: string | null; terminal_at: number | null;
};

/**
 * The Dashboard deep link of an automation run. Coding runs finish through automation workflows, so
 * this is the one place a coding run's notification gains its run view; the coding broker's PR URL and
 * trace id belong here once that broker lands on this branch's base.
 */
export function automationNotificationLink(workflowId: string): string {
  return `/dashboard/automations/runs/${workflowId}`;
}

/** Called by the automation terminal event emitter inside the terminal transition's savepoint. */
export function emitAutomationTerminalNotification(database: DatabaseSync, workflowId: string, now: number): void {
  if (!runtime.enabled) return;
  let row: AutomationNotificationRow | undefined;
  try {
    row = database.prepare(`SELECT id, owner_id, state, repository, resource_number, error_code, terminal_at
      FROM automation_workflows WHERE id = ?`).get(workflowId) as AutomationNotificationRow | undefined;
  } catch (error) {
    recordFailure(error);
    return;
  }
  if (!row) return;
  const resource = `${row.repository}#${row.resource_number}`;
  const base = {
    principalId: row.owner_id, subjectType: 'automation_workflow' as const, subjectId: row.id, transition: 'terminal',
    link: automationNotificationLink(row.id), occurredAt: row.terminal_at ?? now, githubWorkflowId: row.id
  };
  if (row.state === 'COMPLETED') {
    emitNotification(database, { ...base, kind: 'automation.completed', title: `Automation completed: ${resource}` }, now);
    return;
  }
  if (row.state !== 'FAILED' && row.state !== 'CANCELLED' && row.state !== 'EXPIRED') return;
  const reason = row.error_code ? ` (${row.error_code.slice(0, 60)})` : '';
  emitNotification(database, { ...base, kind: 'automation.failed', title: `Automation ${row.state.toLowerCase()}: ${resource}${reason}` }, now);
}

const AUTOMATION_SPAWN_KEY = /^automation:(wfl_[a-f0-9]{32}):spawn$/u;
const FAILED_AGENT_STATUSES = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']);

/**
 * Called by the agent terminal event emitter inside the terminal record's savepoint. Only top-level
 * agents the owner started directly notify: a child agent reports through its parent, and an agent
 * an automation workflow started is covered by that workflow's own notification.
 */
export function emitAgentTerminalNotification(
  database: DatabaseSync,
  agent: { ownerId: string; agentId: string; parentAgentId: string | null; status: string; occurredAt: number },
  now: number
): void {
  if (!runtime.enabled || agent.parentAgentId !== null) return;
  const succeeded = agent.status === 'SUCCEEDED';
  if (!succeeded && !FAILED_AGENT_STATUSES.has(agent.status)) return;
  try {
    // An automation spawns with `automation:<workflowId>:spawn`. The key is on the agent row from
    // admission, before the workflow records `agent_id`, so an agent that ends early still defers to
    // its workflow's notification. A caller can choose the same key shape, so the workflow it names
    // must exist for this owner too. Both reads are primary-key lookups.
    const spawned = database.prepare('SELECT idempotency_key FROM agents WHERE id = ?').get(agent.agentId) as { idempotency_key: string } | undefined;
    const workflowId = spawned ? AUTOMATION_SPAWN_KEY.exec(spawned.idempotency_key)?.[1] : undefined;
    if (workflowId !== undefined && tableExists(database, 'automation_workflows')
      && database.prepare('SELECT 1 FROM automation_workflows WHERE id = ? AND owner_id = ?').get(workflowId, agent.ownerId) !== undefined) return;
  } catch (error) {
    recordFailure(error);
    return;
  }
  emitNotification(database, {
    principalId: agent.ownerId,
    kind: succeeded ? 'agent.completed' : 'agent.failed',
    subjectType: 'agent',
    subjectId: agent.agentId,
    transition: 'terminal',
    title: succeeded ? 'Agent run completed' : `Agent run ended: ${agent.status.toLowerCase().replaceAll('_', ' ')}`,
    link: `/dashboard/agents/${agent.agentId}`,
    occurredAt: agent.occurredAt
  }, now);
}

/**
 * For human-in-the-loop workflows: a workflow is waiting for an owner decision on `approvalId`. One
 * notification per (workflow, approval). Call inside the savepoint that records the wait.
 */
export function emitWaitingForHumanNotification(
  database: DatabaseSync,
  input: { principalId: string; workflowId: string; approvalId: string; title?: string; link?: string; occurredAt?: number },
  now: number
): string | null {
  return emitNotification(database, {
    principalId: input.principalId,
    kind: 'workflow.waiting_for_human',
    subjectType: 'automation_workflow',
    subjectId: input.workflowId,
    transition: `waiting:${input.approvalId}`,
    title: input.title ?? 'Workflow waiting for your approval',
    link: input.link ?? '/dashboard/approvals',
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {})
  }, now);
}

/**
 * For human-in-the-loop workflows: an approval was decided (approved, denied or expired). One
 * notification per approval. Call inside the savepoint that records the decision.
 */
export function emitApprovalDecidedNotification(
  database: DatabaseSync,
  input: {
    principalId: string; approvalId: string; decision: 'approved' | 'denied' | 'expired';
    workflowId?: string; title?: string; link?: string; occurredAt?: number;
  },
  now: number
): string | null {
  return emitNotification(database, {
    principalId: input.principalId,
    kind: 'approval.decided',
    subjectType: 'approval',
    subjectId: input.approvalId,
    transition: 'decided',
    title: input.title ?? `Approval ${input.decision}`,
    link: input.link ?? (input.workflowId ? automationNotificationLink(input.workflowId) : '/dashboard/approvals'),
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {})
  }, now);
}
