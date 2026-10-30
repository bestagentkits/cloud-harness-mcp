import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { mapDashboardData, type DashboardResponseOperation } from '../src/dashboard-response.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { DashboardRequest, DashboardRunnerClient } from '../src/dashboard-types.js';
import { renderSettings } from '../dashboard/dashboard-render.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
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

const STALE_LIFECYCLE_REVISION = 99;
const RUNNER_LIFECYCLE = { maxActiveWorkspacesPerOwner: 3, idleTtlSeconds: 300, wallTtlSeconds: 900, recoverableGraceSeconds: 3_600 } as const;
const LIFECYCLE_BOUNDS = {
  maxActiveWorkspacesPerOwner: { min: 1, max: 64 }, idleTtlSeconds: { min: 60, max: 43_200 },
  wallTtlSeconds: { min: 60, max: 86_400 }, recoverableGraceSeconds: { min: 0, max: 86_400 }
} as const;

/** The runner read-back after an optional lifecycle write: a number is an override, `null` restores the runner value. */
function lifecycleView(update?: Record<string, number | null | true>) {
  const settings = Object.fromEntries((Object.keys(RUNNER_LIFECYCLE) as Array<keyof typeof RUNNER_LIFECYCLE>).map((name) => {
    const override = update?.[name];
    return [name, {
      value: typeof override === 'number' ? override : RUNNER_LIFECYCLE[name],
      source: typeof override === 'number' ? 'setting' : name === 'idleTtlSeconds' ? 'environment' : 'default',
      runnerValue: RUNNER_LIFECYCLE[name], ...LIFECYCLE_BOUNDS[name]
    }];
  }));
  return {
    revision: update ? Number(update.expectedRevision) + 1 : 4,
    updatedAt: update ? '2026-10-15T00:00:00.000Z' : null,
    settings, reaperIntervalSeconds: 60,
    usage: { counted: 2, limit: settings.maxActiveWorkspacesPerOwner.value, recoverable: 1, autoCloseDeferred: 1 },
    executorCeilings: { memoryBytes: 1_073_741_824, cpus: 1, pids: 256 }
  };
}

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
        workspaceId, repositoryUrl: 'https://github.com/example/project.git', ref: null, status: 'ACTIVE', networkProfile: 'network-none',
        createdAt: '2026-08-17T00:00:00.000Z', lastActivityAt: '2026-08-17T00:01:00.000Z', expiresAt: '2026-08-17T00:10:00.000Z',
        generation: 7, ownerId: 'internal-owner', workspacePath: '/host/jobs/private', containerName: 'executor-secret'
      }] } };
      if (operation === 'workspace_context') return { ok: true, message: 'context', truncated: false, data: {
        workspaceId, repositoryUrl: 'https://github.com/example/project.git', ref: 'main', status: 'ACTIVE',
        networkProfile: 'dependency-access', createdAt: '2026-08-17T00:00:00.000Z', lastActivityAt: '2026-08-17T00:01:00.000Z',
        expiresAt: '2026-08-17T00:10:00.000Z', generation: 7, branch: 'feature/x',
        gitIdentity: { name: 'Operator', email: 'owner@example.com' },
        capabilities: { tasks: true, sessions: false, label: 'not-a-boolean' },
        ownerId: 'internal-owner', workspacePath: '/host/jobs/private', containerName: 'executor-secret',
        manifest: { truncated: true, truncationReasons: ['max_bytes', 42], items: [{ path: '/host/jobs/private/secret.env', content: 'SECRET=1' }] }
      } };
      if (operation === 'workspace_finalize') return { ok: true, message: 'finalized', truncated: false, data: {
        branch: 'feature/x', commitSha: 'a'.repeat(40), committed: true, pushed: true, filesChanged: 3,
        remote: 'https://github.com/example/project.git', workspacePath: '/host/jobs/private', ownerId: 'internal-owner'
      } };
      if (operation === 'agent_list') return { ok: true, message: 'agents', truncated: false, data: { agents: [
        {
          agentId: `agent_${'g'.repeat(24)}`, workspaceId, parentAgentId: null, profileId: 'coding-fast', status: 'RUNNING', generation: 3,
          createdAt: '2026-08-17T00:00:00.000Z', startedAt: '2026-08-17T00:00:10.000Z', terminalAt: null, expiresAt: '2026-08-17T01:00:00.000Z',
          budget: { ttlSeconds: 3_600, maxOutputBytes: 1_048_576, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 5_000_000 },
          usage: { inputTokens: 1_000, outputTokens: 500, costMicros: 250_000, outputBytes: 2_048, eventCount: 12, toolTimeMs: 900, wallTimeMs: 5_000 },
          terminalReason: null, outcomeUnknown: false, proxyOperations: ['files_read'],
          ownerId: 'internal-owner', containerName: 'executor-secret', workspacePath: '/host/jobs/private', prompt: 'do the thing'
        }
      ] } };
      if (operation === 'agent_logs') return { ok: true, message: 'logs', truncated: false, data: {
        agentId: `agent_${'g'.repeat(24)}`, cursor: '0', nextCursor: '1', retainedBaseCursor: '0', truncated: false, hasMore: false,
        events: [{ cursor: '0', nextCursor: '1', timestamp: '2026-08-17T00:00:30.000Z', type: 'tool.call', content: `hello ${'x'.repeat(5_000)}` }]
      } };
      if (operation === 'files_read') return { ok: true, message: 'read', truncated: true, data: {
        path: input.path, content: 'x'.repeat(65_536), sha256: 'c'.repeat(64), bytesReturned: 65_536, totalBytes: 100_000, eof: false
      } };
      if (operation === 'files_write') return { ok: true, message: 'written', truncated: false, data: { path: input.path, sha256: 'b'.repeat(64) } };
      return { ok: true, message: 'ok', truncated: false, data: {} };
    }),
    callInternal: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      if (operation === 'settings_get' || operation === 'settings_update') {
        const chosen = input.defaultNetworkProfile as string | null | undefined;
        const lifecycle = input.workspaceLifecycle as Record<string, number | null | true> | undefined;
        if (lifecycle?.expectedRevision === STALE_LIFECYCLE_REVISION) {
          return { ok: false, message: 'conflict', truncated: false, error: { code: 'CONFLICT', message: 'The workspace lifecycle settings changed.', retryable: false } };
        }
        return { ok: true, message: 'Instance workspace settings', truncated: false, data: { defaultNetworkProfile: {
          value: chosen ?? 'dependency-access',
          source: chosen === undefined || chosen === null ? 'environment' : 'setting'
        }, workspaceLifecycle: lifecycleView(lifecycle) } };
      }
      if (operation === 'skill_import_status' || operation === 'skill_import_cancel') {
        // The runner's job view: the job sits at generation 2 (running), so only a cancel fenced on 2 lands.
        if (operation === 'skill_import_cancel' && input.expectedGeneration !== 2) {
          return { ok: false, message: 'conflict', truncated: false, error: { code: 'CONFLICT', message: 'Import job is at generation 2, not 1', retryable: false } };
        }
        return { ok: true, message: 'job', truncated: false, data: {
          id: input.jobId, sourceKind: 'skillx', sourceRef: 'pdf', state: operation === 'skill_import_cancel' ? 'cancelled' : 'running',
          generation: operation === 'skill_import_cancel' ? 3 : 2, progress: { phase: 'acquiring' }, result: null, errorCode: null,
          skillRevisionId: null, createdAt: 1, updatedAt: 2, ownerId: 'internal-owner', progressJson: '{"phase":"acquiring"}'
        } };
      }
      if (operation === 'settings_network_check') return { ok: true, message: 'Dependency egress readiness', truncated: false, data: { ready: true, reason: null } };
      if (operation === 'oauth_settings_get' || operation === 'oauth_settings_update') {
        if ((input.grant as { seconds?: number } | undefined)?.seconds === 86_400) {
          return { ok: false, message: 'conflict', truncated: false, error: { code: 'CONFLICT', message: 'The Cloudflare OAuth configuration changed since this page loaded. Reload to see the current values.', retryable: false } };
        }
        return { ok: true, message: 'Inbound OAuth session settings', truncated: false, data: { provider: { id: 'cloudflare-access', label: 'Cloudflare Access Managed OAuth' }, revision: 'b'.repeat(64) } };
      }
      return { ok: true, message: 'detail', truncated: false, data: {
        workspaceId, repositoryUrl: 'https://github.com/example/project.git', status: 'ACTIVE', networkProfile: 'network-none', generation: 7,
        createdAt: '2026-08-17T00:00:00.000Z', lastActivityAt: '2026-08-17T00:01:00.000Z', expiresAt: '2026-08-17T00:10:00.000Z'
      } };
    }),
    callApiKeys: vi.fn(async (operation) => {
      const key = { id: `apk_${'k'.repeat(24)}`, name: 'CLI', displayPrefix: 'chm_key_apk_kkkk…', state: 'ACTIVE' as const, generation: 1, createdAt: 1, expiresAt: 2, lastUsedAt: null, revokedAt: null };
      if (operation === 'api_key_list') return { ok: true as const, operation, data: { keys: [key] }, truncated: false as const };
      if (operation === 'api_key_create') return { ok: true as const, operation, data: { key, apiKey: `chm_key_apk_${'k'.repeat(24)}.${'s'.repeat(43)}` }, truncated: false as const };
      return { ok: true as const, operation, data: { key: { ...key, state: 'REVOKED' as const, generation: 2, revokedAt: 2 } }, truncated: false as const };
    }),
    callEvents: vi.fn(async (request) => {
      if (request.operation === 'events_subscriptions_list') return { ok: true as const, data: { subscriptions: [{
        id: `sub_${'e'.repeat(32)}`, name: 'cloudharness.task.completed' as const, arguments: { workspaceId }, callbackOrigin: 'https://hooks.example',
        viaApiKey: false, state: 'ACTIVE' as const, createdAt: '2026-08-17T00:00:00.000Z', refreshBefore: '2026-08-18T00:00:00.000Z',
        deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null }, recentDeliveries: []
      }], truncated: false } };
      return { ok: true as const, data: { revoked: true } };
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
        let json: any = undefined;
        try { if (text) json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers as Reply['headers'], text, json });
      });
    });
    request.on('error', reject); request.end(options.body);
  });
}

describe('dashboard BFF', () => {
  it('dispatches every read-only skills endpoint to its operation', async () => {
    const skillId = `sk_${'b'.repeat(24)}`;
    const skillSetId = `skset_${'c'.repeat(24)}`;
    const jobId = `skjob_${'d'.repeat(24)}`;
    const revisionId = `skrev_${'g'.repeat(24)}`;
    const expectations: Array<[string, string]> = [
      ['/api/v1/skills', 'skill_list'],
      [`/api/v1/skills/${skillId}`, 'skill_get'],
      [`/api/v1/skills/${skillId}/revisions`, 'skill_revision_list'],
      [`/api/v1/skills/${skillId}/revisions/${revisionId}`, 'skill_revision_get'],
      [`/api/v1/skills/${skillId}/usage`, 'skill_usage'],
      ['/api/v1/skill-sets', 'skill_set_list'],
      [`/api/v1/skill-sets/${skillSetId}`, 'skill_set_get'],
      [`/api/v1/skill-imports/${jobId}`, 'skill_import_status'],
      ['/api/v1/toolkit-registry', 'toolkit_registry_list']
    ];

    for (const [path, operation] of expectations) {
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(calls.at(-1)?.operation, path).toBe(operation);
    }
    // The route forwards only the identifier it parsed; the operation schema applies `limit` and the
    // list filters when the runner parses the request, so the route cannot disagree with the contract.
    expect(calls.findLast((call) => call.operation === 'skill_revision_list')?.input).toEqual({ skillId });
  });

  it('reaches the skills search route instead of treating search as an identifier', async () => {
    const response = await send('/api/v1/skills/search?query=tdd&providers=local');
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.operation).toBe('skill_search');
    expect(calls.at(-1)?.input).toMatchObject({ query: 'tdd' });
  });

  it('dispatches the skills mutation endpoints to their operations', async () => {
    const skillId = `sk_${'e'.repeat(24)}`;
    const skillSetId = `skset_${'f'.repeat(24)}`;
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const cases: Array<[string, string, string, Record<string, unknown>]> = [
      [`/api/v1/skills/${skillId}`, 'skill_update', 'PATCH', { displayName: 'Renamed', expectedGeneration: 2 }],
      [`/api/v1/skills/${skillId}/archive`, 'skill_archive', 'POST', { expectedGeneration: 2 }],
      ['/api/v1/skill-sets', 'skill_set_create', 'POST', { name: 'core' }],
      ['/api/v1/skills', 'skill_create_custom', 'POST', { slug: 'custom', displayName: 'Custom' }],
      [`/api/v1/skill-sets/${skillSetId}`, 'skill_set_update', 'PATCH', { name: 'core', expectedGeneration: 2 }],
      ['/api/v1/skill-sets/preview', 'skill_set_preview', 'POST', { skillSets: [{ skillSetId, expectedGeneration: 2 }] }],
      [`/api/v1/skill-sets/${skillSetId}`, 'skill_set_delete', 'DELETE', { expectedGeneration: 2 }]
    ];

    for (const [path, operation, method, payload] of cases) {
      const body = JSON.stringify(payload);
      const response = await send(path, { method, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, body });
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(calls.at(-1)?.operation, `${method} ${path}`).toBe(operation);
    }

    // The route forwards the identifier it owns together with the validated generation, so a stale
    // edit reaches the store as a generation conflict rather than an unguarded write.
    expect(calls.findLast((call) => call.operation === 'skill_set_delete')?.input).toEqual({ skillSetId, expectedGeneration: 2 });
  });

  it('projects the skill import generation and refuses a cancel fenced on a stale one', async () => {
    const jobId = `skjob_${'d'.repeat(24)}`;
    const read = await send(`/api/v1/skill-imports/${jobId}`);
    expect(read.status).toBe(200);
    expect(read.json.data).toEqual({
      id: jobId, sourceKind: 'skillx', sourceRef: 'pdf', state: 'running', generation: 2, progress: { phase: 'acquiring' },
      result: null, errorCode: null, skillRevisionId: null, createdAt: 1, updatedAt: 2
    });

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const stale = await send(`/api/v1/skill-imports/${jobId}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expectedGeneration: 1 }) });
    expect(stale.status).toBe(409);
    expect(stale.json.message).toMatch(/changed or already finished/);
    expect(calls.at(-1)).toMatchObject({ operation: 'skill_import_cancel', input: { jobId, expectedGeneration: 1 } });

    // The path names the job, so a body field naming another job is refused, not followed.
    const otherJob = `skjob_${'e'.repeat(24)}`;
    const callsBefore = calls.length;
    const redirected = await send(`/api/v1/skill-imports/${jobId}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expectedGeneration: read.json.data.generation, jobId: otherJob }) });
    expect(redirected.status).toBe(400);
    expect(redirected.json.error).toBe('path_id_mismatch');
    expect(calls).toHaveLength(callsBefore);
    const current = await send(`/api/v1/skill-imports/${jobId}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expectedGeneration: read.json.data.generation }) });
    expect(current.status).toBe(200);
    expect(calls.at(-1)?.input).toEqual({ jobId, expectedGeneration: 2 });
    expect(current.json.data).toMatchObject({ state: 'cancelled', generation: 3 });
  });

  it('returns the skill-run grant request and forwards the approved grant on retry', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const post = (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      return send(`/api/v1/workspaces/${workspaceId}/skills/demo/run`, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, body });
    };
    const digest = 'c'.repeat(64);
    vi.mocked(runner.call).mockImplementationOnce(async (operation, input, selected) => {
      calls.push({ operation, input, principal: selected });
      return { ok: false, message: 'approval', truncated: false, error: {
        code: 'PRIVILEGE_APPROVAL_REQUIRED', message: 'Approval grant required to run skill script demo/run.sh in a disposable helper container', retryable: true,
        grantRequest: { grantId: 'pvg_0123', workspaceId, commandSha256: 'd'.repeat(64), cwd: '.', expiresAt: '2026-10-21T09:00:00.000Z' }
      } } as RunnerResponse;
    });
    const held = await post({ script: 'run.sh', expectedContentSha256: digest });
    expect(held.status).toBe(428);
    expect(held.json).toEqual({
      error: 'privilege_approval_required',
      message: 'This action needs your approval before it runs.',
      grantRequest: { grantId: 'pvg_0123', expiresAt: '2026-10-21T09:00:00.000Z' }
    });
    expect(calls.at(-1)).toMatchObject({ operation: 'skills_run', input: { workspaceId, name: 'demo', script: 'run.sh', expectedContentSha256: digest } });

    vi.mocked(runner.call).mockImplementationOnce(async (operation, input, selected) => {
      calls.push({ operation, input, principal: selected });
      return { ok: true, message: 'ran', truncated: false, data: { output: 'skill-ok\n', exitCode: 0, executionMode: 'helper-container', signal: null } };
    });
    const ran = await post({ script: 'run.sh', expectedContentSha256: digest, approvalGrantToken: 'pvg_0123' });
    expect(ran.status).toBe(200);
    expect(ran.json.data).toEqual({ output: 'skill-ok\n', exitCode: 0, executionMode: 'helper-container' });
    expect(calls.at(-1)?.input).toMatchObject({ workspaceId, name: 'demo', script: 'run.sh', expectedContentSha256: digest, approvalGrantToken: 'pvg_0123' });
  });

  it('accepts a zip upload on the skill archive route without the JSON media-type rule', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const archive = Buffer.from('PK-fake-archive-bytes');
    const base = { origin: 'https://dashboard.example', cookie, 'x-csrf-token': session.json.csrfToken };

    const response = await send('/api/v1/skill-archives', {
      method: 'POST', headers: { ...base, 'content-type': 'application/zip', 'content-length': String(archive.length) }, body: archive as unknown as string
    });
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.operation).toBe('skill_archive_import');
    expect(calls.at(-1)?.input).toEqual({ archiveBase64: archive.toString('base64'), expectedGeneration: 0 });

    // Only an archive media type is accepted here, so a JSON body cannot reach the raw parser by accident.
    const json = await send('/api/v1/skill-archives', {
      method: 'POST', headers: { ...base, 'content-type': 'application/json', 'content-length': '2' }, body: '{}'
    });
    expect(json.status).toBe(415);

    // Every other mutation keeps the JSON-only rule.
    const other = await send('/api/v1/skills', {
      method: 'POST', headers: { ...base, 'content-type': 'application/zip', 'content-length': '2' }, body: 'PK'
    });
    expect(other.status).toBe(415);
  });

  it('rejects a skills identifier that does not match the contract shape', async () => {
    const response = await send('/api/v1/skills/not-a-skill-id');
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.operation === 'skill_get')).toBe(false);
  });
  it('allowlists successful response fields for every dashboard operation', () => {
    const hostile = { ownerId: 'future-owner', token: 'future-token', workspacePath: '/future/private', futureSecret: 'do-not-forward' };
    const fixtures: Record<DashboardResponseOperation, unknown> = {
      workspace_list: { workspaces: [{ workspaceId, repositoryUrl: 'https://github.com/example/project.git', status: 'ACTIVE', ...hostile }], ...hostile },
      workspace_status: { workspaceId, status: 'ACTIVE', ...hostile },
      workspace_detail: { workspaceId, status: 'ACTIVE', generation: 3, canRenewLease: true, leaseCapped: true, leaseState: 'WARNING', availableActions: ['workspace_lease_renew', 'workspace_close', 'workspace_context', 'workspace_finalize'], ...hostile },
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
    expect(mapDashboardData('workspace_detail', fixtures.workspace_detail)).toMatchObject({
      workspaceId,
      status: 'ACTIVE',
      version: 3,
      canRenewLease: true,
      leaseCapped: true,
      leaseState: 'WARNING',
      availableActions: ['workspace_lease_renew', 'workspace_close', 'workspace_context', 'workspace_finalize']
    });
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

  it('projects the read window so a partial file is never taken for the whole file', async () => {
    const response = await send(`/api/v1/workspaces/${workspaceId}/files/content?path=big.txt`);
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: 'files_read', input: { workspaceId, path: 'big.txt', offset: 0, limit: 65_536 } });
    expect(response.json.data).toMatchObject({ path: 'big.txt', sha256: 'c'.repeat(64), bytesReturned: 65_536, totalBytes: 100_000, eof: false });
  });

  it('rejects foreign origin, missing mutation origin, and non-JSON mutations', async () => {
    expect((await send('/api/v1/workspaces', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await send(`/api/v1/workspaces/${workspaceId}/files/directory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await send(`/api/v1/workspaces/${workspaceId}/files/directory`, { method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('projects workspace context to cockpit posture and drops internals', async () => {
    const response = await send(`/api/v1/workspaces/${workspaceId}/context`);
    expect(response.status).toBe(200);
    const raw = JSON.stringify(response.json);
    // The context document can carry job paths, container names, the identity email
    // and file contents; none of it may reach the browser.
    for (const forbidden of ['internal-owner', '/host/jobs', 'executor-secret', 'owner@example.com', 'SECRET=1', 'secret.env']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
    expect(response.json.data.branch).toBe('feature/x');
    expect(response.json.data.gitIdentityName).toBe('Operator');
    expect(response.json.data.capabilities).toEqual({ tasks: true, sessions: false });
    expect(response.json.data.manifest).toEqual({ itemCount: 1, truncated: true, truncationReasons: ['max_bytes'] });
  });

  it('routes the cockpit lifecycle actions with the principal scope and contract validation', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    const renewed = await send(`/api/v1/workspaces/${workspaceId}/lease-renew`, { method: 'POST', headers, body: JSON.stringify({ extensionSeconds: 3_600 }) });
    expect(renewed.status).toBe(200);
    const renewCall = calls.find((call) => call.operation === 'workspace_lease_renew');
    expect(renewCall?.input).toEqual({ workspaceId, extensionSeconds: 3_600 });
    expect(renewCall?.principal).toEqual(principal);

    const recovered = await send(`/api/v1/workspaces/${workspaceId}/recover`, { method: 'POST', headers, body: JSON.stringify({ mode: 'status' }) });
    expect(recovered.status).toBe(200);
    expect(calls.some((call) => call.operation === 'workspace_recover')).toBe(true);

    // Finalize is contract-validated: without a commit message the runner is never called.
    const rejected = await send(`/api/v1/workspaces/${workspaceId}/finalize`, { method: 'POST', headers, body: JSON.stringify({ all: true, push: true }) });
    expect(rejected.status).toBe(400);
    expect(calls.some((call) => call.operation === 'workspace_finalize')).toBe(false);

    const finalized = await send(`/api/v1/workspaces/${workspaceId}/finalize`, { method: 'POST', headers, body: JSON.stringify({ all: true, push: true, commitMessage: 'feat: ship the cockpit' }) });
    expect(finalized.status).toBe(200);
    expect(JSON.stringify(finalized.json)).not.toContain('/host/jobs');
    expect(finalized.json.data).toMatchObject({ commitSha: 'a'.repeat(40), committed: true, pushed: true, filesChanged: 3 });
  });

  it('projects agent records without owner, container or prompt leakage', async () => {
    const list = await send('/api/v1/agents');
    expect(list.status).toBe(200);
    const raw = JSON.stringify(list.json);
    for (const forbidden of ['internal-owner', 'executor-secret', '/host/jobs', 'do the thing']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
    expect(list.json.data.agents[0]).toMatchObject({
      agentId: `agent_${'g'.repeat(24)}`, workspaceId, profileId: 'coding-fast', status: 'RUNNING',
      budget: { maxCostMicros: 5_000_000 }, usage: { inputTokens: 1_000, costMicros: 250_000 }
    });
    expect(list.json.data.agents[0].proxyOperations).toEqual(['files_read']);

    // Log events stay bounded per event, and an oversized event is marked truncated.
    const logs = await send(`/api/v1/agents/agent_${'g'.repeat(24)}/logs`);
    expect(logs.status).toBe(200);
    expect(logs.json.data.events[0].content).toContain('… truncated');
    expect(logs.json.data.events[0].content.length).toBeLessThan(4_100);
    expect(logs.json.data.events[0].type).toBe('tool.call');
  });

  it('serves the workspace-scoped agent list and rejects an unknown agent status', async () => {
    const scoped = await send(`/api/v1/workspaces/${workspaceId}/agents`);
    expect(scoped.status).toBe(200);
    // The contract schema applies its own `limit` default, so match the scope only.
    expect(calls.filter((call) => call.operation === 'agent_list').at(-1)?.input).toMatchObject({ workspaceId });

    const rejected = await send('/api/v1/agents?status=NOPE');
    expect(rejected.status).toBe(400);
  });

  it('lists agents globally by fanning out over the principal workspaces, never unscoped', async () => {
    for (const path of ['/api/v1/agents', '/api/v1/overview', '/api/v1/activity']) {
      calls = [];
      const response = await send(path);
      expect(response.status, path).toBe(200);
      const agentCalls = calls.filter((call) => call.operation === 'agent_list');
      // An unscoped agent_list resolves to the single active workspace in the runner and
      // fails once it is closed, so every global call must name a listed workspace.
      expect(agentCalls.length, path).toBeGreaterThan(0);
      for (const call of agentCalls) expect(call.input, path).toMatchObject({ workspaceId });
    }
    const list = await send('/api/v1/agents');
    expect(list.json.data.agents).toHaveLength(1);
  });

  it('keeps internal audit and trace reads within the runner contract page size', async () => {
    for (const path of ['/api/v1/metrics', '/api/v1/activity', `/api/v1/workspaces/${workspaceId}/activity`]) {
      calls = [];
      expect((await send(path)).status, path).toBe(200);
      const audit = calls.find((call) => call.operation === 'audit_list');
      expect(audit?.input.limit, path).toBeLessThanOrEqual(100);
    }
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

  it('passes the workspace quota message through instead of a generic throttling notice', async () => {
    const quotaMessage = 'active workspace limit reached: 3 active of a maximum 3; close a workspace with workspace_close before opening another';
    vi.mocked(runner.call).mockImplementationOnce(async (): Promise<RunnerResponse> => ({
      ok: false,
      message: 'Workspace admission refused',
      truncated: false,
      error: { code: 'LIMIT_EXCEEDED', message: quotaMessage, retryable: true }
    }));

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const response = await send('/api/v1/workspaces', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken },
      body: JSON.stringify({ repositoryUrl: 'https://github.com/example/project.git', idempotencyKey: 'dashboard-quota-1' })
    });

    expect(response.status).toBe(429);
    expect(response.json.message).toBe(quotaMessage);
    expect(response.text).not.toContain('Too many requests');
  });

  it('replaces a non-quota workspace failure with the generic notice', async () => {
    vi.mocked(runner.call).mockImplementationOnce(async (): Promise<RunnerResponse> => ({
      ok: false,
      message: 'Workspace admission refused',
      truncated: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'executor creation failed: docker: Error response from daemon: /job/repo mount denied',
        retryable: false
      }
    }));

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const response = await send('/api/v1/workspaces', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken },
      body: JSON.stringify({ repositoryUrl: 'https://github.com/example/project.git', idempotencyKey: 'dashboard-internal-1' })
    });

    expect(response.status).toBe(500);
    expect(response.json.message).toBe('The workspace service could not complete the request.');
    expect(response.text).not.toContain('docker');
    expect(response.text).not.toContain('/job/repo');
  });

  it('lists safe key metadata and requires CSRF for one-time create and revoke', async () => {
    const listed = await send('/api/v1/api-keys');
    expect(listed.status).toBe(200);
    expect(listed.json.data.readiness).toEqual({ ready: true, publicUrl: 'https://api.example/mcp' });
    expect(listed.text).not.toContain('chm_key_apk_kkkkkkkkkkkkkkkkkkkkkkkk.s');

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const created = await send('/api/v1/api-keys', { method: 'POST', headers, body: JSON.stringify({ name: 'CLI', expiresInDays: 3_650 }) });
    expect(created.status).toBe(200);
    expect(created.json.data.apiKey).toMatch(/^chm_key_/);
    expect(runner.callApiKeys).toHaveBeenCalledWith('api_key_create', { name: 'CLI', expiresInDays: 3_650 }, principal);

    const callsBeforeRejected = runner.callApiKeys.mock.calls.length;
    const rejectedOverLimit = await send('/api/v1/api-keys', { method: 'POST', headers, body: JSON.stringify({ name: 'CLI', expiresInDays: 3_651 }) });
    expect(rejectedOverLimit.status).toBe(400);
    expect(runner.callApiKeys).toHaveBeenCalledTimes(callsBeforeRejected);
    const revokeBody = JSON.stringify({ expectedGeneration: 1 });
    const revoked = await send(`/api/v1/api-keys/apk_${'k'.repeat(24)}`, {
      method: 'DELETE', headers: { ...headers, 'content-length': String(Buffer.byteLength(revokeBody)) }, body: revokeBody
    });
    expect(revoked.status).toBe(200);
    expect(revoked.text).not.toContain('.ssss');
  });

  it('lists MCP event subscriptions by origin only and revokes one with CSRF', async () => {
    const listed = await send('/api/v1/event-subscriptions');
    expect(listed.status).toBe(200);
    expect(listed.json.data.subscriptions[0]).toMatchObject({ callbackOrigin: 'https://hooks.example', state: 'ACTIVE' });
    expect(runner.callEvents).toHaveBeenCalledWith({ version: 1, principal, operation: 'events_subscriptions_list', input: {} });

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const withoutCsrf = await send(`/api/v1/event-subscriptions/sub_${'e'.repeat(32)}/revoke`, { method: 'POST', headers: { ...headers, 'x-csrf-token': 'wrong' }, body: '{}' });
    expect(withoutCsrf.status).toBe(403);
    const malformed = await send('/api/v1/event-subscriptions/sub_bad/revoke', { method: 'POST', headers, body: '{}' });
    expect(malformed.status).toBe(400);
    const revoked = await send(`/api/v1/event-subscriptions/sub_${'e'.repeat(32)}/revoke`, { method: 'POST', headers, body: '{}' });
    expect(revoked.status).toBe(200);
    expect(revoked.json.data).toEqual({ revoked: true });
    expect(runner.callEvents).toHaveBeenLastCalledWith({ version: 1, principal, operation: 'events_subscription_revoke', input: { id: `sub_${'e'.repeat(32)}` } });
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
    const unsupported = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ nickname: 'quiet' }) });
    expect(unsupported.status).toBe(400);
  });

  it('persists and clears an operator display name without trusting cookie content', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    const named = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ displayName: '  Ops Lead  ' }) });
    expect(named.status).toBe(200);
    expect(named.json.data.displayName).toBe('Ops Lead');
    const setCookie = String(named.headers['set-cookie']?.[0]);
    expect(setCookie).toContain(`ch-dashboard-display-name=${encodeURIComponent('Ops Lead')}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/dashboard');

    const unicode = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ displayName: 'Nguyễn Văn A' }) });
    expect(unicode.status).toBe(200);
    expect(unicode.json.data.displayName).toBe('Nguyễn Văn A');

    const cleared = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ displayName: '   ' }) });
    expect(cleared.status).toBe(200);
    expect(cleared.json.data.displayName).toBeNull();
    expect(String(cleared.headers['set-cookie']?.[0])).toContain('Max-Age=0');

    for (const rejected of ['<script>alert(1)</script>', 'a\nb', 'x'.repeat(65), '.leading-dot', 'a@b.com']) {
      const response = await send('/api/v1/preferences', { method: 'PUT', headers, body: JSON.stringify({ displayName: rejected }) });
      expect(response.status, rejected).toBe(400);
      expect(response.text).not.toContain(rejected);
    }
  });

  it('Issue #109 and #110: exposes artifact read, restore, and streaming download with safe headers', async () => {
    const artifactId = `art_${'a'.repeat(32)}`;
    const artifactPayload = Buffer.from('artifact payload bytes test 123');
    const artifactSha = createHash('sha256').update(artifactPayload).digest('hex');

    (runner.callInternal as any).mockImplementation(async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'artifact_read') {
        return {
          ok: true,
          message: 'read',
          truncated: false,
          data: {
            artifactId,
            logicalName: 'report.txt',
            offset: 0,
            bytesReturned: artifactPayload.length,
            totalBytes: artifactPayload.length,
            sha256: artifactSha,
            eof: true,
            content: artifactPayload.toString('base64')
          }
        };
      }
      if (operation === 'artifact_restore') {
        return {
          ok: true,
          message: 'restored',
          truncated: false,
          data: {
            artifactId,
            workspaceId,
            path: input.path,
            sizeBytes: artifactPayload.length,
            sha256: artifactSha
          }
        };
      }
      return { ok: true, message: 'ok', truncated: false, data: {} };
    });

    // 1. GET /api/v1/artifacts/:artifactId
    const readResp = await send(`/api/v1/artifacts/${artifactId}`);
    expect(readResp.status).toBe(200);
    expect(readResp.json.data).toMatchObject({
      artifactId,
      logicalName: 'report.txt',
      totalBytes: artifactPayload.length,
      sha256: artifactSha
    });

    // 2. POST /api/v1/artifacts/:artifactId/restore
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const restoreBody = JSON.stringify({ workspaceId, path: 'restored/report.txt', overwrite: true });
    const restoreResp = await send(`/api/v1/artifacts/${artifactId}/restore`, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(restoreBody)) },
      body: restoreBody
    });
    expect(restoreResp.status).toBe(200);
    expect(restoreResp.json.data).toMatchObject({
      artifactId,
      workspaceId,
      path: 'restored/report.txt',
      sizeBytes: artifactPayload.length
    });

    // 3. GET /api/v1/artifacts/:artifactId/download
    const downloadResp = await send(`/api/v1/artifacts/${artifactId}/download`);
    expect(downloadResp.status).toBe(200);
    expect(downloadResp.headers['content-type']).toBe('application/octet-stream');
    expect(downloadResp.headers['content-disposition']).toBe('attachment; filename="report.txt"');
    expect(downloadResp.text).toBe('artifact payload bytes test 123');
  });

  it('proxies instance settings reads, updates, and egress readiness through the runner', async () => {
    const read = await send('/api/v1/settings');
    expect(read.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'settings_get', input: {}, principal });
    expect(read.json.data.defaultNetworkProfile).toEqual({ value: 'dependency-access', source: 'environment' });

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    const stored = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ defaultNetworkProfile: 'network-none' }) });
    expect(stored.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'settings_update', input: { defaultNetworkProfile: 'network-none' }, principal });
    expect(stored.json.data.defaultNetworkProfile).toEqual({ value: 'network-none', source: 'setting' });

    const reset = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ defaultNetworkProfile: null }) });
    expect(reset.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'settings_update', input: { defaultNetworkProfile: null }, principal });
    expect(reset.json.data.defaultNetworkProfile).toEqual({ value: 'dependency-access', source: 'environment' });

    const checked = await send('/api/v1/settings/network-check', { method: 'POST', headers, body: JSON.stringify({}) });
    expect(checked.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'settings_network_check', input: {}, principal });
    expect(checked.json.data).toEqual({ ready: true, reason: null });
  });

  it('proxies inbound OAuth session settings with CSRF and passes provider messages through', async () => {
    const read = await send('/api/v1/settings/oauth');
    expect(read.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'oauth_settings_get', input: {}, principal });
    expect(read.json.data.provider.id).toBe('cloudflare-access');

    const body = { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900, expectedRevision: 'b'.repeat(64) };
    const unauthenticated = await send('/api/v1/settings/oauth', { method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(unauthenticated.status).toBe(401);
    expect(calls.some((call) => call.operation === 'oauth_settings_update')).toBe(false);

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
    const saved = await send('/api/v1/settings/oauth', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(saved.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'oauth_settings_update', input: body, principal });

    const conflict = await send('/api/v1/settings/oauth', { method: 'POST', headers, body: JSON.stringify({ ...body, grant: { mode: 'custom', seconds: 86_400 } }) });
    expect(conflict.status).toBe(409);
    expect(conflict.json.message).toMatch(/changed since this page loaded/);

    const before = calls.length;
    for (const invalid of [
      { ...body, grant: { mode: 'forever' } },
      { ...body, tokenLifetimeSeconds: 10 },
      { ...body, apiToken: 'leak' },
      { grant: { mode: 'provider-maximum' }, tokenLifetimeSeconds: 900 }
    ]) {
      const rejected = await send('/api/v1/settings/oauth', { method: 'POST', headers, body: JSON.stringify(invalid) });
      expect(rejected.status, JSON.stringify(invalid)).toBe(400);
    }
    expect(calls.length).toBe(before);
  });

  it('rejects an unsupported or unknown default network profile without calling the runner', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    for (const body of [
      JSON.stringify({ defaultNetworkProfile: 'local-host' }),
      JSON.stringify({ defaultNetworkProfile: 'network-none', instanceWide: true }),
      JSON.stringify({})
    ]) {
      const rejected = await send('/api/v1/settings', { method: 'POST', headers, body });
      expect(rejected.status, body).toBe(400);
    }
    expect(calls.some((call) => call.operation === 'settings_update')).toBe(false);
  });

  it('forwards a lifecycle-only write to the runner intact and keeps network-only writes working', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    const lifecycle = { expectedRevision: 4, maxActiveWorkspacesPerOwner: 5, idleTtlSeconds: 600, wallTtlSeconds: null, recoverableGraceSeconds: 0, acknowledgeImmediateClose: true };
    const saved = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ workspaceLifecycle: lifecycle }) });
    expect(saved.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'settings_update', input: { workspaceLifecycle: lifecycle }, principal });
    expect(saved.json.data.workspaceLifecycle.revision).toBe(5);
    expect(saved.json.data.workspaceLifecycle.settings.maxActiveWorkspacesPerOwner).toMatchObject({ value: 5, source: 'setting', runnerValue: 3 });
    expect(saved.json.data.workspaceLifecycle.executorCeilings).toEqual({ memoryBytes: 1_073_741_824, cpus: 1, pids: 256 });

    const network = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ defaultNetworkProfile: 'network-none' }) });
    expect(network.status).toBe(200);
    expect(calls.at(-1)).toEqual({ operation: 'settings_update', input: { defaultNetworkProfile: 'network-none' }, principal });

    const conflict = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ workspaceLifecycle: { expectedRevision: STALE_LIFECYCLE_REVISION, idleTtlSeconds: 600 } }) });
    expect(conflict.status).toBe(409);
    expect(conflict.json.message).toBe('Instance settings changed after you opened them. Reload and try again.');
  });

  it('rejects invalid lifecycle writes before they reach the runner', async () => {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    const before = calls.length;
    for (const workspaceLifecycle of [
      { expectedRevision: 4, idleTtlSeconds: 90.5 },
      { expectedRevision: 4, maxActiveWorkspacesPerOwner: 1.5 },
      { expectedRevision: 4, maxActiveWorkspacesPerOwner: 0 },
      { expectedRevision: 4, maxActiveWorkspacesPerOwner: 65 },
      { expectedRevision: 4, idleTtlSeconds: 59 },
      { expectedRevision: 4, idleTtlSeconds: 43_201 },
      { expectedRevision: 4, wallTtlSeconds: 86_401 },
      { expectedRevision: 4, recoverableGraceSeconds: -1 },
      { expectedRevision: 4, recoverableGraceSeconds: 0 },
      { expectedRevision: 4, recoverableGraceSeconds: 0, acknowledgeImmediateClose: false },
      { expectedRevision: 4, idleTtlSeconds: '600' },
      { expectedRevision: 4, idleTtlSeconds: 600, workspaceDeletes: true },
      { expectedRevision: 4 },
      { idleTtlSeconds: 600 },
      {}
    ]) {
      const body = JSON.stringify({ workspaceLifecycle });
      const rejected = await send('/api/v1/settings', { method: 'POST', headers, body });
      expect(rejected.status, body).toBe(400);
      expect(rejected.json.error, body).toBe('invalid_request');
    }
    for (const body of [JSON.stringify({ workspaceLifecycle: { expectedRevision: 4, idleTtlSeconds: 600 }, quota: 3 }), JSON.stringify({ maxActiveWorkspacesPerOwner: 3 })]) {
      const rejected = await send('/api/v1/settings', { method: 'POST', headers, body });
      expect(rejected.status, body).toBe(400);
    }
    expect(calls.length).toBe(before);

    // The same-origin and CSRF boundary is unchanged for the new field.
    const forged = await send('/api/v1/settings', { method: 'POST', headers: { ...headers, 'x-csrf-token': 'wrong' }, body: JSON.stringify({ workspaceLifecycle: { expectedRevision: 4, idleTtlSeconds: 600 } }) });
    expect(forged.status).toBe(403);
    const crossOrigin = await send('/api/v1/settings', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ workspaceLifecycle: { expectedRevision: 4, idleTtlSeconds: 600 } }) });
    expect(crossOrigin.status).toBe(403);
    expect(calls.length).toBe(before);
  });

  it('round-trips the settings page through the BFF and the shipped renderer', async () => {
    // DOM+BFF wiring for /dashboard/settings: the BFF responses below are the
    // exact shapes the shipped dashboard.js handlers consume, and renderSettings
    // is the shipped renderer those handlers call. A drift in field names,
    // select values, or button ids breaks this test instead of shipping a dead
    // control that unit tests on either side alone would miss.
    const read = await send('/api/v1/settings');
    expect(read.status).toBe(200);
    const initial = renderSettings(read.json.data);
    expect(initial).toContain('id="settings-network-profile"');
    expect(initial).toContain('id="save-settings-network-profile"');
    expect(initial).toContain('id="reset-settings-network-profile"');
    expect(initial).toContain('id="check-settings-network"');
    expect(initial).toContain('id="settings-status"');
    for (const selector of ['id="settings-lifecycle-form"', 'id="settings-lifecycle-max-active"', 'id="settings-lifecycle-idle"', 'id="settings-lifecycle-wall"', 'id="settings-lifecycle-grace"', 'id="save-settings-lifecycle"', 'id="reset-settings-lifecycle"', 'id="settings-lifecycle-status"']) {
      expect(initial, selector).toContain(selector);
    }

    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0];
    const headers = { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };

    // Save: what dashboard.js posts on #save-settings-network-profile click.
    const saved = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ defaultNetworkProfile: 'network-none' }) });
    expect(saved.status).toBe(200);
    const savedHtml = renderSettings(saved.json.data);
    expect(savedHtml).toMatch(/<option value="network-none" selected>/);
    expect(savedHtml).toContain('Set in this dashboard');

    // Reset: what dashboard.js posts on #reset-settings-network-profile click.
    const reset = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ defaultNetworkProfile: null }) });
    expect(reset.status).toBe(200);
    const resetHtml = renderSettings(reset.json.data);
    expect(resetHtml).toMatch(/<option value="" selected>/);
    expect(resetHtml).toContain('Runner default (WORKSPACE_NETWORK_PROFILE or built-in)');

    // Readiness check: what dashboard.js posts on #check-settings-network click.
    const checked = await send('/api/v1/settings/network-check', { method: 'POST', headers, body: JSON.stringify({}) });
    expect(checked.status).toBe(200);
    const checkedHtml = renderSettings(reset.json.data, checked.json.data);
    expect(checkedHtml).toContain('Egress readiness');
    expect(checkedHtml).toContain('Ready');

    // Lifecycle save and reset: what dashboard.js posts from #settings-lifecycle-form and #reset-settings-lifecycle.
    const lifecycle = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ workspaceLifecycle: { expectedRevision: 4, idleTtlSeconds: 600 } }) });
    expect(lifecycle.status).toBe(200);
    const lifecycleHtml = renderSettings(lifecycle.json.data);
    expect(lifecycleHtml).toMatch(/id="settings-lifecycle-idle"[^>]*value="10"/);
    expect(lifecycleHtml).toContain('Source: Dashboard override · Runner value: 5 min');
    const restored = await send('/api/v1/settings', { method: 'POST', headers, body: JSON.stringify({ workspaceLifecycle: { expectedRevision: 5, maxActiveWorkspacesPerOwner: null, idleTtlSeconds: null, wallTtlSeconds: null, recoverableGraceSeconds: null } }) });
    expect(restored.status).toBe(200);
    expect(renderSettings(restored.json.data)).toContain('Source: Runner environment · Runner value: 5 min');
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

  function get(cookie?: string): Promise<Reply> {
    const { promise, resolve, reject } = Promise.withResolvers<Reply>();
    const request = httpRequest({ hostname: '127.0.0.1', port: profilePort, path: '/dashboard/api/v1/profile', method: 'GET', headers: { host: 'dashboard.example', ...(cookie ? { cookie } : {}) } }, (response) => {
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
      preferences: { displayName: null },
      sessionExpiresAt: new Date(expiresAt * 1_000).toISOString()
    });
    expect(calls.length).toBe(before);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports the operator-editable display name and ignores a tampered cookie', async () => {
    await serveProfile({
      token: 'cloudflare-access', clientId: 'operator', scopes: [],
      extra: { principal: { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator', name: 'Op Erator' } }
    });
    const named = await get(`ch-dashboard-display-name=${encodeURIComponent('Ops Lead')}`);
    expect(named.json.data.identity).toEqual({ issuer: 'https://team.cloudflareaccess.com', subject: 'operator', name: 'Op Erator' });
    expect(named.json.data.preferences).toEqual({ displayName: 'Ops Lead' });

    for (const hostile of ['%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'a%0Ab', 'x'.repeat(65), '%E0%A4%A']) {
      expect((await get(`ch-dashboard-display-name=${hostile}`)).json.data.preferences, hostile).toEqual({ displayName: null });
    }
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
