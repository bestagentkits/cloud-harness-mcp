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

  it('enforces one principal per GitHub installation identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-unique-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principalA = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'a' });
    const principalB = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'b' });
    const store = new SqliteGitHubInstallationStore(state.database);
    const verified = { appId: 1, installationId: 2, accountId: 3, accountLogin: 'acme', status: 'active' as const, repositories: [] };
    store.replaceVerified(principalA, verified, 100);
    expect(() => store.replaceVerified(principalB, verified, 200)).toThrow('already bound');
    expect(store.getInstallation(principalB)).toBeUndefined();
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

  it('supports multiple concurrent installations per principal with scoped grant reconciliation', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-multi-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principal = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'multi-owner' });
    const store = new SqliteGitHubInstallationStore(state.database);

    // Bind first installation: personal account
    store.replaceVerified(principal, {
      appId: 1, installationId: 101, accountId: 201, accountLogin: 'mrgoonie', status: 'active',
      repositories: [{ owner: 'mrgoonie', repository: 'personal-repo', contents: 'write' }]
    }, 100);

    // Bind second installation: organization
    store.replaceVerified(principal, {
      appId: 1, installationId: 102, accountId: 202, accountLogin: 'bestagentkits', status: 'active',
      repositories: [{ owner: 'bestagentkits', repository: 'agentkit', contents: 'read' }]
    }, 110);

    // Both installations exist
    const installations = store.listInstallations(principal);
    expect(installations).toHaveLength(2);
    expect(installations.map((i) => i.accountLogin)).toEqual(['mrgoonie', 'bestagentkits']);
    expect(store.getInstallation(principal, 101)).toMatchObject({ accountLogin: 'mrgoonie', installationId: '101' });
    expect(store.getInstallation(principal, 102)).toMatchObject({ accountLogin: 'bestagentkits', installationId: '102' });

    // Both repository grants exist
    expect(store.getRepositoryGrant(principal, 'mrgoonie', 'personal-repo')).toMatchObject({ status: 'granted', installationId: '101' });
    expect(store.getRepositoryGrant(principal, 'bestagentkits', 'agentkit')).toMatchObject({ status: 'granted', installationId: '102' });
    expect(store.listRepositoryGrants(principal)).toHaveLength(2);
    expect(store.listRepositoryGrants(principal, 101)).toHaveLength(1);
    expect(store.listRepositoryGrants(principal, 102)).toHaveLength(1);

    // Reconciling installation 102 removes its removed repo but DOES NOT touch 101's repos
    store.replaceVerified(principal, {
      appId: 1, installationId: 102, accountId: 202, accountLogin: 'bestagentkits', status: 'active',
      repositories: []
    }, 120);
    expect(store.getRepositoryGrant(principal, 'mrgoonie', 'personal-repo')).toMatchObject({ status: 'granted', installationId: '101' });
    expect(store.getRepositoryGrant(principal, 'bestagentkits', 'agentkit')).toMatchObject({ status: 'removed', installationId: '102' });

    state.close();
  });

  it('supports removing an individual installation and its grants', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-remove-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principal = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'remove-owner' });
    const store = new SqliteGitHubInstallationStore(state.database);

    store.replaceVerified(principal, {
      appId: 1, installationId: 101, accountId: 201, accountLogin: 'mrgoonie', status: 'active',
      repositories: [{ owner: 'mrgoonie', repository: 'repo1', contents: 'write' }]
    }, 100);
    store.replaceVerified(principal, {
      appId: 1, installationId: 102, accountId: 202, accountLogin: 'bestagentkits', status: 'active',
      repositories: [{ owner: 'bestagentkits', repository: 'repo2', contents: 'read' }]
    }, 110);

    expect(store.removeInstallation(principal, 101, 120)).toBe(true);
    expect(store.listInstallations(principal)).toHaveLength(1);
    expect(store.getInstallation(principal, 101)).toBeUndefined();
    expect(store.getRepositoryGrant(principal, 'mrgoonie', 'repo1')).toMatchObject({ status: 'removed' });
    expect(store.getRepositoryGrant(principal, 'bestagentkits', 'repo2')).toMatchObject({ status: 'granted' });

    state.close();
  });

  it('migrates legacy single-installation SQLite tables in-place without data loss', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-github-migration-')); roots.push(root);
    const state = new StateStore(join(root, 'state.db'));
    const principal = state.resolveExternalPrincipal({ kind: 'external', issuer: 'https://access.example.com', subject: 'legacy-owner' });

    // Manually create legacy schema where principal_id is primary key
    state.database.exec(`
      DROP TABLE IF EXISTS github_repository_grants;
      DROP TABLE IF EXISTS github_installations;
      CREATE TABLE github_installations (
        principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
        app_id TEXT NOT NULL, installation_id TEXT NOT NULL, account_id TEXT NOT NULL, account_login TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','suspended','uninstalled')),
        generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL
      );
      CREATE TABLE github_repository_grants (
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL, owner TEXT NOT NULL, repository TEXT NOT NULL,
        contents TEXT NOT NULL CHECK(contents IN ('read','write')),
        status TEXT NOT NULL CHECK(status IN ('granted','removed')),
        generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, owner, repository)
      );
      INSERT INTO github_installations VALUES ('${principal}', '1', '999', '888', 'legacy-org', 'active', 1, 100, 100, 100);
      INSERT INTO github_repository_grants VALUES ('${principal}', '999', 'legacy-org', 'legacy-repo', 'write', 'granted', 1, 100, 100, 100);
    `);

    // Instantiate store which runs migration
    const store = new SqliteGitHubInstallationStore(state.database);

    // Existing installation & grants preserved
    expect(store.getInstallation(principal, 999)).toMatchObject({
      principalId: principal, installationId: '999', accountLogin: 'legacy-org', status: 'active'
    });
    expect(store.getRepositoryGrant(principal, 'legacy-org', 'legacy-repo')).toMatchObject({
      status: 'granted', contents: 'write', installationId: '999'
    });

    // Now can add second installation without error
    store.replaceVerified(principal, {
      appId: 1, installationId: 1000, accountId: 889, accountLogin: 'new-org', status: 'active',
      repositories: [{ owner: 'new-org', repository: 'new-repo', contents: 'read' }]
    }, 200);

    expect(store.listInstallations(principal)).toHaveLength(2);
    expect(store.getRepositoryGrant(principal, 'legacy-org', 'legacy-repo')).toMatchObject({ status: 'granted' });
    expect(store.getRepositoryGrant(principal, 'new-org', 'new-repo')).toMatchObject({ status: 'granted' });

    state.close();
  });
});
