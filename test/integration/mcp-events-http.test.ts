import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client, ProtocolError, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { MCP_EVENT_NAMES, TOOL_SPECS, type ApiConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { EventDeliveryWorker } from '../../apps/api/src/events/event-delivery-worker.js';
import { createWebhookSender } from '../../apps/api/src/events/webhook-sender.js';
import type { ResolvedAddress } from '../../apps/api/src/mcp-gateway/url-policy.js';
import { McpEventService } from '../../apps/runner/src/mcp-event-service.js';
import { SecretKeyring } from '../../apps/runner/src/secret-keyring.js';
import { StateStore, type WorkspaceRecord } from '../../apps/runner/src/state-store.js';

/**
 * End to end over streamable HTTP: a real API (`createApiApp`) talks to the real runner events
 * service on a real state database, and callbacks land on a mock receiver behind the API's
 * SSRF-guarded sender. Only DNS and the TLS socket are substituted.
 */

const token = 'integration-bearer-token-longer-than-32-characters';
const HOOK = 'https://hooks.example.com/mcp/events';
const PUBLIC: ResolvedAddress[] = [{ address: '93.184.216.34', family: 4 }];
const secret = (fill: number) => `whsec_${Buffer.alloc(32, fill).toString('base64')}`;
const WS_OWNED = `ws_${'a'.repeat(24)}`;
const WS_FOREIGN = `ws_${'f'.repeat(24)}`;

type Received = { url: string; headers: Record<string, string>; body: string };
type ReceiverMode = 'echo' | 'wrong-challenge' | 'error-500' | 'gone-410' | 'redirect';

let directory: string;
let store: StateStore;
let events: McpEventService;
let owner: string;
const clock = { now: Date.now() };
let runner: Server;
let api: Server;
let runtime: ApiRuntime;
let endpoint: URL;
let resolveAnswer: ResolvedAddress[] = PUBLIC;
let receiverMode: ReceiverMode = 'echo';
const received: Received[] = [];
const sender = createWebhookSender({
  resolve: async () => resolveAnswer,
  fetchImpl: async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    const body = String(init?.body);
    received.push({ url: String(input), headers, body });
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (receiverMode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } });
    if (receiverMode === 'error-500') return new Response('upstream detail must not leak', { status: 500 });
    if (receiverMode === 'gone-410') return new Response(null, { status: 410 });
    if (parsed.type === 'verification') return Response.json({ challenge: receiverMode === 'wrong-challenge' ? 'nope' : parsed.challenge });
    return new Response(null, { status: 204 });
  }
});

function workspace(id: string, ownerId: string): WorkspaceRecord {
  const now = Date.now();
  return {
    id, ownerId, idempotencyKey: `idem-${id}`, repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: `/tmp/${id}`, environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 3_600_000, hardExpiresAt: now + 7_200_000, gitAuthorName: null,
    gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-events-http-'));
  store = new StateStore(join(directory, 'state.db'));
  events = new McpEventService({
    database: store.database,
    resolvePrincipal: (principal) => store.resolvePrincipal(principal),
    keyring: new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 7) }]),
    now: () => clock.now
  });
  owner = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const stranger = store.resolvePrincipal({ kind: 'external', issuer: 'https://issuer.example.com', subject: 'stranger' });
  store.create(workspace(WS_OWNED, owner));
  store.create(workspace(WS_FOREIGN, stranger));

  const runnerApp = express();
  runnerApp.use(express.json({ limit: '1mb' }));
  runnerApp.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  runnerApp.post('/v1/operations', (request, response) => {
    response.json({ ok: true, message: 'Stub runner result', data: { operation: (request.body as { operation: string }).operation }, truncated: false });
  });
  runnerApp.post('/v1/internal/events', (request, response) => response.json(events.execute(request.body)));
  runner = createServer(runnerApp);
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  const runnerAddress = runner.address();
  if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('runner failed');
  const config: ApiConfig = {
    host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: token,
    runnerUrl: `http://127.0.0.1:${runnerAddress.port}`, runnerToken: 'runner-token-that-is-longer-than-32-characters',
    publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 5_000, maxBodyBytes: 262_144,
    mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
    mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
    mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
  };
  runtime = createApiApp(config, { webhookSender: sender });
  api = createServer(runtime.app);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('api failed');
  endpoint = new URL(`http://127.0.0.1:${apiAddress.port}/mcp`);
});

afterAll(async () => {
  await runtime.close();
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => runner.close(() => resolve()))
  ]);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  resolveAnswer = PUBLIC;
  receiverMode = 'echo';
  received.length = 0;
  clock.now = Date.now();
});

function recordingFetch(bodies: unknown[]): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.clone().text();
    const payloads = /^(event|data|id):/m.test(text)
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
      : (text ? [text] : []);
    for (const payload of payloads) {
      try { bodies.push(JSON.parse(payload)); } catch { /* transport noise */ }
    }
    return response;
  };
}

async function connect(mode: 'modern' | 'legacy' = 'modern', bodies: unknown[] = []): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: recordingFetch(bodies)
  });
  const client = new Client({ name: 'events-http-test', version: '1.0.0' }, {
    versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' }
  });
  await client.connect(transport);
  return client;
}

const SubscribeResult = z.looseObject({
  id: z.string(), refreshBefore: z.string().nullable(), cursor: z.null(), truncated: z.boolean(),
  deliveryStatus: z.looseObject({ active: z.boolean(), lastDeliveryAt: z.string().nullable(), lastError: z.string().nullable() }).optional()
});
const ListResult = z.looseObject({ events: z.array(z.looseObject({ name: z.string(), delivery: z.array(z.string()), inputSchema: z.record(z.string(), z.unknown()), payloadSchema: z.record(z.string(), z.unknown()) })) });

const subscribeParams = (overrides: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) => ({
  name: 'cloudharness.task.completed',
  arguments: { workspaceId: WS_OWNED },
  delivery: { mode: 'webhook', url: HOOK, secret: secret(1), ...delivery },
  cursor: null,
  ...overrides
});

async function rpcError(promise: Promise<unknown>): Promise<ProtocolError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProtocolError);
  return error as ProtocolError;
}

let taskSequence = 0;
function completeTask(workspaceId = WS_OWNED, status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'): string {
  taskSequence += 1;
  const id = `task_${String(taskSequence).padStart(24, '0')}`;
  store.createDurableTask({
    id, workspaceId, ownerId: owner, name: 'build', command: 'echo TOP-SECRET-COMMAND', cwd: '.', status: 'RUNNING',
    idempotencyKey: null, requestFingerprint: null, bootId: 'boot_a', exitCode: null, errorCode: null,
    errorMessage: 'raw failure output', timeoutMs: 60_000, maxBytes: 65_536, logPath: '/tmp/log',
    outputBytes: 0, outputArtifactId: null, createdAt: Date.now(), startedAt: Date.now(), finishedAt: null
  });
  store.updateDurableTaskStatus(id, 1, status === 'SUCCEEDED'
    ? { status, exitCode: 0, finishedAt: Date.now() }
    : { status, exitCode: 2, errorCode: 'EXIT_NONZERO', finishedAt: Date.now() });
  // Emission stamps wall-clock time; move the injected clock past it so the delivery is due.
  clock.now = Date.now() + 1_000;
  return id;
}

function worker(): EventDeliveryWorker {
  return new EventDeliveryWorker({ callRunner: (request, signal) => runtime.runnerClient.callEvents(request, signal), sender });
}

function verifySignature(message: Received, key: string): boolean {
  const raw = Buffer.from(key.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', raw).update(`${message.headers['webhook-id']}.${message.headers['webhook-timestamp']}.${message.body}`).digest();
  return message.headers['webhook-signature']!.split(' ').some((candidate) => {
    const actual = Buffer.from(candidate.replace(/^v1,/u, ''), 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

describe('MCP Events over streamable HTTP', () => {
  it('advertises the events capability in server/discover and keeps the tool surface for both protocol eras', async () => {
    const bodies: unknown[] = [];
    const client = await connect('modern', bodies);
    const discover = bodies.map((body) => (body as { result?: Record<string, unknown> }).result).find((result) => result && 'capabilities' in result);
    expect((discover!.capabilities as Record<string, unknown>).events).toEqual({});
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_SPECS.map((spec) => spec.name));
    await client.close();

    const legacy = await connect('legacy');
    expect((await legacy.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_SPECS.map((spec) => spec.name));
    expect((await legacy.callTool({ name: 'workspace_list', arguments: {} })).isError).toBeFalsy();
    await legacy.close();
  });

  it('lists the four events with webhook delivery and JSON Schemas', async () => {
    const client = await connect();
    const listed = await client.request({ method: 'events/list', params: {} } as never, ListResult);
    expect(listed.events.map((event) => event.name)).toEqual([...MCP_EVENT_NAMES]);
    for (const event of listed.events) {
      expect(event.delivery).toEqual(['webhook']);
      expect(event.inputSchema.type).toBe('object');
      expect(event.inputSchema.additionalProperties).toBe(false);
      expect(event.payloadSchema.type).toBe('object');
      expect(event.inputSchema.$schema).toBeUndefined();
    }
    await client.close();
  });

  it('verifies the callback, delivers a signed event once, and reports delivery status on refresh', async () => {
    const client = await connect();
    const subscribed = await client.request({ method: 'events/subscribe', params: subscribeParams() } as never, SubscribeResult);
    expect(subscribed.id).toMatch(/^sub_[a-f0-9]{32}$/u);
    expect(subscribed).toMatchObject({ cursor: null, truncated: false });
    expect(Date.parse(subscribed.refreshBefore!) - clock.now).toBeLessThanOrEqual(86_400_000);
    expect(received).toHaveLength(1);
    const verification = received[0]!;
    expect(verification.headers['webhook-id']).toMatch(/^msg_verification_/u);
    expect(verification.headers['x-mcp-subscription-id']).toBe(subscribed.id);
    expect(verifySignature(verification, secret(1))).toBe(true);

    const taskId = completeTask();
    completeTask(WS_OWNED, 'FAILED'); // a failed task does not match a completed subscription
    await worker().tick();
    const deliveries = received.slice(1);
    expect(deliveries).toHaveLength(1);
    const delivered = deliveries[0]!;
    expect(delivered.url).toBe(HOOK);
    expect(verifySignature(delivered, secret(1))).toBe(true);
    expect(verifySignature(delivered, secret(2))).toBe(false);
    const body = JSON.parse(delivered.body) as Record<string, unknown>;
    expect(body).toEqual({
      eventId: delivered.headers['webhook-id'],
      name: 'cloudharness.task.completed',
      timestamp: expect.any(String),
      data: expect.objectContaining({ workspaceId: WS_OWNED, taskId, status: 'SUCCEEDED', exitCode: 0 }),
      cursor: null
    });
    expect(delivered.body).not.toContain('TOP-SECRET-COMMAND');
    expect(delivered.body).not.toContain('raw failure output');

    // A second pass finds nothing left to send.
    await worker().tick();
    expect(received).toHaveLength(2);

    // Refresh: same key, same id, no second verification, delivery status reported.
    const refreshed = await client.request({ method: 'events/subscribe', params: subscribeParams() } as never, SubscribeResult);
    expect(refreshed.id).toBe(subscribed.id);
    expect(received).toHaveLength(2);
    expect(refreshed.deliveryStatus).toMatchObject({ active: true, lastError: null, lastDeliveryAt: expect.any(String) });

    expect(await client.request({ method: 'events/unsubscribe', params: { name: 'cloudharness.task.completed', arguments: { workspaceId: WS_OWNED }, delivery: { url: HOOK } } } as never, z.looseObject({}))).toBeDefined();
    completeTask();
    await worker().tick();
    expect(received).toHaveLength(2);
    // Unsubscribe is idempotent.
    await client.request({ method: 'events/unsubscribe', params: { name: 'cloudharness.task.completed', arguments: { workspaceId: WS_OWNED }, delivery: { url: HOOK } } } as never, z.looseObject({}));
    await client.close();
  });

  it('retries a failed delivery with the same event id so receivers can dedupe', async () => {
    const client = await connect();
    await client.request({ method: 'events/subscribe', params: subscribeParams({ name: 'cloudharness.task.failed' }, { url: `${HOOK}/retry` }) } as never, SubscribeResult);
    received.length = 0;
    completeTask(WS_OWNED, 'FAILED');
    receiverMode = 'error-500';
    await worker().tick();
    expect(received).toHaveLength(1);
    const status = await client.request({ method: 'events/subscribe', params: subscribeParams({ name: 'cloudharness.task.failed' }, { url: `${HOOK}/retry` }) } as never, SubscribeResult);
    expect(status.deliveryStatus).toMatchObject({ lastError: 'http_5xx' });
    expect(JSON.stringify(status)).not.toContain('upstream detail');

    receiverMode = 'echo';
    clock.now += 15_001;
    await worker().tick();
    expect(received).toHaveLength(2);
    expect(received[1]!.headers['webhook-id']).toBe(received[0]!.headers['webhook-id']);
    expect(received[1]!.body).toBe(received[0]!.body);
    await worker().tick();
    expect(received).toHaveLength(2);
    await client.close();
  });

  it('stops retrying when the receiver answers 410 Gone', async () => {
    const client = await connect();
    await client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: `${HOOK}/gone` }) } as never, SubscribeResult);
    received.length = 0;
    completeTask();
    receiverMode = 'gone-410';
    await worker().tick();
    clock.now += 600_000;
    await worker().tick();
    expect(received).toHaveLength(1);
    await client.close();
  });

  it('never dials a callback whose hostname rebinds to a private address after subscribing', async () => {
    const client = await connect();
    await client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: `${HOOK}/rebind` }) } as never, SubscribeResult);
    received.length = 0;
    completeTask();
    resolveAnswer = [{ address: '10.1.2.3', family: 4 }];
    await worker().tick();
    expect(received).toHaveLength(0);
    const row = store.database.prepare(`SELECT d.attempts, d.last_error FROM event_deliveries d
      JOIN event_subscriptions s ON s.id = d.subscription_id WHERE s.url = ? ORDER BY d.created_at DESC`).get(`${HOOK}/rebind`) as { attempts: number; last_error: string };
    expect(row).toEqual({ attempts: 1, last_error: 'connection_refused' });
    await client.close();
  });

  it('maps refusals onto the events error codes without creating subscriptions', async () => {
    const client = await connect();
    const before = (store.database.prepare('SELECT count(*) AS count FROM event_subscriptions').get() as { count: number }).count;

    const unknown = await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({ name: 'cloudharness.nope' }) } as never, SubscribeResult));
    expect(unknown.code).toBe(-32011);
    expect(unknown.data).toEqual({ kind: 'event' });

    const unsupported = await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { mode: 'push' }) } as never, SubscribeResult));
    expect(unsupported.code).toBe(-32014);
    expect(unsupported.data).toEqual({ feature: 'deliveryMode', value: 'push' });

    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { secret: 'whsec_short' }) } as never, SubscribeResult))).code).toBe(-32602);
    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: 'http://hooks.example.com/x' }) } as never, SubscribeResult))).code).toBe(-32602);
    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: 'https://169.254.169.254/latest/meta-data' }) } as never, SubscribeResult))).code).toBe(-32602);
    resolveAnswer = [{ address: '192.168.1.10', family: 4 }];
    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: `${HOOK}/private` }) } as never, SubscribeResult))).code).toBe(-32602);
    resolveAnswer = PUBLIC;

    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({ arguments: { workspaceId: WS_FOREIGN } }, { url: `${HOOK}/foreign` }) } as never, SubscribeResult))).code).toBe(-32012);
    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({ arguments: { bogus: true } }, { url: `${HOOK}/bogus` }) } as never, SubscribeResult))).code).toBe(-32602);

    receiverMode = 'wrong-challenge';
    const challenge = await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: `${HOOK}/challenge` }) } as never, SubscribeResult));
    expect(challenge.code).toBe(-32015);
    expect(challenge.data).toEqual({ reason: 'challenge_failed' });
    receiverMode = 'redirect';
    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: `${HOOK}/redirect` }) } as never, SubscribeResult))).data).toEqual({ reason: 'http_4xx' });
    receiverMode = 'error-500';
    expect((await rpcError(client.request({ method: 'events/subscribe', params: subscribeParams({}, { url: `${HOOK}/down` }) } as never, SubscribeResult))).data).toEqual({ reason: 'http_5xx' });

    expect((store.database.prepare('SELECT count(*) AS count FROM event_subscriptions').get() as { count: number }).count).toBe(before);
    await client.close();
  });
});
