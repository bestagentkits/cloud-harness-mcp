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
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'api-key-audience',
  apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
};

type Reply = { status: number; text: string; json: Record<string, unknown> };
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
      if (operation === 'model_credential_list') {
        return { ok: true, message: 'listed', truncated: false, data: { credentials: [{ id: 'cred_12345678901234567890', label: 'OpenAI Prod', provider: 'openai', activeVersion: 1, status: 'ACTIVE' }] } };
      }
      if (operation === 'model_credential_create') {
        return { ok: true, message: 'created', truncated: false, data: { id: 'cred_12345678901234567890', label: 'OpenAI Prod' } };
      }
      if (operation === 'model_profile_list') {
        return { ok: true, message: 'listed', truncated: false, data: { profiles: [{ id: 'coding-fast', displayName: 'Fast Coding', status: 'ACTIVE' }] } };
      }
      if (operation === 'model_config_status') {
        return { ok: true, message: 'status', truncated: false, data: { status: { gatewaySynced: true } } };
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
    const headers: Record<string, string> = {
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
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('Dashboard Models & Credentials Router', () => {
  it('handles GET /provider-credentials, POST /provider-credentials, PUT /rotate', async () => {
    const list = await request('/provider-credentials');
    expect(list.status).toBe(200);
    expect(calls[0]?.operation).toBe('model_credential_list');

    const created = await request('/provider-credentials', {
      method: 'POST',
      body: { label: 'OpenAI Key', provider: 'openai', apiKey: 'sk-secret-123' }
    });
    expect(created.status).toBe(200);
    expect(calls[1]?.operation).toBe('model_credential_create');

    const rotated = await request('/provider-credentials/cred_12345678901234567890/rotate', {
      method: 'PUT',
      body: { apiKey: 'sk-new-123', expectedGeneration: 1 }
    });
    expect(rotated.status).toBe(200);
    expect(calls[2]?.operation).toBe('model_credential_rotate');
  });

  it('handles GET /agent-model-profiles, POST /agent-model-profiles, and status', async () => {
    const list = await request('/agent-model-profiles');
    expect(list.status).toBe(200);
    expect(calls[0]?.operation).toBe('model_profile_list');

    const status = await request('/agent-model-config-status');
    expect(status.status).toBe(200);
    expect(calls[1]?.operation).toBe('model_config_status');
  });
});
