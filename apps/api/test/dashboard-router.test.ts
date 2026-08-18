import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { mapDashboardData, type DashboardResponseOperation } from '../src/dashboard-response.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'api-key-audience',
  apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };
let server: Server;
let port: number;
let runner: DashboardRunnerClient;
let calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;

beforeEach(async () => {
  calls = [];
  runner = {
    call: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      if (operation === 'workspace_list') return { ok: true, message: 'listed', truncated: false, data: { workspaces: [{
        workspaceId, repositoryUrl: 'https://github.com/example/project.git', ref: null, status: 'ACTIVE', networkMode: 'none',
        createdAt: '2026-08-17T00:00:00.000Z', lastActivityAt: '2026-08-17T00:01:00.000Z', expiresAt: '2026-08-17T00:10:00.000Z',
        generation: 7, ownerId: 'internal-owner', workspacePath: '/host/jobs/private', containerName: 'executor-secret'
      }] } };
      if (operation === 'files_write') return { ok: true, message: 'written', truncated: false, data: { path: input.path, sha256: 'b'.repeat(64) } };
      return { ok: true, message: 'ok', truncated: false, data: {} };
    }),
    callInternal: vi.fn(async (_operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation: 'workspace_detail', input, principal: selected });
      return { ok: true, message: 'detail', truncated: false, data: {
        workspaceId, repositoryUrl: 'https://github.com/example/project.git', status: 'ACTIVE', networkMode: 'none', generation: 7,
        createdAt: '2026-08-17T00:00:00.000Z', lastActivityAt: '2026-08-17T00:01:00.000Z', expiresAt: '2026-08-17T00:10:00.000Z'
      } };
    }),
    callApiKeys: vi.fn(async (operation) => {
      const key = { id: `apk_${'k'.repeat(24)}`, name: 'CLI', displayPrefix: 'chm_key_apk_kkkk…', state: 'ACTIVE' as const, generation: 1, createdAt: 1, expiresAt: 2, lastUsedAt: null, revokedAt: null };
      if (operation === 'api_key_list') return { ok: true as const, operation, data: { keys: [key] }, truncated: false as const };
      if (operation === 'api_key_create') return { ok: true as const, operation, data: { key, apiKey: `chm_key_apk_${'k'.repeat(24)}.${'s'.repeat(43)}` }, truncated: false as const };
      return { ok: true as const, operation, data: { key: { ...key, state: 'REVOKED' as const, generation: 2, revokedAt: 2 } }, truncated: false as const };
    })
  };
  const app = express();
  app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
  app.use('/dashboard', createDashboardRouter(config, runner));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
});

afterEach(async () => await new Promise<void>((resolve) => server.close(() => resolve())));

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers: { host: 'dashboard.example', ...options.headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers as Reply['headers'], text, json: text ? JSON.parse(text) : undefined });
      });
    });
    request.on('error', reject); request.end(options.body);
  });
}

describe('dashboard BFF', () => {
  it('allowlists successful response fields for every dashboard operation', () => {
    const hostile = { ownerId: 'future-owner', token: 'future-token', workspacePath: '/future/private', futureSecret: 'do-not-forward' };
    const fixtures: Record<DashboardResponseOperation, unknown> = {
      workspace_list: { workspaces: [{ workspaceId, repositoryUrl: 'https://github.com/example/project.git', status: 'ACTIVE', ...hostile }], ...hostile },
      workspace_status: { workspaceId, status: 'ACTIVE', ...hostile },
      workspace_detail: { workspaceId, status: 'ACTIVE', generation: 3, ...hostile },
      workspace_close: { workspaceId, status: 'CLOSED', generation: 4, ...hostile },
      files_list: { path: '.', entries: [{ name: 'README.md', type: 'file', ...hostile }], ...hostile },
      files_read: { path: 'README.md', content: 'safe', sha256: 'a'.repeat(64), bytes: 4, ...hostile },
      files_write: { path: 'README.md', sha256: 'b'.repeat(64), bytes: 4, ...hostile },
      files_apply_patch: { path: 'README.md', sha256: 'c'.repeat(64), ...hostile },
      files_delete: { path: 'README.md', type: 'file', ...hostile },
      files_move: { source: 'old', destination: 'new', ...hostile },
      files_mkdir: { path: 'folder', ...hostile },
      tasks_list: { tasks: [{ id: 'task_safe', status: 'running', exitCode: 0, dependsOn: [], command: 'secret', ...hostile }], ...hostile },
      sessions_list: { sessions: [{ id: 'session_safe', name: 'main', status: 'running', output: 'secret', ...hostile }], ...hostile }
    };
    for (const [operation, value] of Object.entries(fixtures) as Array<[DashboardResponseOperation, unknown]>) {
      const serialized = JSON.stringify(mapDashboardData(operation, value));
      for (const forbidden of Object.values(hostile)) expect(serialized, operation).not.toContain(String(forbidden));
      expect(serialized, operation).not.toContain('"command"');
      expect(serialized, operation).not.toContain('"output"');
    }
  });

  it('uses only the verified request principal and strips control-plane fields', async () => {
    const response = await send('/api/v1/workspaces');
    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({ operation: 'workspace_list', input: { limit: 100 }, principal });
    expect(response.json.data.workspaces[0].version).toBe(7);
    for (const forbidden of ['internal-owner', '/host/jobs/private', 'executor-secret', 'runner-token']) expect(response.text).not.toContain(forbidden);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('requires exact same-origin JSON and a principal-bound CSRF session for mutations', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const rejected = await send(`/api/v1/workspaces/${workspaceId}/files/content`, {
      method: 'PUT', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' }, body: JSON.stringify({ path: 'README.md', content: 'hello' })
    });
    expect(rejected.status).toBe(401);
    const accepted = await send(`/api/v1/workspaces/${workspaceId}/files/content`, {
      method: 'PUT', headers: { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken },
      body: JSON.stringify({ path: 'README.md', content: 'hello' })
    });
    expect(accepted.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'files_write', input: { workspaceId, path: 'README.md', content: 'hello' }, principal });
  });

  it('rejects foreign origin, missing mutation origin, and non-JSON mutations', async () => {
    expect((await send('/api/v1/workspaces', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await send(`/api/v1/workspaces/${workspaceId}/files/directory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await send(`/api/v1/workspaces/${workspaceId}/files/directory`, { method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('accepts an allowlisted hostname when the request host includes its HTTPS port', async () => {
    const response = await send('/api/v1/workspaces', { headers: { host: 'dashboard.example:443' } });
    expect(response.status).toBe(200);
  });

  it('does not fall back to unconditional workspace close', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const response = await send(`/api/v1/workspaces/${workspaceId}/close`, {
      method: 'POST', headers: { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken },
      body: JSON.stringify({ expectedGeneration: 7 })
    });
    expect(response.status).toBe(503);
    expect(calls.some((call) => call.operation === 'workspace_close')).toBe(false);
  });

  it('lists safe key metadata and requires CSRF for one-time create and revoke', async () => {
    const listed = await send('/api/v1/api-keys');
    expect(listed.status).toBe(200);
    expect(listed.json.data.readiness).toEqual({ ready: true, publicUrl: 'https://api.example/mcp' });
    expect(listed.text).not.toContain('chm_key_apk_kkkkkkkkkkkkkkkkkkkkkkkk.s');

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const created = await send('/api/v1/api-keys', { method: 'POST', headers, body: JSON.stringify({ name: 'CLI', expiresInDays: 30 }) });
    expect(created.status).toBe(200);
    expect(created.json.data.apiKey).toMatch(/^chm_key_/);
    const revokeBody = JSON.stringify({ expectedGeneration: 1 });
    const revoked = await send(`/api/v1/api-keys/apk_${'k'.repeat(24)}`, {
      method: 'DELETE', headers: { ...headers, 'content-length': String(Buffer.byteLength(revokeBody)) }, body: revokeBody
    });
    expect(revoked.status).toBe(200);
    expect(revoked.text).not.toContain('.ssss');
  });
});
