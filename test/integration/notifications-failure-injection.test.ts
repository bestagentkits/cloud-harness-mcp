import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationCreatedPayloadSchema, type RunnerOperation } from '@cloud-harness/contracts';
import { AutomationService, type AutomationOperationResult } from '../../apps/runner/src/automation-service.js';
import { McpEventService } from '../../apps/runner/src/mcp-event-service.js';
import { GithubNotificationAdapter, McpEventNotificationAdapter } from '../../apps/runner/src/notifications/notification-adapters.js';
import {
  NOTIFICATION_LEASE_MS, NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_MIRROR_POLL_MS, NOTIFICATION_RETRY_DELAYS_MS, NotificationDispatcher
} from '../../apps/runner/src/notifications/notification-dispatcher.js';
import { emitNotification, notificationEmitFailures, notificationIdFor } from '../../apps/runner/src/notifications/notification-emitter.js';
import { NotificationService } from '../../apps/runner/src/notifications/notification-service.js';
import { NotificationStore } from '../../apps/runner/src/notifications/notification-store.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { FakeNotificationAdapter } from '../../apps/runner/test/support/fake-notification-adapter.js';
import { disableNotifications, enableNotifications } from '../../apps/runner/test/support/notification-fixtures.js';

/**
 * Failure injection for the notification inbox. Real automation runs go through `AutomationService`
 * on a real state database; their terminal transition writes the notification in the same savepoint.
 * The MCP Events channel is the real runner event queue (the API egress worker's claim and report are
 * called directly), the GitHub channel mirrors the automation's own comment state, and a second
 * channel is the scripted fake. Only the agent and GitHub operations are substituted.
 */

const WS = `ws_${'a'.repeat(24)}`;
const AGENT = `agent_${'b'.repeat(24)}`;
const REPO = 'acme/widgets';
const HOOK = 'https://hooks.example.com/mcp/events';
const T0 = Date.parse('2026-10-20T00:00:00Z');
const owner = { kind: 'owner' as const, ownerId: 'owner' };
const other = { kind: 'external' as const, issuer: 'https://issuer.example.com', subject: 'someone-else' };

type Call = { operation: RunnerOperation; input: Record<string, unknown> };

/** The agent and GitHub side of an automation run; `agent_spawn` calls are the agent launch counter. */
class FakeOperations {
  calls: Call[] = [];
  agentStatus = 'SUCCEEDED';
  failSpawn = false;
  async execute(_ownerId: string, operation: RunnerOperation, input: Record<string, unknown>): Promise<AutomationOperationResult> {
    this.calls.push({ operation, input });
    switch (operation) {
      case 'workspace_open': return { ok: true, data: { workspaceId: WS } };
      case 'agent_spawn': return this.failSpawn
        ? { ok: false, error: { code: 'NOT_FOUND', retryable: false } }
        : { ok: true, data: { agentId: AGENT, status: 'SPAWNING' } };
      case 'agent_status': return { ok: true, data: { status: this.agentStatus, usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 } } };
      case 'agent_logs': return { ok: true, data: { events: [{ type: 'event', content: JSON.stringify({ kind: 'text_delta', text: 'Done' }) }], nextCursor: '1', hasMore: false } };
      default: return { ok: true, data: {} };
    }
  }
  count(operation: RunnerOperation): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }
}

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  disableNotifications();
  for (const close of closers.splice(0).reverse()) {
    try { close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function newPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-notify-d5-'));
  directories.push(directory);
  return join(directory, 'state.db');
}

const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 7) }]);

/** One runner process: its own connection to the state database, its own dispatcher and fake channel. */
function runner(path: string, clock: { now: number }, options: { channels?: 'all' | 'fake' } = {}) {
  const store = new StateStore(path);
  closers.push(() => store.close());
  const database = store.database;
  const now = () => clock.now;
  const resolvePrincipal = (principal: typeof owner | typeof other) => store.resolvePrincipal(principal);
  const operations = new FakeOperations();
  const automations = new AutomationService({
    database, enabled: true, maxConcurrentWorkflows: 4, resolvePrincipal, operations, keyring,
    selfLogin: 'cloud-harness[bot]', audit: () => undefined, now
  });
  const events = new McpEventService({ database, resolvePrincipal, keyring, now });
  const notificationStore = new NotificationStore(database, now);
  const fake = new FakeNotificationAdapter();
  const adapters = options.channels === 'fake' ? [fake] : [new McpEventNotificationAdapter(database), new GithubNotificationAdapter(database), fake];
  const dispatcher = new NotificationDispatcher({ store: notificationStore, adapters, now });
  const notifications = new NotificationService({ store: notificationStore, enabled: true, resolvePrincipal });
  const ownerId = store.resolvePrincipal(owner);
  return { store, database, clock, operations, automations, events, notificationStore, fake, dispatcher, notifications, ownerId, path, close: () => store.close() };
}

type Runner = ReturnType<typeof runner>;

function ok<T>(response: { ok: boolean; data?: unknown; error?: { code: string; message: string } }): T {
  if (!response.ok) throw new Error(`expected ok, got ${response.error?.code}: ${response.error?.message}`);
  return response.data as T;
}

let payloadSequence = 0;
/** Runs one labeled issue through the automation engine to its terminal state. */
async function automationRun(context: Runner, options: { publishComment?: boolean; fail?: boolean; number?: number } = {}) {
  const { connection, secret } = ok<{ connection: { id: string }; secret: string }>(context.automations.execute({
    version: 1, principal: owner, operation: 'connection_create', input: { provider: 'github', name: `acme-${payloadSequence}` }
  }));
  ok(context.automations.execute({
    version: 1, principal: owner, operation: 'rule_create', input: {
      connectionId: connection.id, name: 'Triage', enabled: true,
      match: { repository: REPO, events: ['issues'], label: 'claude' },
      action: { profileId: 'default', instructions: 'Analyse the issue.', cooldownSeconds: 0, publishComment: options.publishComment ?? false }
    }
  }));
  payloadSequence += 1;
  const number = options.number ?? 7;
  const body = Buffer.from(JSON.stringify({
    action: 'labeled', updated_at: new Date(Date.UTC(2026, 9, 20, 0, 0, payloadSequence)).toISOString(), label: { name: 'Claude' },
    issue: { number, html_url: `https://github.com/${REPO}/issues/${number}`, title: 'Crash on start', body: 'secret-looking prompt text ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    repository: { full_name: REPO }, sender: { login: 'alice', type: 'User' }
  }));
  context.operations.failSpawn = options.fail ?? false;
  ok(context.automations.execute({
    version: 1, operation: 'webhook_ingest', input: {
      provider: 'github', connectionId: connection.id, event: 'issues', deliveryId: `delivery-${payloadSequence}`,
      signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, bodyBase64: body.toString('base64')
    }
  }));
  for (let pass = 0; pass < 5; pass += 1) await context.automations.tick();
  const { workflows } = ok<{ workflows: { id: string; state: string; publishState: string }[] }>(
    context.automations.execute({ version: 1, principal: owner, operation: 'workflows_list', input: {} })
  );
  return workflows[0]!;
}

function inbox(context: Runner, principal: typeof owner | typeof other = owner) {
  return ok<{ notifications: { notificationId: string; kind: string; title: string; link: string | null; readAt: string | null; deliveries: { channel: string; state: string; attempts: number; lastErrorClass: string | null }[] }[]; unread: number }>(
    context.notifications.execute({ version: 1, principal, operation: 'inbox_list', input: {} })
  );
}

function delivery(context: Runner, channel: string) {
  const [notification] = inbox(context).notifications;
  return notification?.deliveries.find((entry) => entry.channel === channel);
}

function subscribe(context: Runner, args: Record<string, unknown> = {}) {
  return context.events.subscribe(context.ownerId, {
    name: 'cloudharness.notification.created', arguments: args, url: HOOK, secret: `whsec_${Buffer.alloc(32, 3).toString('base64')}`, verified: true
  }).id;
}

/** Scenario 7 holds for every scenario: notification work never relaunches the agent. */
function expectSingleLaunch(...contexts: Runner[]) {
  expect(contexts.reduce((total, context) => total + context.operations.count('agent_spawn'), 0)).toBe(1);
}

async function ticks(context: Runner, count: number, advanceMs = 0) {
  for (let index = 0; index < count; index += 1) {
    await context.dispatcher.tick();
    context.clock.now += advanceMs;
  }
}

describe('notification failure injection', () => {
  it('a successful run notifies the inbox, MCP Events and the GitHub mirror exactly once', async () => {
    const context = runner(newPath(), { now: T0 });
    enableNotifications(context.dispatcher.channels());
    subscribe(context);
    const workflow = await automationRun(context, { publishComment: true });
    expect(workflow).toMatchObject({ state: 'COMPLETED', publishState: 'DELIVERED' });

    const [notification] = inbox(context).notifications;
    expect(notification).toMatchObject({ kind: 'automation.completed', title: `Automation completed: ${REPO}#7`, link: `/dashboard/automations/runs/${workflow.id}`, readAt: null });
    expect(notification!.deliveries.map((entry) => `${entry.channel}:${entry.state}`)).toEqual(['inbox:DELIVERED', 'mcp_event:PENDING', 'github:PENDING', 'fake_chat:PENDING']);

    // The API egress worker drains the event; the payload carries ids, a bounded title and a link only.
    const [claimed] = context.events.claim(10, 30_000);
    const body = JSON.parse(claimed!.body) as { name: string; data: unknown };
    expect(body.name).toBe('cloudharness.notification.created');
    expect(NotificationCreatedPayloadSchema.parse(body.data)).toMatchObject({ notificationId: notification!.notificationId, subjectId: workflow.id });
    expect(claimed!.body).not.toMatch(/prompt text|ghp_/);
    expect(context.events.report([{ deliveryId: claimed!.deliveryId, leaseToken: claimed!.leaseToken, outcome: 'delivered' }])).toBe(1);

    await ticks(context, 3, NOTIFICATION_MIRROR_POLL_MS);
    expect(inbox(context).notifications[0]!.deliveries.map((entry) => `${entry.channel}:${entry.state}`))
      .toEqual(['inbox:DELIVERED', 'mcp_event:DELIVERED', 'github:DELIVERED', 'fake_chat:DELIVERED']);
    expect(context.fake.uniqueDeliveries).toBe(1);
    expect(inbox(context).notifications).toHaveLength(1);
    expect(notificationEmitFailures()).toBe(0);
    expectSingleLaunch(context);
  });

  it('without a subscription and without a GitHub comment there are no rows for those channels', async () => {
    const context = runner(newPath(), { now: T0 });
    enableNotifications(context.dispatcher.channels());
    await automationRun(context, { publishComment: false });
    expect(inbox(context).notifications[0]!.deliveries.map((entry) => entry.channel)).toEqual(['inbox', 'fake_chat']);
    expect((context.database.prepare('SELECT count(*) AS count FROM event_outbox').get() as { count: number }).count).toBe(0);
    expectSingleLaunch(context);
  });

  it('a failed run notifies automation.failed once', async () => {
    const context = runner(newPath(), { now: T0 });
    enableNotifications(context.dispatcher.channels());
    const workflow = await automationRun(context, { fail: true });
    expect(workflow.state).toBe('FAILED');
    const { notifications } = inbox(context);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: 'automation.failed', title: `Automation failed: ${REPO}#7 (AGENT_SPAWN_FAILED:NOT_FOUND)` });
    expectSingleLaunch(context);
  });

  it('keeps the MCP Events delivery pending while the API worker is down and recovers after its lease expires', async () => {
    const context = runner(newPath(), { now: T0 });
    enableNotifications(context.dispatcher.channels());
    subscribe(context);
    await automationRun(context);
    // Worker down: nothing drains the event queue, so the notification channel stays pending without spending attempts.
    await ticks(context, 3, NOTIFICATION_MIRROR_POLL_MS);
    expect(delivery(context, 'mcp_event')).toMatchObject({ state: 'PENDING', attempts: 0 });
    // The worker comes up, claims the event, and dies before reporting.
    const [lost] = context.events.claim(10, 30_000);
    expect(lost).toBeDefined();
    expect(context.events.claim(10, 30_000)).toEqual([]);
    await ticks(context, 1, NOTIFICATION_MIRROR_POLL_MS);
    expect(delivery(context, 'mcp_event')).toMatchObject({ state: 'PENDING' });
    // After the lease expires a restarted worker re-claims it; the dead worker's late report is refused.
    context.clock.now += 30_000;
    const [retry] = context.events.claim(10, 30_000);
    expect(retry!.deliveryId).toBe(lost!.deliveryId);
    expect(context.events.report([{ deliveryId: lost!.deliveryId, leaseToken: lost!.leaseToken, outcome: 'failed' }])).toBe(0);
    expect(context.events.report([{ deliveryId: retry!.deliveryId, leaseToken: retry!.leaseToken, outcome: 'delivered' }])).toBe(1);
    context.clock.now += NOTIFICATION_MIRROR_POLL_MS;
    await ticks(context, 1);
    expect(delivery(context, 'mcp_event')).toMatchObject({ state: 'DELIVERED', lastErrorClass: null });
    expectSingleLaunch(context);
  });

  it('a runner restart mid-claim reclaims the lease and delivers once', async () => {
    const clock = { now: T0 };
    const path = newPath();
    const first = runner(path, clock, { channels: 'fake' });
    enableNotifications(first.dispatcher.channels());
    await automationRun(first);
    // The first process leases the delivery and dies before sending or reporting.
    expect(first.notificationStore.claim(['fake_chat'], 10, NOTIFICATION_LEASE_MS)).toHaveLength(1);
    first.close();

    const second = runner(path, clock, { channels: 'fake' });
    expect(delivery(second, 'fake_chat')).toMatchObject({ state: 'CLAIMED' });
    expect(await second.dispatcher.tick()).toMatchObject({ claimed: 0 });
    clock.now += NOTIFICATION_LEASE_MS;
    expect(await second.dispatcher.tick()).toMatchObject({ claimed: 1, delivered: 1 });
    await ticks(second, 3, 3_600_000);
    expect(second.fake.sends).toHaveLength(1);
    // The lease the dead process lost counts as an attempt, so a crash loop still reaches the cap.
    expect(delivery(second, 'fake_chat')).toMatchObject({ state: 'DELIVERED', attempts: 2 });
    expectSingleLaunch(first, second);
  });

  it('a lease taken on one connection blocks another, and its stale token cannot settle after a reclaim', async () => {
    const clock = { now: T0 };
    const path = newPath();
    const left = runner(path, clock, { channels: 'fake' });
    const right = runner(path, clock, { channels: 'fake' });
    enableNotifications(left.dispatcher.channels());
    await automationRun(left);
    const results = await Promise.all([left.dispatcher.tick(), right.dispatcher.tick()]);
    expect(results.map((result) => result.claimed).sort()).toEqual([0, 1]);
    expect(left.fake.sends.length + right.fake.sends.length).toBe(1);
    expectSingleLaunch(left, right);

    // Contest the token itself: a stalled holder on one connection loses its lease to the other.
    const contested = notificationIdFor(`${left.ownerId}:agent:${`agent_${'c'.repeat(24)}`}:terminal`);
    emitNotification(left.database, {
      principalId: left.ownerId, kind: 'agent.failed', subjectType: 'agent', subjectId: `agent_${'c'.repeat(24)}`, transition: 'terminal',
      title: 'Agent run ended: failed', link: null
    }, clock.now);
    const [stalled] = left.notificationStore.claim(['fake_chat'], 10, NOTIFICATION_LEASE_MS);
    expect(stalled).toMatchObject({ notificationId: contested });
    expect(await right.dispatcher.tick()).toMatchObject({ claimed: 0 });
    clock.now += NOTIFICATION_LEASE_MS;
    expect(await right.dispatcher.tick()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(left.notificationStore.report(contested, 'fake_chat', stalled!.leaseToken, {
      state: 'FAILED', attempts: 5, nextAttemptAt: clock.now, errorClass: 'late'
    })).toBe(false);
    expect(right.notificationStore.deliveryState(contested, 'fake_chat')).toBe('DELIVERED');
    expect(right.fake.sends.filter((send) => send.notificationId === contested)).toHaveLength(1);
  });

  it('retries 429 then delivers, and fails a channel that keeps answering 500 with the error class visible', async () => {
    const throttled = runner(newPath(), { now: T0 }, { channels: 'fake' });
    enableNotifications(throttled.dispatcher.channels());
    await automationRun(throttled);
    throttled.fake.respondWith(429, 200);
    await throttled.dispatcher.tick();
    expect(delivery(throttled, 'fake_chat')).toMatchObject({ state: 'PENDING', attempts: 1, lastErrorClass: 'http_429' });
    throttled.clock.now += NOTIFICATION_RETRY_DELAYS_MS[0];
    await throttled.dispatcher.tick();
    expect(delivery(throttled, 'fake_chat')).toMatchObject({ state: 'DELIVERED', attempts: 2, lastErrorClass: null });
    expect(throttled.fake.uniqueDeliveries).toBe(1);
    expectSingleLaunch(throttled);

    const broken = runner(newPath(), { now: T0 }, { channels: 'fake' });
    await automationRun(broken);
    broken.fake.fallback = 500;
    for (const delay of [...NOTIFICATION_RETRY_DELAYS_MS, 0]) {
      await broken.dispatcher.tick();
      broken.clock.now += delay;
    }
    expect(delivery(broken, 'fake_chat')).toMatchObject({ state: 'FAILED', attempts: NOTIFICATION_MAX_ATTEMPTS, lastErrorClass: 'http_5xx' });
    await ticks(broken, 2, 86_400_000);
    expect(broken.fake.sends).toHaveLength(NOTIFICATION_MAX_ATTEMPTS);
    // The inbox copy is unaffected by a failing channel.
    expect(delivery(broken, 'inbox')).toMatchObject({ state: 'DELIVERED' });
    expectSingleLaunch(broken);
  });

  it('a preference turned off or a subscription revoked mid-retry stops the delivery with no further sends', async () => {
    const context = runner(newPath(), { now: T0 });
    enableNotifications(context.dispatcher.channels());
    subscribe(context);
    await automationRun(context, { publishComment: true });
    context.fake.fallback = 500;
    await context.dispatcher.tick();
    expect(delivery(context, 'fake_chat')).toMatchObject({ state: 'PENDING', attempts: 1, lastErrorClass: 'http_5xx' });
    expect(delivery(context, 'mcp_event')).toMatchObject({ state: 'PENDING' });
    expect(delivery(context, 'github')).toMatchObject({ state: 'DELIVERED' });

    // The fake stands in for a future channel, so its preference is written at the store; the
    // shipped channels go through the owner API.
    expect(context.notificationStore.setPreferences(context.ownerId, [{ channel: 'fake_chat', kind: 'automation.completed', enabled: false }])).toBe(1);
    const saved = ok<{ revoked: number }>(context.notifications.execute({
      version: 1, principal: owner, operation: 'preferences_put', input: { preferences: [
        { channel: 'mcp_event', kind: 'automation.completed', enabled: false },
        { channel: 'github', kind: 'automation.completed', enabled: false }
      ] }
    }));
    // Only the pending MCP Events delivery stops; the settled GitHub mirror is history and stays delivered.
    expect(saved.revoked).toBe(1);
    // Turning MCP Events off also stops the real webhook: the API egress worker finds nothing to send.
    expect(context.events.claim(10, 30_000)).toEqual([]);

    await ticks(context, 6, 3_600_000);
    expect(context.fake.sends).toHaveLength(1);
    expect(delivery(context, 'fake_chat')).toMatchObject({ state: 'REVOKED', lastErrorClass: 'preference_disabled' });
    expect(delivery(context, 'mcp_event')).toMatchObject({ state: 'REVOKED', lastErrorClass: 'preference_disabled' });
    expect(delivery(context, 'github')).toMatchObject({ state: 'DELIVERED' });
    expect(delivery(context, 'inbox')).toMatchObject({ state: 'DELIVERED' });
    expectSingleLaunch(context);

    // A subscription revoked while its event is still queued ends the MCP Events channel too.
    const revoked = runner(newPath(), { now: T0 }, { channels: 'all' });
    const subscriptionId = subscribe(revoked);
    await automationRun(revoked);
    await revoked.dispatcher.tick();
    expect(delivery(revoked, 'mcp_event')).toMatchObject({ state: 'PENDING' });
    expect(revoked.events.revoke(revoked.ownerId, subscriptionId)).toBe(true);
    await ticks(revoked, 3, NOTIFICATION_MIRROR_POLL_MS);
    expect(delivery(revoked, 'mcp_event')).toMatchObject({ state: 'REVOKED', lastErrorClass: 'subscription_ended' });
    expect(revoked.events.claim(10, 30_000)).toEqual([]);
    expectSingleLaunch(revoked);
  });

  it('never lets another principal read or mark the owner\'s inbox', async () => {
    const context = runner(newPath(), { now: T0 });
    enableNotifications(context.dispatcher.channels());
    await automationRun(context);
    const [notification] = inbox(context).notifications;
    expect(inbox(context, other)).toMatchObject({ notifications: [], unread: 0 });
    const refused = context.notifications.execute({
      version: 1, principal: other, operation: 'inbox_mark_read', input: { notificationIds: [notification!.notificationId] }
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    ok(context.notifications.execute({ version: 1, principal: other, operation: 'inbox_mark_read', input: { all: true } }));
    expect(inbox(context)).toMatchObject({ unread: 1 });
    expect(inbox(context).notifications[0]!.readAt).toBeNull();
    expectSingleLaunch(context);
  });
});
