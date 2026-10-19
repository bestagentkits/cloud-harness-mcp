import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiConfig,
  NotificationsRunnerRequest,
  NotificationsRunnerResponse,
  RunnerPrincipalSelector,
  RunnerResponse
} from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false,
  apiKeyAuthEnabled: false, automationsEnabled: false
} as ApiConfig;

const notificationId = `ntf_${'a'.repeat(32)}`;
const at = '2026-10-20T00:00:00.000Z';
const summary = {
  notificationId, kind: 'automation.failed', subjectType: 'automation_workflow', subjectId: 'wfl_1', title: 'Automation failed: acme/widgets#7',
  link: '/dashboard/automations/runs/wfl_1', createdAt: at, readAt: null,
  deliveries: [{ channel: 'inbox', state: 'DELIVERED', attempts: 0, lastErrorClass: null, updatedAt: at }]
};
const preferences = [{ channel: 'mcp_event', kind: 'automation.failed', enabled: false }];
const dataFor: Record<string, unknown> = {
  inbox_status: { enabled: true, unread: 1 },
  inbox_list: { notifications: [summary], nextCursor: null, unread: 1 },
  inbox_mark_read: { updated: 1, unread: 0 },
  preferences_get: { preferences },
  preferences_put: { preferences, revoked: 2 }
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; json: any };
let server: Server;
let port: number;
let requests: NotificationsRunnerRequest[];
let nextReply: ((request: NotificationsRunnerRequest) => NotificationsRunnerResponse) | undefined;

async function listen(client: DashboardRunnerClient): Promise<void> {
  const app = express();
  app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
  app.use('/dashboard', createDashboardRouter(config, client));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
}

const unused = async (): Promise<RunnerResponse> => ({ ok: true, message: 'ok', truncated: false, data: {} });

beforeEach(async () => {
  requests = [];
  nextReply = undefined;
  await listen({
    call: vi.fn(unused),
    callInternal: vi.fn(unused),
    callNotifications: vi.fn(async (request: NotificationsRunnerRequest): Promise<NotificationsRunnerResponse> => {
      requests.push(request);
      return nextReply ? nextReply(request) : { ok: true, data: dataFor[request.operation] };
    })
  });
});

afterEach(async () => await new Promise<void>((resolve) => server.close(() => resolve())));

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: 'dashboard.example', ...options.headers };
    if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json });
      });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

async function mutationHeaders(): Promise<Record<string, string>> {
  const session = await send('/api/v1/session');
  const cookie = String((session.headers['set-cookie'] as string[] | undefined)?.[0]).split(';', 1)[0]!;
  return { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
}

describe('dashboard inbox BFF', () => {
  it('maps every read route to its runner operation with the session principal', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['/api/v1/inbox/status', 'inbox_status', {}],
      ['/api/v1/inbox', 'inbox_list', { limit: 50, unreadOnly: false }],
      ['/api/v1/inbox?limit=10&unread=true&cursor=abc_DEF-1', 'inbox_list', { limit: 10, unreadOnly: true, cursor: 'abc_DEF-1' }],
      ['/api/v1/notification-preferences', 'preferences_get', {}]
    ];
    for (const [path, operation, input] of cases) {
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(response.json.data, path).toEqual(dataFor[operation]);
      expect(requests.at(-1), path).toEqual({ version: 1, principal, operation, input });
    }
  });

  it('maps mutations behind CSRF and never lets the body choose the principal', async () => {
    const headers = await mutationHeaders();
    const cases: Array<[string, string, string, Record<string, unknown>]> = [
      ['POST', '/api/v1/inbox/read', 'inbox_mark_read', { notificationIds: [notificationId] }],
      ['POST', '/api/v1/inbox/read', 'inbox_mark_read', { all: true }],
      ['POST', '/api/v1/inbox/read', 'inbox_mark_read', { all: true, before: '2026-10-20T08:00:00.000Z' }],
      ['PUT', '/api/v1/notification-preferences', 'preferences_put', { preferences }]
    ];
    for (const [method, path, operation, body] of cases) {
      const response = await send(path, { method, headers, body: JSON.stringify(body) });
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.json.data).toEqual(dataFor[operation]);
      expect(requests.at(-1)).toEqual({ version: 1, principal, operation, input: body });
    }
    const forged = await send('/api/v1/inbox/read', { method: 'POST', headers, body: JSON.stringify({ all: true, principal: { kind: 'owner', ownerId: 'x' } }) });
    expect(forged.status).toBe(400);
  });

  it('refuses mutations without CSRF or Origin before reaching the runner', async () => {
    const headers = await mutationHeaders();
    const body = JSON.stringify({ all: true });
    expect((await send('/api/v1/inbox/read', { method: 'POST', headers: { ...headers, 'x-csrf-token': 'wrong' }, body })).status).toBe(403);
    const { origin: _origin, ...withoutOrigin } = headers;
    void _origin;
    expect((await send('/api/v1/inbox/read', { method: 'POST', headers: withoutOrigin, body })).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it('rejects malformed input locally and maps runner errors', async () => {
    expect((await send('/api/v1/inbox?limit=1000')).status).toBe(400);
    expect((await send('/api/v1/inbox?unread=maybe')).status).toBe(400);
    expect((await send('/api/v1/inbox?cursor=../x')).status).toBe(400);
    expect(requests).toHaveLength(0);

    const headers = await mutationHeaders();
    nextReply = () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'One or more notifications were not found.' } });
    const missing = await send('/api/v1/inbox/read', { method: 'POST', headers, body: JSON.stringify({ notificationIds: [notificationId] }) });
    expect(missing).toMatchObject({ status: 404, json: { error: 'not_found', message: 'One or more notifications were not found.' } });

    nextReply = () => ({ ok: false, error: { code: 'FEATURE_DISABLED', message: 'Notifications are disabled.' } });
    expect((await send('/api/v1/inbox')).json).toEqual({ error: 'feature_disabled', message: 'Notifications are disabled.' });

    nextReply = () => ({ ok: false, error: { code: 'INTERNAL', message: 'database path /var/lib/x leaked' } });
    const internal = await send('/api/v1/inbox');
    expect(internal).toMatchObject({ status: 503, json: { error: 'internal', message: 'Notifications are temporarily unavailable.' } });

    nextReply = () => ({ ok: true, data: { notifications: 'nope' } });
    expect((await send('/api/v1/inbox')).status).toBe(503);
  });

  it('answers 503 when the runner client has no notifications support', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen({ call: vi.fn(unused), callInternal: vi.fn(unused) });
    expect((await send('/api/v1/inbox/status')).status).toBe(503);
  });
});
