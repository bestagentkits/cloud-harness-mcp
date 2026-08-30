import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { executeInternalRunnerOperation } from '../src/internal-runner-operations.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-internal-operations-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  const workspacePath = join(jobsRoot, `ws_${'a'.repeat(24)}`);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });
  const config = { jobsRoot, stateDb: join(directory, 'state.db') } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'owner' };
  const ownerId = store.resolvePrincipal(principal);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'a'.repeat(24)}`, ownerId, idempotencyKey: 'dashboard-workspace',
    repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
    containerName: null, workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 4, error: null
  };
  store.create(record);
  return { principal, record, store, service: new WorkspaceService(config, store) };
}

describe('internal runner operations', () => {
  it('returns a safe workspace detail with a generation fence', async () => {
    const { principal, record, service, store } = fixture();
    try {
      const result = await executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_detail', input: { workspaceId: record.id }
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ workspaceId: record.id, generation: 4, repositoryUrl: record.repositoryUrl });
      expect(result.data).not.toHaveProperty('ownerId');
      expect(result.data).not.toHaveProperty('containerName');
      expect(result.data).not.toHaveProperty('workspacePath');
    } finally { store.close(); }
  });

  it('never closes a newer lifecycle with a stale generation', async () => {
    const { principal, record, service, store } = fixture();
    try {
      await expect(executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_close_fenced',
        input: { workspaceId: record.id, expectedGeneration: record.generation - 1 }
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(store.byId(record.id)).toMatchObject({ status: 'ACTIVE', generation: 4 });
    } finally { store.close(); }
  });

  it('closes only after claiming the exact generation', async () => {
    const { principal, record, service, store } = fixture();
    try {
      const result = await executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_close_fenced',
        input: { workspaceId: record.id, expectedGeneration: record.generation }
      });
      expect(result.ok).toBe(true);
      expect(store.byId(record.id)).toMatchObject({ status: 'CLOSED', generation: record.generation + 1 });
    } finally { store.close(); }
  });

  it('reports an expired lifecycle without attempting another close', async () => {
    const { principal, record, service, store } = fixture();
    try {
      store.update(record.id, { status: 'CLOSED', generation: record.generation + 1, expiresAt: Date.now() });
      await expect(executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_close_fenced',
        input: { workspaceId: record.id, expectedGeneration: record.generation }
      })).rejects.toMatchObject({ code: 'EXPIRED' });
      expect(store.byId(record.id)).toMatchObject({ status: 'CLOSED', generation: record.generation + 1 });
    } finally { store.close(); }
  });
});
