import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  DEFAULT_POLICY_ADVISOR,
  type AgentPoliciesRunnerRequest,
  type AgentPoliciesRunnerResponse,
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

const projectId = `prj_${'p'.repeat(32)}`;
const revisionId = `apr_${'1'.repeat(32)}`;
const otherRevisionId = `apr_${'2'.repeat(32)}`;
const at = '2026-10-19T00:00:00.000Z';
const revision = {
  revisionId, scope: 'global', projectId: null, version: 1, digest: 'a'.repeat(64), createdAt: at,
  createdBy: 'owner', rollbackOf: null, note: null, document: DEFAULT_GLOBAL_EXECUTION_POLICY
};
const effective = {
  hardDeny: [], mandatoryApproval: [], allowedActionClasses: ['read'],
  effects: [{ actionClass: 'read', effect: 'allow', source: 'global', delegable: false, mandatoryApproval: false }],
  scope: DEFAULT_GLOBAL_EXECUTION_POLICY.scope, budget: DEFAULT_GLOBAL_EXECUTION_POLICY.budget,
  approval: DEFAULT_GLOBAL_EXECUTION_POLICY.approval, advisor: DEFAULT_POLICY_ADVISOR, ignoredProjectFields: []
};
const decision = {
  version: 1, decision: 'DENY', reasonCode: 'ACTION_CLASS_NOT_ALLOWED',
  reasons: [{ code: 'ACTION_CLASS_NOT_ALLOWED', source: 'default', detail: 'the global policy does not allow edit' }],
  matchedRules: ['global.allowedActionClasses'], actionClass: 'edit',
  policy: { globalRevisionId: null, globalSource: 'default', projectId: null, projectRevisionId: null, projectSource: 'none' },
  inputFingerprint: 'b'.repeat(64),
  advisor: { required: false, consulted: false, effect: null, decisionId: null, risk: null, confidence: null, fallbackReason: null, fallback: null, minConfidence: null },
  approval: { ttlSeconds: 3_600, approverRoles: ['owner'] }
};
const dataFor: Record<string, unknown> = {
  policy_overview: { global: null, projects: [], projectsTruncated: false, defaultGlobal: DEFAULT_GLOBAL_EXECUTION_POLICY },
  policy_get: { scope: 'global', projectId: null, projectState: null, head: null, global: { revision: null, document: DEFAULT_GLOBAL_EXECUTION_POLICY, source: 'default' }, effective },
  policy_validate: { valid: true, errors: [], widenings: [], weakenings: [], changes: [], effective, weakeningDigest: null },
  policy_put: { head: revision, weakenings: [] },
  policy_delete: { deleted: true },
  policy_history: { revisions: [], headRevisionId: null, nextBeforeVersion: null },
  policy_revision_get: { revision },
  policy_diff: { changes: [{ path: 'allowedActionClasses', before: '["read"]', after: '["read","edit"]' }] },
  policy_rollback: { head: revision, weakenings: [] },
  policy_simulate: { decision, effective }
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; json: any };
let server: Server;
let port: number;
let requests: AgentPoliciesRunnerRequest[];
let nextReply: ((request: AgentPoliciesRunnerRequest) => AgentPoliciesRunnerResponse) | undefined;

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
  await listen({
    call: vi.fn(unused),
    callInternal: vi.fn(unused),
    callAgentPolicies: vi.fn(async (request: AgentPoliciesRunnerRequest): Promise<AgentPoliciesRunnerResponse> => {
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

const projectDocument = { version: 1, hardDeny: ['edit'] };
const simulateBody = { projectId, action: { version: 1, actionClass: 'edit', repository: 'acme/widgets', paths: ['src/a.ts'] } };

describe('dashboard agent policy BFF', () => {
  it('maps every read route to its runner operation, with the session principal', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['/api/v1/agent-policies', 'policy_overview', {}],
      ['/api/v1/agent-policies/global', 'policy_get', { scope: 'global' }],
      ['/api/v1/agent-policies/global/history', 'policy_history', { scope: 'global', limit: 20 }],
      ['/api/v1/agent-policies/global/history?beforeVersion=7&limit=5', 'policy_history', { scope: 'global', beforeVersion: 7, limit: 5 }],
      [`/api/v1/agent-policies/projects/${projectId}`, 'policy_get', { scope: 'project', projectId }],
      [`/api/v1/agent-policies/projects/${projectId}/history`, 'policy_history', { scope: 'project', projectId, limit: 20 }],
      [`/api/v1/agent-policies/revisions/${revisionId}`, 'policy_revision_get', { revisionId }],
      [`/api/v1/agent-policies/diff?from=${revisionId}&to=${otherRevisionId}`, 'policy_diff', { fromRevisionId: revisionId, toRevisionId: otherRevisionId }]
    ];
    for (const [path, operation, input] of cases) {
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(response.json.data, path).toEqual(dataFor[operation]);
      expect(requests.at(-1), path).toEqual({ version: 1, principal, operation, input });
    }
  });

  it('maps every mutation route behind CSRF, with scope and project taken from the path', async () => {
    const headers = await mutationHeaders();
    const cases: Array<[string, string, string, Record<string, unknown>, Record<string, unknown>]> = [
      ['PUT', '/api/v1/agent-policies/global', 'policy_put', { document: DEFAULT_GLOBAL_EXECUTION_POLICY, expectedVersion: 0 }, { scope: 'global', document: DEFAULT_GLOBAL_EXECUTION_POLICY, expectedVersion: 0, confirmWeakening: false }],
      ['POST', '/api/v1/agent-policies/global/validate', 'policy_validate', { document: DEFAULT_GLOBAL_EXECUTION_POLICY }, { scope: 'global', document: DEFAULT_GLOBAL_EXECUTION_POLICY, intent: 'save' }],
      ['PUT', `/api/v1/agent-policies/projects/${projectId}`, 'policy_put', { document: projectDocument, expectedVersion: 2, confirmWeakening: true, note: 'narrow' }, { scope: 'project', projectId, document: projectDocument, expectedVersion: 2, confirmWeakening: true, note: 'narrow' }],
      ['POST', `/api/v1/agent-policies/projects/${projectId}/validate`, 'policy_validate', { document: projectDocument, intent: 'delete' }, { scope: 'project', projectId, document: projectDocument, intent: 'delete' }],
      ['DELETE', `/api/v1/agent-policies/projects/${projectId}`, 'policy_delete', { expectedVersion: 3 }, { projectId, expectedVersion: 3, confirmWeakening: false }],
      ['POST', `/api/v1/agent-policies/revisions/${revisionId}/rollback`, 'policy_rollback', { expectedVersion: 4, confirmWeakening: true }, { revisionId, expectedVersion: 4, confirmWeakening: true }],
      ['POST', '/api/v1/agent-policies/simulate', 'policy_simulate', simulateBody, { ...simulateBody, action: { ...simulateBody.action, platformEffects: [] } }]
    ];
    for (const [method, path, operation, body, input] of cases) {
      const response = await send(path, { method, headers, body: JSON.stringify(body) });
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.json.data, `${method} ${path}`).toEqual(dataFor[operation]);
      expect(requests.at(-1), `${method} ${path}`).toEqual({ version: 1, principal, operation, input });
    }
  });

  it('refuses mutations without a valid CSRF token or Origin before reaching the runner', async () => {
    const headers = await mutationHeaders();
    const body = JSON.stringify({ document: DEFAULT_GLOBAL_EXECUTION_POLICY, expectedVersion: 0 });
    expect((await send('/api/v1/agent-policies/global', { method: 'PUT', headers: { ...headers, 'x-csrf-token': 'wrong' }, body })).status).toBe(403);
    const { origin: _origin, ...withoutOrigin } = headers;
    void _origin;
    expect((await send('/api/v1/agent-policies/simulate', { method: 'POST', headers: withoutOrigin, body: JSON.stringify(simulateBody) })).status).toBe(403);
    expect((await send(`/api/v1/agent-policies/projects/${projectId}`, { method: 'DELETE', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ expectedVersion: 1 }) })).status).toBe(403);
    expect((await send('/api/v1/agent-policies/global', { method: 'PUT', headers: { ...headers, 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect(requests).toHaveLength(0);
  });

  it('never lets the body choose the principal, scope or project', async () => {
    const headers = await mutationHeaders();
    const intruder = { kind: 'owner', ownerId: 'intruder' };
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ['PUT', '/api/v1/agent-policies/global', { document: DEFAULT_GLOBAL_EXECUTION_POLICY, expectedVersion: 0, principal: intruder }],
      ['PUT', '/api/v1/agent-policies/global', { document: DEFAULT_GLOBAL_EXECUTION_POLICY, expectedVersion: 0, projectId }],
      ['POST', '/api/v1/agent-policies/simulate', { ...simulateBody, principal: intruder }],
      ['POST', '/api/v1/agent-policies/simulate', { ...simulateBody, action: { ...simulateBody.action, projectId, principalId: 'intruder' } }]
    ];
    for (const [method, path, body] of attempts) {
      const response = await send(path, { method, headers, body: JSON.stringify(body) });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // A body scope is overwritten by the path, never trusted.
    const scoped = await send(`/api/v1/agent-policies/projects/${projectId}`, { method: 'PUT', headers, body: JSON.stringify({ document: projectDocument, expectedVersion: 0, scope: 'global' }) });
    expect(scoped.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ principal, input: { scope: 'project', projectId } });
    // A body id that repeats the path id is accepted; a different one is refused before the runner.
    const repeated = await send(`/api/v1/agent-policies/revisions/${revisionId}/rollback`, { method: 'POST', headers, body: JSON.stringify({ revisionId, expectedVersion: 4 }) });
    expect(repeated.status).toBe(200);
    expect(requests[1]).toMatchObject({ operation: 'policy_rollback', input: { revisionId, expectedVersion: 4 } });
    const redirected = await send(`/api/v1/agent-policies/projects/${projectId}`, { method: 'PUT', headers, body: JSON.stringify({ document: projectDocument, expectedVersion: 0, projectId: `prj_${'q'.repeat(32)}` }) });
    expect(redirected.status).toBe(400);
    expect(redirected.json).toEqual({ error: 'path_id_mismatch', message: 'The request body names a different projectId than the URL.' });
    expect(requests).toHaveLength(2);
  });

  it('rejects malformed identifiers and queries before reaching the runner', async () => {
    for (const path of [
      '/api/v1/agent-policies/projects/not-a-project',
      '/api/v1/agent-policies/revisions/apr_123',
      `/api/v1/agent-policies/diff?from=${revisionId}`,
      `/api/v1/agent-policies/diff?from=${revisionId}&from=${otherRevisionId}&to=${otherRevisionId}`,
      '/api/v1/agent-policies/global/history?limit=1000'
    ]) {
      expect((await send(path)).status, path).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it('maps runner errors to HTTP statuses and keeps the details the editor shows', async () => {
    const headers = await mutationHeaders();
    const body = JSON.stringify({ document: projectDocument, expectedVersion: 1 });
    const cases: Array<[AgentPoliciesRunnerResponse, number, string]> = [
      [{ ok: false, error: { code: 'CONFLICT', message: 'the policy changed; reload and retry' } }, 409, 'conflict'],
      [{ ok: false, error: { code: 'POLICY_WIDENS', message: 'a project policy can only narrow the global policy', details: ['scope.pathScopes: docs/ is outside the global scope'] } }, 422, 'policy_widens'],
      [{ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'confirm', details: ['allows edit'] } }, 428, 'confirmation_required'],
      [{ ok: false, error: { code: 'NOT_FOUND', message: 'project not found' } }, 404, 'not_found'],
      [{ ok: false, error: { code: 'INVALID_INPUT', message: 'the policy document is invalid', details: ['budget: too big'] } }, 400, 'invalid_input'],
      [{ ok: false, error: { code: 'FEATURE_DISABLED', message: 'agent policies are disabled on this instance' } }, 503, 'feature_disabled']
    ];
    for (const [reply, status, error] of cases) {
      nextReply = () => reply;
      const response = await send(`/api/v1/agent-policies/projects/${projectId}`, { method: 'PUT', headers, body });
      expect(response.status, error).toBe(status);
      expect(response.json.error).toBe(error);
      if (!reply.ok) {
        expect(response.json.message).toBe(reply.error.message);
        expect(response.json.details).toEqual(reply.error.details);
      }
    }
    nextReply = () => ({ ok: false, error: { code: 'INTERNAL', message: 'stack trace with /var/lib/secret' } });
    const internal = await send('/api/v1/agent-policies');
    expect(internal.status).toBe(503);
    expect(JSON.stringify(internal.json)).not.toContain('/var/lib');
    nextReply = () => ({ ok: true, data: { unexpected: true } });
    expect((await send('/api/v1/agent-policies')).status).toBe(503);
  });

  it('answers 503 when the runner client has no agent policy channel', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const unused = async (): Promise<RunnerResponse> => ({ ok: true, message: 'ok', truncated: false, data: {} });
    await listen({ call: vi.fn(unused), callInternal: vi.fn(unused) });
    const response = await send('/api/v1/agent-policies');
    expect(response.status).toBe(503);
    expect(response.json.error).toBe('unavailable');
  });
});
