import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import { PathIdMismatchError, withPathIds } from '../src/dashboard-path-ids.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

// The URL is the authority for which resource a dashboard mutation touches. A body that names a
// different id must be refused before the runner sees it, on every route that merges a body.

const id = (prefix: string, fill: string) => `${prefix}_${fill.repeat(24)}`;
const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: false, runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

const ws = id('ws', 'a');
const otherWs = id('ws', 'b');
const agent = id('agent', 'a');
const env = id('env', 'a');
const skill = id('sk', 'a');
const revision = id('skrev', 'a');
const skillSet = id('skset', 'a');
const job = id('skjob', 'a');
const cred = id('cred', 'a');
const icr = id('icr', 'a');
const artifact = id('art', 'a');
const server = id('mcps', 'a');
const hex = (prefix: string, fill: string) => `${prefix}_${fill.repeat(32)}`;
const connection = hex('whc', 'a');
const rule = hex('arl', 'a');
const workflow = hex('wfl', 'a');
const project = id('prj', 'a');
const policyRevision = hex('apr', 'a');

/** [method, path, body key the path owns, a different value for that key]. */
const ROUTES: Array<[string, string, string, string]> = [
  ['POST', `/workspaces/${ws}/lease-renew`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/recover`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/finalize`, 'workspaceId', otherWs],
  ['PUT', `/workspaces/${ws}/files/content`, 'workspaceId', otherWs],
  ['PATCH', `/workspaces/${ws}/files/content`, 'workspaceId', otherWs],
  ['DELETE', `/workspaces/${ws}/files/content`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/files/move`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/files/directory`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/skills/build/run`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/skills/build/run`, 'name', 'other'],
  ['POST', `/workspaces/${ws}/hooks/run`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/hooks/activate`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/hooks/deactivate`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/deployments/run`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/git/fetch`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/git/pull`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/git/checkout`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/git/branch`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/git/merge`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/git/rebase`, 'workspaceId', otherWs],
  ['POST', `/workspaces/${ws}/worktrees`, 'workspaceId', otherWs],
  ['DELETE', `/workspaces/${ws}/worktrees/feature`, 'workspaceId', otherWs],
  ['DELETE', `/workspaces/${ws}/worktrees/feature`, 'name', 'other'],
  ['POST', `/workspaces/${ws}/sessions`, 'workspaceId', otherWs],
  ['POST', `/agents/${agent}/messages`, 'agentId', id('agent', 'b')],
  ['POST', `/agents/${agent}/cancel`, 'agentId', id('agent', 'b')],
  ['POST', `/environments/${env}/secrets`, 'environmentId', id('env', 'b')],
  ['POST', `/environments/${env}/secrets/bulk`, 'environmentId', id('env', 'b')],
  ['PUT', `/environments/${env}/secrets/API_TOKEN`, 'environmentId', id('env', 'b')],
  ['PUT', `/environments/${env}/secrets/API_TOKEN`, 'name', 'OTHER_TOKEN'],
  ['PATCH', `/environments/${env}/secrets/API_TOKEN`, 'name', 'OTHER_TOKEN'],
  ['DELETE', `/environments/${env}/secrets/API_TOKEN`, 'name', 'OTHER_TOKEN'],
  ['PUT', '/secrets/API_TOKEN', 'name', 'OTHER_TOKEN'],
  ['PATCH', '/secrets/API_TOKEN', 'name', 'OTHER_TOKEN'],
  ['DELETE', '/secrets/API_TOKEN', 'name', 'OTHER_TOKEN'],
  ['PUT', `/provider-credentials/${cred}/rotate`, 'credentialId', id('cred', 'b')],
  ['PUT', `/integration-credentials/${icr}/rotate`, 'credentialId', id('icr', 'b')],
  ['POST', `/skill-imports/${job}/cancel`, 'jobId', id('skjob', 'b')],
  ['PATCH', `/skills/${skill}`, 'skillId', id('sk', 'b')],
  ['POST', `/skills/${skill}/archive`, 'skillId', id('sk', 'b')],
  ['POST', `/skills/${skill}/restore`, 'skillId', id('sk', 'b')],
  ['POST', `/skills/${skill}/revisions`, 'skillId', id('sk', 'b')],
  ['POST', `/skills/${skill}/revisions/${revision}/fork`, 'revisionId', id('skrev', 'b')],
  ['POST', `/skills/${skill}/revisions/${revision}/fork`, 'skillId', id('sk', 'b')],
  ['PATCH', `/skill-sets/${skillSet}`, 'skillSetId', id('skset', 'b')],
  ['PATCH', '/agent-model-profiles/fast', 'profileId', 'slow'],
  ['POST', `/artifacts/${artifact}/restore`, 'artifactId', id('art', 'b')],
  ['PUT', '/knowledge/note-1', 'id', 'note-2'],
  ['PATCH', `/mcp-servers/${server}`, 'serverId', id('mcps', 'b')],
  ['POST', `/mcp-servers/${server}/enabled`, 'serverId', id('mcps', 'b')],
  ['PATCH', `/automations/connections/${connection}`, 'id', hex('whc', 'b')],
  ['POST', `/automations/connections/${connection}/rotate-secret`, 'id', hex('whc', 'b')],
  ['DELETE', `/automations/connections/${connection}`, 'id', hex('whc', 'b')],
  ['PATCH', `/automations/rules/${rule}`, 'id', hex('arl', 'b')],
  ['DELETE', `/automations/rules/${rule}`, 'id', hex('arl', 'b')],
  ['POST', `/automations/rules/${rule}/preview`, 'id', hex('arl', 'b')],
  ['POST', `/automations/workflows/${workflow}/cancel`, 'id', hex('wfl', 'b')],
  ['PUT', `/agent-policies/projects/${project}`, 'projectId', id('prj', 'b')],
  ['DELETE', `/agent-policies/projects/${project}`, 'projectId', id('prj', 'b')],
  ['POST', `/agent-policies/projects/${project}/validate`, 'projectId', id('prj', 'b')],
  ['POST', `/agent-policies/revisions/${policyRevision}/rollback`, 'revisionId', hex('apr', 'b')]
];

const sample = { event: 'issues', repository: 'example/project', label: 'triage', senderLogin: 'octocat' };
/** [method, path, runner operation, body that repeats the path id with the same value, forwarded input]. */
const MATCHING: Array<[string, string, string, Record<string, unknown>, Record<string, unknown>]> = [
  ['PATCH', `/automations/connections/${connection}`, 'connection_update', { id: connection, expectedGeneration: 1, enabled: false }, { id: connection, expectedGeneration: 1, enabled: false }],
  ['POST', `/automations/connections/${connection}/rotate-secret`, 'connection_rotate_secret', { id: connection, expectedGeneration: 1 }, { id: connection, expectedGeneration: 1 }],
  ['DELETE', `/automations/connections/${connection}`, 'connection_delete', { id: connection, expectedGeneration: 2 }, { id: connection, expectedGeneration: 2 }],
  ['PATCH', `/automations/rules/${rule}`, 'rule_update', { id: rule, expectedGeneration: 1, enabled: true }, { id: rule, expectedGeneration: 1, enabled: true }],
  ['DELETE', `/automations/rules/${rule}`, 'rule_delete', { id: rule, expectedGeneration: 1 }, { id: rule, expectedGeneration: 1 }],
  ['POST', `/automations/rules/${rule}/preview`, 'rule_preview', { id: rule, sample }, { id: rule, sample: { ...sample, senderType: 'User' } }],
  ['POST', `/automations/workflows/${workflow}/cancel`, 'workflow_cancel', { id: workflow, reason: 'not needed' }, { id: workflow, reason: 'not needed' }],
  ['PUT', `/agent-policies/projects/${project}`, 'policy_put', { projectId: project, document: {}, expectedVersion: 2 }, { scope: 'project', projectId: project, document: {}, expectedVersion: 2, confirmWeakening: false }],
  ['DELETE', `/agent-policies/projects/${project}`, 'policy_delete', { projectId: project, expectedVersion: 3 }, { projectId: project, expectedVersion: 3, confirmWeakening: false }],
  ['POST', `/agent-policies/projects/${project}/validate`, 'policy_validate', { projectId: project, document: {} }, { scope: 'project', projectId: project, document: {}, intent: 'save' }],
  ['POST', `/agent-policies/revisions/${policyRevision}/rollback`, 'policy_rollback', { revisionId: policyRevision, expectedVersion: 4 }, { revisionId: policyRevision, expectedVersion: 4, confirmWeakening: false }]
];

let httpServer: Server;
let port: number;
let operations: Array<{ operation: string; input: Record<string, unknown> }>;

beforeEach(async () => {
  operations = [];
  const ok = async (operation: string, input: Record<string, unknown>): Promise<RunnerResponse> => {
    operations.push({ operation, input });
    return { ok: true, message: 'ok', truncated: false, data: {} };
  };
  // Automation and policy routes forward a typed request; record its operation and input like the rest.
  const record = async (request: { operation: string; input: unknown }) => {
    operations.push({ operation: request.operation, input: request.input as Record<string, unknown> });
    return { ok: true as const, data: {} };
  };
  const runner: DashboardRunnerClient = { call: vi.fn(ok), callInternal: vi.fn(ok), callAutomations: vi.fn(record), callAgentPolicies: vi.fn(record) };
  const app = express();
  app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
  app.use('/dashboard', createDashboardRouter(config, runner));
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('server unavailable');
  port = address.port;
});

afterEach(async () => await new Promise<void>((resolve) => httpServer.close(() => resolve())));

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; json: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers: { host: 'dashboard.example', ...options.headers, ...(options.body ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json: text ? JSON.parse(text) : undefined });
      });
    });
    request.on('error', reject); request.end(options.body);
  });
}

async function mutationHeaders(): Promise<Record<string, string>> {
  const session = await send('/api/v1/session');
  const cookie = String((session.headers['set-cookie'] as string[])[0]).split(';', 1)[0];
  return { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
}

describe('withPathIds', () => {
  it('lets the path id win and keeps the other body fields', () => {
    expect(withPathIds({ mode: 'status' }, { workspaceId: ws })).toEqual({ mode: 'status', workspaceId: ws });
    expect(withPathIds({ workspaceId: ws, mode: 'status' }, { workspaceId: ws })).toEqual({ workspaceId: ws, mode: 'status' });
  });

  it('treats a missing, null or array body as empty', () => {
    expect(withPathIds(undefined, { workspaceId: ws })).toEqual({ workspaceId: ws });
    expect(withPathIds(null, { workspaceId: ws })).toEqual({ workspaceId: ws });
    expect(withPathIds([otherWs], { workspaceId: ws })).toEqual({ workspaceId: ws });
  });

  it('refuses a body that names a different id, including a null or non-string one', () => {
    expect(() => withPathIds({ workspaceId: otherWs }, { workspaceId: ws })).toThrow(PathIdMismatchError);
    expect(() => withPathIds({ workspaceId: null }, { workspaceId: ws })).toThrow(PathIdMismatchError);
    expect(() => withPathIds({ workspaceId: 1 }, { workspaceId: ws })).toThrow(PathIdMismatchError);
  });
});

describe('dashboard BFF path id authority', () => {
  it.each(ROUTES)('%s %s refuses a body %s that differs from the URL', async (method, path, key, other) => {
    const headers = await mutationHeaders();
    const reply = await send(`/api/v1${path}`, { method, headers, body: JSON.stringify({ [key]: other }) });
    expect(reply.status).toBe(400);
    expect(reply.json).toEqual({ error: 'path_id_mismatch', message: `The request body names a different ${key} than the URL.` });
    expect(operations).toEqual([]);
  });

  it.each(MATCHING)('%s %s forwards %s when the body repeats the same id', async (method, path, operation, body, input) => {
    const headers = await mutationHeaders();
    const reply = await send(`/api/v1${path}`, { method, headers, body: JSON.stringify(body) });
    expect(reply.status).not.toBe(400);
    expect(operations).toEqual([{ operation, input }]);
  });

  it('forwards the path workspace when the body repeats the same id', async () => {
    const headers = await mutationHeaders();
    const reply = await send(`/api/v1/workspaces/${ws}/lease-renew`, { method: 'POST', headers, body: JSON.stringify({ workspaceId: ws, extensionSeconds: 600 }) });
    expect(reply.status).toBe(200);
    expect(operations).toEqual([{ operation: 'workspace_lease_renew', input: { workspaceId: ws, extensionSeconds: 600 } }]);
  });

  it('forwards the path secret scope when the body carries no ids', async () => {
    const headers = await mutationHeaders();
    const reply = await send(`/api/v1/environments/${env}/secrets/API_TOKEN`, { method: 'PATCH', headers, body: JSON.stringify({ expectedGeneration: 2 }) });
    expect(reply.status).toBe(200);
    expect(operations).toEqual([{ operation: 'secret_update', input: { expectedGeneration: 2, environmentId: env, name: 'API_TOKEN' } }]);
  });
});
