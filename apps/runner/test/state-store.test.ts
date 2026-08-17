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

  it('migrates version 1 state and keeps legacy workspaces owner-qualified', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
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
    legacy.prepare(`INSERT INTO workspaces
      (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path, status,
       network_mode, created_at, last_activity_at, expires_at, generation, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      workspace.id, workspace.ownerId, workspace.idempotencyKey, workspace.repositoryUrl, workspace.repositoryRef,
      workspace.containerName, workspace.workspacePath, workspace.status, workspace.networkMode, workspace.createdAt,
      workspace.lastActivityAt, workspace.expiresAt, workspace.generation, workspace.error
    );
    legacy.close();

    const store = new StateStore(path);
    expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(3);
    expect(store.legacyWorkspaceOwnerIds()).toEqual(['owner']);
    expect(store.byOwnerAndId('owner', workspace.id)?.id).toBe(workspace.id);
    expect(store.byOwnerAndId('other-owner', workspace.id)).toBeUndefined();
    store.close();
  });

  it('resolves external principals to one stable opaque identity across restarts and connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.db');
    const first = new StateStore(path);
    const second = new StateStore(path);
    const selector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'subject-123', email: 'old@example.com' };

    const [firstId, secondId] = await Promise.all([
      Promise.resolve().then(() => first.resolvePrincipal(selector)),
      Promise.resolve().then(() => second.resolvePrincipal({ ...selector, email: 'new@example.com', name: 'Example User' }))
    ]);
    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^prn_[A-Za-z0-9_-]{32}$/);
    first.close();
    second.close();

    const reopened = new StateStore(path);
    expect(reopened.resolvePrincipal(selector)).toBe(firstId);
    expect(reopened.principalByExternalIdentity(selector)).toMatchObject({ id: firstId, issuer: selector.issuer, subject: selector.subject });
    reopened.close();
  });

  it('transactionally pins an explicit legacy owner and fails closed on conflicting mappings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const workspace = record();
    store.create(workspace);
    const selector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'subject-123' };

    const principalId = store.resolveExternalPrincipal(selector, { legacyOwnerId: 'owner' });
    expect(store.legacyWorkspaceOwnerIds()).toEqual([]);
    expect(store.byOwnerAndId(principalId, workspace.id)?.id).toBe(workspace.id);
    expect(store.byOwnerAndId('owner', workspace.id)).toBeUndefined();
    expect(store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' })).toBe(principalId);
    expect(() => store.resolveExternalPrincipal(selector, { legacyOwnerId: 'different-owner' })).toThrow('external identity is already mapped');
    store.close();
  });

  it('materializes owner-bearer identity and preserves it through an explicit Access cutover', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-owner-principal-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const workspace = record();
    store.create(workspace);

    const ownerPrincipal = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    expect(ownerPrincipal).toMatch(/^prn_[A-Za-z0-9_-]{32}$/);
    expect(store.resolvePrincipal({ kind: 'owner', ownerId: ownerPrincipal })).toBe(ownerPrincipal);
    expect(store.byOwnerAndId(ownerPrincipal, workspace.id)?.id).toBe(workspace.id);

    const access = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'subject-123' };
    expect(store.resolveExternalPrincipal(access, { legacyOwnerId: 'owner' })).toBe(ownerPrincipal);
    expect(store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' })).toBe(ownerPrincipal);
    expect(store.principalByExternalIdentity(access)?.id).toBe(ownerPrincipal);
    store.close();
  });

  it('rolls back a legacy claim that would merge two active workspaces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const selector = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'subject-123' };
    const principalId = store.resolveExternalPrincipal(selector);
    store.create({ ...record(), ownerId: principalId });
    const legacy = { ...record(), id: `ws_${'b'.repeat(24)}`, ownerId: 'owner', idempotencyKey: 'legacy-request' };
    store.create(legacy);

    expect(() => store.resolveExternalPrincipal(selector, { legacyOwnerId: 'owner' })).toThrow();
    expect(store.principalByExternalIdentity(selector)?.legacyOwnerId).toBeNull();
    expect(store.byOwnerAndId(principalId, record().id)?.id).toBe(record().id);
    expect(store.byOwnerAndId('owner', legacy.id)?.id).toBe(legacy.id);
    store.close();
  });

  it('atomically rejects an operator mapping when another legacy owner remains', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const first = record();
    const second = { ...record(), id: `ws_${'b'.repeat(24)}`, ownerId: 'other-owner', idempotencyKey: 'other-request' };
    store.create(first);
    store.create(second);
    const mapping = { legacyOwnerId: 'owner', issuer: 'https://access.example.com', subject: 'subject-123' };

    expect(() => store.applyLegacyPrincipalMapping(mapping)).toThrow('unmapped legacy workspace owners remain');
    expect(store.principalByExternalIdentity(mapping)).toBeUndefined();
    expect(store.byOwnerAndId('owner', first.id)?.id).toBe(first.id);
    expect(store.byOwnerAndId('other-owner', second.id)?.id).toBe(second.id);
    store.close();
  });

  it('relinks an external subject without changing principal or workspace ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const oldIdentity = { kind: 'external' as const, issuer: 'https://old.example.com', subject: 'old-subject' };
    const principalId = store.resolvePrincipal(oldIdentity);
    const workspace = { ...record(), ownerId: principalId };
    store.create(workspace);
    const mapping = {
      oldIssuer: oldIdentity.issuer, oldSubject: oldIdentity.subject,
      newIssuer: 'https://new.example.com', newSubject: 'new-subject'
    };

    expect(store.applyPrincipalRelinks([mapping])).toEqual([{ ...mapping, principalId, status: 'applied' }]);
    expect(store.principalByExternalIdentity(oldIdentity)).toBeUndefined();
    expect(store.principalByExternalIdentity({ issuer: mapping.newIssuer, subject: mapping.newSubject })?.id).toBe(principalId);
    expect(store.byOwnerAndId(principalId, workspace.id)?.id).toBe(workspace.id);
    store.close();
  });

  it('keeps an exact relink idempotent across restart and rejects a changed replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.db');
    const mapping = {
      oldIssuer: 'https://old.example.com', oldSubject: 'old-subject',
      newIssuer: 'https://new.example.com', newSubject: 'new-subject'
    };
    const store = new StateStore(path);
    const principalId = store.resolvePrincipal({ kind: 'external', issuer: mapping.oldIssuer, subject: mapping.oldSubject });
    let auditCount = 0;
    store.applyPrincipalRelinks([mapping], () => { auditCount += 1; });
    store.close();

    const reopened = new StateStore(path);
    expect(reopened.applyPrincipalRelinks([mapping], () => { auditCount += 1; }))
      .toEqual([{ ...mapping, principalId, status: 'already-applied' }]);
    expect(auditCount).toBe(1);
    expect(() => reopened.applyPrincipalRelinks([{ ...mapping, newSubject: 'changed-target' }]))
      .toThrow('already mapped to a different target');
    expect(reopened.principalByExternalIdentity({ issuer: mapping.newIssuer, subject: mapping.newSubject })?.id).toBe(principalId);
    reopened.close();
  });

  it('rolls back the identity and ledger when the transactional audit callback fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const mapping = {
      oldIssuer: 'https://old.example.com', oldSubject: 'old-subject',
      newIssuer: 'https://new.example.com', newSubject: 'new-subject'
    };
    const principalId = store.resolvePrincipal({ kind: 'external', issuer: mapping.oldIssuer, subject: mapping.oldSubject });

    expect(() => store.applyPrincipalRelinks([mapping], () => { throw new Error('audit write failed'); }))
      .toThrow('audit write failed');
    expect(store.principalByExternalIdentity({ issuer: mapping.oldIssuer, subject: mapping.oldSubject })?.id).toBe(principalId);
    expect(store.principalByExternalIdentity({ issuer: mapping.newIssuer, subject: mapping.newSubject })).toBeUndefined();
    expect((store.database.prepare('SELECT COUNT(*) AS count FROM principal_relinks').get() as { count: number }).count).toBe(0);
    store.close();
  });

  it('rejects a relink target collision and rolls back the entire configured batch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const first = { issuer: 'https://old.example.com', subject: 'first' };
    const second = { issuer: 'https://old.example.com', subject: 'second' };
    const occupied = { issuer: 'https://new.example.com', subject: 'occupied' };
    const firstId = store.resolvePrincipal({ kind: 'external', ...first });
    const secondId = store.resolvePrincipal({ kind: 'external', ...second });
    store.resolvePrincipal({ kind: 'external', ...occupied });
    const firstMapping = {
      oldIssuer: first.issuer, oldSubject: first.subject,
      newIssuer: 'https://new.example.com', newSubject: 'first-new'
    };
    const collision = {
      oldIssuer: second.issuer, oldSubject: second.subject,
      newIssuer: occupied.issuer, newSubject: occupied.subject
    };

    expect(() => store.applyPrincipalRelinks([firstMapping, collision])).toThrow('target identity already exists');
    expect(store.principalByExternalIdentity(first)?.id).toBe(firstId);
    expect(store.principalByExternalIdentity(second)?.id).toBe(secondId);
    expect(store.principalByExternalIdentity({ issuer: firstMapping.newIssuer, subject: firstMapping.newSubject })).toBeUndefined();
    expect((store.database.prepare('SELECT COUNT(*) AS count FROM principal_relinks').get() as { count: number }).count).toBe(0);
    store.close();
  });
});
