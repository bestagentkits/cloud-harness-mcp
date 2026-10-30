import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentApprovalSummarySchema,
  type AgentApprovalsRunnerRequest,
  type AgentApprovalsRunnerResponse,
  type ApiConfig,
  type RunnerPrincipalSelector,
  type RunnerResponse
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

const approvalId = `apv_${'a'.repeat(32)}`;
const digest = 'b'.repeat(64);
const at = '2026-10-20T00:00:00.000Z';
const summary = AgentApprovalSummarySchema.parse({
  approvalId, workflowId: `wfl_${'c'.repeat(32)}`, actionId: `act_${'d'.repeat(32)}`, step: 'push', state: 'PENDING',
  descriptor: { version: 1, actionClass: 'publish_branch', repository: 'acme/widgets', branch: 'agent/7-abcdef01' },
  descriptorDigest: digest,
  gate: {
    version: 1, decision: 'REQUIRE_APPROVAL', reasonCode: 'MANDATORY_APPROVAL',
    reasons: [{ code: 'MANDATORY_APPROVAL', source: 'global', detail: 'publishing needs approval' }],
    matchedRules: ['global.defaults.publish_branch'], actionClass: 'publish_branch',
    policy: { globalRevisionId: null, globalSource: 'default', projectId: null, projectRevisionId: null, projectSource: 'none' },
    inputFingerprint: digest,
    advisor: { required: false, consulted: false, effect: null, decisionId: null, risk: null, confidence: null, fallbackReason: null, fallback: null, minConfidence: null },
    approval: { ttlSeconds: 3_600, approverRoles: ['owner'] }
  },
  generation: 1, diff: { artifactId: 'art_1', files: 2, additions: 3, deletions: 1 },
  expiresAt: '2026-10-20T01:00:00.000Z', decidedAt: null, decidedBy: null, consumedAt: null, createdAt: at
});
const dataFor: Record<string, unknown> = {
  approvals_list: { enabled: true, approvals: [summary] },
  approval_get: { approval: summary },
  approval_decide: { approval: { ...summary, state: 'APPROVED', decidedAt: at, decidedBy: 'owner' }, workflowState: 'RUNNING' }
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; json: any };
let server: Server;
let port: number;
let requests: AgentApprovalsRunnerRequest[];
let nextReply: ((request: AgentApprovalsRunnerRequest) => AgentApprovalsRunnerResponse) | undefined;

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
    callAgentApprovals: vi.fn(async (request: AgentApprovalsRunnerRequest): Promise<AgentApprovalsRunnerResponse> => {
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

const decide = (headers: Record<string, string>, body: Record<string, unknown> = { decision: 'approve', expectedDigest: digest }, id = approvalId) =>
  send(`/api/v1/agent-approvals/${id}/decision`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('dashboard agent approvals BFF', () => {
  it('maps the read routes to their runner operations with the session principal', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['/api/v1/agent-approvals', 'approvals_list', { limit: 50 }],
      ['/api/v1/agent-approvals?state=PENDING&limit=10', 'approvals_list', { state: 'PENDING', limit: 10 }],
      [`/api/v1/agent-approvals/${approvalId}`, 'approval_get', { approvalId }]
    ];
    for (const [path, operation, input] of cases) {
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(response.json.data, path).toEqual(dataFor[operation]);
      expect(requests.at(-1), path).toEqual({ version: 1, principal, operation, input });
    }
  });

  it('forwards a decision behind CSRF with the reviewed digest and never lets the body choose the principal', async () => {
    const headers = await mutationHeaders();
    const response = await decide(headers);
    expect(response.status).toBe(200);
    expect(response.json.data).toEqual(dataFor.approval_decide);
    expect(requests.at(-1)).toEqual({ version: 1, principal, operation: 'approval_decide', input: { approvalId, decision: 'approve', expectedDigest: digest } });

    const before = requests.length;
    // Fields other than the decision and digest are ignored, so a body cannot pick a principal or another approval.
    await decide(headers, { decision: 'deny', expectedDigest: digest, principal: { kind: 'owner', ownerId: 'x' }, approvalId: `apv_${'f'.repeat(32)}` });
    expect(requests.at(-1)).toEqual({ version: 1, principal, operation: 'approval_decide', input: { approvalId, decision: 'deny', expectedDigest: digest } });
    // A decision without the digest, with an unknown verdict or for a malformed id never reaches the runner.
    expect((await decide(headers, { decision: 'approve' })).status).toBe(400);
    expect((await decide(headers, { decision: 'maybe', expectedDigest: digest })).status).toBe(400);
    expect((await decide(headers, undefined, 'apv_short')).status).toBe(400);
    expect(requests).toHaveLength(before + 1);
  });

  it('refuses a decision without CSRF or Origin before reaching the runner', async () => {
    const headers = await mutationHeaders();
    expect((await decide({ ...headers, 'x-csrf-token': 'wrong' })).status).toBe(403);
    const { origin: _origin, ...withoutOrigin } = headers;
    void _origin;
    expect((await decide(withoutOrigin)).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it('maps typed refusals: wrong principal, double submit, stale and expired', async () => {
    const headers = await mutationHeaders();
    const cases: Array<[string, number]> = [
      ['APPROVAL_FORBIDDEN', 403], ['APPROVAL_NOT_FOUND', 404], ['APPROVAL_ALREADY_DECIDED', 409],
      ['APPROVAL_STALE', 409], ['APPROVAL_EXPIRED', 410], ['FEATURE_DISABLED', 503]
    ];
    for (const [code, status] of cases) {
      nextReply = () => ({ ok: false, error: { code: code as never, message: `refused: ${code}` } });
      const response = await decide(headers);
      expect(response, code).toMatchObject({ status, json: { error: code.toLowerCase(), message: `refused: ${code}` } });
    }
    nextReply = () => ({ ok: false, error: { code: 'INTERNAL', message: 'database path /var/lib/x leaked' } });
    expect(await send('/api/v1/agent-approvals')).toMatchObject({ status: 503, json: { error: 'internal', message: 'Agent approvals are temporarily unavailable.' } });
    nextReply = () => ({ ok: true, data: { approvals: 'nope' } });
    expect((await send('/api/v1/agent-approvals')).status).toBe(503);
  });

  it('accepts one of two concurrent decisions and reports the other as already decided', async () => {
    const headers = await mutationHeaders();
    let decided = false;
    nextReply = (request) => {
      if (request.operation !== 'approval_decide') return { ok: true, data: dataFor[request.operation] };
      if (decided) return { ok: false, error: { code: 'APPROVAL_ALREADY_DECIDED', message: 'The approval was already decided.' } };
      decided = true;
      return { ok: true, data: dataFor.approval_decide };
    };
    const statuses = (await Promise.all([decide(headers), decide(headers)])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('rejects malformed list input locally and answers 503 without approvals support', async () => {
    expect((await send('/api/v1/agent-approvals?limit=1000')).status).toBe(400);
    expect((await send('/api/v1/agent-approvals?state=REVOKED')).status).toBe(400);
    expect((await send('/api/v1/agent-approvals/not-an-id')).status).toBe(400);
    expect(requests).toHaveLength(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen({ call: vi.fn(unused), callInternal: vi.fn(unused) });
    expect((await send('/api/v1/agent-approvals')).status).toBe(503);
  });
});
