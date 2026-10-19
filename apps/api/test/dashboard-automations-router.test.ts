import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, AutomationsRunnerErrorCode, AutomationsRunnerRequest, AutomationsRunnerResponse, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
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
  apiKeyAuthEnabled: false, automationsEnabled: true
} as ApiConfig;

const connectionId = `whc_${'a'.repeat(32)}`;
const ruleId = `arl_${'b'.repeat(32)}`;
const workflowId = `wfl_${'c'.repeat(32)}`;
const deliveryId = `dlv_${'d'.repeat(32)}`;
const at = '2026-10-17T00:00:00.000Z';
const connection = {
  id: connectionId, provider: 'github', name: 'Main repo', enabled: true, generation: 1,
  webhookPath: `/integrations/webhooks/github/${connectionId}`, secretRotatedAt: at, lastDeliveryAt: null, createdAt: at, updatedAt: at
};
const match = { repository: 'example/project', events: ['issues'], label: 'triage', ignoreBots: true };
const action = {
  profileId: 'coding-fast', instructions: 'Analyse the issue.', proxyOperations: ['files_read'],
  budget: { ttlSeconds: 900, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 2_000_000 },
  publishComment: false, cooldownSeconds: 300, maxConcurrent: 1
};
const rule = { id: ruleId, connectionId, name: 'Triage', enabled: false, generation: 1, match, action, createdAt: at, updatedAt: at };
const workflow = {
  id: workflowId, ruleId, ruleGeneration: 1, connectionId, deliveryId, eventType: 'github.issue.label_added',
  repository: 'example/project', resourceNumber: 7, resourceUrl: 'https://github.com/example/project/issues/7', label: 'triage',
  state: 'RUNNING', workspaceId: null, agentId: null, agentStatus: null, errorCode: null, publishState: 'NONE', usage: null, coding: null,
  createdAt: at, updatedAt: at, terminalAt: null
};
const delivery = {
  id: deliveryId, connectionId, providerDeliveryId: 'gh-1', providerEvent: 'issues', eventType: 'github.issue.label_added',
  repository: 'example/project', resourceNumber: 7, label: 'triage', state: 'PROCESSED', outcome: 'accepted', workflowsCreated: 1, receivedAt: at
};
const secret = 'whsec-canary-secret-value';

const dataFor: Record<string, unknown> = {
  connections_list: { connections: [connection] },
  connection_create: { connection, secret },
  connection_update: { connection },
  connection_rotate_secret: { connection: { ...connection, generation: 2 }, secret },
  connection_delete: { deleted: true },
  rules_list: { rules: [rule] },
  rule_create: { rule },
  rule_update: { rule },
  rule_delete: { deleted: true },
  rule_preview: { matched: true, reason: 'label matched' },
  workflows_list: { workflows: [workflow] },
  workflow_get: { workflow, result: null, transitions: [{ fromState: null, toState: 'QUEUED', actor: 'system', code: null, at }], actions: [] },
  workflow_cancel: { workflow: { ...workflow, state: 'CANCELLED' } },
  deliveries_list: { deliveries: [delivery] }
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; json: any };
let server: Server;
let port: number;
let requests: AutomationsRunnerRequest[];
let nextReply: ((request: AutomationsRunnerRequest) => AutomationsRunnerResponse) | undefined;
let runner: DashboardRunnerClient;

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

beforeEach(async () => {
  requests = [];
  nextReply = undefined;
  const unused = async (): Promise<RunnerResponse> => ({ ok: true, message: 'ok', truncated: false, data: {} });
  runner = {
    call: vi.fn(unused),
    callInternal: vi.fn(unused),
    callAutomations: vi.fn(async (request: AutomationsRunnerRequest): Promise<AutomationsRunnerResponse> => {
      requests.push(request);
      return nextReply ? nextReply(request) : { ok: true, data: dataFor[request.operation] };
    })
  };
  await listen(runner);
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

const ruleInput = { connectionId, name: 'Triage', match: { repository: 'example/project', events: ['issues'], label: 'triage' }, action: { profileId: 'coding-fast', instructions: 'Analyse the issue.' } };
const sample = { event: 'issues', repository: 'example/project', label: 'triage', senderLogin: 'octocat' };

describe('dashboard automations BFF', () => {
  it('maps every read route to its runner operation with parsed filters', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['/api/v1/automations/connections', 'connections_list', {}],
      ['/api/v1/automations/rules', 'rules_list', {}],
      [`/api/v1/automations/rules?connectionId=${connectionId}`, 'rules_list', { connectionId }],
      ['/api/v1/automations/workflows', 'workflows_list', { limit: 50 }],
      [`/api/v1/automations/workflows?ruleId=${ruleId}&state=RUNNING&limit=10`, 'workflows_list', { ruleId, state: 'RUNNING', limit: 10 }],
      [`/api/v1/automations/workflows/${workflowId}`, 'workflow_get', { id: workflowId }],
      ['/api/v1/automations/deliveries?limit=5', 'deliveries_list', { limit: 5 }],
      [`/api/v1/automations/deliveries?connectionId=${connectionId}`, 'deliveries_list', { connectionId, limit: 50 }]
    ];
    for (const [path, operation, input] of cases) {
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(response.json.data, path).toEqual(dataFor[operation]);
      expect(requests.at(-1), path).toEqual({ version: 1, principal, operation, input });
    }
  });

  it('maps every mutation route to its runner operation behind CSRF', async () => {
    const headers = await mutationHeaders();
    const cases: Array<[string, string, string, Record<string, unknown>, Record<string, unknown>]> = [
      ['POST', '/api/v1/automations/connections', 'connection_create', { provider: 'github', name: 'Main repo' }, { provider: 'github', name: 'Main repo' }],
      ['PATCH', `/api/v1/automations/connections/${connectionId}`, 'connection_update', { expectedGeneration: 1, enabled: false }, { id: connectionId, expectedGeneration: 1, enabled: false }],
      ['POST', `/api/v1/automations/connections/${connectionId}/rotate-secret`, 'connection_rotate_secret', { expectedGeneration: 1 }, { id: connectionId, expectedGeneration: 1 }],
      ['DELETE', `/api/v1/automations/connections/${connectionId}`, 'connection_delete', { expectedGeneration: 2 }, { id: connectionId, expectedGeneration: 2 }],
      ['PATCH', `/api/v1/automations/rules/${ruleId}`, 'rule_update', { expectedGeneration: 1, enabled: true }, { id: ruleId, expectedGeneration: 1, enabled: true }],
      ['DELETE', `/api/v1/automations/rules/${ruleId}`, 'rule_delete', { expectedGeneration: 1 }, { id: ruleId, expectedGeneration: 1 }],
      ['POST', `/api/v1/automations/rules/${ruleId}/preview`, 'rule_preview', { sample }, { id: ruleId, sample: { ...sample, senderType: 'User' } }],
      ['POST', `/api/v1/automations/workflows/${workflowId}/cancel`, 'workflow_cancel', { reason: 'not needed' }, { id: workflowId, reason: 'not needed' }]
    ];
    for (const [method, path, operation, body, input] of cases) {
      const response = await send(path, { method, headers, body: JSON.stringify(body) });
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.json.data, `${method} ${path}`).toEqual(dataFor[operation]);
      expect(requests.at(-1), `${method} ${path}`).toEqual({ version: 1, principal, operation, input });
    }

    const created = await send('/api/v1/automations/rules', { method: 'POST', headers, body: JSON.stringify(ruleInput) });
    expect(created.status).toBe(200);
    const forwarded = requests.at(-1)!;
    expect(forwarded.operation).toBe('rule_create');
    // Schema defaults are applied before the runner sees the rule, so the runner receives a complete input.
    expect(forwarded.input).toMatchObject({ connectionId, enabled: false, match: { ignoreBots: true }, action: { publishComment: false, maxConcurrent: 1 } });
  });

  it('returns the signing secret only with no-store caching', async () => {
    const headers = await mutationHeaders();
    const created = await send('/api/v1/automations/connections', { method: 'POST', headers, body: JSON.stringify({ provider: 'github', name: 'Main repo' }) });
    expect(created.status).toBe(200);
    expect(created.json.data.secret).toBe(secret);
    expect(created.headers['cache-control']).toBe('no-store');
    const listed = await send('/api/v1/automations/connections');
    expect(JSON.stringify(listed.json)).not.toContain(secret);
  });

  it('refuses mutations without a valid CSRF token or Origin before reaching the runner', async () => {
    const headers = await mutationHeaders();
    const body = JSON.stringify({ provider: 'github', name: 'Main repo' });
    const wrongToken = await send('/api/v1/automations/connections', { method: 'POST', headers: { ...headers, 'x-csrf-token': 'wrong' }, body });
    expect(wrongToken.status).toBe(403);
    const { origin: _origin, ...withoutOrigin } = headers;
    void _origin;
    const noOrigin = await send(`/api/v1/automations/rules/${ruleId}`, { method: 'DELETE', headers: withoutOrigin, body: JSON.stringify({ expectedGeneration: 1 }) });
    expect(noOrigin.status).toBe(403);
    const notJson = await send('/api/v1/automations/connections', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body });
    expect(notJson.status).toBe(415);
    expect(requests).toHaveLength(0);
  });

  it('rejects invalid requests with 400 without calling the runner', async () => {
    const headers = await mutationHeaders();
    const reads = [
      '/api/v1/automations/workflows/wfl_bad',
      '/api/v1/automations/workflows?limit=abc',
      '/api/v1/automations/workflows?limit=0',
      '/api/v1/automations/workflows?state=PAUSED',
      `/api/v1/automations/rules?connectionId=${connectionId}&connectionId=${connectionId}`,
      '/api/v1/automations/deliveries?limit=500'
    ];
    for (const path of reads) {
      const response = await send(path);
      expect(response.status, path).toBe(400);
      expect(response.json.error, path).toBe('invalid_request');
    }
    const writes: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/api/v1/automations/connections', { provider: 'gitlab', name: 'x' }],
      ['POST', '/api/v1/automations/connections', { provider: 'github', name: 'x', extra: true }],
      ['PATCH', '/api/v1/automations/connections/whc_bad', { expectedGeneration: 1 }],
      ['DELETE', `/api/v1/automations/connections/${connectionId}`, {}],
      ['POST', '/api/v1/automations/rules', { ...ruleInput, match: { ...ruleInput.match, repository: 'bad owner/project' } }],
      ['POST', `/api/v1/automations/rules/${ruleId}/preview`, { sample: { ...sample, event: 'push' } }],
      ['POST', `/api/v1/automations/workflows/${workflowId}/cancel`, { reason: 'x'.repeat(501) }]
    ];
    for (const [method, path, body] of writes) {
      const response = await send(path, { method, headers, body: JSON.stringify(body) });
      expect(response.status, `${method} ${path}`).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it('maps runner error codes to HTTP statuses and only passes safe messages through', async () => {
    const cases: Array<[AutomationsRunnerErrorCode, string, number, string]> = [
      ['NOT_FOUND', 'Workflow not found.', 404, 'Workflow not found.'],
      ['INVALID_INPUT', 'Rule references a disabled connection.', 400, 'Rule references a disabled connection.'],
      ['CONFLICT', 'The rule changed.', 409, 'The rule changed.'],
      ['RESOURCE_EXHAUSTED', 'At most 100 rules.', 429, 'At most 100 rules.'],
      ['UNAUTHORIZED', 'principal mismatch for owner-1', 403, 'You cannot manage this automation.'],
      ['UNAVAILABLE', 'Automations are disabled on this instance.', 503, 'Automations are disabled on this instance.'],
      ['UNAVAILABLE', 'Runner is unavailable', 503, 'Automations are temporarily unavailable.'],
      ['INTERNAL', 'SQLITE_BUSY at /var/lib/cloud-harness/state', 503, 'Automations are temporarily unavailable.']
    ];
    for (const [code, message, status, expected] of cases) {
      nextReply = () => ({ ok: false, error: { code, message } });
      const response = await send(`/api/v1/automations/workflows/${workflowId}`);
      expect(response.status, `${code} ${message}`).toBe(status);
      expect(response.json, `${code} ${message}`).toEqual({ error: code.toLowerCase(), message: expected });
    }
  });

  it('answers 503 when the runner returns data outside the contract', async () => {
    nextReply = () => ({ ok: true, data: { connections: [{ ...connection, internalPath: '/var/lib/cloud-harness' }] } });
    const response = await send('/api/v1/automations/connections');
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.json)).not.toContain('/var/lib');
  });

  it('answers 503 when the runner client has no automation channel', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { callAutomations: _callAutomations, ...withoutAutomations } = runner;
    void _callAutomations;
    await listen(withoutAutomations);
    const response = await send('/api/v1/automations/connections');
    expect(response.status).toBe(503);
    expect(response.json.error).toBe('unavailable');
  });
});
