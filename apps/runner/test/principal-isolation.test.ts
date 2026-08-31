import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function record(ownerId: string): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${'a'.repeat(24)}`, ownerId, idempotencyKey: 'request-1234',
    repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git', repositoryRef: null,
    containerName: null, workspacePath: '/tmp/example', status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null
  };
}

describe('runner principal isolation', () => {
  it('returns the same not-found error for missing and foreign workspace handles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-principal-isolation-'));
    temporaryDirectories.push(directory);
    const config = {
      jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db')
    } as RunnerConfig;
    const store = new StateStore(config.stateDb);
    const owner = store.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
    const foreign = store.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'foreign' });
    const workspace = record(owner);
    store.create(workspace);
    const service = new WorkspaceService(config, store);

    const capture = (action: () => unknown) => {
      try { action(); } catch (error) {
        const value = error as { code?: string; status?: number; message?: string };
        return { code: value.code, status: value.status, message: value.message };
      }
      throw new Error('expected operation to fail');
    };
    expect(capture(() => service.status(foreign, workspace.id))).toEqual(
      capture(() => service.status(foreign, `ws_${'b'.repeat(24)}`))
    );
    expect(service.status(owner, workspace.id).ok).toBe(true);
    store.close();
  });

  it('gates workspace, shell, session, and task handles before operation lookup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-principal-isolation-'));
    temporaryDirectories.push(directory);
    const config = {
      jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'), maxOutputBytes: 262_144
    } as RunnerConfig;
    const store = new StateStore(config.stateDb);
    const owner = store.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
    const foreign = store.resolvePrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'foreign' });
    const workspace = record(owner);
    store.create(workspace);
    const service = new WorkspaceService(config, store);
    const missingWorkspaceId = `ws_${'b'.repeat(24)}`;
    const cases = [
      ['files_read', { path: 'README.md', offset: 0, limit: 1_024 }],
      ['shell_io', { shellId: `sh_${'c'.repeat(24)}`, input: '', waitMs: 0 }],
      ['sessions_io', { sessionId: `ses_${'d'.repeat(24)}`, input: '', waitMs: 0 }],
      ['tasks_status', { taskId: `task_${'e'.repeat(24)}` }]
    ] as const;
    const capture = async (operation: string, input: Record<string, unknown>, workspaceId: string) => {
      try {
        await service.execute(foreign, operation as Parameters<WorkspaceService['execute']>[1], { workspaceId, ...input });
      } catch (error) {
        const value = error as { code?: string; status?: number; message?: string };
        return { code: value.code, status: value.status, message: value.message };
      }
      throw new Error('expected operation to fail');
    };
    for (const [operation, input] of cases) {
      expect(await capture(operation, input, workspace.id)).toEqual(await capture(operation, input, missingWorkspaceId));
    }
    store.close();
  });

  it('fails startup before Docker reconciliation when a configured legacy mapping is ambiguous', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-principal-isolation-'));
    temporaryDirectories.push(directory);
    const config = {
      jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db'),
      authMode: 'cloudflare-access',
      legacyPrincipalMapping: {
        legacyOwnerId: 'owner', issuer: 'https://access.example.com', subject: 'subject-123'
      }
    } as RunnerConfig;
    const store = new StateStore(config.stateDb);
    store.create(record('owner'));
    store.create({ ...record('other-owner'), id: `ws_${'b'.repeat(24)}`, idempotencyKey: 'other-request' });
    const service = new WorkspaceService(config, store);

    await expect(service.start()).rejects.toThrow('unmapped legacy workspace owners remain');
    expect(store.principalByExternalIdentity(config.legacyPrincipalMapping!)).toBeUndefined();
    store.close();
  });

  it('fails Access startup with legacy rows and no exact mapping', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-principal-isolation-'));
    temporaryDirectories.push(directory);
    const config = {
      authMode: 'cloudflare-access', jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state.db')
    } as RunnerConfig;
    const store = new StateStore(config.stateDb);
    store.create(record('owner'));
    const service = new WorkspaceService(config, store);

    await expect(service.start()).rejects.toThrow('requires an exact legacy principal mapping');
    expect(store.legacyWorkspaceOwnerIds()).toEqual(['owner']);
    store.close();
  });
});
