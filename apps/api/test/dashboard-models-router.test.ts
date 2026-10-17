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
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

const verificationRef = `vref_${'0'.repeat(32)}`;
const spendPolicyId = `msp_${'p'.repeat(32)}`;

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
      if (operation === 'model_provider_list') {
        return { ok: true, message: 'listed', truncated: false, data: { providers: [{ id: 'google', displayName: 'Google Gemini' }] } };
      }
      if (operation === 'model_profile_create' && input.verificationRef) {
        return { ok: true, message: 'created', truncated: false, data: { id: input.profileId, lastVerification: { outcome: 'verified', checkedAt: 1, revisionId: 'rev_12345678901234567890' } } };
      }
      if (operation === 'model_profile_create') {
        return { ok: false, message: 'refused', truncated: false, error: { code: 'INVALID_INPUT', message: 'Google Gemini does not support the responses API mode; supported: chat-completions', retryable: false } };
      }
      if (operation === 'model_catalog_search') {
        return { ok: true, message: 'searched', truncated: false, data: { entries: [], nextCursor: null, freshness: { state: 'fresh', fetchedAt: 1, sources: [] } } };
      }
      if (operation === 'model_catalog_refresh' && input.provider === 'openai') {
        return { ok: false, message: 'limited', truncated: false, error: { code: 'LIMIT_EXCEEDED', message: 'The model catalog was refreshed recently. Try again in 12 seconds.', retryable: true } };
      }
      if (operation === 'model_connection_verify' && input.credentialId === 'cred_limited_1234567890ab') {
        return { ok: false, message: 'limited', truncated: false, error: { code: 'LIMIT_EXCEEDED', message: 'Connection checks are limited to 6 per minute. Retry in 30 s.', retryable: true } } as RunnerResponse;
      }
      if (operation === 'model_connection_verify') {
        return { ok: true, message: 'checked', truncated: false, data: { outcome: 'verified', checkedAt: 1, elapsedMs: 5, provider: 'openai', model: 'gpt-test', apiMode: 'chat-completions', checks: [], estimatedCostMicros: null, verificationRef } };
      }
      if (operation === 'model_spend_summary') {
        return { ok: true, message: 'summarized', truncated: false, data: { summary: { isEstimate: true, windows: [] }, policies: [] } };
      }
      if (operation === 'model_spend_policy_set' && input.profileId === 'missing') {
        return { ok: false, message: 'missing', truncated: false, error: { code: 'NOT_FOUND', message: 'model profile was not found', retryable: false } };
      }
      if (operation === 'model_spend_policy_set' && input.expectedGeneration === 8) {
        return { ok: false, message: 'gone', truncated: false, error: { code: 'NOT_FOUND', message: 'model spend policy was not found', retryable: false } };
      }
      if (operation === 'model_spend_policy_set' && input.expectedGeneration === 9) {
        return { ok: false, message: 'stale', truncated: false, error: { code: 'CONFLICT', message: 'model spend policy changed; reload it and retry', retryable: false } };
      }
      if (operation === 'model_spend_policy_set') {
        return { ok: true, message: 'saved', truncated: false, data: { id: spendPolicyId, profileId: null, period: input.period, limitMicros: input.limitMicros, warnPercent: 80, generation: 1, createdAt: 1, updatedAt: 1 } };
      }
      if (operation === 'model_spend_policy_delete' && input.expectedGeneration === 9) {
        return { ok: false, message: 'gone', truncated: false, error: { code: 'NOT_FOUND', message: 'model spend policy was not found', retryable: false } };
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
      // Node does not chunk a DELETE body, so its length must be declared for the server to read it.
      ...(options.body ? { 'content-length': String(Buffer.byteLength(JSON.stringify(options.body))) } : {}),
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

  it('lists the provider registry through GET /model-providers', async () => {
    const reply = await request('/model-providers');
    expect(reply.status).toBe(200);
    expect(calls[0]?.operation).toBe('model_provider_list');
    expect(reply.json.data).toEqual({ providers: [{ id: 'google', displayName: 'Google Gemini' }] });
  });

  it('shows the registry refusal naming the supported values when a profile save is rejected', async () => {
    const reply = await request('/agent-model-profiles', {
      method: 'POST',
      body: {
        profileId: 'gemini', displayName: 'Gemini', credentialId: 'cred_12345678901234567890', model: 'gemini-2.5-flash',
        apiMode: 'responses', pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
        limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCostMicros: 1000 }, maxProxyOperations: ['files_read']
      }
    });
    expect(calls[0]?.operation).toBe('model_profile_create');
    expect(reply.status).toBe(400);
    expect(reply.json.message).toBe('Google Gemini does not support the responses API mode; supported: chat-completions');
  });

  it('forwards catalog search query parameters with numbers coerced and refresh bodies', async () => {
    const searched = await request('/model-catalog?provider=anthropic&credentialId=cred_12345678901234567890&q=sonnet&cursor=Y2F0YWxvZzoy&limit=10&capability=tools');
    expect(searched.status).toBe(200);
    expect(searched.json).toMatchObject({ data: { entries: [], nextCursor: null, freshness: { state: 'fresh' } } });
    expect(calls[0]).toMatchObject({
      operation: 'model_catalog_search',
      input: { provider: 'anthropic', credentialId: 'cred_12345678901234567890', query: 'sonnet', cursor: 'Y2F0YWxvZzoy', limit: 10, capability: 'tools' },
      principal
    });

    await request('/model-catalog?provider=openrouter');
    expect(calls[1]?.input).toEqual({ provider: 'openrouter' });

    await request('/model-catalog?provider=openai&provider=google&limit=abc');
    expect(calls[2]?.input).toMatchObject({ provider: null });
    expect(Number.isNaN(calls[2]?.input.limit)).toBe(true);

    const refreshed = await request('/model-catalog/refresh', { method: 'POST', body: { provider: 'anthropic' } });
    expect(refreshed.status).toBe(200);
    expect(calls[3]).toMatchObject({ operation: 'model_catalog_refresh', input: { provider: 'anthropic' } });

    const limited = await request('/model-catalog/refresh', { method: 'POST', body: { provider: 'openai' } });
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ error: 'limit_exceeded', message: 'The model catalog was refreshed recently. Try again in 12 seconds.' });
  });

  it('forwards POST /model-connection/verify to the runner, carries its verification reference to profile saves, and surfaces its rate limit message', async () => {
    const verified = await request('/model-connection/verify', {
      method: 'POST',
      body: { credentialId: 'cred_12345678901234567890', model: 'gpt-test', checks: { tools: true } }
    });
    expect(verified.status).toBe(200);
    expect(calls[0]).toMatchObject({
      operation: 'model_connection_verify',
      input: { credentialId: 'cred_12345678901234567890', model: 'gpt-test', checks: { tools: true } },
      principal
    });
    expect((verified.json.data as Record<string, unknown>).outcome).toBe('verified');
    // The draft check's opaque reference reaches the browser so the next save can name it.
    expect((verified.json.data as Record<string, unknown>).verificationRef).toBe(verificationRef);

    const limited = await request('/model-connection/verify', { method: 'POST', body: { credentialId: 'cred_limited_1234567890ab' } });
    expect(limited.status).toBe(429);
    expect(limited.json.message).toBe('Connection checks are limited to 6 per minute. Retry in 30 s.');

    const created = await request('/agent-model-profiles', { method: 'POST', body: { profileId: 'coding', verificationRef } });
    expect(created.status).toBe(200);
    expect(calls[2]).toMatchObject({ operation: 'model_profile_create', input: { profileId: 'coding', verificationRef } });
    expect((created.json.data as Record<string, unknown>).lastVerification).toEqual({ outcome: 'verified', checkedAt: 1, revisionId: 'rev_12345678901234567890' });
    await request('/agent-model-profiles/coding', { method: 'PATCH', body: { expectedGeneration: 1, verificationRef } });
    expect(calls[3]).toMatchObject({ operation: 'model_profile_update', input: { profileId: 'coding', expectedGeneration: 1, verificationRef } });

    const noCsrf = await request('/model-connection/verify', { method: 'POST', body: { profileId: 'coding' }, headers: { 'x-csrf-token': 'wrong' } });
    expect(noCsrf.status).toBe(403);
    expect(calls).toHaveLength(4);
  });

  it('routes spend summary and policy changes to the runner and passes their refusals through', async () => {
    const summary = await request('/model-spend');
    expect(summary.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'model_spend_summary', input: {}, principal });
    expect(summary.json).toEqual({ data: { summary: { isEstimate: true, windows: [] }, policies: [] }, truncated: false });

    await request('/model-spend/policies');
    expect(calls[1]).toMatchObject({ operation: 'model_spend_policy_list', input: {} });

    const saved = await request('/model-spend/policies', { method: 'PUT', body: { period: 'day', limitMicros: 5_000_000 } });
    expect(saved.status).toBe(200);
    expect(calls[2]).toMatchObject({ operation: 'model_spend_policy_set', input: { period: 'day', limitMicros: 5_000_000 } });
    expect(saved.json.data).toMatchObject({ id: spendPolicyId, generation: 1 });

    const missing = await request('/model-spend/policies', { method: 'PUT', body: { profileId: 'missing', period: 'day', limitMicros: 1 } });
    expect(missing.status).toBe(404);
    // A set refuses both a missing profile and a missing policy as NOT_FOUND, so the runner's wording says which.
    expect(missing.json).toEqual({ error: 'not_found', message: 'model profile was not found' });
    const unknown = await request('/model-spend/policies', { method: 'PUT', body: { policyId: spendPolicyId, period: 'day', limitMicros: 1, expectedGeneration: 8 } });
    expect(unknown.json).toEqual({ error: 'not_found', message: 'model spend policy was not found' });
    const stale = await request('/model-spend/policies', { method: 'PUT', body: { policyId: spendPolicyId, period: 'day', limitMicros: 1, expectedGeneration: 9 } });
    expect(stale.status).toBe(409);
    expect(stale.json.message).toBe('model spend policy changed; reload it and retry');

    const deleted = await request(`/model-spend/policies/${spendPolicyId}`, { method: 'DELETE', body: { expectedGeneration: 2 } });
    expect(deleted.status).toBe(200);
    expect(calls[6]).toMatchObject({ operation: 'model_spend_policy_delete', input: { policyId: spendPolicyId, expectedGeneration: 2 } });
    const gone = await request(`/model-spend/policies/${spendPolicyId}`, { method: 'DELETE', body: { expectedGeneration: 9 } });
    expect(gone.json).toEqual({ error: 'not_found', message: 'Model spend policy not found.' });

    // A delete without a generation never reaches the runner.
    const unguarded = await request(`/model-spend/policies/${spendPolicyId}`, { method: 'DELETE', body: { force: true } });
    expect(unguarded.status).toBe(400);
    const noCsrf = await request('/model-spend/policies', { method: 'PUT', body: { period: 'day', limitMicros: 1 }, headers: { 'x-csrf-token': 'wrong' } });
    expect(noCsrf.status).toBe(403);
    expect(calls).toHaveLength(8);
  });
});
