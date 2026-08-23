import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: false,
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
};

type Reply = { status: number; text: string; json: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };
let server: Server;
let port: number;
let runner: DashboardRunnerClient;
let calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;

beforeEach(async () => {
  calls = [];
  runner = {
    call: vi.fn(),
    callInternal: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      if (operation === 'privilege_grant_list') {
        return {
          ok: true,
          message: 'Privilege grants listed',
          truncated: false,
          data: {
            grants: [{
              id: 'pvg_1234567890abcdef',
              ownerId: 'owner',
              workspaceId: 'ws_1234567890abcdef',
              command: 'whoami',
              cwd: '.',
              commandSha256: 'a'.repeat(64),
              status: 'PENDING',
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              consumedAt: null
            }]
          }
        };
      }
      if (operation === 'privilege_grant_approve') {
        return {
          ok: true,
          message: 'Privilege grant approved',
          truncated: false,
          data: {
            grant: {
              id: String(input.grantId),
              ownerId: 'owner',
              workspaceId: 'ws_1234567890abcdef',
              command: 'whoami',
              cwd: '.',
              commandSha256: 'a'.repeat(64),
              status: 'APPROVED',
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              consumedAt: null
            }
          }
        };
      }
      if (operation === 'privilege_grant_reject') {
        return {
          ok: true,
          message: 'Privilege grant rejected',
          truncated: false,
          data: {
            grant: {
              id: String(input.grantId),
              ownerId: 'owner',
              workspaceId: 'ws_1234567890abcdef',
              command: 'whoami',
              cwd: '.',
              commandSha256: 'a'.repeat(64),
              status: 'REJECTED',
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              consumedAt: null
            }
          }
        };
      }
      return { ok: true, message: 'ok', truncated: false, data: {} };
    })
  };
  const app = express();
  app.use((request: express.Request & { auth?: unknown }, _response, next) => {
    request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } };
    next();
  });
  app.use('/dashboard', createDashboardRouter(config, runner));
  server = createServer(app);
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  await promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
});

afterEach(async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
});

function request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const payload = options.body ? JSON.stringify(options.body) : undefined;
  const req = httpRequest({
    host: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET',
    headers: {
      host: 'dashboard.example',
      origin: 'https://dashboard.example',
      'content-type': 'application/json',
      ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...options.headers
    }
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => {
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-json response */ }
      resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
  return promise;
}

describe('Dashboard privilege grant routes', () => {
  it('lists privilege grants through the dashboard control router', async () => {
    const reply = await request('/api/v1/privilege-grants?workspaceId=ws_1234567890abcdef');
    expect(reply.status).toBe(200);
    expect(calls[0]).toMatchObject({
      operation: 'privilege_grant_list',
      input: { workspaceId: 'ws_1234567890abcdef' },
      principal
    });
    expect(reply.json.data).toMatchObject({
      grants: [expect.objectContaining({ id: 'pvg_1234567890abcdef', status: 'PENDING' })]
    });
  });

  it('approves a privilege grant through the dashboard control router', async () => {
    const session = await request('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const csrfHeaders = {
      origin: 'https://dashboard.example',
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': String(session.json.csrfToken)
    };

    const reply = await request('/api/v1/privilege-grants/pvg_1234567890abcdef/approve', {
      method: 'POST',
      body: {},
      headers: csrfHeaders
    });
    expect(reply.status).toBe(200);
    expect(calls.some((c) => c.operation === 'privilege_grant_approve' && c.input.grantId === 'pvg_1234567890abcdef')).toBe(true);
    expect(reply.json.data).toMatchObject({
      grant: expect.objectContaining({ id: 'pvg_1234567890abcdef', status: 'APPROVED' })
    });
  });

  it('rejects a privilege grant through the dashboard control router', async () => {
    const session = await request('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const csrfHeaders = {
      origin: 'https://dashboard.example',
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': String(session.json.csrfToken)
    };

    const reply = await request('/api/v1/privilege-grants/pvg_1234567890abcdef/reject', {
      method: 'POST',
      body: {},
      headers: csrfHeaders
    });
    expect(reply.status).toBe(200);
    expect(calls.some((c) => c.operation === 'privilege_grant_reject' && c.input.grantId === 'pvg_1234567890abcdef')).toBe(true);
    expect(reply.json.data).toMatchObject({
      grant: expect.objectContaining({ id: 'pvg_1234567890abcdef', status: 'REJECTED' })
    });
  });
});
