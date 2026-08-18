import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerConfigSchema, type RunnerOperation, type RunnerResponse } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentManager } from '../src/agent-manager.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agent-api-'));
  directories.push(root);
  const jobsRoot = join(root, 'jobs');
  const workspacePath = join(jobsRoot, `ws_${'w'.repeat(24)}`);
  mkdirSync(workspacePath, { recursive: true });
  const config = RunnerConfigSchema.parse({
    serviceToken: 's'.repeat(32), jobsRoot, stateDb: join(root, 'state.db'),
    executorImage: 'executor:test', allowedGitHosts: ['github.com']
  });
  const store = new StateStore(config.stateDb);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'w'.repeat(24)}`, ownerId: 'owner', idempotencyKey: 'workspace-key',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: null, workspacePath, status: 'ACTIVE', networkMode: 'none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 300_000, generation: 1, error: null
  };
  store.create(record);
  return { root, config, store, record };
}

function injectedManager(overrides: Partial<AgentManager> = {}): AgentManager {
  return {
    dispatch: vi.fn(async (_ownerId: string, _workspace: WorkspaceRecord, operation: RunnerOperation): Promise<RunnerResponse> => ({
      ok: true, message: operation, data: { routed: operation }, truncated: false
    })),
    stopWorkspace: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    fence: vi.fn(),
    ...overrides
  } as unknown as AgentManager;
}

describe('WorkspaceService agent dispatch', () => {
  it('routes every agent operation before workspace touch and generic executor fallback', async () => {
    const { config, store, record } = setup();
    const manager = injectedManager();
    const service = new WorkspaceService(config, store, { manager });
    const operations: Array<[RunnerOperation, Record<string, unknown>]> = [
      ['agent_status', { workspaceId: record.id, agentId: `agent_${'a'.repeat(24)}` }],
      ['agent_logs', { workspaceId: record.id, agentId: `agent_${'a'.repeat(24)}`, cursor: '0', limitBytes: 1_024 }],
      ['agent_message', { workspaceId: record.id, agentId: `agent_${'a'.repeat(24)}`, idempotencyKey: 'message-key', mode: 'steer', message: 'hello' }],
      ['agent_cancel', { workspaceId: record.id, agentId: `agent_${'a'.repeat(24)}` }],
      ['agent_list', { workspaceId: record.id, limit: 50 }],
      ['agent_spawn', {
        workspaceId: record.id, prompt: 'hello', idempotencyKey: 'spawn-key', profileId: 'default',
        proxyOperations: ['files_read'], ttlSeconds: 30, maxOutputBytes: 262_144,
        maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000
      }]
    ];
    for (const [operation, input] of operations) {
      await expect(service.execute('owner', operation, input)).resolves.toMatchObject({ data: { routed: operation } });
    }
    expect(manager.dispatch).toHaveBeenCalledTimes(6);
    expect(store.byId(record.id)?.lastActivityAt).toBe(record.lastActivityAt);
    store.close();
  });

  it('returns non-enumerating not-found before manager dispatch for a foreign owner', async () => {
    const { config, store, record } = setup();
    const manager = injectedManager();
    const service = new WorkspaceService(config, store, { manager });
    await expect(service.execute('foreign', 'agent_status', {
      workspaceId: record.id, agentId: `agent_${'a'.repeat(24)}`
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(manager.dispatch).not.toHaveBeenCalled();
    store.close();
  });

  it('claims REAPING and awaits agent cleanup before removing the workspace path and closing', async () => {
    const { config, store, record } = setup();
    const gate = Promise.withResolvers<void>();
    const stopWorkspace = vi.fn(async () => await gate.promise);
    const manager = injectedManager({ stopWorkspace } as Partial<AgentManager>);
    const service = new WorkspaceService(config, store, { manager });
    const closing = service.execute('owner', 'workspace_close', { workspaceId: record.id });
    await vi.waitFor(() => expect(stopWorkspace).toHaveBeenCalledOnce());
    expect(store.byId(record.id)?.status).toBe('REAPING');
    gate.resolve();
    await expect(closing).resolves.toMatchObject({ data: { status: 'CLOSED' } });
    expect(store.byId(record.id)?.status).toBe('CLOSED');
    store.close();
  });
});
