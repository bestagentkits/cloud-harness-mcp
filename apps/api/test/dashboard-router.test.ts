import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { mapDashboardData, type DashboardResponseOperation } from '../src/dashboard-response.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { DashboardRequest, DashboardRunnerClient } from '../src/dashboard-types.js';

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
    callInternal: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
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

  it('maps multi-installation github status and disconnect operations cleanly', async () => {
    const hostile = { ownerId: 'hostile-owner', secretToken: 'secret' };
    const rawStatus = {
      configured: true,
      installations: [
        { appId: '1', installationId: '101', accountId: '201', accountLogin: 'org-one', status: 'active', ...hostile },
        { appId: '1', installationId: '102', accountId: '202', accountLogin: 'org-two', status: 'active', ...hostile }
      ],
      repositories: [
        { installationId: '101', owner: 'org-one', repository: 'repo1', contents: 'write', status: 'granted', ...hostile }
      ],
      ...hostile
    };

    const mapped = mapDashboardData('github_status', rawStatus) as Record<string, unknown>;
    expect(mapped.configured).toBe(true);
    expect(mapped.installations).toHaveLength(2);
    expect(mapped.installation).toMatchObject({ installationId: '101', accountLogin: 'org-one' });
    expect(mapped.repositories).toHaveLength(1);
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain('hostile-owner');
    expect(serialized).not.toContain('secretToken');

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const csrfHeaders = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    // Reconcile with specific installation
    await send('/api/v1/github/reconcile', {
      method: 'POST', headers: csrfHeaders, body: JSON.stringify({ installationId: '101' })
    });
    expect(calls.at(-1)).toEqual({ operation: 'github_reconcile', input: { installationId: '101' }, principal });

    // Disconnect via DELETE endpoint
    const body = JSON.stringify({});
    const res = await send('/api/v1/github/installations/101', {
      method: 'DELETE',
      headers: { ...csrfHeaders, 'content-length': String(Buffer.byteLength(body)) },
      body
    });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'github_disconnect', input: { installationId: '101' }, principal });

    // Disconnect via POST endpoint
    const postBody = JSON.stringify({ installationId: '102' });
    const postRes = await send('/api/v1/github/disconnect', {
      method: 'POST',
      headers: { ...csrfHeaders, 'content-length': String(Buffer.byteLength(postBody)) },
      body: postBody
    });
    expect(postRes.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'github_disconnect', input: { installationId: '102' }, principal });
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

  it('exposes safe server configuration and status without control-plane fields', async () => {
    const response = await send('/api/v1/server');
    expect(response.status).toBe(200);
    expect(response.json.data.authMode).toBe('cloudflare-access');
    expect(response.json.data.managedOAuthUrl).toBe('https://dashboard.example/mcp');
    expect(response.json.data.apiKeyGateway).toEqual({ enabled: true, endpoint: 'https://api.example/mcp' });
    expect(response.json.data.limits).toEqual({ maxRequestBytes: 65_536, requestTimeoutMs: 2_000 });
    expect(typeof response.json.data.version).toBe('string');
    expect(typeof response.json.data.checkedAt).toBe('string');
    for (const forbidden of ['runner-token', 'runner:3001', 'api-key-audience', 'cf-service:d29ya2Vy']) expect(response.text).not.toContain(forbidden);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('persists a valid theme preference by cookie and rejects unknown or unauthenticated changes', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const missingCsrf = await send('/api/v1/preferences', { method: 'PUT', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'dark' }) });
    expect(missingCsrf.status).toBe(401);
    const dark = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ theme: 'dark' }) });
    expect(dark.status).toBe(200);
    expect(dark.json.data.theme).toBe('dark');
    const setCookie = String(dark.headers['set-cookie']?.[0]);
    expect(setCookie).toContain('ch-dashboard-theme=dark');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/dashboard');
    const cleared = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ theme: 'system' }) });
    expect(String(cleared.headers['set-cookie']?.[0])).toContain('Max-Age=0');
    const invalid = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ theme: 'purple' }) });
    expect(invalid.status).toBe(400);
  });
});

describe('dashboard profile', () => {
  let profileServer: Server;
  let profilePort: number;

  async function serveProfile(auth: AuthInfo): Promise<void> {
    const app = express();
    app.use((request, _response, next) => { (request as DashboardRequest).auth = auth; next(); });
    app.use('/dashboard', createDashboardRouter(config, runner));
    profileServer = createServer(app);
    const listening = Promise.withResolvers<void>();
    profileServer.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = profileServer.address();
    if (!address || typeof address === 'string') throw new Error('server unavailable');
    profilePort = address.port;
  }

  function get(): Promise<Reply> {
    const { promise, resolve, reject } = Promise.withResolvers<Reply>();
    const request = httpRequest({ hostname: '127.0.0.1', port: profilePort, path: '/dashboard/api/v1/profile', method: 'GET', headers: { host: 'dashboard.example' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers as Reply['headers'], text, json: text ? JSON.parse(text) : undefined });
      });
    });
    request.on('error', reject); request.end();
    return promise;
  }

  afterEach(async () => {
    if (!profileServer) return;
    const closed = Promise.withResolvers<void>();
    profileServer.close(() => closed.resolve());
    await closed.promise;
  });

  it('returns the verified identity, scopes, and session expiry without any runner call', async () => {
    const expiresAt = 1_800_000_000;
    await serveProfile({
      token: 'cloudflare-access', clientId: 'operator', scopes: ['workspace:read', 'workspace:write'], expiresAt,
      extra: { principal: { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator', email: 'op@example.com', name: 'Op Erator' } }
    });
    const before = calls.length;
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.json.data).toEqual({
      identity: { issuer: 'https://team.cloudflareaccess.com', subject: 'operator', email: 'op@example.com', name: 'Op Erator' },
      scopes: ['workspace:read', 'workspace:write'],
      sessionExpiresAt: new Date(expiresAt * 1_000).toISOString()
    });
    expect(calls.length).toBe(before);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('omits absent optional identity fields and reports no expiry', async () => {
    await serveProfile({ token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.json.data.identity).toEqual({ issuer: 'https://team.cloudflareaccess.com', subject: 'operator' });
    expect(response.json.data.sessionExpiresAt).toBeNull();
  });

  it('rejects a request that has no verified external principal', async () => {
    await serveProfile({ token: 'owner', clientId: 'owner', scopes: [], extra: { principal: { kind: 'owner', ownerId: 'owner' } } });
    expect((await get()).status).toBe(401);
  });
});

describe('dashboard server access control', () => {
  let srv: Server;
  let srvPort: number;

  async function serve(auth: AuthInfo): Promise<void> {
    const app = express();
    app.use((request, _response, next) => { (request as DashboardRequest).auth = auth; next(); });
    app.use('/dashboard', createDashboardRouter(config, runner));
    srv = createServer(app);
    const listening = Promise.withResolvers<void>();
    srv.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = srv.address();
    if (!address || typeof address === 'string') throw new Error('server unavailable');
    srvPort = address.port;
  }

  function statusOf(): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const request = httpRequest({ hostname: '127.0.0.1', port: srvPort, path: '/dashboard/api/v1/server', method: 'GET', headers: { host: 'dashboard.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject); request.end();
    return promise;
  }

  afterEach(async () => {
    if (!srv) return;
    const closed = Promise.withResolvers<void>();
    srv.close(() => closed.resolve());
    await closed.promise;
  });

  it('serves server info to a verified external principal', async () => {
    await serve({ token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } });
    expect(await statusOf()).toBe(200);
  });

  it('rejects server info for a non-external principal', async () => {
    await serve({ token: 'owner', clientId: 'owner', scopes: [], extra: { principal: { kind: 'owner', ownerId: 'owner' } } });
    expect(await statusOf()).toBe(401);
  });
});
