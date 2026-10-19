import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

const traceId = `trc_${'a'.repeat(26)}`;
const agentId = `agent_${'b'.repeat(24)}`;
const workspaceId = `ws_${'c'.repeat(24)}`;
const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'api-key-audience',
  apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 60_000, maxBodyBytes: 1_048_576,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

const summary = {
  traceId, agentId, workspaceId, generation: 1, runId: null, parentTraceId: null, workflowId: null,
  profileId: 'default', profileRevisionId: null, state: 'COMPLETED', finishReason: 'completed',
  startedAt: '2026-10-19T10:00:00.000Z', endedAt: '2026-10-19T10:00:05.000Z', durationMs: 5_000,
  tokens: { prompt: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: null },
  requests: 1, requestsWithoutUsage: 0, costMicros: 3, costProvenance: 'estimated', coverage: 'full',
  spanCount: 2, truncated: false, reconciliationStatus: 'reconciled', expiresAt: '2026-11-02T10:00:05.000Z'
};
const latency = { samples: 1, p50Ms: 100, p95Ms: 100 };
const listSummary = {
  traces: 1, byState: { COMPLETED: 1 }, tokens: summary.tokens, costMicros: 3, unknownCostTraces: 0, errorTraces: 0,
  partialTraces: 0, unreconciledTraces: 0, modelLatency: latency, ttft: latency, cohorts: [], sampled: false
};
const detail = {
  ...summary,
  reconciliation: {
    status: 'reconciled', reasons: [], toleranceMicros: 1, ledger: { inputTokens: 10, outputTokens: 2, costMicros: 3 },
    spans: { inputTokens: 10, outputTokens: 2, costMicros: 3 }, gateway: null
  },
  modelCalls: 1, toolCalls: 0, errors: 0, modelLatency: latency, ttft: latency
};
const span = {
  spanSeq: 0, spanId: `spn_${'d'.repeat(16)}`, parentSpanId: null, kind: 'agent_run', name: 'agent.run', state: 'OK',
  startedAt: summary.startedAt, endedAt: summary.endedAt, durationMs: 5_000, ttftMs: null,
  tokens: { prompt: null, output: null, cacheRead: null, cacheWrite: null }, costMicros: null, attributes: {}, inputDigest: null, errorClass: null
};

type Call = { operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector };
type Handler = (call: Call) => Promise<RunnerResponse>;
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };

const ok = (data: Record<string, unknown>): RunnerResponse => ({ ok: true, message: 'ok', truncated: false, data });
const failure = (code: string, message = 'raw runner text /var/lib/secret'): RunnerResponse => ({
  ok: false, message, truncated: false, error: { code, message, retryable: false }
} as RunnerResponse);
const defaultHandler: Handler = async ({ operation }) => {
  if (operation === 'agent_traces_list') return ok({ traces: [{ ...summary }], summary: listSummary, nextCursor: null });
  if (operation === 'agent_trace_get') return ok({ trace: detail });
  if (operation === 'agent_trace_spans') return ok({ traceId, spans: [span], nextCursor: null });
  return ok({ traceId, format: 'csv', contentType: 'text/csv', filename: `${traceId}.csv`, content: 'trace_id\r\n', bytes: 10, truncated: false });
};

let server: Server | undefined;
let port = 0;
let calls: Call[] = [];

async function stop(): Promise<void> {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => { current.closeAllConnections(); current.close(() => resolve()); });
}

async function start(handler: Handler = defaultHandler): Promise<void> {
  await stop();
  calls = [];
  const runner: DashboardRunnerClient = {
    call: vi.fn(async (operation, input, selected) => {
      const call = { operation, input, principal: selected };
      calls.push(call);
      return await handler(call);
    })
  };
  const app = express();
  app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
  app.use('/dashboard', createDashboardRouter(config, runner));
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
}

afterEach(stop);

function get(path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: 'GET', headers: { host: 'dashboard.example' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { if (text) json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers as Reply['headers'], text, json });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

describe('dashboard trace routes', () => {
  it('dispatches each route to its trace operation with the session principal', async () => {
    await start();
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['/api/v1/traces', 'agent_traces_list', { limit: 25, includeSummary: true }],
      [`/api/v1/traces?state=FAILED&profileId=fast&agentId=${agentId}&limit=10`, 'agent_traces_list', { state: 'FAILED', profileId: 'fast', agentId, limit: 10, includeSummary: true }],
      ['/api/v1/traces?includeSummary=false', 'agent_traces_list', { limit: 25, includeSummary: false }],
      [`/api/v1/traces/${traceId}`, 'agent_trace_get', { traceId }],
      [`/api/v1/traces/${traceId}/spans?kind=model_call&limit=500`, 'agent_trace_spans', { traceId, kind: 'model_call', limit: 500 }],
      [`/api/v1/traces/${traceId}/export?format=csv`, 'agent_trace_export', { traceId, format: 'csv' }]
    ];
    for (const [path, operation, input] of cases) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers['cache-control'], path).toContain('no-store');
      expect(calls.at(-1), path).toEqual({ operation, input, principal });
    }
  });

  it('projects responses through the strict trace schema and fails closed on extra fields', async () => {
    await start(async ({ operation }) => (operation === 'agent_trace_get'
      ? ok({ trace: { ...detail, ownerId: 'internal-owner', prompt: 'secret prompt' } })
      : ok({ traces: [summary], summary: listSummary, nextCursor: null })));
    const list = await get('/api/v1/traces');
    expect(list.json.data.traces[0]).toEqual(summary);
    const leaked = await get(`/api/v1/traces/${traceId}`);
    expect(leaked.status).toBe(502);
    expect(leaked.text).not.toContain('secret prompt');
    expect(leaked.text).not.toContain('internal-owner');
  });

  it('answers the status route from one summary-free list read', async () => {
    await start(async () => ok({ traces: [], summary: null, nextCursor: null }));
    const enabled = await get('/api/v1/traces/status');
    expect(enabled.status).toBe(200);
    expect(enabled.json).toEqual({ data: { enabled: true } });
    expect(calls).toEqual([{ operation: 'agent_traces_list', input: { limit: 1, includeSummary: false }, principal }]);

    await start(async () => failure('FEATURE_DISABLED'));
    const disabled = await get('/api/v1/traces/status');
    expect(disabled.status).toBe(200);
    expect(disabled.json).toEqual({ data: { enabled: false } });

    await start(async () => failure('UNAVAILABLE'));
    const unavailable = await get('/api/v1/traces/status');
    expect(unavailable.status).toBe(503);
    expect(unavailable.text).not.toContain('/var/lib/secret');
  });

  it('passes a null summary and a null window cost through the strict schema', async () => {
    await start(async () => ok({ traces: [summary], summary: { ...listSummary, costMicros: null, unknownCostTraces: 1 }, nextCursor: null }));
    expect((await get('/api/v1/traces')).json.data.summary.costMicros).toBeNull();
    await start(async () => ok({ traces: [summary], summary: null, nextCursor: null }));
    expect((await get('/api/v1/traces?includeSummary=false')).json.data.summary).toBeNull();
  });

  it('sends exports as attachments with their own media type', async () => {
    await start();
    const response = await get(`/api/v1/traces/${traceId}/export?format=csv`);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${traceId}.csv"`);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.text).toBe('trace_id\r\n');
  });

  it.each([
    ['FEATURE_DISABLED', 409, 'feature_disabled'],
    ['NOT_FOUND', 404, 'not_found'],
    ['TRACE_EXPIRED', 410, 'trace_expired'],
    ['INVALID_INPUT', 400, 'invalid_input'],
    ['INTERNAL_ERROR', 500, 'internal_error']
  ])('maps %s to %i without leaking runner text', async (code, status, error) => {
    await start(async () => failure(code));
    const response = await get(`/api/v1/traces/${traceId}`);
    expect(response.status).toBe(status);
    expect(response.json.error).toBe(error);
    expect(response.text).not.toContain('/var/lib/secret');
  });

  it('refuses malformed identifiers and unknown query parameters before reaching the runner', async () => {
    await start();
    for (const path of [
      '/api/v1/traces/trc_UPPERCASE',
      '/api/v1/traces?ownerId=someone',
      '/api/v1/traces?limit=1000',
      '/api/v1/traces?includeSummary=yes',
      `/api/v1/traces/${traceId}/export?format=html`,
      `/api/v1/traces/${traceId}/spans?principalId=other`
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
    }
    expect(calls).toEqual([]);
  });
});
