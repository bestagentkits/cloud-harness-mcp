import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerAgentLimitsSchema } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { ApiKeyStore } from '../src/api-key-store.js';
import { eventIdForSource } from '../src/event-outbox.js';
import { MCP_EVENT_RETRY_DELAYS_MS, McpEventService } from '../src/mcp-event-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, downgradeStateSchemaToV12, type WorkspaceRecord } from '../src/state-store.js';

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try { close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const URL_A = 'https://hooks.example.com/mcp/events';
const URL_B = 'https://other.example.com/hook';
const secret = (fill = 1) => `whsec_${Buffer.alloc(32, fill).toString('base64')}`;
const WS_A = `ws_${'a'.repeat(24)}`;
const WS_B = `ws_${'b'.repeat(24)}`;
const WS_OTHER = `ws_${'o'.repeat(24)}`;

type Clock = { now: number };

function workspace(id: string, ownerId: string, now: number): WorkspaceRecord {
  return {
    id, ownerId, idempotencyKey: `idem-${id}`, repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: `/tmp/${id}`, environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 3_600_000, hardExpiresAt: now + 7_200_000, gitAuthorName: null,
    gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
}

function setup(options: { keyring?: boolean; path?: string; clock?: Clock } = {}) {
  let path = options.path;
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-events-'));
    directories.push(directory);
    path = join(directory, 'state.db');
  }
  const store = new StateStore(path);
  closers.push(() => store.close());
  const keyring = options.keyring === false ? undefined : new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 7) }]);
  const metadata = new MetadataStore(path, keyring);
  closers.push(() => metadata.close());
  const clock = options.clock ?? { now: Date.now() };
  const audits: string[] = [];
  const events = new McpEventService({
    database: store.database,
    resolvePrincipal: (principal) => store.resolvePrincipal(principal),
    keyring,
    now: () => clock.now,
    audit: (_database, _principal, action) => { audits.push(action); }
  });
  const owner = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const other = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.example.com', subject: 'someone-else' });
  if (!store.byOwnerAndId(owner, WS_A)) {
    store.create(workspace(WS_A, owner, clock.now));
    store.create(workspace(WS_B, owner, clock.now));
    store.create(workspace(WS_OTHER, other, clock.now));
  }
  return { store, events, owner, other, clock, audits, path, metadata };
}

let taskSequence = 0;
function createTask(store: StateStore, ownerId: string, workspaceId: string, status: 'RUNNING' | 'QUEUED' = 'RUNNING', bootId = 'boot_a') {
  taskSequence += 1;
  const id = `task_${String(taskSequence).padStart(24, '0')}`;
  return store.createDurableTask({
    id, workspaceId, ownerId, name: 'build', command: 'echo SECRET-COMMAND-TEXT', cwd: '.', status,
    idempotencyKey: null, requestFingerprint: null, bootId, exitCode: null, errorCode: null,
    errorMessage: 'raw failure output must not leak', timeoutMs: 60_000, maxBytes: 65_536, logPath: '/tmp/log',
    outputBytes: 0, outputArtifactId: null, createdAt: Date.now(), startedAt: Date.now(), finishedAt: null
  });
}

function subscribe(events: McpEventService, ownerId: string, name: Parameters<McpEventService['subscribe']>[1]['name'], args: Record<string, unknown> = {}, extra: Partial<Parameters<McpEventService['subscribe']>[1]> = {}) {
  return events.subscribe(ownerId, { name, arguments: args, url: URL_A, secret: secret(), verified: true, ...extra });
}

const deliveries = (store: StateStore) => store.database.prepare('SELECT * FROM event_deliveries ORDER BY created_at, id').all() as {
  id: string; event_id: string; subscription_id: string; status: string; attempts: number; next_attempt_at: number; last_error: string | null;
}[];

describe('MCP event store schema', () => {
  it('migrates past v13 and refuses a lossy downgrade while events are retained', () => {
    const { store, events, owner } = setup();
    expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(17);
    subscribe(events, owner, 'cloudharness.task.completed');
    expect(() => downgradeStateSchemaToV12(store.database)).toThrow('allowDataLoss required');
    downgradeStateSchemaToV12(store.database, true);
    expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(12);
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE name = 'event_outbox'").get()).toBeUndefined();
  });
});

describe('MCP event emission', () => {
  it('records one logical event per task even when terminal status is written again', () => {
    const { store, events, owner } = setup();
    subscribe(events, owner, 'cloudharness.task.completed');
    subscribe(events, owner, 'cloudharness.task.failed');
    const task = createTask(store, owner, WS_A);
    expect(store.updateDurableTaskStatus(task.id, 1, { status: 'SUCCEEDED', exitCode: 0, finishedAt: Date.now() })).toBe(true);
    expect(store.updateDurableTaskStatus(task.id, 2, { status: 'FAILED', errorCode: 'LATE' })).toBe(true);
    const outbox = store.database.prepare('SELECT id, name, payload_json FROM event_outbox').all() as { id: string; name: string; payload_json: string }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.id).toBe(eventIdForSource(`task:${task.id}:terminal`));
    expect(outbox[0]!.name).toBe('cloudharness.task.completed');
    expect(JSON.parse(outbox[0]!.payload_json)).toEqual(expect.objectContaining({ taskId: task.id, workspaceId: WS_A, status: 'SUCCEEDED', exitCode: 0 }));
    expect(JSON.parse(outbox[0]!.payload_json)).not.toHaveProperty('name');
    expect(outbox[0]!.payload_json).not.toContain('SECRET-COMMAND-TEXT');
    expect(outbox[0]!.payload_json).not.toContain('raw failure output');
    expect(deliveries(store)).toHaveLength(1);
  });

  it('rolls the event back with a guarded transition that loses its generation race', () => {
    const { store, events, owner } = setup();
    subscribe(events, owner, 'cloudharness.task.completed');
    const task = createTask(store, owner, WS_A);
    expect(store.updateDurableTaskStatus(task.id, 99, { status: 'SUCCEEDED' })).toBe(false);
    expect(store.database.prepare('SELECT count(*) AS count FROM event_outbox').get()).toEqual({ count: 0 });
  });

  it('fans out only to the owner subscriptions whose arguments match', () => {
    const { store, events, owner, other } = setup();
    const all = subscribe(events, owner, 'cloudharness.task.failed');
    const scoped = subscribe(events, owner, 'cloudharness.task.failed', { workspaceId: WS_A }, { url: URL_B });
    subscribe(events, owner, 'cloudharness.task.failed', { workspaceId: WS_B }, { url: 'https://third.example.com/x' });
    subscribe(events, other, 'cloudharness.task.failed');
    const task = createTask(store, owner, WS_A);
    store.updateDurableTaskStatus(task.id, 1, { status: 'CANCELLED', finishedAt: Date.now() });
    expect(deliveries(store).map((row) => row.subscription_id).sort()).toEqual([all.id, scoped.id].sort());
  });

  it('writes nothing when no subscription matches', () => {
    const { store, owner } = setup();
    const task = createTask(store, owner, WS_A);
    store.updateDurableTaskStatus(task.id, 1, { status: 'SUCCEEDED' });
    expect(store.database.prepare('SELECT count(*) AS count FROM event_outbox').get()).toEqual({ count: 0 });
  });

  it('emits task.failed for tasks interrupted by a runner restart and keeps them across reopen', () => {
    const first = setup();
    subscribe(first.events, first.owner, 'cloudharness.task.failed');
    const task = createTask(first.store, first.owner, WS_A, 'RUNNING', 'boot_old');
    first.store.close();
    first.metadata.close();
    const reopened = setup({ path: first.path, clock: first.clock });
    expect(reopened.store.reconcileRunningTasks('boot_new', reopened.clock.now)).toBe(1);
    const [claimed] = reopened.events.claim(10, 30_000);
    expect(claimed?.eventId).toBe(eventIdForSource(`task:${task.id}:terminal`));
    expect(JSON.parse(claimed!.body)).toMatchObject({ name: 'cloudharness.task.failed', cursor: null, data: { status: 'FAILED', errorCode: 'RUNNER_RESTARTED' } });
  });

  it('emits agent settlement and failure with an uncertain-outcome flag', () => {
    const { store, events, owner } = setup();
    subscribe(events, owner, 'cloudharness.agent.settled');
    subscribe(events, owner, 'cloudharness.agent.failed');
    const repository = new AgentStateRepository(store.database, RunnerAgentLimitsSchema.parse({}));
    const now = Date.now();
    const spawn = (suffix: string) => repository.reserveSpawn({
      id: `agent_${suffix.repeat(24)}`, ownerId: owner, workspaceId: WS_A, workspaceGeneration: 1, idempotencyKey: `spawn-${suffix}`,
      payloadHash: suffix.repeat(64), promptHash: suffix.repeat(64), profileId: 'default', proxyOperations: ['files_read'],
      budget: { ttlSeconds: 30, maxOutputBytes: 1024, maxInputTokens: 10, maxOutputTokens: 10, maxCostMicros: 10 },
      containerName: `agent-${suffix}`, networkName: `net-${suffix}`, gatewayLeaseId: `lease-${suffix}`, now, expiresAt: now + 30_000
    }).record;
    const settled = spawn('s');
    const running = repository.transitionStatus({ ownerId: owner, workspaceId: WS_A, agentId: settled.id, generation: settled.generation, expectedStatuses: ['SPAWNING'], status: 'RUNNING', now })!;
    const settling = repository.transitionStatus({ ownerId: owner, workspaceId: WS_A, agentId: settled.id, generation: running.generation, expectedStatuses: ['RUNNING'], status: 'CANCELLING', now })!;
    repository.transitionStatus({ ownerId: owner, workspaceId: WS_A, agentId: settled.id, generation: settling.generation, expectedStatuses: ['CANCELLING'], status: 'SUCCEEDED', now, terminalReason: 'private reason' });
    const lost = spawn('l');
    repository.transitionStatus({ ownerId: owner, workspaceId: WS_A, agentId: lost.id, generation: lost.generation, expectedStatuses: ['SPAWNING'], status: 'INTERRUPTED', now, outcomeUnknown: true });
    const rows = store.database.prepare('SELECT name, payload_json FROM event_outbox ORDER BY name').all() as { name: string; payload_json: string }[];
    expect(rows.map((row) => row.name)).toEqual(['cloudharness.agent.failed', 'cloudharness.agent.settled']);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ agentId: lost.id, status: 'INTERRUPTED', outcomeUnknown: true });
    expect(rows[1]!.payload_json).not.toContain('private reason');
  });
});

describe('MCP event subscriptions', () => {
  it('upserts idempotently with a deterministic id and refreshes the TTL', () => {
    const { events, owner, clock, audits } = setup();
    const first = subscribe(events, owner, 'cloudharness.task.completed', { workspaceId: WS_A }, { ttlMs: 120_000 });
    clock.now += 60_000;
    const second = subscribe(events, owner, 'cloudharness.task.completed', { workspaceId: WS_A }, { ttlMs: null });
    expect(second.id).toBe(first.id);
    expect(Date.parse(second.refreshBefore) - clock.now).toBe(86_400_000);
    expect(second.deliveryStatus).toMatchObject({ active: true, lastDeliveryAt: null, lastError: null });
    expect(audits).toEqual(['mcp_event.subscribed']);
    expect(events.list(owner).subscriptions).toHaveLength(1);
  });

  it('refuses another principal workspace, an unverified callback, and a missing keyring', () => {
    const { events, owner } = setup();
    expect(events.execute({ version: 1, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'events_prepare', input: { name: 'cloudharness.task.completed', arguments: { workspaceId: WS_OTHER }, url: URL_A } }))
      .toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'workspace is not accessible to this principal' } });
    expect(() => subscribe(events, owner, 'cloudharness.task.completed', {}, { verified: false })).toThrow('not been verified');
    expect(events.prepare(owner, { name: 'cloudharness.task.completed', arguments: {}, url: URL_A }).verified).toBe(false);
    subscribe(events, owner, 'cloudharness.task.completed');
    expect(events.prepare(owner, { name: 'cloudharness.task.failed', arguments: {}, url: URL_A }).verified).toBe(true);
    const unkeyed = setup({ keyring: false });
    expect(() => subscribe(unkeyed.events, unkeyed.owner, 'cloudharness.task.completed')).toThrow('secret keyring');
  });

  it('rejects unknown filter keys and enforces the per-principal quota', () => {
    const { events, owner } = setup();
    expect(() => subscribe(events, owner, 'cloudharness.task.completed', { agentId: `agent_${'x'.repeat(24)}` })).toThrow('invalid event arguments');
    for (let index = 0; index < 100; index += 1) {
      subscribe(events, owner, 'cloudharness.task.completed', {}, { url: `https://hooks.example.com/${index}` });
    }
    expect(() => subscribe(events, owner, 'cloudharness.task.completed', {}, { url: 'https://hooks.example.com/overflow' })).toThrow('limit reached');
  });

  it('bounds retained rows per principal and pages the listing', () => {
    const { events, owner } = setup();
    for (let round = 0; round < 10; round += 1) {
      for (let index = 0; index < 100; index += 1) {
        const created = subscribe(events, owner, 'cloudharness.task.completed', {}, { url: `https://hooks.example.com/${round}/${index}` });
        expect(events.revoke(owner, created.id)).toBe(true);
      }
    }
    expect(() => subscribe(events, owner, 'cloudharness.task.completed', {}, { url: 'https://hooks.example.com/overflow' })).toThrow('retained event subscription limit');
    const listed = events.list(owner);
    expect(listed.truncated).toBe(true);
    expect(listed.subscriptions).toHaveLength(200);
  });

  it('isolates listing and revocation by principal', () => {
    const { events, owner, other } = setup();
    const mine = subscribe(events, owner, 'cloudharness.task.completed');
    expect(events.list(other)).toEqual({ subscriptions: [], truncated: false });
    expect(events.revoke(other, mine.id)).toBe(false);
    expect(events.revoke(owner, mine.id)).toBe(true);
    expect(events.list(owner).subscriptions[0]).toMatchObject({ state: 'REVOKED', callbackOrigin: 'https://hooks.example.com' });
  });

  it('unsubscribes idempotently and drops pending deliveries', () => {
    const { store, events, owner } = setup();
    subscribe(events, owner, 'cloudharness.task.completed');
    const task = createTask(store, owner, WS_A);
    store.updateDurableTaskStatus(task.id, 1, { status: 'SUCCEEDED' });
    const key = { name: 'cloudharness.task.completed' as const, arguments: {}, url: URL_A };
    expect(events.unsubscribe(owner, key)).toEqual({ removed: true });
    expect(events.unsubscribe(owner, key)).toEqual({ removed: false });
    expect(deliveries(store)).toHaveLength(0);
  });
});

describe('MCP event delivery queue', () => {
  function pending() {
    const context = setup();
    subscribe(context.events, context.owner, 'cloudharness.task.completed');
    const task = createTask(context.store, context.owner, WS_A);
    context.store.updateDurableTaskStatus(task.id, 1, { status: 'SUCCEEDED', exitCode: 0, finishedAt: context.clock.now });
    // Emission stamps wall-clock time; move the injected clock past it so the delivery is due.
    context.clock.now = Date.now() + 1_000;
    return { ...context, task };
  }

  it('leases a delivery once, records success, and ignores a stale lease report', () => {
    const { events, store, clock } = pending();
    const [delivery] = events.claim(10, 30_000);
    expect(delivery).toBeDefined();
    expect(delivery!.secrets).toEqual([secret()]);
    expect(events.claim(10, 30_000)).toEqual([]);
    expect(events.report([{ deliveryId: delivery!.deliveryId, leaseToken: 'x'.repeat(22), outcome: 'delivered' }])).toBe(0);
    expect(events.report([{ deliveryId: delivery!.deliveryId, leaseToken: delivery!.leaseToken, outcome: 'delivered' }])).toBe(1);
    expect(deliveries(store)[0]).toMatchObject({ status: 'DELIVERED', attempts: 1 });
    clock.now += 1;
    expect(events.list(store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' })).subscriptions[0]!.deliveryStatus.lastDeliveryAt).not.toBeNull();
  });

  it('redelivers the same event id and body after an expired lease', () => {
    const { events, clock } = pending();
    const [first] = events.claim(10, 5_000);
    clock.now += 5_001;
    const [second] = events.claim(10, 5_000);
    expect(second!.eventId).toBe(first!.eventId);
    expect(second!.body).toBe(first!.body);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
  });

  it('backs off failed attempts, then abandons after the final retry', () => {
    const { events, store, clock } = pending();
    for (let attempt = 1; attempt <= MCP_EVENT_RETRY_DELAYS_MS.length; attempt += 1) {
      const [delivery] = events.claim(10, 30_000);
      expect(delivery).toBeDefined();
      events.report([{ deliveryId: delivery!.deliveryId, leaseToken: delivery!.leaseToken, outcome: 'failed', error: 'http_5xx' }]);
      expect(deliveries(store)[0]).toMatchObject({ status: 'PENDING', next_attempt_at: clock.now + MCP_EVENT_RETRY_DELAYS_MS[attempt - 1]! });
      expect(events.claim(10, 30_000)).toEqual([]);
      clock.now += MCP_EVENT_RETRY_DELAYS_MS[attempt - 1]!;
    }
    const [last] = events.claim(10, 30_000);
    events.report([{ deliveryId: last!.deliveryId, leaseToken: last!.leaseToken, outcome: 'failed', error: 'timeout' }]);
    expect(deliveries(store)[0]).toMatchObject({ status: 'ABANDONED', attempts: 5, last_error: 'timeout' });
    expect(events.list(store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' })).subscriptions[0]!.deliveryStatus).toMatchObject({ lastError: 'timeout' });
  });

  it('does not retry a rejected delivery', () => {
    const { events, store } = pending();
    const [delivery] = events.claim(10, 30_000);
    events.report([{ deliveryId: delivery!.deliveryId, leaseToken: delivery!.leaseToken, outcome: 'rejected', error: 'http_4xx' }]);
    expect(deliveries(store)[0]).toMatchObject({ status: 'ABANDONED' });
  });

  it('stops delivery when the creating API key is revoked', () => {
    const context = setup();
    const keys = new ApiKeyStore(context.store.database, () => undefined, () => context.clock.now);
    const { key } = keys.create(context.owner, 'chatgpt', 30);
    subscribe(context.events, context.owner, 'cloudharness.task.completed', {}, { apiKeyId: key.id });
    const task = createTask(context.store, context.owner, WS_A);
    context.store.updateDurableTaskStatus(task.id, 1, { status: 'SUCCEEDED' });
    keys.revoke(context.owner, key.id, key.generation);
    context.clock.now = Date.now() + 1_000;
    expect(context.events.claim(10, 30_000)).toEqual([]);
    expect(deliveries(context.store)[0]).toMatchObject({ status: 'ABANDONED', last_error: 'credential_revoked' });
    expect(context.events.list(context.owner).subscriptions[0]).toMatchObject({ state: 'REVOKED', viaApiKey: true });
    expect(context.audits).toContain('mcp_event.revoked');
  });

  it('abandons deliveries for subscriptions that lapsed before delivery', () => {
    const { events, store, clock } = pending();
    clock.now += 86_400_001;
    expect(events.claim(10, 30_000)).toEqual([]);
    expect(deliveries(store)[0]).toMatchObject({ status: 'ABANDONED', last_error: 'subscription_inactive' });
  });

  it('dual-signs during secret rotation grace and re-seals under a new key version', () => {
    const { events, owner, clock, store } = pending();
    subscribe(events, owner, 'cloudharness.task.completed', {}, { secret: secret(2) });
    expect(events.claim(10, 30_000)[0]!.secrets).toEqual([secret(2), secret()]);
    clock.now += 600_001 + 30_000;
    expect(events.claim(10, 30_000)[0]!.secrets).toEqual([secret(2)]);
    const rotated = new McpEventService({
      database: store.database,
      resolvePrincipal: (principal) => store.resolvePrincipal(principal),
      keyring: new SecretKeyring(2, [{ version: 1, key: Buffer.alloc(32, 7) }, { version: 2, key: randomBytes(32) }]),
      now: () => clock.now
    });
    expect(rotated.reencrypt()).toBe(1);
    expect(rotated.reencrypt()).toBe(0);
  });
});
