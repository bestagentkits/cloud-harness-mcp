import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationCreatedPayloadSchema } from '@cloud-harness/contracts';
import { traceIdFor } from '../src/agent-trace-store.js';
import { withEventSavepoint } from '../src/event-outbox.js';
import {
  boundedNotificationTitle,
  emitAgentTerminalNotification,
  emitApprovalDecidedNotification,
  emitAutomationTerminalNotification,
  emitNotification,
  emitWaitingForHumanNotification,
  notificationEmitFailures,
  notificationIdFor,
  relatedLinks
} from '../src/notifications/notification-emitter.js';
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

const AGENT = `agent_${'b'.repeat(24)}`;

/** A bare agent row carrying only what the emitter reads; the workspace foreign key is not under test. */
function insertAgentRow(database: DatabaseSync, ownerId: string, agentId: string, idempotencyKey: string): void {
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.prepare(`INSERT INTO agents (id, owner_id, workspace_id, workspace_generation, idempotency_key, payload_hash, prompt_hash,
        profile_id, proxy_operations_json, max_ttl_seconds, max_output_bytes, max_input_tokens, max_output_tokens, max_cost_micros,
        container_name, network_name, gateway_lease_id, status, generation, created_at, expires_at)
      VALUES (?, ?, 'wks_test', 1, ?, 'h', 'h', 'p', '[]', 60, 1, 1, 1, 1, 'c', 'n', ?, 'RUNNING', 1, ?, ?)`)
      .run(agentId, ownerId, idempotencyKey, `lease-${agentId}`, T0, T0 + 60_000);
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

/** A trace row carrying only what the emitter reads. */
function insertTrace(database: DatabaseSync, principalId: string, traceId: string, agentId: string, generation = 1, workflowId: string | null = null): void {
  database.prepare(`INSERT INTO agent_traces (trace_id, principal_id, workspace_id, agent_id, generation, workflow_id, state, started_at,
      cost_provenance, coverage, expires_at) VALUES (?, ?, 'wks_test', ?, ?, ?, 'COMPLETED', ?, 'unknown', 'full', ?)`)
    .run(traceId, principalId, agentId, generation, workflowId, T0 + generation, T0 + 86_400_000);
}

/** An automation connection row carrying only what the emitter reads: its owner and provider. */
function insertConnection(database: DatabaseSync, ownerId: string, id: string, provider: string): void {
  database.prepare(`INSERT INTO automation_connections (id, owner_id, provider, name, enabled, generation, secret_generation, secret_json,
      secret_rotated_at, created_at, updated_at) VALUES (?, ?, ?, 'test', 1, 1, 1, '{}', ?, ?, ?)`)
    .run(id, ownerId, provider, T0, T0, T0);
}

describe('notification emitter', () => {
  it('writes nothing while notifications are disabled', () => {
    const { database, ownerId } = open();
    const workflowId = insertWorkflow(database, { ownerId, publishState: 'PENDING' });
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    expect(emitWaitingForHumanNotification(database, { principalId: ownerId, workflowId, approvalId: 'apv_1' }, T0)).toBeNull();
    expect(notificationRows(database)).toHaveLength(0);
    expect(deliveries(database)).toHaveLength(0);
  });

  it('writes one inbox notification with a delivered inbox row and no rows for channels that do not apply', () => {
    const { database, ownerId } = open();
    enableNotifications();
    const workflowId = insertWorkflow(database, { ownerId, publishState: 'NONE' });
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    const [row] = notificationRows(database);
    expect(row).toMatchObject({ kind: 'automation.completed', title: 'Automation completed: acme/widgets#7', principal_id: ownerId });
    // No MCP subscription and a workflow that does not publish: only the inbox row exists.
    expect(deliveries(database)).toEqual([{ notification_id: row!.notification_id, channel: 'inbox', state: 'DELIVERED', attempts: 0, last_error_class: null }]);
    const payload = NotificationCreatedPayloadSchema.parse(JSON.parse(row!.payload_json));
    expect(payload.link).toBe(`/dashboard/automations/runs/${workflowId}`);
    expect(row!.payload_json).not.toContain('prompt text');
  });

  it('adds an MCP event delivery for a matching subscription and a github mirror for a publishing workflow', () => {
    const { database, ownerId } = open();
    enableNotifications(['mcp_event', 'github', 'fake_chat']);
    insertSubscription(database, ownerId, 'cloudharness.notification.created', { kind: 'automation.failed' });
    const workflowId = insertWorkflow(database, { ownerId, publishState: 'PENDING' });
    setWorkflowState(database, workflowId, 'FAILED', 'AGENT_FAILED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    const [row] = notificationRows(database);
    expect(row).toMatchObject({ kind: 'automation.failed', title: 'Automation failed: acme/widgets#7 (AGENT_FAILED)' });
    expect(deliveries(database).map((delivery) => `${delivery.channel}:${delivery.state}`)).toEqual([
      'fake_chat:PENDING', 'github:PENDING', 'inbox:DELIVERED', 'mcp_event:PENDING'
    ]);
    const event = database.prepare('SELECT name, payload_json FROM event_outbox').get() as { name: string; payload_json: string };
    expect(event.name).toBe('cloudharness.notification.created');
    expect(JSON.parse(event.payload_json)).toMatchObject({ notificationId: row!.notification_id, kind: 'automation.failed' });
  });

  it('does not deliver to an MCP subscription filtered to another kind', () => {
    const { database, ownerId } = open();
    enableNotifications();
    insertSubscription(database, ownerId, 'cloudharness.notification.created', { kind: 'agent.failed' });
    const workflowId = insertWorkflow(database, { ownerId });
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    expect(deliveries(database).map((delivery) => delivery.channel)).toEqual(['inbox']);
    expect(database.prepare('SELECT count(*) AS count FROM event_outbox').get()).toEqual({ count: 0 });
  });

  it('creates no delivery row for a channel the owner turned off', () => {
    const { database, ownerId } = open();
    enableNotifications(['mcp_event', 'github', 'fake_chat']);
    database.prepare("INSERT INTO notification_preferences VALUES (?, 'fake_chat', 'automation.completed', 0, ?)").run(ownerId, T0);
    database.prepare("INSERT INTO notification_preferences VALUES (?, 'github', 'automation.completed', 0, ?)").run(ownerId, T0);
    const workflowId = insertWorkflow(database, { ownerId, publishState: 'PENDING' });
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    expect(deliveries(database).map((delivery) => delivery.channel)).toEqual(['inbox']);
  });

  it('keeps one logical notification per principal, subject and transition across repeated emission', () => {
    const { database, ownerId } = open();
    enableNotifications(['fake_chat']);
    const workflowId = insertWorkflow(database, { ownerId });
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    emitAutomationTerminalNotification(database, workflowId, T0 + 5_000);
    enableNotifications(['fake_chat']);
    emitAutomationTerminalNotification(database, workflowId, T0 + 10_000);
    expect(notificationRows(database)).toHaveLength(1);
    expect(deliveries(database)).toHaveLength(2);
    expect(notificationRows(database)[0]!.notification_id).toBe(notificationIdFor(`${ownerId}:automation_workflow:${workflowId}:terminal`));
  });

  it('re-throws when SQLite already rolled back the enclosing transaction, instead of letting later writes autocommit', () => {
    const { database, ownerId } = open();
    const errors: unknown[] = [];
    enableNotifications([], (error) => errors.push(error));
    // RAISE(ROLLBACK) ends the whole transaction, as SQLITE_FULL or an I/O error can.
    database.exec(`CREATE TRIGGER notifications_abort BEFORE INSERT ON notifications BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END`);
    const workflowId = insertWorkflow(database, { ownerId });
    database.exec('BEGIN IMMEDIATE');
    setWorkflowState(database, workflowId, 'COMPLETED');
    expect(() => emitNotification(database, {
      principalId: ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: `${AGENT}7`, transition: 'terminal', title: 'x', link: null
    }, T0)).toThrow('disk full');
    expect(database.isTransaction).toBe(false);
    expect((database.prepare('SELECT state FROM automation_workflows WHERE id = ?').get(workflowId) as { state: string }).state).toBe('RUNNING');
    expect(errors).toEqual([]);
    // Without an enclosing transaction there is no parent to lose, so the same failure is swallowed.
    expect(emitNotification(database, {
      principalId: ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: `${AGENT}8`, transition: 'terminal', title: 'x', link: null
    }, T0)).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('does not roll back the parent transition when the notification write fails', () => {
    const { database, ownerId } = open();
    const errors: unknown[] = [];
    enableNotifications(['mcp_event'], (error) => errors.push(error));
    const before = notificationEmitFailures();
    database.exec('DROP TABLE notification_deliveries');
    const workflowId = insertWorkflow(database, { ownerId });
    withEventSavepoint(database, () => {
      setWorkflowState(database, workflowId, 'COMPLETED');
      emitAutomationTerminalNotification(database, workflowId, T0);
    });
    expect((database.prepare('SELECT state FROM automation_workflows WHERE id = ?').get(workflowId) as { state: string }).state).toBe('COMPLETED');
    // The failed notification rolled back with its own nested savepoint: no half-written row remains.
    expect(notificationRows(database)).toHaveLength(0);
    expect(notificationEmitFailures()).toBe(before + 1);
    expect(errors).toHaveLength(1);
  });

  it('rolls the notification back with the parent when the transition itself rolls back', () => {
    const { database, ownerId } = open();
    enableNotifications();
    const workflowId = insertWorkflow(database, { ownerId });
    expect(() => withEventSavepoint(database, () => {
      setWorkflowState(database, workflowId, 'COMPLETED');
      emitAutomationTerminalNotification(database, workflowId, T0);
      throw new Error('transition aborted');
    })).toThrow('transition aborted');
    expect(notificationRows(database)).toHaveLength(0);
  });

  it('notifies only top-level agents that no automation workflow spawned', () => {
    const { database, ownerId } = open();
    enableNotifications();
    const base = { ownerId, parentAgentId: null, occurredAt: T0 };
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}1`, parentAgentId: `${AGENT}0`, status: 'SUCCEEDED' }, T0);
    // An automation's agent can end before its workflow records `agent_id`; the spawn key on the agent
    // row identifies it either way, so it defers to the workflow's own notification.
    const workflowId = insertWorkflow(database, { ownerId, agentId: null });
    insertAgentRow(database, ownerId, `${AGENT}2`, `automation:${workflowId}:spawn`);
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}2`, status: 'FAILED' }, T0);
    // A caller's own key that merely starts with `automation:` does not hide its agent, nor does one in
    // the exact spawn shape that names no workflow of this owner.
    insertAgentRow(database, ownerId, `${AGENT}6`, 'automation:mine');
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}6`, status: 'CANCELLED' }, T0);
    insertAgentRow(database, ownerId, `${AGENT}7`, `automation:wfl_${'f'.repeat(32)}:spawn`);
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}7`, status: 'LIMIT_EXCEEDED' }, T0);
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}3`, status: 'RUNNING' }, T0);
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}4`, status: 'TIMED_OUT' }, T0);
    emitAgentTerminalNotification(database, { ...base, agentId: `${AGENT}5`, status: 'SUCCEEDED' }, T0);
    expect(notificationRows(database).map((row) => `${row.kind}:${row.title}`).sort()).toEqual([
      'agent.completed:Agent run completed', 'agent.failed:Agent run ended: cancelled', 'agent.failed:Agent run ended: limit exceeded',
      'agent.failed:Agent run ended: timed out'
    ]);
  });

  it('exports the waiting-for-human and approval-decided emitters with their own identities', () => {
    const { database, ownerId } = open();
    enableNotifications();
    const workflowId = insertWorkflow(database, { ownerId });
    const waiting = emitWaitingForHumanNotification(database, { principalId: ownerId, workflowId, approvalId: 'apv_1' }, T0);
    expect(emitWaitingForHumanNotification(database, { principalId: ownerId, workflowId, approvalId: 'apv_1' }, T0)).toBeNull();
    const second = emitWaitingForHumanNotification(database, { principalId: ownerId, workflowId, approvalId: 'apv_2' }, T0);
    const decided = emitApprovalDecidedNotification(database, { principalId: ownerId, approvalId: 'apv_1', decision: 'denied', workflowId }, T0);
    expect(new Set([waiting, second, decided]).size).toBe(3);
    const rows = notificationRows(database);
    expect(rows.map((row) => row.kind).sort()).toEqual(['approval.decided', 'workflow.waiting_for_human', 'workflow.waiting_for_human']);
    expect(JSON.parse(rows.find((row) => row.kind === 'approval.decided')!.payload_json)).toMatchObject({
      title: 'Approval denied', link: `/dashboard/automations/runs/${workflowId}`, subjectType: 'approval', subjectId: 'apv_1'
    });
  });

  it('bounds and redacts titles and drops off-site links', () => {
    const { database, ownerId } = open();
    enableNotifications();
    const title = `Deploy failed token=ghp_${'a'.repeat(36)}\u0000\n${'x'.repeat(400)}`;
    const id = emitNotification(database, {
      principalId: ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: `${AGENT}9`, transition: 'terminal',
      title, link: 'https://evil.example.com/phish'
    }, T0);
    const row = notificationRows(database).find((entry) => entry.notification_id === id)!;
    expect(row.title).not.toContain('ghp_');
    expect(row.title).toContain('[REDACTED]');
    expect(row.title.length).toBeLessThanOrEqual(160);
    expect(row.title.includes('\u0000')).toBe(false);
    expect(row.title.includes('\n')).toBe(false);
    expect(JSON.parse(row.payload_json).link).toBeNull();
    expect(boundedNotificationTitle('   ')).toBe('Notification');
  });

  it('bounds emoji titles in UTF-16 units, as the contract counts them, without splitting a surrogate pair', () => {
    for (const title of ['😀'.repeat(200), `a${'😀'.repeat(200)}`, '😀'.repeat(80), `${'a'.repeat(159)}😀`]) {
      const bounded = boundedNotificationTitle(title);
      expect(bounded.length).toBeLessThanOrEqual(160);
      // encodeURIComponent throws on a lone surrogate.
      expect(() => encodeURIComponent(bounded)).not.toThrow();
      expect(NotificationCreatedPayloadSchema.shape.title.safeParse(bounded).success).toBe(true);
    }
    expect(boundedNotificationTitle('😀'.repeat(80))).toBe('😀'.repeat(80));
    expect(boundedNotificationTitle('😀'.repeat(200))).toBe(`${'😀'.repeat(79)}…`);
    expect(boundedNotificationTitle(`a${'😀'.repeat(200)}`)).toBe(`a${'😀'.repeat(79)}…`);
  });

  it('refuses malformed subject ids without throwing into the caller', () => {
    const { database, ownerId } = open();
    enableNotifications();
    expect(emitNotification(database, {
      principalId: ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: '../../etc', transition: 'terminal', title: 'x', link: null
    }, T0)).toBeNull();
    expect(notificationRows(database)).toHaveLength(0);
  });

  it('adds the source issue, the agent trace and the coding pull request beside the run link', () => {
    const { database, ownerId } = open();
    enableNotifications();
    insertConnection(database, ownerId, 'con_x', 'github');
    const workflowId = insertWorkflow(database, { ownerId, agentId: AGENT });
    const traceId = traceIdFor(AGENT, 1);
    insertTrace(database, ownerId, traceId, AGENT);
    database.prepare('UPDATE automation_workflows SET project_id = ?, pr_number = 12, pr_url = ?, trace_id = ? WHERE id = ?')
      .run('prj_x', 'https://github.com/acme/widgets/pull/12', traceId, workflowId);
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    const payload = NotificationCreatedPayloadSchema.parse(JSON.parse(notificationRows(database)[0]!.payload_json));
    expect(payload.link).toBe(`/dashboard/automations/runs/${workflowId}`);
    expect(payload.links).toEqual({
      source: 'https://github.com/acme/widgets/issues/7',
      trace: `/dashboard/traces/${traceId}`,
      pullRequest: 'https://github.com/acme/widgets/pull/12'
    });
  });

  it('falls back to the newest trace of the run agent and links only what the run has', () => {
    const { database, ownerId, otherId } = open();
    enableNotifications();
    insertConnection(database, ownerId, 'con_x', 'github');
    const workflowId = insertWorkflow(database, { ownerId, agentId: AGENT });
    insertTrace(database, ownerId, traceIdFor(AGENT, 1), AGENT, 1);
    insertTrace(database, ownerId, traceIdFor(AGENT, 2), AGENT, 2);
    setWorkflowState(database, workflowId, 'FAILED', 'AGENT_FAILED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    expect(JSON.parse(notificationRows(database)[0]!.payload_json).links).toEqual({
      source: 'https://github.com/acme/widgets/issues/7', trace: `/dashboard/traces/${traceIdFor(AGENT, 2)}`
    });
    // Another owner's trace of the same agent id is never linked.
    const foreign = `agent_${'c'.repeat(24)}`;
    const second = insertWorkflow(database, { ownerId, agentId: foreign });
    insertTrace(database, otherId, traceIdFor(foreign, 1), foreign);
    setWorkflowState(database, second, 'COMPLETED');
    emitAutomationTerminalNotification(database, second, T0);
    const secondId = notificationIdFor(`${ownerId}:automation_workflow:${second}:terminal`);
    const secondRow = notificationRows(database).find((row) => row.notification_id === secondId);
    expect(JSON.parse(secondRow!.payload_json).links).toEqual({ source: 'https://github.com/acme/widgets/issues/7' });
  });

  it('drops a pull request URL that is not the run repository page and a source URL that could carry a credential', () => {
    const { database, ownerId } = open();
    enableNotifications();
    insertConnection(database, ownerId, 'con_x', 'github');
    const cases = [
      ['https://github.com/evil/widgets/pull/12', 'https://user:token@github.com/acme/widgets/issues/7'],
      ['https://github.com/acme/widgets/pull/13', 'https://github.com/acme/widgets/issues/7?token=abc'],
      ['https://x-access-token:secret@github.com/acme/widgets/pull/12', 'http://github.com/acme/widgets/issues/7']
    ];
    for (const [prUrl, resourceUrl] of cases) {
      const workflowId = insertWorkflow(database, { ownerId });
      database.prepare('UPDATE automation_workflows SET project_id = ?, pr_number = 12, pr_url = ?, resource_url = ? WHERE id = ?')
        .run('prj_x', prUrl, resourceUrl, workflowId);
      setWorkflowState(database, workflowId, 'COMPLETED');
      emitAutomationTerminalNotification(database, workflowId, T0);
    }
    const rows = notificationRows(database);
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      expect(JSON.parse(row.payload_json).links).toBeUndefined();
      expect(row.payload_json).not.toMatch(/token|secret|evil/u);
    }
  });

  it('links the source only for a provider that pins its URL host, never for a custom webhook', () => {
    const { database, ownerId } = open();
    enableNotifications();
    insertConnection(database, ownerId, 'con_x', 'github');
    insertConnection(database, ownerId, 'con_custom', 'custom');
    const github = insertWorkflow(database, { ownerId });
    const custom = insertWorkflow(database, { ownerId });
    database.prepare("UPDATE automation_workflows SET connection_id = 'con_custom', provider = 'custom', resource_url = ? WHERE id = ?")
      .run('https://evil.example/phish', custom);
    // A workflow whose recorded provider disagrees with its connection gets no source link either.
    const mismatched = insertWorkflow(database, { ownerId });
    database.prepare("UPDATE automation_workflows SET provider = 'custom' WHERE id = ?").run(mismatched);
    for (const id of [github, custom, mismatched]) {
      setWorkflowState(database, id, 'COMPLETED');
      emitAutomationTerminalNotification(database, id, T0);
    }
    const linksOf = (workflowId: string) => {
      const notificationId = notificationIdFor(`${ownerId}:automation_workflow:${workflowId}:terminal`);
      return JSON.parse(notificationRows(database).find((row) => row.notification_id === notificationId)!.payload_json).links;
    };
    expect(linksOf(github)).toEqual({ source: 'https://github.com/acme/widgets/issues/7' });
    expect(linksOf(custom)).toBeUndefined();
    expect(linksOf(mismatched)).toBeUndefined();
    expect(JSON.stringify(notificationRows(database))).not.toContain('evil.example');
  });

  it('prefers the newest trace recorded for the workflow over the agent\'s newest trace', () => {
    const { database, ownerId, otherId } = open();
    enableNotifications();
    const workflowId = insertWorkflow(database, { ownerId, agentId: AGENT });
    insertTrace(database, ownerId, traceIdFor(AGENT, 1), AGENT, 1, workflowId);
    insertTrace(database, ownerId, traceIdFor(AGENT, 2), AGENT, 2);
    // Another owner's trace naming the same workflow is ignored.
    insertTrace(database, otherId, traceIdFor(`agent_${'d'.repeat(24)}`, 1), `agent_${'d'.repeat(24)}`, 1, workflowId);
    setWorkflowState(database, workflowId, 'COMPLETED');
    emitAutomationTerminalNotification(database, workflowId, T0);
    expect(JSON.parse(notificationRows(database)[0]!.payload_json).links).toEqual({ trace: `/dashboard/traces/${traceIdFor(AGENT, 1)}` });
  });

  it('re-validates every related link it is handed', () => {
    expect(relatedLinks(undefined)).toBeUndefined();
    expect(relatedLinks({ source: 'javascript:alert(1)', trace: 'https://evil.example.com/', pullRequest: '//evil.example.com/pull/1' })).toBeUndefined();
    expect(relatedLinks({ trace: '/dashboard/traces/trc_x', source: 'https://github.com/a/b/issues/1#frag' })).toEqual({ trace: '/dashboard/traces/trc_x' });
  });
});
