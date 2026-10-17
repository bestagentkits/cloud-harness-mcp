import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../scripts/deploy-canary.mjs');
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

type OpenArguments = { idempotencyKey: string; networkProfile?: string };
type DefaultOpen = 'ok' | 'egress-unavailable' | 'other-error';

/**
 * A minimal MCP endpoint with the runner's idempotency behaviour: a repeated key replays the stored
 * workspace, including a FAILED one, so a fallback that reuses the failed open's key cannot succeed.
 */
async function startStub(options: { defaultOpen: DefaultOpen; fallbackFails?: boolean }) {
  const opens: OpenArguments[] = [];
  const closed: string[] = [];
  const byKey = new Map<string, { workspaceId: string; status: string; networkProfile: string }>();
  const ok = (data: unknown) => ({ structuredContent: { ok: true, data } });
  const failed = (code: string, workspace?: unknown) => ({
    isError: true,
    content: [{ type: 'text', text: `${code} ${JSON.stringify(workspace ?? {})}` }]
  });

  function openWorkspace(args: OpenArguments) {
    opens.push(args);
    const prior = byKey.get(args.idempotencyKey);
    if (prior) return prior.status === 'ACTIVE' ? ok(prior) : failed('Idempotent workspace result', prior);
    const workspace = { workspaceId: `ws_${opens.length}`, status: 'ACTIVE', networkProfile: args.networkProfile ?? 'dependency-access' };
    byKey.set(args.idempotencyKey, workspace);
    const outcome = args.networkProfile ? (options.fallbackFails ? 'other-error' : 'ok') : options.defaultOpen;
    if (outcome === 'ok') return ok({ ...workspace, capabilities: { workspace: { networkProfile: workspace.networkProfile } } });
    workspace.status = 'FAILED';
    return failed(outcome === 'egress-unavailable' ? 'DEPENDENCY_EGRESS_UNAVAILABLE' : 'UNAVAILABLE');
  }

  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      let result: unknown;
      if (method === 'server/discover') result = { supportedVersions: ['2026-07-28'] };
      else if (method === 'tools/list') result = { tools: [{ name: 'workspace_open' }] };
      else if (params.name === 'workspace_open') result = openWorkspace(params.arguments);
      else if (params.name === 'exec_run') result = ok({ stdout: '10001\n' });
      else if (params.name === 'workspace_close') { closed.push(params.arguments.workspaceId); result = ok({}); }
      else result = ok({});
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, opens, closed };
}

function runCanary(url: string): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, MCP_CANARY_URL: url, MCP_BEARER_TOKEN: 'canary-test-token' }
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => done({ code, output }));
  });
}

describe('deploy canary', () => {
  it('opens once with the instance default when it succeeds', async () => {
    const stub = await startStub({ defaultOpen: 'ok' });
    const result = await runCanary(stub.url);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('deploy-canary-network-profile=instance-default');
    expect(result.output).toContain('deploy-canary=pass');
    expect(stub.opens).toHaveLength(1);
    expect(stub.opens[0]!.networkProfile).toBeUndefined();
    expect(stub.closed).toEqual(['ws_1']);
  });

  it('falls back to a fresh network-none workspace under its own key when egress is unattested', async () => {
    const stub = await startStub({ defaultOpen: 'egress-unavailable' });
    const result = await runCanary(stub.url);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('deploy-canary-network-profile=network-none-fallback');
    expect(result.output).toContain('deploy-canary=pass');
    expect(stub.opens).toHaveLength(2);
    expect(stub.opens[1]!.networkProfile).toBe('network-none');
    expect(stub.opens[1]!.idempotencyKey).not.toBe(stub.opens[0]!.idempotencyKey);
    expect(stub.closed).toEqual(['ws_2']);
  });

  it('does not fall back on a failure other than unattested egress', async () => {
    const stub = await startStub({ defaultOpen: 'other-error' });
    const result = await runCanary(stub.url);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('deploy-canary=pass');
    expect(stub.opens).toHaveLength(1);
  });

  it('still fails the gate when the network-none fallback fails', async () => {
    const stub = await startStub({ defaultOpen: 'egress-unavailable', fallbackFails: true });
    const result = await runCanary(stub.url);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('deploy-canary-fallback=unattested-dependency-egress');
    expect(result.output).not.toContain('deploy-canary=pass');
    expect(stub.opens).toHaveLength(2);
  });
});
