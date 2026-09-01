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
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 2_000, maxBodyBytes: 65_536
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };
let server: Server;
let port: number;
let runner: DashboardRunnerClient;
let calls: Array<{ operation: string; input: Record<string, unknown>; principal: RunnerPrincipalSelector }>;
let csrfHeaders: Record<string, string>;

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const bodyBuf = options.body ? Buffer.from(options.body, 'utf8') : undefined;
  const headers: Record<string, string> = { host: 'dashboard.example', ...options.headers };
  if (bodyBuf && !headers['content-length'] && !headers['Content-Length']) {
    headers['content-length'] = String(bodyBuf.byteLength);
  }
  const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      resolve({ status: response.statusCode ?? 500, headers: response.headers as Record<string, string | string[] | undefined>, text, json });
    });
  });
  request.on('error', reject);
  request.end(options.body);
  return promise;
}

beforeEach(async () => {
  calls = [];
  runner = {
    call: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      return { ok: true, message: 'ok', truncated: false, data: {} };
    }),
    callInternal: vi.fn(async (operation, input, selected): Promise<RunnerResponse> => {
      calls.push({ operation, input, principal: selected });
      if (operation === 'knowledge_dashboard_list') {
        return {
          ok: true, message: 'listed', truncated: false, data: {
            items: [{
              id: 'kn_123456789012', kind: 'memory', scope: 'owner', title: 'Arch', content: 'Design',
              contentSha256: 'a'.repeat(64), generation: 1, createdAt: 1000, updatedAt: 1000, tags: ['arch']
            }]
          }
        };
      }
      if (operation === 'knowledge_dashboard_get') {
        return {
          ok: true, message: 'retrieved', truncated: false, data: {
            id: 'kn_123456789012', kind: 'memory', scope: 'owner', title: 'Arch', content: 'Design',
            contentSha256: 'a'.repeat(64), generation: 1, createdAt: 1000, updatedAt: 1000, tags: ['arch'],
            outboundLinks: [], backlinks: []
          }
        };
      }
      if (operation === 'knowledge_dashboard_create') {
        return {
          ok: true, message: 'created', truncated: false, data: {
            id: 'kn_created1234', kind: input.kind ?? 'memory', scope: input.scope ?? 'owner',
            title: input.title, content: input.content, contentSha256: 'b'.repeat(64),
            generation: 1, createdAt: 2000, updatedAt: 2000, tags: input.tags ?? []
          }
        };
      }
      if (operation === 'knowledge_dashboard_update') {
        if (input.expectedGeneration === 1) {
          return {
            ok: true, message: 'updated', truncated: false, data: {
              id: input.id, kind: 'memory', scope: 'owner', title: 'Updated Arch', content: input.content,
              contentSha256: 'c'.repeat(64), generation: 2, createdAt: 1000, updatedAt: 3000, tags: ['v2']
            }
          };
        }
        return {
          ok: false, message: 'generation conflict', truncated: false,
          error: { code: 'CONFLICT', message: 'generation conflict', retryable: false }
        };
      }
      if (operation === 'knowledge_dashboard_delete') {
        return { ok: true, message: 'deleted', truncated: false, data: { deleted: true } };
      }
      if (operation === 'knowledge_dashboard_search') {
        return {
          ok: true, message: 'search results', truncated: false, data: {
            results: [{
              item: { id: 'kn_123456789012', kind: 'memory', scope: 'owner', title: 'Arch', content: 'Design' },
              relevancePercent: 95, matchMode: 'hybrid'
            }]
          }
        };
      }
      if (operation === 'knowledge_dashboard_graph') {
        return {
          ok: true, message: 'graph', truncated: false, data: {
            nodes: [{ id: 'kn_123456789012', kind: 'memory', scope: 'owner', title: 'Arch', tags: ['arch'], updatedAt: 1000 }],
            edges: [], truncated: false
          }
        };
      }
      return { ok: true, message: 'ok', truncated: false, data: {} };
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

  const session = await send('/api/v1/session');
  const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0]!;
  csrfHeaders = {
    origin: 'https://dashboard.example',
    cookie,
    'content-type': 'application/json',
    'x-csrf-token': session.json.csrfToken
  };
});

afterEach(async () => await new Promise<void>((resolve) => server.close(() => resolve())));

describe('Dashboard Knowledge REST API', () => {
  it('GET /api/v1/knowledge lists items and filters', async () => {
    const res = await send('/api/v1/knowledge?kind=memory&tags=arch');
    expect(res.status).toBe(200);
    expect(res.json.data.items.length).toBe(1);
    expect(res.json.data.items[0].id).toBe('kn_123456789012');
    expect(res.json.data.items[0].title).toBe('Arch');
    expect(calls[0].operation).toBe('knowledge_dashboard_list');
    expect(calls[0].input).toMatchObject({ kind: 'memory', tags: ['arch'] });
  });

  it('GET /api/v1/knowledge/:id retrieves single item', async () => {
    const res = await send('/api/v1/knowledge/kn_123456789012');
    expect(res.status).toBe(200);
    expect(res.json.data.id).toBe('kn_123456789012');
    expect(calls[0].operation).toBe('knowledge_dashboard_get');
    expect(calls[0].input).toMatchObject({ id: 'kn_123456789012' });
  });

  it('POST /api/v1/knowledge creates item with origin and session header', async () => {
    const res = await send('/api/v1/knowledge', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({
        kind: 'memory',
        scope: 'owner',
        title: 'New Memory',
        content: '# Hello',
        expectedGeneration: 0
      })
    });
    expect(res.status).toBe(200);
    expect(res.json.data.id).toBe('kn_created1234');
    expect(calls.at(-1)?.operation).toBe('knowledge_dashboard_create');
  });

  it('PUT /api/v1/knowledge/:id updates item with CAS, returns 409 on generation conflict', async () => {
    const successRes = await send('/api/v1/knowledge/kn_123456789012', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ content: 'Updated', expectedGeneration: 1 })
    });
    expect(successRes.status).toBe(200);
    expect(successRes.json.data.generation).toBe(2);

    const conflictRes = await send('/api/v1/knowledge/kn_123456789012', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ content: 'Conflict update', expectedGeneration: 99 })
    });
    expect(conflictRes.status).toBe(409);
  });

  it('DELETE /api/v1/knowledge/:id deletes item with generation', async () => {
    const res = await send('/api/v1/knowledge/kn_123456789012', {
      method: 'DELETE',
      headers: csrfHeaders,
      body: JSON.stringify({ expectedGeneration: 1 })
    });
    expect(res.status).toBe(200);
    expect(res.json.data.deleted).toBe(true);
  });

  it('POST /api/v1/knowledge/search runs search', async () => {
    const res = await send('/api/v1/knowledge/search', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ query: 'database' })
    });
    expect(res.status).toBe(200);
    expect(res.json.data.results.length).toBe(1);
    expect(res.json.data.results[0].relevancePercent).toBe(95);
  });

  it('GET /api/v1/knowledge-graph retrieves graph', async () => {
    const res = await send('/api/v1/knowledge-graph?depth=2&maxNodes=30');
    expect(res.status).toBe(200);
    expect(res.json.data.nodes.length).toBe(1);
    expect(calls[0].operation).toBe('knowledge_dashboard_graph');
    expect(calls[0].input).toMatchObject({ depth: 2, maxNodes: 30 });
  });
});
