import { createServer, request as httpRequest, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { createDashboardRouter } from '../src/dashboard-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';

// The cockpit's Automation tab runs one named hook against the manifest digest it rendered, and
// lists skills without the runner's host paths.

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

const ws = `ws_${'a'.repeat(24)}`;
const digest = 'c'.repeat(64);

let httpServer: Server;
let port: number;
let calls: Array<{ operation: string; input: Record<string, unknown> }>;

beforeEach(async () => {
  calls = [];
  const respond = async (operation: string, input: Record<string, unknown>): Promise<RunnerResponse> => {
    calls.push({ operation, input });
    if (operation === 'skills_list') {
      return { ok: true, message: 'ok', truncated: false, data: { skills: [{ name: 'build', source: 'owner', root: '/opt/skills', contentSha256: digest, shadowed: [{ source: 'repository', root: '/workspace/repo/.cloud-harness/skills', contentSha256: 'd'.repeat(64), reason: 'Shadowed by higher-precedence owner skill in /opt/skills' }] }] } };
    }
    return { ok: true, message: 'ok', truncated: false, data: { output: 'done', exitCode: 0 } };
  };
  const runner: DashboardRunnerClient = { call: vi.fn(respond), callInternal: vi.fn(respond) };
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

describe('dashboard automation BFF', () => {
  it('lists shadowed skills by source and digest only, without runner paths', async () => {
    const reply = await send(`/api/v1/workspaces/${ws}/skills`);
    expect(reply.status).toBe(200);
    expect(reply.json.data.skills).toEqual([{ name: 'build', source: 'owner', contentSha256: digest, shadowed: [{ source: 'repository', contentSha256: 'd'.repeat(64) }] }]);
    expect(JSON.stringify(reply.json)).not.toContain('/opt/skills');
    expect(JSON.stringify(reply.json)).not.toContain('/workspace/repo');
  });

  it('forwards a named hook run with the manifest digest the page rendered', async () => {
    const headers = await mutationHeaders();
    const manifest = 'b'.repeat(64);
    const reply = await send(`/api/v1/workspaces/${ws}/hooks/run`, { method: 'POST', headers, body: JSON.stringify({ name: 'format', expectedManifestSha256: manifest }) });
    expect(reply.status).toBe(200);
    expect(calls).toEqual([{ operation: 'hooks_run', input: { workspaceId: ws, name: 'format', expectedManifestSha256: manifest, timeoutMs: 60_000 } }]);
    // The old form's `{ event }` body never named a hook or a digest, so the contract refused it.
    const legacy = await send(`/api/v1/workspaces/${ws}/hooks/run`, { method: 'POST', headers, body: JSON.stringify({ event: 'manual' }) });
    expect(legacy.status).toBe(400);
  });

  it('refuses a hook run without a CSRF token before the runner sees it', async () => {
    const headers = await mutationHeaders();
    delete headers['x-csrf-token'];
    const reply = await send(`/api/v1/workspaces/${ws}/hooks/run`, { method: 'POST', headers, body: JSON.stringify({ name: 'format', expectedManifestSha256: 'b'.repeat(64) }) });
    expect(reply.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
