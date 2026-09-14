import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, InternalRunnerRequest, MetadataRunnerRequest } from '@cloud-harness/contracts';
import { RunnerClient } from '../src/runner-client.js';

const config = {
  runnerUrl: 'http://runner:3001', runnerToken: 'runner-token-that-is-longer-than-32-characters',
  requestTimeoutMs: 2_000,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
} as ApiConfig;

afterEach(() => vi.unstubAllGlobals());

describe('RunnerClient internal operations', () => {
  it('uses the internal endpoint and v2 principal for generation-fenced close', async () => {
    let url = '';
    let request: InternalRunnerRequest | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      url = String(input);
      request = JSON.parse(String(init?.body)) as InternalRunnerRequest;
      return new Response(JSON.stringify({ ok: true, message: 'Workspace closed', truncated: false }), { status: 200 });
    }));
    const client = new RunnerClient(config);
    const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'owner' };
    const workspaceId = `ws_${'a'.repeat(24)}`;

    await client.closeWorkspaceFenced(workspaceId, 8, principal);

    expect(url).toBe('http://runner:3001/v1/internal/dashboard-operations');
    expect(request).toEqual({
      version: 2, principal, operation: 'workspace_close_fenced', input: { workspaceId, expectedGeneration: 8 }
    });
  });

  it('validates metadata operations and uses the same internal endpoint', async () => {
    let request: MetadataRunnerRequest | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as MetadataRunnerRequest;
      return new Response(JSON.stringify({ ok: true, message: 'Projects listed', data: { projects: [] }, truncated: false }), { status: 200 });
    }));
    const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'owner' };
    await new RunnerClient(config).callInternal('project_list', {}, principal);
    expect(request).toEqual({ version: 2, principal, operation: 'project_list', input: {} });
  });
});
