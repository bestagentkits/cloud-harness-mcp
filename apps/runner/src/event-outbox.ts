import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { McpEventName } from '@cloud-harness/contracts';

/**
 * Transactional outbox for MCP Events. Emission runs on the same connection and inside the same
 * savepoint as the generation-guarded terminal transition, so a state change and its event commit
 * or roll back together. Payloads carry identifiers, statuses, codes and timestamps only — never
 * command text, output, prompts, or free-form reasons.
 */

const TERMINAL_TASK_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const MAX_CODE_LENGTH = 100;

let savepointSequence = 0;

/** Runs `action` inside a savepoint, nesting safely inside an open transaction or opening one. */
export function withEventSavepoint<T>(database: DatabaseSync, action: () => T): T {
  savepointSequence = (savepointSequence + 1) % 1_000_000;
  const name = `mcp_event_${savepointSequence}`;
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    database.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO ${name}`);
    database.exec(`RELEASE ${name}`);
    throw error;
  }
}

export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_TASK_STATUSES.has(status);
}

/** Deterministic, opaque event id: one source transition maps to exactly one id. */
export function eventIdForSource(sourceKey: string): string {
  return `evt_${createHash('sha256').update(sourceKey, 'utf8').digest('hex').slice(0, 32)}`;
}

export function newDeliveryId(): string {
  return `dlv_${randomBytes(16).toString('base64url')}`;
}

const iso = (value: number): string => new Date(value).toISOString();
const boundedCode = (value: string | null): string | null => (value === null ? null : value.slice(0, MAX_CODE_LENGTH));

function matchesArguments(argumentsJson: string, payload: Record<string, unknown>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.entries(parsed as Record<string, unknown>).every(([key, value]) => payload[key] === value);
}

/**
 * Records one logical event and fans it out to the owner's active, unexpired subscriptions whose
 * filter arguments match. Nothing is written when no subscription matches: events are not replayed
 * to later subscribers, so an outbox row without a recipient would only be retained garbage.
 */
function recordEvent(
  database: DatabaseSync,
  ownerId: string,
  sourceKey: string,
  name: McpEventName,
  occurredAt: number,
  payload: Record<string, unknown>,
  now: number
): void {
  const subscriptions = database.prepare(`SELECT id, arguments_json FROM event_subscriptions
    WHERE owner_id = ? AND name = ? AND state = 'ACTIVE' AND expires_at > ?`)
    .all(ownerId, name, now) as { id: string; arguments_json: string }[];
  const recipients = subscriptions.filter((subscription) => matchesArguments(subscription.arguments_json, payload));
  if (recipients.length === 0) return;
  const eventId = eventIdForSource(sourceKey);
  const inserted = database.prepare(`INSERT OR IGNORE INTO event_outbox (id, owner_id, source_key, name, occurred_at, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, ownerId, sourceKey, name, occurredAt, JSON.stringify(payload), now);
  if (Number(inserted.changes) !== 1) return;
  const insertDelivery = database.prepare(`INSERT OR IGNORE INTO event_deliveries
    (id, event_id, subscription_id, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`);
  for (const recipient of recipients) insertDelivery.run(newDeliveryId(), eventId, recipient.id, now, now);
}

type TaskEventRow = {
  id: string; workspace_id: string; owner_id: string; name: string | null; status: string;
  exit_code: number | null; error_code: string | null; finished_at: number | null;
};

/** Emits the task terminal event for a task that has just entered a terminal status. */
export function emitTaskTerminalEvent(database: DatabaseSync, taskId: string, now: number): void {
  const row = database.prepare(`SELECT id, workspace_id, owner_id, name, status, exit_code, error_code, finished_at
    FROM durable_tasks WHERE id = ?`).get(taskId) as TaskEventRow | undefined;
  if (!row || !isTerminalTaskStatus(row.status)) return;
  const occurredAt = row.finished_at ?? now;
  if (row.status === 'SUCCEEDED') {
    recordEvent(database, row.owner_id, `task:${row.id}:terminal`, 'cloudharness.task.completed', occurredAt, {
      workspaceId: row.workspace_id,
      taskId: row.id,
      name: row.name,
      status: 'SUCCEEDED',
      exitCode: row.exit_code,
      finishedAt: iso(occurredAt)
    }, now);
    return;
  }
  recordEvent(database, row.owner_id, `task:${row.id}:terminal`, 'cloudharness.task.failed', occurredAt, {
    workspaceId: row.workspace_id,
    taskId: row.id,
    name: row.name,
    status: row.status,
    exitCode: row.exit_code,
    errorCode: boundedCode(row.error_code),
    finishedAt: iso(occurredAt)
  }, now);
}

type AgentEventRow = {
  id: string; workspace_id: string; owner_id: string; parent_agent_id: string | null; status: string;
  outcome_unknown: number; terminal_at: number | null;
};

const FAILED_AGENT_STATUSES = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']);

/** Emits the agent terminal event for an agent that has just reached a terminal record. */
export function emitAgentTerminalEvent(database: DatabaseSync, ownerId: string, workspaceId: string, agentId: string, now: number): void {
  const row = database.prepare(`SELECT id, workspace_id, owner_id, parent_agent_id, status, outcome_unknown, terminal_at
    FROM agents WHERE owner_id = ? AND workspace_id = ? AND id = ?`).get(ownerId, workspaceId, agentId) as AgentEventRow | undefined;
  if (!row) return;
  const occurredAt = row.terminal_at ?? now;
  const base = { workspaceId: row.workspace_id, agentId: row.id, parentAgentId: row.parent_agent_id };
  if (row.status === 'SUCCEEDED') {
    recordEvent(database, row.owner_id, `agent:${row.id}:terminal`, 'cloudharness.agent.settled', occurredAt, {
      ...base, status: 'SUCCEEDED', terminalAt: iso(occurredAt)
    }, now);
    return;
  }
  if (!FAILED_AGENT_STATUSES.has(row.status)) return;
  recordEvent(database, row.owner_id, `agent:${row.id}:terminal`, 'cloudharness.agent.failed', occurredAt, {
    ...base, status: row.status, outcomeUnknown: row.outcome_unknown === 1, terminalAt: iso(occurredAt)
  }, now);
}
