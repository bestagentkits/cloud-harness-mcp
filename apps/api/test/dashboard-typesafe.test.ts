import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { renderTypesafeSettings } from '../dashboard/dashboard-render.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'api-key-audience',
  apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

type Reply = { status: number; text: string; json: Record<string, unknown> };
let server: Server;
let port: number;
let runner: DashboardRunnerClient;
let calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;
let next: RunnerResponse | undefined;
const credential = { id: 'icr_12345678901234567890', integration: 'typesafe', label: 'TypeSafe', status: 'ACTIVE', activeVersion: 1, generation: 1, createdAt: 1, updatedAt: 1 };

beforeEach(async () => {
  calls = [];
  next = undefined;
  runner = {
    call: vi.fn(),
    callInternal: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      if (next) { const reply = next; next = undefined; return reply; }
      if (operation === 'integration_credential_list') {
        // A stray value field must never survive the response mapping.
        return { ok: true, message: 'listed', truncated: false, data: { credentials: [{ ...credential, value: 'tsk-leaked' }] } };
      }
      if (operation === 'integration_credential_create' || operation === 'integration_credential_rotate') {
        return { ok: true, message: 'stored', truncated: false, data: { ...credential, value: 'tsk-leaked', ciphertext: 'abc' } };
      }
      if (operation === 'integration_credential_delete') {
        return { ok: true, message: 'deleted', truncated: false, data: { id: credential.id, deleted: true } };
      }
      if (operation === 'typesafe_status') {
        return { ok: true, message: 'status', truncated: false, data: { configured: true, enabled: false, endpoint: 'https://typesafe.example/v1', model: 'jev-latest', apiKey: 'tsk-leaked' } };
      }
      return { ok: true, message: 'ok', truncated: false, data: {} };
    }),
    callApiKeys: vi.fn()
  };
  const app = express();
  app.use((request: express.Request, _response, next) => {
    (request as unknown as { auth: Record<string, unknown> }).auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } };
    next();
  });
  app.use('/dashboard', createDashboardRouter(config, runner));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const sessionReq = await new Promise<{ token: string; cookie: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/dashboard/api/v1/session', method: 'GET', headers: { host: 'dashboard.example' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ token: JSON.parse(data).csrfToken, cookie: res.headers['set-cookie']?.[0] ?? '' }));
    });
    req.on('error', reject);
    req.end();
  });

  return new Promise<Reply>((resolve, reject) => {
    const isMutation = !['GET', 'HEAD'].includes(options.method ?? 'GET');
    // DELETE is not chunked by default, so the body needs an explicit length to be framed at all.
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      ...(payload === undefined ? {} : { 'content-length': String(Buffer.byteLength(payload)) }),
      host: 'dashboard.example',
      origin: 'https://dashboard.example',
      cookie: sessionReq.cookie,
      ...(isMutation ? { 'content-type': 'application/json', 'x-csrf-token': sessionReq.token } : {}),
      ...options.headers
    };
    const req = httpRequest({ host: '127.0.0.1', port, path: `/dashboard/api/v1${path}`, method: options.method ?? 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch { /* ignore */ }
        resolve({ status: res.statusCode ?? 500, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('dashboard TypeSafe integration routes', () => {
  it('lists integration credentials as metadata only', async () => {
    const list = await request('/integration-credentials');
    expect(list.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'integration_credential_list', input: {}, principal });
    expect(list.json.data).toEqual({ credentials: [credential] });
    expect(list.text).not.toContain('tsk-leaked');
  });

  it('forwards a new key to the runner and never echoes it back', async () => {
    const created = await request('/integration-credentials', {
      method: 'POST',
      body: { integration: 'typesafe', label: 'TypeSafe', value: 'tsk-secret-value', expectedGeneration: 0 }
    });
    expect(created.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'integration_credential_create', input: { integration: 'typesafe', label: 'TypeSafe', value: 'tsk-secret-value', expectedGeneration: 0 } });
    expect(created.json.data).toEqual(credential);
    expect(created.text).not.toContain('tsk-secret-value');
    expect(created.text).not.toContain('tsk-leaked');
    expect(created.text).not.toContain('ciphertext');
  });

  it('rotates by credential id with the expected generation', async () => {
    const rotated = await request(`/integration-credentials/${credential.id}/rotate`, {
      method: 'PUT',
      body: { value: 'tsk-rotated-value', expectedGeneration: 1 }
    });
    expect(rotated.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'integration_credential_rotate', input: { credentialId: credential.id, value: 'tsk-rotated-value', expectedGeneration: 1 } });
    expect(rotated.text).not.toContain('tsk-rotated-value');
  });

  it('reports a stale generation as a conflict', async () => {
    next = { ok: false, message: 'conflict', truncated: false, error: { code: 'CONFLICT', message: 'integration credential is at generation 2', retryable: false } } as RunnerResponse;
    const rotated = await request(`/integration-credentials/${credential.id}/rotate`, { method: 'PUT', body: { value: 'tsk-value', expectedGeneration: 1 } });
    expect(rotated.status).toBe(409);
    expect(rotated.text).not.toContain('tsk-value');
  });

  it('refuses a malformed credential id before reaching the runner', async () => {
    const rotated = await request('/integration-credentials/cred_12345678901234567890/rotate', { method: 'PUT', body: { value: 'tsk-value', expectedGeneration: 1 } });
    expect(rotated.status).toBe(400);
    const removed = await request('/integration-credentials/not-an-id', { method: 'DELETE', body: { expectedGeneration: 1 } });
    expect(removed.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('deletes only with a positive expected generation', async () => {
    const missing = await request(`/integration-credentials/${credential.id}`, { method: 'DELETE', body: {} });
    expect(missing.status).toBe(400);
    expect(calls).toHaveLength(0);
    const removed = await request(`/integration-credentials/${credential.id}`, { method: 'DELETE', body: { expectedGeneration: 1 } });
    expect(removed.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'integration_credential_delete', input: { credentialId: credential.id, expectedGeneration: 1 } });
    expect(removed.json.data).toEqual({ id: credential.id, deleted: true });
  });

  it('requires the CSRF token for key mutations', async () => {
    const created = await request('/integration-credentials', {
      method: 'POST',
      body: { integration: 'typesafe', label: 'TypeSafe', value: 'tsk-secret-value', expectedGeneration: 0 },
      headers: { 'x-csrf-token': 'wrong-token' }
    });
    expect(created.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('serves TypeSafe status without any credential material', async () => {
    const status = await request('/typesafe/status');
    expect(status.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'typesafe_status', input: {} });
    expect(status.json.data).toEqual({ configured: true, enabled: false, endpoint: 'https://typesafe.example/v1', model: 'jev-latest' });
    expect(status.text).not.toContain('tsk-leaked');
  });
});

describe('TypeSafe settings panel', () => {
  const status = { configured: false, enabled: true, endpoint: 'https://typesafe.example/v1', model: 'jev-latest' };

  it('offers a first save and no removal when no key is stored', () => {
    const panel = renderTypesafeSettings({ status });
    expect(panel).toContain('Not configured');
    expect(panel).toContain('>Save key<');
    expect(panel).not.toContain('id="typesafe-remove"');
    expect(panel).not.toContain('TYPESAFE_EGRESS=off');
    expect(panel).toContain('https://typesafe.example/v1');
    expect(panel).toContain('jev-latest');
  });

  it('offers replacement and removal once a key is stored', () => {
    const panel = renderTypesafeSettings({ status: { ...status, configured: true }, credential });
    expect(panel).toContain('Configured');
    expect(panel).toContain('>Replace key<');
    expect(panel).toContain('id="typesafe-remove"');
  });

  it('says when the operator turned egress off instance-wide', () => {
    const panel = renderTypesafeSettings({ status: { ...status, enabled: false } });
    expect(panel).toContain('<dt>Egress</dt><dd>Off</dd>');
    expect(panel).toContain('TYPESAFE_EGRESS=off');
  });

  it('withholds the key form and escapes the reason when a read failed', () => {
    const panel = renderTypesafeSettings({ status, error: '<img src=x onerror=alert(1)>' });
    expect(panel).not.toContain('id="typesafe-form"');
    expect(panel).not.toContain('<img');
    expect(panel).toContain('&lt;img');
    expect(panel).toContain('id="typesafe-status"');
  });

  it('escapes server-supplied status values', () => {
    const panel = renderTypesafeSettings({ status: { ...status, model: '<b>m</b>' } });
    expect(panel).not.toContain('<b>m</b>');
    expect(panel).toContain('&lt;b&gt;m&lt;/b&gt;');
  });
});
