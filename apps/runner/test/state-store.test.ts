import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function record(): WorkspaceRecord {
  const now = Date.now();
  return { id: `ws_${'a'.repeat(24)}`, ownerId: 'owner', idempotencyKey: 'request-1234', repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git', repositoryRef: null, containerName: null, workspacePath: '/tmp/example', status: 'CREATING', networkMode: 'none', createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 1, error: null };
}

function createVersionOneDatabase(path: string, withBrokenAgentTable = false): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES (1);
    CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      repository_url TEXT NOT NULL, repository_ref TEXT, container_name TEXT, workspace_path TEXT NOT NULL,
      status TEXT NOT NULL, network_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
      error TEXT, UNIQUE(owner_id, idempotency_key)
    );
  `);
  const workspace = record();
  database.prepare(`INSERT INTO workspaces
    (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status, network_mode,
     created_at, last_activity_at, expires_at, generation, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(workspace.id, workspace.ownerId, workspace.idempotencyKey, workspace.repositoryUrl, workspace.repositoryRef,
      workspace.containerName, workspace.workspacePath, workspace.status, workspace.networkMode, workspace.createdAt,
      workspace.lastActivityAt, workspace.expiresAt, workspace.generation, workspace.error);
  if (withBrokenAgentTable) database.exec('CREATE TABLE agents (id TEXT PRIMARY KEY);');
  database.close();
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

  it('transactionally upgrades schema 1 without losing workspace rows and reopens schema 2', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.db');
    createVersionOneDatabase(path);
    const upgraded = new StateStore(path);
    expect(upgraded.byId(record().id)?.idempotencyKey).toBe('request-1234');
    expect(upgraded.database.prepare('SELECT version FROM schema_meta').get()).toEqual({ version: 2 });
    expect(upgraded.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get()).toBeDefined();
    upgraded.close();
    const reopened = new StateStore(path);
    expect(reopened.byId(record().id)?.repositoryUrl).toContain('typescript-sdk');
    reopened.close();
  });

  it('rolls back a failed schema 1 migration and remains upgradeable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.db');
    createVersionOneDatabase(path, true);
    expect(() => new StateStore(path)).toThrow();
    const original = new DatabaseSync(path);
    expect(original.prepare('SELECT version FROM schema_meta').get()).toEqual({ version: 1 });
    expect(original.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
    original.exec('DROP TABLE agents');
    original.close();
    const recovered = new StateStore(path);
    expect(recovered.database.prepare('SELECT version FROM schema_meta').get()).toEqual({ version: 2 });
    recovered.close();
  });
});
