import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { createRunnerApp } from '../src/app.js';
import type { WorkspaceService } from '../src/workspace-service.js';
import type { DashboardControlService } from '../src/dashboard-control-service.js';

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

async function start(service: Pick<WorkspaceService, 'execute' | 'executeInternal'>, controls?: Pick<DashboardControlService, 'execute'>) {
  const config = { serviceToken: 'runner-token-that-is-longer-than-32-characters' } as RunnerConfig;
  server = createServer(createRunnerApp(config, service as WorkspaceService, controls as DashboardControlService | undefined));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('runner test server did not bind');
  return { url: `http://127.0.0.1:${address.port}`, token: config.serviceToken };
}

describe('internal runner HTTP boundary', () => {
  it('serves internal operations only on the service-authenticated endpoint', async () => {
    const execute = vi.fn();
    const executeInternal = vi.fn(async () => ({ ok: true, message: 'Workspace detail', data: { workspaceId: `ws_${'a'.repeat(24)}`, generation: 7 }, truncated: false }));
    const { url, token } = await start({ execute, executeInternal } as Pick<WorkspaceService, 'execute' | 'executeInternal'>);
    const body = {
      version: 2,
      principal: { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' },
      operation: 'workspace_detail',
      input: { workspaceId: `ws_${'a'.repeat(24)}` }
    };

    const unauthenticated = await fetch(`${url}/v1/internal/dashboard-operations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(unauthenticated.status).toBe(401);

    const internal = await fetch(`${url}/v1/internal/dashboard-operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(internal.status).toBe(200);
    expect(await internal.json()).toMatchObject({ ok: true, data: { generation: 7 } });
    expect(executeInternal).toHaveBeenCalledWith(body.principal, 'workspace_detail', body.input);

    const publicResponse = await fetch(`${url}/v1/operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(publicResponse.status).toBe(400);
    expect(await publicResponse.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps metadata controls on the authenticated internal endpoint', async () => {
    const execute = vi.fn(); const executeInternal = vi.fn();
    const controls = { execute: vi.fn(async () => ({ ok: true, message: 'Projects listed', data: { projects: [] }, truncated: false })) };
    const { url, token } = await start({ execute, executeInternal }, controls);
    const body = { version: 2, principal: { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' }, operation: 'project_list', input: {} };
    const internal = await fetch(`${url}/v1/internal/dashboard-operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(internal.status).toBe(200);
    expect(await internal.json()).toMatchObject({ ok: true, data: { projects: [] } });
    expect(controls.execute).toHaveBeenCalledWith(body);

    const publicResponse = await fetch(`${url}/v1/operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(publicResponse.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});
