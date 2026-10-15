import { describe, expect, it } from 'vitest';
import type { McpGatewayServerView, McpGatewayToolView, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import type { RunnerClient } from '../src/runner-client.js';
import type { GatewayConnectionManager } from '../src/mcp-gateway/connection-manager.js';
import { McpGatewayService } from '../src/mcp-gateway/service.js';

const principal: RunnerPrincipalSelector = { kind: 'owner', ownerId: 'owner' };

const server: McpGatewayServerView = {
  id: `mcps_${'a'.repeat(24)}`, principalId: 'owner', name: 'fleet', description: null, transport: 'streamable-http',
  endpoint: 'https://upstream.test/mcp', headers: [], enabled: true, status: 'unknown', toolCount: 0,
  lastConnectedAt: null, lastError: null, lastCheckedAt: null, permissionDefault: 'allow', generation: 1, createdAt: 1, updatedAt: 1
};

function tool(name: string, description: string, permission: 'allow' | 'deny' = 'allow', index = 0): McpGatewayToolView {
  return {
    id: `mcpt_${String(index).padStart(24, '0')}`, principalId: 'owner', serverId: server.id, serverName: server.name,
    qualifiedName: `fleet.${name}`, upstreamName: name, description, inputSchema: { type: 'object' }, annotations: null,
    availability: 'available', permission, discoveredAt: 1
  };
}

const TOOLS = [
  tool('container_run', 'Run a docker container for the app', 'allow', 1),
  tool('pages_publish', 'Publish static app pages to production', 'allow', 2),
  tool('create_deployment', 'Create a deployment record for the app', 'allow', 3),
  tool('app_delete', 'Delete the app in production', 'deny', 4)
];

function fakeRunner(rerank: (input: Record<string, unknown>) => RunnerResponse | Promise<RunnerResponse>) {
  const rerankCalls: Record<string, unknown>[] = [];
  const runner = {
    async callInternal(operation: string, input: Record<string, unknown>): Promise<RunnerResponse> {
      if (operation === 'mcp_gateway_catalog') return { ok: true, message: 'catalog', data: { servers: [server], tools: TOOLS }, truncated: false };
      if (operation === 'decision_rerank_tools') {
        rerankCalls.push(input);
        return await rerank(input);
      }
      return { ok: true, message: 'ok', data: {}, truncated: false };
    }
  } as unknown as RunnerClient;
  return { runner, rerankCalls };
}

const connections = { withConnection: async () => undefined, health: () => 'unknown', invalidate: () => undefined, closeAll: async () => undefined } as unknown as GatewayConnectionManager;

function service(runner: RunnerClient): McpGatewayService {
  return new McpGatewayService(runner, connections, { timeoutMs: 2_000, maxResponseBytes: 262_144, maxToolsPerServer: 500, maxSchemaBytes: 65_536, maxCatalogBytes: 2_097_152 });
}

type SearchData = { results: Array<{ tool: string; score: number }>; ranking: string; decisionId?: string };

describe('McpGatewayService: semantic rerank', () => {
  it('reorders only the permission-filtered lexical pool and reports the semantic ranking', async () => {
    const { runner, rerankCalls } = fakeRunner((input) => {
      const names = (input.candidates as Array<{ tool: string }>).map((candidate) => candidate.tool);
      const ordering = ['fleet.pages_publish', ...names.filter((name) => name !== 'fleet.pages_publish')];
      return { ok: true, message: 'applied', data: { applied: true, decisionId: 'dec_1', ordering, relevance: { 'fleet.pages_publish': 0.93 } }, truncated: false };
    });
    const result = await service(runner).search(principal, { query: 'deploy the app to production', limit: 2 });
    const data = result.data as SearchData;
    expect(data.ranking).toBe('semantic');
    expect(data.decisionId).toBe('dec_1');
    expect(data.results.map((entry) => entry.tool)[0]).toBe('fleet.pages_publish');
    expect(data.results[0]!.score).toBe(0.93);
    expect(data.results).toHaveLength(2);
    // The denied tool never reaches the Decision Plane, so no ranking can surface it.
    const offered = (rerankCalls[0]!.candidates as Array<{ tool: string }>).map((candidate) => candidate.tool);
    expect(offered).not.toContain('fleet.app_delete');
  });

  it.each([
    ['adds a tool outside the pool', ['fleet.app_delete', 'fleet.container_run', 'fleet.pages_publish']],
    ['drops a pool tool', ['fleet.pages_publish']],
    ['repeats a tool', ['fleet.pages_publish', 'fleet.pages_publish', 'fleet.container_run']]
  ])('keeps the lexical order when the ordering %s', async (_label, ordering) => {
    const { runner } = fakeRunner(() => ({ ok: true, message: 'applied', data: { applied: true, decisionId: 'dec_x', ordering, relevance: {} }, truncated: false }));
    const lexical = await service(fakeRunner(() => ({ ok: true, message: 'off', data: { applied: false }, truncated: false })).runner)
      .search(principal, { query: 'deploy the app to production', limit: 5 });
    const result = await service(runner).search(principal, { query: 'deploy the app to production', limit: 5 });
    const data = result.data as SearchData;
    expect(data.ranking).toBe('lexical');
    expect(data.results.map((entry) => entry.tool)).not.toContain('fleet.app_delete');
    expect(data.results).toEqual((lexical.data as SearchData).results);
  });

  it('keeps the lexical order when the runner fails, throws, or the plane is disabled', async () => {
    const failing = [
      () => ({ ok: false, message: 'down', error: { code: 'UNAVAILABLE' as const, message: 'down', retryable: true }, truncated: false }),
      () => { throw new Error('socket hang up'); },
      () => ({ ok: true, message: 'off', data: { applied: false, decisionId: null, ordering: [], relevance: {}, reason: 'purpose_disabled' }, truncated: false })
    ];
    for (const rerank of failing) {
      const { runner } = fakeRunner(rerank);
      const result = await service(runner).search(principal, { query: 'deploy the app to production', limit: 5 });
      expect(result.ok).toBe(true);
      expect((result.data as SearchData).ranking).toBe('lexical');
      expect((result.data as SearchData).results.length).toBeGreaterThan(0);
    }
  });

  it('does not ask for a rerank when lexical search found fewer than two candidates', async () => {
    const { runner, rerankCalls } = fakeRunner(() => ({ ok: true, message: 'x', data: {}, truncated: false }));
    const result = await service(runner).search(principal, { query: 'docker', limit: 5 });
    expect((result.data as SearchData).ranking).toBe('lexical');
    expect(rerankCalls).toHaveLength(0);
  });
});
