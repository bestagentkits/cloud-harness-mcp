import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError } from '@cloud-harness/contracts';
import { GitHubBindingService, GitHubSetupStateStore } from '../src/github-binding-service.js';
import { SqliteGitHubInstallationStore } from '../src/github-installation-sqlite-store.js';
import { StateStore } from '../src/state-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('SQLite GitHub installation store', () => {
  it('persists principal-qualified grants and reconciles repository removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-store-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principalA = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'a' });
    const principalB = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'b' });
    const store = new SqliteGitHubInstallationStore(state.database);
    store.replaceVerified(principalA, { appId: 1, installationId: 2, accountId: 3, accountLogin: 'acme', status: 'active', repositories: [{ owner: 'Acme', repository: 'App', contents: 'write' }] }, 100);
    expect(store.getRepositoryGrant(principalA, 'acme', 'app')).toMatchObject({ status: 'granted', contents: 'write' });
    expect(store.getRepositoryGrant(principalB, 'acme', 'app')).toBeUndefined();
    store.replaceVerified(principalA, { appId: 1, installationId: 2, accountId: 3, accountLogin: 'acme', status: 'active', repositories: [] }, 200);
    expect(store.getRepositoryGrant(principalA, 'acme', 'app')).toMatchObject({ status: 'removed', generation: 2 });
    state.close();
  });

  it('atomically persists uninstall, grant removal, and audit callback across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-uninstall-')); roots.push(root);
    const databasePath = join(root, 'state.db');
    let state = new StateStore(databasePath);
    const principal = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
    let store = new SqliteGitHubInstallationStore(state.database);
    store.replaceVerified(principal, {
      appId: 1, installationId: 2, accountId: 3, accountLogin: 'acme', status: 'active',
      repositories: [{ owner: 'Acme', repository: 'App', contents: 'write' }]
    }, 100);
    state.database.exec('CREATE TABLE github_test_audit (generation INTEGER NOT NULL)');
    const verifier = { verifyInstallation: vi.fn(async () => { throw new HarnessError('NOT_FOUND', 'gone', 404); }) };
    const service = new GitHubBindingService(new GitHubSetupStateStore(state.database), store, verifier, () => 200);

    await expect(service.reconcile(principal, (record) => {
      state.database.prepare('INSERT INTO github_test_audit (generation) VALUES (?)').run(record.generation);
    })).resolves.toMatchObject({ status: 'uninstalled', generation: 2 });
    state.close();

    state = new StateStore(databasePath);
    store = new SqliteGitHubInstallationStore(state.database);
    expect(store.getInstallation(principal)).toMatchObject({ status: 'uninstalled', generation: 2 });
    expect(store.getRepositoryGrant(principal, 'acme', 'app')).toMatchObject({ status: 'removed', generation: 2 });
    expect(state.database.prepare('SELECT generation FROM github_test_audit').all()).toEqual([{ generation: 2 }]);
    state.close();
  });

  it('rolls back SQLite installation and grants when audit append fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-audit-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principal = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
    const store = new SqliteGitHubInstallationStore(state.database);
    expect(() => store.replaceVerified(principal, {
      appId: 1, installationId: 2, accountId: 3, accountLogin: 'acme', status: 'active',
      repositories: [{ owner: 'Acme', repository: 'App', contents: 'write' }]
    }, 100, () => { throw new Error('audit unavailable'); })).toThrow('audit unavailable');
    expect(store.getInstallation(principal)).toBeUndefined();
    expect(store.listRepositoryGrants(principal)).toEqual([]);
    state.close();
  });

  it('persists only hashed setup state and atomically consumes it after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-state-')); roots.push(root);
    const databasePath = join(root, 'state.db');
    let state = new StateStore(databasePath);
    const principal = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'owner' });
    const setupStates = new GitHubSetupStateStore(state.database);
    const setup = setupStates.create({ principalId: principal, expectedAppId: 1, expectedAccountId: 3, now: 100, ttlMs: 1_000 });
    const persisted = state.database.prepare('SELECT * FROM github_setup_states').get() as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain(setup.state);
    state.close();

    state = new StateStore(databasePath);
    const restartedStates = new GitHubSetupStateStore(state.database);
    expect(restartedStates.consume(setup.state, principal, 200)).toMatchObject({ expectedAppId: '1', expectedAccountId: '3' });
    expect(() => restartedStates.consume(setup.state, principal, 200)).toThrow('invalid or expired');
    state.close();
  });

  it('bounds pending setup states, prunes expiry, and does not consume on a cross-principal attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-state-cap-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principalA = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'a' });
    const principalB = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'b' });
    const states = new GitHubSetupStateStore(state.database, 2);
    const first = states.create({ principalId: principalA, expectedAppId: 1, now: 100, ttlMs: 1_000 });
    const second = states.create({ principalId: principalA, expectedAppId: 1, now: 101, ttlMs: 1_000 });
    const third = states.create({ principalId: principalA, expectedAppId: 1, now: 102, ttlMs: 1_000 });
    expect(() => states.consume(first.state, principalA, 103)).toThrow('invalid or expired');
    expect(() => states.consume(second.state, principalB, 103)).toThrow('invalid or expired');
    expect(states.consume(second.state, principalA, 103)).toMatchObject({ principalId: principalA });
    states.create({ principalId: principalA, expectedAppId: 1, now: 2_000, ttlMs: 100 });
    expect(state.database.prepare('SELECT COUNT(*) AS count FROM github_setup_states').get()).toEqual({ count: 1 });
    expect(() => states.consume(third.state, principalA, 2_000)).toThrow('invalid or expired');
    state.close();
  });
});
