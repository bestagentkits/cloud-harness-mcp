import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function record(): WorkspaceRecord {
  const now = Date.now();
  return { id: `ws_${'a'.repeat(24)}`, ownerId: 'owner', idempotencyKey: 'request-1234', repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git', repositoryRef: null, containerName: null, workspacePath: '/tmp/example', status: 'CREATING', networkMode: 'none', createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null };
}

describe('StateStore', () => {
  it('persists idempotency and fences cleanup claims', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const workspace = record();
    store.create(workspace);
    expect(store.byIdempotency('owner', 'request-1234')?.id).toBe(workspace.id);
    expect(store.claimForReaping(workspace.id, 1)).toBe(true);
    expect(store.claimForReaping(workspace.id, 1)).toBe(false);
    expect(store.updateFenced(workspace.id, 1, ['ACTIVE'], { status: 'ACTIVE' })).toBeUndefined();
    expect(store.updateFenced(workspace.id, 2, ['REAPING'], { status: 'CLOSED' })?.status).toBe('CLOSED');
    const instanceId = store.instanceId();
    store.close();
    const reopened = new StateStore(join(directory, 'state.db'));
    expect(reopened.instanceId()).toBe(instanceId);
    reopened.close();
  });

  it('atomically admits only one active workspace per owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const first = record();
    const second = { ...record(), id: `ws_${'b'.repeat(24)}`, idempotencyKey: 'request-5678' };
    store.create(first);
    expect(() => store.create(second)).toThrow();
    store.update(first.id, { status: 'CLOSED' });
    expect(() => store.create(second)).not.toThrow();
    store.close();
  });
});
