import { describe, expect, it, vi } from 'vitest';
import { GitHubRepositoriesListInputSchema, HarnessError, type GitHubRepositoriesListResult, type RunnerConfig } from '@cloud-harness/contracts';
import { GitHubRepositoryLister, type GitHubUserAuthorizationState } from '../src/github-repository-lister.js';
import { InMemoryGitHubInstallationStore, type VerifiedGitHubInstallation } from '../src/github-installation-store.js';
import type { GitHubUserRepositoryListing } from '../src/github-user-authorizer.js';
import { deferred } from './github-user-fixtures.js';

const PRINCIPAL = 'principal_1';
const githubApp = { appId: 123, appSlug: 'cloud-harness', privateKey: 'unused' } as NonNullable<RunnerConfig['githubApp']>;

function verified(overrides: Partial<VerifiedGitHubInstallation> = {}): VerifiedGitHubInstallation {
  return {
    appId: 123, installationId: 456, accountId: 789, accountLogin: 'acme', accountType: 'Organization',
    issues: 'write', pullRequests: 'write', contents: 'write', status: 'active',
    repositories: [{ owner: 'acme', repository: 'api', contents: 'write' }, { owner: 'acme', repository: 'web', contents: 'read' }],
    ...overrides
  };
}

type UserListing = GitHubUserRepositoryListing & { login: string; generation: number };

function userListing(overrides: Partial<UserListing> = {}): UserListing {
  return {
    login: 'alice',
    generation: 1,
    complete: true,
    installationsComplete: true,
    organizationsComplete: true,
    organizations: ['acme', 'globex', 'initech'],
    installations: [
      // The bound installation as the user sees it: only `api`, and only with read access.
      { installationId: '456', accountLogin: 'acme', accountType: 'Organization', complete: true, repositories: [{ owner: 'acme', name: 'api', access: 'read', private: true }] },
      { installationId: '700', accountLogin: 'initech', accountType: 'Organization', complete: true, repositories: [
        { owner: 'initech', name: 'billing', access: 'write', private: true, defaultBranch: 'main' }
      ] }
    ],
    ...overrides
  };
}

function fixture(options: {
  authMode?: RunnerConfig['authMode'];
  githubApp?: RunnerConfig['githubApp'];
  user?: GitHubUserAuthorizationState;
  userRepositories?: () => Promise<UserListing>;
  reconcile?: (principalId: string, installationId: string) => Promise<void>;
  verify?: () => Promise<VerifiedGitHubInstallation>;
} = {}) {
  const installations = new InMemoryGitHubInstallationStore();
  installations.replaceVerified(PRINCIPAL, verified(), 1_000);
  const config = { authMode: options.authMode ?? 'cloudflare-access', githubApp: 'githubApp' in options ? options.githubApp : githubApp } as RunnerConfig;
  const state = { user: options.user, lifetimes: new Map<string, number>() };
  const reconcileInstallation = vi.fn(options.reconcile ?? (async () => undefined));
  const userRepositories = vi.fn(options.userRepositories ?? (async () => userListing()));
  const verifyInstallation = vi.fn(options.verify ?? (async () => verified({ installationId: 321, accountLogin: 'solo', accountType: 'User', repositories: [{ owner: 'solo', repository: 'site', contents: 'write' }] })));
  const lister = new GitHubRepositoryLister({
    config,
    installations,
    reconcileInstallation,
    verifyInstallation,
    userAuthorization: () => state.user,
    bindingLifetime: (installationId) => state.lifetimes.get(installationId) ?? 0,
    userRepositories,
    now: () => 1_700_000_000_000
  });
  return { lister, installations, state, reconcileInstallation, userRepositories, verifyInstallation };
}

const input = (value: Record<string, unknown> = {}) => GitHubRepositoriesListInputSchema.parse(value);
const data = (result: { data?: unknown }) => result.data as GitHubRepositoriesListResult;
const names = (result: GitHubRepositoriesListResult) => result.repositories.map((repository) => repository.fullName);
const CONNECTED: GitHubUserAuthorizationState = { status: 'connected', generation: 1 };

describe('github_repositories_list binding identity and hints', () => {
  it('never lets a slower older read replace what a newer refresh cached', async () => {
    const slow = deferred<void>();
    let calls = 0;
    const { lister } = fixture({ user: CONNECTED, userRepositories: async () => {
      calls += 1;
      // The first (older) read still sees initech; by the refresh GitHub has removed the user's access to it.
      if (calls === 1) { await slow.promise; return userListing(); }
      return userListing({ installations: [userListing().installations[0]!] });
    } });
    const older = lister.listing(PRINCIPAL, { sync: false });
    await vi.waitFor(() => expect(calls).toBe(1));
    const refreshed = await lister.listing(PRINCIPAL, { sync: true, refresh: true });
    expect(refreshed.repositories.map((repository) => repository.fullName)).toEqual(['acme/api']);
    slow.resolve();
    await older;
    expect((await lister.listing(PRINCIPAL, { sync: false })).repositories.map((repository) => repository.fullName)).toEqual(['acme/api']);
  });

  it('shares one read between overlapping requests even though the read advances generations itself', async () => {
    const { lister, installations, state, reconcileInstallation, userRepositories } = fixture({
      user: CONNECTED,
      // A real reconcile rewrites the binding, so its generation moves while the read runs.
      reconcile: async () => { installations.replaceVerified(PRINCIPAL, verified(), 1_000); },
      // A renewal during the read rotates the user authorization to a new generation.
      userRepositories: async () => { state.user = { status: 'connected', generation: 2 }; return userListing({ generation: 2 }); }
    });
    const [first, second] = await Promise.all([lister.listing(PRINCIPAL, { sync: true }), lister.listing(PRINCIPAL, { sync: true })]);
    expect(second).toBe(first);
    expect(reconcileInstallation).toHaveBeenCalledTimes(1);
    expect(userRepositories).toHaveBeenCalledTimes(1);
    await lister.listing(PRINCIPAL, { sync: true });
    expect(reconcileInstallation).toHaveBeenCalledTimes(1);
  });

  it('does not serve a cached listing across a disconnect and rebind that repeat the record exactly', async () => {
    const { lister, installations, state, reconcileInstallation } = fixture();
    await lister.list(PRINCIPAL, input());
    // Same millisecond, same generation: only the binding lifetime moves, as GitHubBindingService does it.
    installations.removeInstallation(PRINCIPAL, 456, 1_000);
    installations.replaceVerified(PRINCIPAL, verified({ repositories: [{ owner: 'acme', repository: 'fresh', contents: 'read' }] }), 1_000);
    state.lifetimes.set('456', 2);
    expect(names(data(await lister.list(PRINCIPAL, input())))).toEqual(['acme/fresh']);
    expect(reconcileInstallation).toHaveBeenCalledTimes(2);
  });

  it('ignores another App\'s binding when deciding whether the App is installed on an account', async () => {
    const { lister, installations } = fixture({ user: CONNECTED, userRepositories: async () => userListing({ installations: [] }) });
    installations.replaceVerified(PRINCIPAL, verified({ appId: 999, installationId: 888, accountId: 889, accountLogin: 'globex' }), 1_000);
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(result.unreachableAccounts.find((account) => account.login === 'globex')).toEqual({
      login: 'globex', type: 'Organization', installation: 'unknown', installUrl: 'https://github.com/apps/cloud-harness/installations/new'
    });
  });
});

describe('github_repositories_list', () => {
  it('limits a connected user to what that user can access, capped at the user\'s permission', async () => {
    const { lister, reconcileInstallation } = fixture({ user: CONNECTED });
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(reconcileInstallation).toHaveBeenCalledWith(PRINCIPAL, '456');
    expect(result.repositories).toEqual([
      // Granted to the installation as write, but the user may only read; `acme/web` is not the user's.
      { fullName: 'acme/api', owner: 'acme', name: 'api', repositoryUrl: 'https://github.com/acme/api.git', access: 'read', via: 'installation', private: true },
      { fullName: 'initech/billing', owner: 'initech', name: 'billing', repositoryUrl: 'https://github.com/initech/billing.git', access: 'write', via: 'user', private: true, defaultBranch: 'main' }
    ]);
    expect(result.accounts.map((account) => [account.login, account.via, account.repositoryCount, account.live])).toEqual([
      ['acme', 'installation', 1, true], ['initech', 'user', 1, true]
    ]);
    expect(result.unreachableAccounts).toEqual([
      { login: 'alice', type: 'User', installation: 'unknown', installUrl: 'https://github.com/apps/cloud-harness/installations/new' },
      { login: 'globex', type: 'Organization', installation: 'unknown', installUrl: 'https://github.com/apps/cloud-harness/installations/new' }
    ]);
    expect(result).toMatchObject({ userAuthorization: 'connected', synced: true, incomplete: false, warnings: [], totalCount: 2 });
  });

  it('lists the installation grants unfiltered when no GitHub user is connected', async () => {
    const result = data(await fixture().lister.list(PRINCIPAL, input()));
    expect(result.repositories.map((repository) => [repository.fullName, repository.access])).toEqual([['acme/api', 'write'], ['acme/web', 'read']]);
    expect(result).toMatchObject({ userAuthorization: 'not_connected', unreachableAccounts: [] });
  });

  it('shows nothing it cannot confirm when the connected user\'s access cannot be read', async () => {
    const { lister } = fixture({ user: CONNECTED, userRepositories: async () => { throw new HarnessError('GITHUB_RATE_LIMITED', 'GitHub rate limit reached', 429, true); } });
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(result.repositories).toEqual([]);
    expect(result).toMatchObject({ incomplete: true, userAuthorization: 'connected' });
    expect(result.warnings[0]).toContain('GITHUB_RATE_LIMITED');
  });

  it('keeps unfiltered installation repositories for a revoked user, with a warning', async () => {
    const result = data(await fixture({ user: { status: 'revoked', generation: 1 } }).lister.list(PRINCIPAL, input()));
    expect(names(result)).toEqual(['acme/api', 'acme/web']);
    expect(result.userAuthorization).toBe('revoked');
    expect(result.warnings[0]).toContain('reconnect');
  });

  it('falls back to stored grants and marks the listing incomplete when an installation cannot be refreshed', async () => {
    const { lister } = fixture({ reconcile: async () => { throw new HarnessError('UNAVAILABLE', 'GitHub installation verification failed', 502, true); } });
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(names(result)).toEqual(['acme/api', 'acme/web']);
    expect(result.accounts[0]).toMatchObject({ login: 'acme', live: false });
    expect(result.incomplete).toBe(true);
    expect(result.warnings[0]).toContain('UNAVAILABLE');
  });

  it('reads stored grants without reconciling when sync is off', async () => {
    const { lister, reconcileInstallation } = fixture();
    const listing = await lister.listing(PRINCIPAL, { sync: false });
    expect(reconcileInstallation).not.toHaveBeenCalled();
    expect(listing).toMatchObject({ synced: false });
    expect(listing.accounts[0]).toMatchObject({ live: false });
  });

  it('filters by owner and query and pages with a cursor', async () => {
    const { lister } = fixture();
    expect(names(data(await lister.list(PRINCIPAL, input({ owner: 'ACME' }))))).toEqual(['acme/api', 'acme/web']);
    expect(names(data(await lister.list(PRINCIPAL, input({ query: 'WEB' }))))).toEqual(['acme/web']);
    const first = await lister.list(PRINCIPAL, input({ limit: 1 }));
    expect(first).toMatchObject({ truncated: true, cursor: '1' });
    const second = await lister.list(PRINCIPAL, input({ limit: 1, cursor: '1' }));
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeUndefined();
    expect(names(data(second))).toEqual(['acme/web']);
  });

  it('shares one read, reuses it for paging, and reads again on refresh', async () => {
    const { lister, reconcileInstallation, userRepositories } = fixture({ user: CONNECTED });
    await Promise.all([lister.list(PRINCIPAL, input()), lister.list(PRINCIPAL, input())]);
    await lister.list(PRINCIPAL, input({ cursor: '1' }));
    expect(reconcileInstallation).toHaveBeenCalledTimes(1);
    expect(userRepositories).toHaveBeenCalledTimes(1);
    await lister.list(PRINCIPAL, input({ refresh: true }));
    expect(reconcileInstallation).toHaveBeenCalledTimes(2);
  });

  it('never serves a cached listing after the user authorization or a binding changes', async () => {
    const { lister, state, installations, userRepositories } = fixture({ user: CONNECTED });
    expect(names(data(await lister.list(PRINCIPAL, input())))).toContain('initech/billing');

    state.user = { status: 'disconnected', generation: 1 };
    const afterDisconnect = data(await lister.list(PRINCIPAL, input()));
    expect(names(afterDisconnect)).toEqual(['acme/api', 'acme/web']);
    expect(userRepositories).toHaveBeenCalledTimes(1);

    installations.removeInstallation(PRINCIPAL, 456, 2_000);
    expect(data(await lister.list(PRINCIPAL, input())).repositories).toEqual([]);
  });

  it('does not let a read begun before a disconnect answer a request made after it', async () => {
    const gate = deferred<void>();
    const { lister, state } = fixture({ user: CONNECTED, userRepositories: async () => { await gate.promise; return userListing(); } });
    const before = lister.list(PRINCIPAL, input());
    await Promise.resolve();
    state.user = { status: 'disconnected', generation: 1 };
    const after = lister.list(PRINCIPAL, input());
    gate.resolve();
    expect(names(data(await after))).toEqual(['acme/api', 'acme/web']);
    // The read begun while connected is discarded and repeated, so neither answer nor the cache keeps the user's rows.
    expect(names(data(await before))).toEqual(['acme/api', 'acme/web']);
    expect(names(data(await lister.list(PRINCIPAL, input())))).toEqual(['acme/api', 'acme/web']);
  });

  it('discards a listing when a binding it already read is removed before it ends, and never caches it', async () => {
    const { lister, installations } = fixture({
      reconcile: async (_principalId, installationId) => {
        // Disconnect of the first binding lands while the second is being read from GitHub.
        if (installationId === '457' && installations.getInstallation(PRINCIPAL, 456)) installations.removeInstallation(PRINCIPAL, 456, 2_000);
      }
    });
    installations.replaceVerified(PRINCIPAL, verified({ installationId: 457, accountId: 790, accountLogin: 'beta', repositories: [{ owner: 'beta', repository: 'tool', contents: 'write' }] }), 1_000);
    expect(names(data(await lister.list(PRINCIPAL, input())))).toEqual(['beta/tool']);
    expect(names(data(await lister.list(PRINCIPAL, input())))).toEqual(['beta/tool']);
  });

  it('names a public organization the user reaches through no installation, even when the principal has it bound', async () => {
    const { lister } = fixture({ user: CONNECTED, userRepositories: async () => userListing({
      installations: [{ installationId: '700', accountLogin: 'initech', accountType: 'Organization', complete: true, repositories: [] }]
    }) });
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(result.repositories).toEqual([]);
    expect(result.unreachableAccounts.map((account) => [account.login, account.installation, account.installUrl !== undefined])).toEqual([
      ['alice', 'unknown', true], ['acme', 'installed', false], ['globex', 'unknown', true]
    ]);
  });

  it('reads the user lane without renewing the token unless the read syncs', async () => {
    const { lister, userRepositories } = fixture({ user: CONNECTED });
    await lister.listing(PRINCIPAL, { sync: false });
    expect(userRepositories).toHaveBeenLastCalledWith(PRINCIPAL, { renew: false });
    await lister.listing(PRINCIPAL, { sync: true });
    expect(userRepositories).toHaveBeenLastCalledWith(PRINCIPAL, { renew: true });
  });

  it('gives no negative account hint when the user installation list itself was cut short', async () => {
    const { lister } = fixture({ user: CONNECTED, userRepositories: async () => userListing({ installationsComplete: false, complete: false }) });
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(result.unreachableAccounts).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it('uses only the operator-configured installation in owner-bearer mode and marks a failed read incomplete', async () => {
    const ownerApp = { ...githubApp, installationId: 321 } as NonNullable<RunnerConfig['githubApp']>;
    const { lister, verifyInstallation, reconcileInstallation, userRepositories } = fixture({ authMode: 'owner-bearer', githubApp: ownerApp, user: CONNECTED });
    const result = data(await lister.list(PRINCIPAL, input()));
    expect(verifyInstallation).toHaveBeenCalledWith('321');
    expect(reconcileInstallation).not.toHaveBeenCalled();
    expect(userRepositories).not.toHaveBeenCalled();
    expect(names(result)).toEqual(['solo/site']);
    expect(result).toMatchObject({ userAuthorization: 'not_applicable', incomplete: false });

    const failing = fixture({ authMode: 'owner-bearer', githubApp: ownerApp, verify: async () => { throw new HarnessError('UNAVAILABLE', 'down', 502, true); } });
    expect(data(await failing.lister.list(PRINCIPAL, input()))).toMatchObject({ repositories: [], incomplete: true });
  });

  it('refuses without a GitHub App', async () => {
    await expect(fixture({ githubApp: undefined }).lister.list(PRINCIPAL, input())).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});
