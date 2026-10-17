import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { createRunnerApp } from '../src/app.js';
import type { WorkspaceService } from '../src/workspace-service.js';
import type { DashboardControlService } from '../src/dashboard-control-service.js';

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

async function start(service: Pick<WorkspaceService, 'execute' | 'executeInternal'>, controls?: Partial<Pick<DashboardControlService, 'execute' | 'executeModelTool'>>) {
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
    expect(executeInternal).toHaveBeenCalledWith(body.principal, 'workspace_detail', body.input, expect.any(AbortSignal));

    const publicResponse = await fetch(`${url}/v1/operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(publicResponse.status).toBe(400);
    expect(await publicResponse.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('aborts an internal operation when the caller disconnects', async () => {
    let observed: AbortSignal | undefined;
    const executeInternal = vi.fn((_principal: unknown, _operation: unknown, _input: unknown, signal?: AbortSignal) => new Promise((resolve) => {
      observed = signal;
      signal?.addEventListener('abort', () => resolve({ ok: true, message: 'Terminal output', data: {}, truncated: false }), { once: true });
    }));
    const { url, token } = await start({ execute: vi.fn(), executeInternal } as unknown as Pick<WorkspaceService, 'execute' | 'executeInternal'>);
    const body = {
      version: 2,
      principal: { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' },
      operation: 'terminal_read',
      input: { workspaceId: `ws_${'a'.repeat(24)}`, terminalId: `term_${'b'.repeat(24)}`, cursor: '0', waitMs: 20_000 }
    };
    const client = new AbortController();
    const request = fetch(`${url}/v1/internal/dashboard-operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: client.signal
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(executeInternal).toHaveBeenCalledTimes(1));
    expect(observed?.aborted).toBe(false);
    client.abort();
    await request;
    await vi.waitFor(() => expect(observed?.aborted).toBe(true));
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

  it('accepts an archive-sized body on the internal endpoint but keeps the small default elsewhere', async () => {
    const execute = vi.fn(); const executeInternal = vi.fn();
    const controls = { execute: vi.fn(async () => ({ ok: true, message: 'Imported', data: { results: [] }, truncated: false })) };
    const { url, token } = await start({ execute, executeInternal }, controls);
    // A base64 archive at the 8 MiB cap is ~10.7 MiB, far above the 1 MiB default every other route keeps.
    const archiveBase64 = 'A'.repeat(11_184_816);
    const body = { version: 2, principal: { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' }, operation: 'skill_archive_import', input: { archiveBase64, expectedGeneration: 0 } };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const internal = await fetch(`${url}/v1/internal/dashboard-operations`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(internal.status).toBe(200);
    expect(controls.execute).toHaveBeenCalledTimes(1);

    const publicResponse = await fetch(`${url}/v1/operations`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(publicResponse.status).toBe(413);

    // The larger allowance sits behind service authentication, so it is not an unauthenticated parse.
    const unauthenticated = await fetch(`${url}/v1/internal/dashboard-operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(unauthenticated.status).toBe(401);
  });

  it('exposes the first Zod validation issue on the internal endpoint', async () => {
    const controls = {
      execute: vi.fn(() => {
        throw new ZodError([{ code: 'custom', message: 'secret name GH_TOKEN is reserved for the control plane or system toolchains', path: ['input', 'name'] }]);
      })
    };
    const { url, token } = await start({ execute: vi.fn(), executeInternal: vi.fn() }, controls);
    const body = {
      version: 2,
      principal: { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' },
      operation: 'global_secret_create',
      input: { name: 'GH_TOKEN', value: 'abcd', expectedGeneration: 0 }
    };
    const response = await fetch(`${url}/v1/internal/dashboard-operations`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe('INVALID_INPUT');
    expect(json.message).toContain('reserved');
    expect(json.error.message).toContain('reserved');
  });
});

describe('public model tool routing', () => {
  const principal = { kind: 'external', issuer: 'https://access.example.com', subject: 'owner' };
  const post = async (url: string, token: string, operation: string, input: Record<string, unknown>) => await fetch(`${url}/v1/operations`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 2, principal, operation, input })
  });

  it('sends a model tool to the control service and every other tool to the workspace service', async () => {
    const execute = vi.fn(async () => ({ ok: true, message: 'Workspace listed', data: { workspaces: [] }, truncated: false }));
    const executeModelTool = vi.fn(async () => ({ ok: true, message: 'Agent model profiles listed', data: { profiles: [] }, truncated: false }));
    const controls = { execute: vi.fn(), executeModelTool };
    const { url, token } = await start({ execute, executeInternal: vi.fn() } as unknown as Pick<WorkspaceService, 'execute' | 'executeInternal'>, controls);

    const model = await post(url, token, 'model_profile_list', {});
    expect(model.status).toBe(200);
    expect(await model.json()).toMatchObject({ ok: true, data: { profiles: [] } });
    expect(executeModelTool).toHaveBeenCalledWith(principal, 'model_profile_list', {});
    expect(execute).not.toHaveBeenCalled();
    // The Dashboard's metadata entry point is not used for public calls.
    expect(controls.execute).not.toHaveBeenCalled();

    const workspace = await post(url, token, 'workspace_list', {});
    expect(workspace.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, 'workspace_list', {}, expect.any(AbortSignal));
    expect(executeModelTool).toHaveBeenCalledTimes(1);
  });

  it('answers UNAVAILABLE for a model tool on a runner without the control service', async () => {
    const execute = vi.fn();
    const { url, token } = await start({ execute, executeInternal: vi.fn() } as unknown as Pick<WorkspaceService, 'execute' | 'executeInternal'>);
    const response = await post(url, token, 'model_spend_summary', {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps model credential, lifecycle, and spend policy operations off the public endpoint', async () => {
    const executeModelTool = vi.fn();
    const { url, token } = await start({ execute: vi.fn(), executeInternal: vi.fn() } as unknown as Pick<WorkspaceService, 'execute' | 'executeInternal'>, { execute: vi.fn(), executeModelTool });
    for (const operation of ['model_credential_create', 'model_profile_activate', 'model_profile_delete', 'model_spend_policy_set']) {
      const response = await post(url, token, operation, {});
      expect(response.status, operation).toBe(400);
      expect(await response.json(), operation).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect(executeModelTool).not.toHaveBeenCalled();
  });

  it('carries an owner-approval refusal and its resume action to the caller', async () => {
    const executeModelTool = vi.fn(async () => {
      throw new HarnessError('OWNER_APPROVAL_REQUIRED', 'needs the owner', 403, false, { resumeAction: 'dashboard:models' });
    });
    const { url, token } = await start({ execute: vi.fn(), executeInternal: vi.fn() } as unknown as Pick<WorkspaceService, 'execute' | 'executeInternal'>, { execute: vi.fn(), executeModelTool });
    const response = await post(url, token, 'model_profile_update', {});
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'OWNER_APPROVAL_REQUIRED', retryable: false, resumeAction: 'dashboard:models' } });
  });
});
