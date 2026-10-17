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
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

const planId = `pkp_${'a'.repeat(24)}`;
const planDigest = 'b'.repeat(64);
const bindingId = `pkb_${'c'.repeat(24)}`;
const releaseId = `pkr_${'d'.repeat(24)}`;
const runtime = { imageId: 'sha256:executor-image', node: 'v24.11.0', npm: '11.6.0', uv: null, python: null };
/** A plan as a careless runner might send it: fields the browser must never see ride along. */
const runnerPlan = {
  planId, planDigest, status: 'PENDING_APPROVAL', scope: 'owner', ecosystem: 'npm', name: 'chm-hello', version: '1.1.0',
  requestedSpec: '^1.1.0', source: { registry: 'https://registry.npmjs.org/', resolved: 'https://registry.npmjs.org/chm-hello/-/chm-hello-1.1.0.tgz' },
  integrity: 'sha512-abc', dependencyCount: 2, sizeEstimateBytes: 8_192, binaries: ['hello'], lifecycleScripts: true,
  conflicts: [{ binary: 'hello', bindingId, scope: 'owner', workspaceId: null, ecosystem: 'npm', name: 'other', ownerId: 'owner' }],
  runtime, bindingGeneration: 1, stale: false, affectedWorkspaces: ['ws_1234567890abcdefghij'],
  currentRelease: { releaseId, version: '1.0.0', generation: 1 }, createdAt: '2026-10-14T00:00:00.000Z', expiresAt: '2026-10-14T00:30:00.000Z',
  ownerId: 'owner', lockText: '{"lockfileVersion":3}'
};

type Reply = { status: number; text: string; json: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };
let server: Server;
let port: number;
let calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;
let answers: Record<string, RunnerResponse>;

const success = (data: unknown): RunnerResponse => ({ ok: true, message: 'ok', truncated: false, data });

beforeEach(async () => {
  calls = [];
  answers = {
    package_overview: success({
      enabled: true, approvalMode: 'required', ecosystems: ['npm', 'uv'], lifecycleScripts: 'deny',
      quotas: { maxReleaseBytes: 536_870_912, maxOwnerBytes: 4_294_967_296, maxBindings: 32 },
      usage: { ownerBytes: 2_048, bindings: 1 }, ownerId: 'owner',
      bindings: [{
        bindingId, scope: 'owner', ecosystem: 'npm', name: 'chm-hello', generation: 1, affectedWorkspaces: [], ownerId: 'owner',
        release: { releaseId, ecosystem: 'npm', name: 'chm-hello', version: '1.0.0', treeDigest: 'e'.repeat(64), sizeBytes: 2_048, binaries: ['hello'], createdAt: '2026-10-14T00:00:00.000Z', runtime, status: 'VERIFIED', stale: false, relPath: 'releases/abc/pkr' },
        history: [{ generation: 1, releaseId, version: '1.0.0', reason: 'apply', actor: 'mcp', createdAt: '2026-10-14T00:00:00.000Z', available: true, ownerId: 'owner' }]
      }],
      releases: [{ releaseId, ecosystem: 'npm', name: 'chm-hello', version: '1.0.0', treeDigest: 'e'.repeat(64), sizeBytes: 2_048, fileCount: 4, binaries: ['hello'], createdAt: '2026-10-14T00:00:00.000Z', runtime, status: 'VERIFIED', stale: false, relPath: 'releases/abc/pkr', source: runnerPlan.source }],
      inFlight: [], recentApplies: [{ applyId: `pka_${'f'.repeat(24)}`, planId, bindingId, releaseId, state: 'SUCCEEDED', outputTail: 'npm notice', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' }],
      pendingPlans: [runnerPlan]
    }),
    package_plan_list: success({ enabled: true, approvalMode: 'required', plans: [runnerPlan] }),
    package_plan_approve: success({ plan: { ...runnerPlan, status: 'APPROVED', decidedBy: 'dashboard' } }),
    package_plan_reject: success({ plan: { ...runnerPlan, status: 'REJECTED', decidedBy: 'dashboard' } }),
    package_rollback: success({ binding: { bindingId, scope: 'owner', ecosystem: 'npm', name: 'chm-hello', generation: 3, releaseId, ownerId: 'owner' }, replayed: false }),
    package_remove: success({ bindingId, removed: true, releaseIds: [releaseId], collectedReleases: 1, affectedWorkspaces: [], ownerId: 'owner', relPath: 'releases/abc/pkr' })
  };
  const runner: DashboardRunnerClient = {
    call: vi.fn(),
    callInternal: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      return answers[operation] ?? success({});
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

async function csrfHeaders(): Promise<Record<string, string>> {
  const session = await request('/api/v1/session');
  const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
  return { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': String(session.json.csrfToken) };
}

const mutations = () => calls.filter((call) => call.operation !== 'package_overview' && call.operation !== 'package_plan_list');

describe('Dashboard managed package routes', () => {
  it('reads the overview through an allowlist that drops owner, path, image, and output fields', async () => {
    const reply = await request('/api/v1/packages');
    expect(reply.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'package_overview', input: {}, principal });
    expect(reply.json.data).toMatchObject({
      enabled: true, approvalMode: 'required', usage: { ownerBytes: 2_048, bindings: 1 },
      bindings: [{ bindingId, release: { version: '1.0.0', status: 'VERIFIED', runtime: { node: 'v24.11.0' } }, history: [{ releaseId, available: true }] }],
      pendingPlans: [{ planId, planDigest, conflicts: [{ binary: 'hello', name: 'other' }] }]
    });
    for (const leaked of ['ownerId', 'relPath', 'imageId', 'executor-image', 'lockText', 'outputTail', 'npm notice']) expect(reply.text, leaked).not.toContain(leaked);
  });

  it('lists package plans with the digest and facts an operator decides on', async () => {
    const reply = await request('/api/v1/package-plans');
    expect(reply.status).toBe(200);
    expect(calls[0]).toMatchObject({ operation: 'package_plan_list', input: {} });
    expect(reply.json.data).toMatchObject({
      enabled: true,
      plans: [{ planId, planDigest, version: '1.1.0', lifecycleScripts: true, dependencyCount: 2, currentRelease: { version: '1.0.0' }, affectedWorkspaces: ['ws_1234567890abcdefghij'] }]
    });
    expect(reply.text).not.toContain('ownerId');
    expect(reply.text).not.toContain('lockfileVersion');
  });

  it('approves with the shown digest and the session principal', async () => {
    const reply = await request(`/api/v1/package-plans/${planId}/approve`, { method: 'POST', body: { planDigest }, headers: await csrfHeaders() });
    expect(reply.status).toBe(200);
    expect(mutations()).toEqual([{ operation: 'package_plan_approve', input: { planId, planDigest }, principal }]);
    expect(reply.json.data).toMatchObject({ plan: { planId, status: 'APPROVED', decidedBy: 'dashboard' } });
  });

  it('refuses an approval without a CSRF token or from a foreign origin before reaching the runner', async () => {
    const headers = await csrfHeaders();
    const missingToken = await request(`/api/v1/package-plans/${planId}/approve`, {
      method: 'POST', body: { planDigest }, headers: { origin: headers.origin, cookie: headers.cookie }
    });
    expect(missingToken.status).toBe(403);
    const foreignOrigin = await request(`/api/v1/package-plans/${planId}/approve`, {
      method: 'POST', body: { planDigest }, headers: { ...headers, origin: 'https://evil.example' }
    });
    expect(foreignOrigin.status).toBe(403);
    const rollback = await request('/api/v1/packages/rollback', {
      method: 'POST', body: { bindingId, releaseId, expectedGeneration: 1 }, headers: { ...headers, origin: 'https://evil.example' }
    });
    expect(rollback.status).toBe(403);
    const remove = await request('/api/v1/packages/remove', {
      method: 'POST', body: { bindingId, expectedGeneration: 1 }, headers: { origin: headers.origin, cookie: headers.cookie }
    });
    expect(remove.status).toBe(403);
    expect(mutations()).toEqual([]);
  });

  it('refuses a malformed plan id, digest, or extra field before reaching the runner', async () => {
    const headers = await csrfHeaders();
    for (const [path, body] of [
      [`/api/v1/package-plans/${planId}/approve`, {}],
      [`/api/v1/package-plans/${planId}/approve`, { planDigest: 'B'.repeat(64) }],
      [`/api/v1/package-plans/${planId}/approve`, { planDigest, ownerId: 'other' }],
      ['/api/v1/package-plans/not-a-plan/approve', { planDigest }],
      ['/api/v1/package-plans/not-a-plan/reject', { reason: 'x' }],
      ['/api/v1/packages/rollback', { bindingId, releaseId, expectedGeneration: -1 }],
      ['/api/v1/packages/rollback', { bindingId, releaseId: 'pkr_short', expectedGeneration: 1 }],
      ['/api/v1/packages/remove', { bindingId, expectedGeneration: -1 }],
      ['/api/v1/packages/remove', { bindingId, expectedGeneration: 1, releaseId }]
    ] as const) {
      const reply = await request(path, { method: 'POST', body, headers });
      expect(reply.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(mutations()).toEqual([]);
  });

  it('rejects a plan and rolls back with the expected generation', async () => {
    const headers = await csrfHeaders();
    const rejected = await request(`/api/v1/package-plans/${planId}/reject`, { method: 'POST', body: {}, headers });
    expect(rejected.status).toBe(200);
    expect(rejected.json.data).toMatchObject({ plan: { planId, status: 'REJECTED' } });
    const rolled = await request('/api/v1/packages/rollback', { method: 'POST', body: { bindingId, releaseId, expectedGeneration: 2 }, headers });
    expect(rolled.status).toBe(200);
    expect(rolled.json.data).toEqual({ binding: { bindingId, scope: 'owner', ecosystem: 'npm', name: 'chm-hello', generation: 3, releaseId }, replayed: false });
    expect(mutations()).toEqual([
      { operation: 'package_plan_reject', input: { planId }, principal },
      { operation: 'package_rollback', input: { bindingId, releaseId, expectedGeneration: 2 }, principal }
    ]);
  });

  it('maps a changed plan to 409 with the runner refusal and a disabled feature to the operator copy', async () => {
    const headers = await csrfHeaders();
    answers.package_plan_approve = { ok: false, message: 'refused', truncated: false, error: { code: 'STALE_GENERATION', message: 'package plan digest does not match; review the current plan', retryable: false } };
    const stale = await request(`/api/v1/package-plans/${planId}/approve`, { method: 'POST', body: { planDigest }, headers });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: 'stale_generation', message: 'package plan digest does not match; review the current plan' });

    answers.package_rollback = { ok: false, message: 'refused', truncated: false, error: { code: 'FORBIDDEN', message: 'internal detail', retryable: false } };
    const disabled = await request('/api/v1/packages/rollback', { method: 'POST', body: { bindingId, releaseId, expectedGeneration: 1 }, headers });
    expect(disabled.json.message).toBe('Managed packages are off. Operators enable them with PACKAGES_ENABLED=true.');
  });

  it('uninstalls a binding with the expected generation and projects only the public fields', async () => {
    const headers = await csrfHeaders();
    const removed = await request('/api/v1/packages/remove', { method: 'POST', body: { bindingId, expectedGeneration: 1 }, headers });
    expect(removed.status).toBe(200);
    expect(removed.json.data).toEqual({ bindingId, removed: true, releaseIds: [releaseId], collectedReleases: 1, affectedWorkspaces: [] });
    expect(mutations()).toEqual([{ operation: 'package_remove', input: { bindingId, expectedGeneration: 1 }, principal }]);

    answers.package_remove = { ok: false, message: 'refused', truncated: false, error: { code: 'CONFLICT', message: 'an apply for this package and scope is in progress', retryable: true } };
    const busy = await request('/api/v1/packages/remove', { method: 'POST', body: { bindingId, expectedGeneration: 1 }, headers });
    expect(busy.status).toBe(409);
    expect(busy.json.message).toBe('an apply for this package and scope is in progress');
  });
});
