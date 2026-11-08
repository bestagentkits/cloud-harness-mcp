import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { GitHubAuthorizationStateStore, GitHubBindingService, GitHubSetupStateStore } from '../src/github-binding-service.js';
import { mintPrincipalRepositoryToken } from '../src/github-app-broker.js';
import {
  InMemoryGitHubInstallationStore,
  type VerifiedGitHubInstallation
} from '../src/github-installation-store.js';
import type { GitHubUserAuthorizer, GitHubUserInstallationProof } from '../src/github-user-authorizer.js';

const activeInstallation = (overrides: Partial<VerifiedGitHubInstallation> = {}): VerifiedGitHubInstallation => ({
  appId: '123',
  installationId: '456',
  accountId: '789',
  accountLogin: 'example',
  issues: null,
  pullRequests: null,
  status: 'active',
  repositories: [{ owner: 'Example', repository: 'Private-Repo', contents: 'write' }],
  ...overrides
});

const ownerProof = (overrides: Partial<GitHubUserInstallationProof> = {}): GitHubUserInstallationProof => ({
  userId: '789', userLogin: 'example', appId: '123', installationId: '456', accountId: '789', accountLogin: 'example', relation: 'owner',
  ...overrides
});

const BROWSER = 'b'.repeat(43);
const OTHER_BROWSER = 'c'.repeat(43);
const REDIRECT_URI = 'https://dashboard.example.com/dashboard/integrations/github';

describe('GitHub installation binding', () => {
  let now: number;
  let store: InMemoryGitHubInstallationStore;
  let verifyInstallation: ReturnType<typeof vi.fn<(installationId: string) => Promise<VerifiedGitHubInstallation>>>;
  let prove: ReturnType<typeof vi.fn<GitHubUserAuthorizer['proveInstallationAdministration']>>;
  let service: GitHubBindingService;

  beforeEach(() => {
    now = 1_000;
    store = new InMemoryGitHubInstallationStore();
    verifyInstallation = vi.fn(async () => activeInstallation());
    prove = vi.fn(async ({ installationId }) => ownerProof({ installationId }));
    const authorizer: GitHubUserAuthorizer = {
      authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
        `https://github.com/login/oauth/authorize?state=${state}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      proveInstallationAdministration: prove
    };
    service = new GitHubBindingService(
      new GitHubSetupStateStore(), store, { verifyInstallation }, () => now,
      { states: new GitHubAuthorizationStateStore(), authorizer }
    );
  });

  /** Starts a user authorization and returns the one-time state GitHub would hand back. */
  function authorize(principalId: string, input: { installationId?: string; setupState?: string; browserBinding?: string } = {}) {
    const { url } = service.beginAuthorization({
      principalId, installationId: input.installationId ?? '456', expectedAppId: '123', redirectUri: REDIRECT_URI,
      browserBinding: input.browserBinding ?? BROWSER, ...(input.setupState ? { setupState: input.setupState } : {})
    });
    const parsed = new URL(url);
    return { state: parsed.searchParams.get('state')!, codeChallenge: parsed.searchParams.get('code_challenge')! };
  }

  /** Completes as whatever the stored state says; these tests bind, so the installation is what they read. */
  async function complete(principalId: string, state: string, browserBinding = BROWSER) {
    const completion = await service.completeAuthorization({ principalId, state, code: 'github-code', browserBinding });
    if (completion.purpose !== 'bind') throw new Error('expected a bind completion');
    return completion.installation;
  }

  async function bind(principalId: string, installationId = '456') {
    return await complete(principalId, authorize(principalId, { installationId }).state);
  }

  it('binds an installation only after the GitHub user proves ownership, with a one-time PKCE-bound state', async () => {
    const { state, codeChallenge } = authorize('principal-a');
    const record = await complete('principal-a', state);

    expect(record).toMatchObject({ principalId: 'principal-a', status: 'active', generation: 1, createdAt: now, checkedAt: now });
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({ status: 'granted', contents: 'write', generation: 1 });
    const [{ codeVerifier, redirectUri, installationId }] = prove.mock.calls[0]!;
    expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(codeChallenge);
    expect(codeChallenge).not.toBe(codeVerifier);
    expect({ redirectUri, installationId }).toEqual({ redirectUri: REDIRECT_URI, installationId: '456' });

    await expect(complete('principal-a', state)).rejects.toThrow('invalid or expired');
    expect(prove).toHaveBeenCalledTimes(1);
    expect(verifyInstallation).toHaveBeenCalledTimes(1);
  });

  it('connects an already-installed App without a setup state', async () => {
    await expect(bind('principal-a')).resolves.toMatchObject({ installationId: '456', status: 'active' });
  });

  it.each([
    ['another principal', 'principal-b', BROWSER],
    ['another browser', 'principal-a', OTHER_BROWSER]
  ])('refuses a state presented by %s without consuming it', async (_label, principalId, browserBinding) => {
    const { state } = authorize('principal-a');
    await expect(complete(principalId, state, browserBinding)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prove).not.toHaveBeenCalled();
    expect(store.getInstallation(principalId)).toBeUndefined();

    await expect(complete('principal-a', state)).resolves.toMatchObject({ principalId: 'principal-a' });
  });

  it('expires the authorization state before talking to GitHub', async () => {
    const { state } = authorize('principal-a');
    now += 10 * 60_000;
    await expect(complete('principal-a', state)).rejects.toThrow('invalid or expired');
    expect(prove).not.toHaveBeenCalled();
    expect(verifyInstallation).not.toHaveBeenCalled();
  });

  it('binds nothing when the GitHub user cannot access or administer the installation', async () => {
    prove.mockRejectedValueOnce(new HarnessError('FORBIDDEN', 'Your GitHub account cannot access installation 456.', 403));
    await expect(bind('principal-a')).rejects.toThrow('cannot access installation 456');
    expect(verifyInstallation).not.toHaveBeenCalled();
    expect(store.getInstallation('principal-a')).toBeUndefined();
    expect(store.listRepositoryGrants('principal-a')).toEqual([]);
  });

  it.each([
    ['proven installation', ownerProof({ installationId: '999' }), activeInstallation()],
    ['proven App', ownerProof({ appId: '999' }), activeInstallation()],
    ['proven account', ownerProof({ accountId: '999' }), activeInstallation()],
    ['verified App', ownerProof(), activeInstallation({ appId: '999' })],
    ['verified installation', ownerProof(), activeInstallation({ installationId: '999' })]
  ])('refuses a mismatched %s', async (_label, proof, verified) => {
    prove.mockResolvedValueOnce(proof);
    verifyInstallation.mockResolvedValueOnce(verified);
    await expect(bind('principal-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.getInstallation('principal-a')).toBeUndefined();
  });

  it('consumes a setup state once, for its own principal, and enforces its expected account', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123', expectedAccountId: '790' });
    expect(() => authorize('principal-b', { setupState: setup.state })).toThrow('invalid or expired');
    const { state } = authorize('principal-a', { setupState: setup.state });
    expect(() => authorize('principal-a', { setupState: setup.state })).toThrow('invalid or expired');
    await expect(complete('principal-a', state)).rejects.toThrow('does not match');
    expect(store.getInstallation('principal-a')).toBeUndefined();

    const expired = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123', ttlMs: 50 });
    now += 50;
    expect(() => authorize('principal-a', { setupState: expired.state })).toThrow('invalid or expired');
  });

  it('refuses to start without GitHub App client credentials', () => {
    const unconfigured = new GitHubBindingService(new GitHubSetupStateStore(), store, { verifyInstallation }, () => now);
    expect(() => unconfigured.beginAuthorization({
      principalId: 'principal-a', installationId: '456', expectedAppId: '123', redirectUri: REDIRECT_URI, browserBinding: BROWSER
    })).toThrow('GITHUB_APP_CLIENT_ID');
  });

  it('lets a proven owner take over a binding held by another principal in one step', async () => {
    await bind('principal-a');
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({ status: 'granted' });

    now += 100;
    const audit = vi.fn();
    const { state } = authorize('principal-b');
    const completion = await service.completeAuthorization({ principalId: 'principal-b', state, code: 'github-code', browserBinding: BROWSER }, audit);

    expect(completion).toMatchObject({ purpose: 'bind', installation: { principalId: 'principal-b', installationId: '456', status: 'active' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'principal-b' }), expect.objectContaining({ relation: 'owner' }), 'principal-a');
    // The previous holder lost the installation and every repository grant that came with it.
    expect(store.getInstallation('principal-a')).toBeUndefined();
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({ status: 'removed' });
    expect(store.getRepositoryGrant('principal-b', 'example', 'private-repo')).toMatchObject({ status: 'granted' });
  });

  it('keeps the previous holder bound when the takeover cannot be proven or its audit fails', async () => {
    await bind('principal-a');
    prove.mockRejectedValueOnce(new HarnessError('FORBIDDEN', 'Not the owner.', 403));
    await expect(bind('principal-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.getInstallation('principal-a')).toMatchObject({ status: 'active' });

    const { state } = authorize('principal-b');
    await expect(service.completeAuthorization(
      { principalId: 'principal-b', state, code: 'github-code', browserBinding: BROWSER },
      () => { throw new Error('audit unavailable'); }
    )).rejects.toThrow('audit unavailable');
    expect(store.getInstallation('principal-a')).toMatchObject({ status: 'active' });
    expect(store.getInstallation('principal-b')).toBeUndefined();
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({ status: 'granted' });
  });

  it('reports a refused binding with its installation, but not a retryable provider failure', async () => {
    const refused = vi.fn();
    const run = async () => {
      const { state } = authorize('principal-a');
      return await service.completeAuthorization({ principalId: 'principal-a', state, code: 'github-code', browserBinding: BROWSER }, undefined, refused);
    };
    prove.mockRejectedValueOnce(new HarnessError('FORBIDDEN', 'Only the owner can connect it.', 403));
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith('456', expect.objectContaining({ code: 'FORBIDDEN' }));

    prove.mockRejectedValueOnce(new HarnessError('UNAVAILABLE', 'GitHub is down', 502, true));
    await expect(run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('says whether user authorization is configured', () => {
    expect(service.userAuthorizationConfigured).toBe(true);
    expect(new GitHubBindingService(new GitHubSetupStateStore(), store, { verifyInstallation }, () => now).userAuthorizationConfigured).toBe(false);
  });

  it('reconciles repository removal, suspension, and uninstall with generations and timestamps', async () => {
    await bind('principal-a');

    now += 100;
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ repositories: [] }));
    await service.reconcile('principal-a');
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({
      status: 'removed', generation: 2, updatedAt: now
    });

    now += 100;
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ status: 'suspended', repositories: [] }));
    await expect(service.reconcile('principal-a')).resolves.toMatchObject({ status: 'suspended', generation: 3 });
    now += 100;
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ status: 'uninstalled', repositories: [] }));
    await expect(service.reconcile('principal-a')).resolves.toMatchObject({ status: 'uninstalled', generation: 4 });
  });

  it('records the granted permission levels and converges them on reconciliation', async () => {
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ issues: 'read', pullRequests: 'none' }));
    await bind('principal-a');
    expect(store.getInstallation('principal-a')).toMatchObject({ issues: 'read', pullRequests: 'none' });

    now += 100;
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ issues: 'write', pullRequests: 'write' }));
    await service.reconcile('principal-a');
    expect(store.getInstallation('principal-a')).toMatchObject({ issues: 'write', pullRequests: 'write', generation: 2 });
  });

  it('turns a provider 404 into an uninstall and removes every repository grant', async () => {
    await bind('principal-a');
    now += 100;
    verifyInstallation.mockRejectedValueOnce(new HarnessError('NOT_FOUND', 'GitHub installation not found', 404));

    await expect(service.reconcile('principal-a')).resolves.toMatchObject({
      status: 'uninstalled', generation: 2, checkedAt: now
    });
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({
      status: 'removed', generation: 2, checkedAt: now
    });
    await expect(mintPrincipalRepositoryToken({
      config: { githubApp: { appId: 123, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' } } as RunnerConfig,
      principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/example/private-repo.git'),
      installations: store,
      requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
  });

  it('rolls back an installation mutation when its in-transaction audit callback fails', async () => {
    const { state } = authorize('principal-a');
    await expect(service.completeAuthorization(
      { principalId: 'principal-a', state, code: 'github-code', browserBinding: BROWSER },
      () => { throw new Error('audit unavailable'); }
    )).rejects.toThrow('audit unavailable');
    expect(store.getInstallation('principal-a')).toBeUndefined();
    expect(store.listRepositoryGrants('principal-a')).toEqual([]);
  });

  it('rejects a provider installation identity change during reconciliation', async () => {
    await bind('principal-a');
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ installationId: '999' }));
    await expect(service.reconcile('principal-a')).rejects.toThrow('identity changed');
    expect(store.getInstallation('principal-a')).toMatchObject({ installationId: '456', generation: 1 });
  });

  it('does not retain provider tokens or private keys in installation records', async () => {
    verifyInstallation.mockResolvedValueOnce({
      ...activeInstallation(), providerToken: 'provider-secret', privateKey: 'private-key-secret'
    } as VerifiedGitHubInstallation);
    await bind('principal-a');
    const persisted = JSON.stringify({ installation: store.getInstallation('principal-a'), grants: store.listRepositoryGrants('principal-a') });
    expect(persisted).not.toContain('provider-secret');
    expect(persisted).not.toContain('private-key-secret');
  });

  it('supports binding and reconciling multiple concurrent installations per principal', async () => {
    await bind('principal-a');

    verifyInstallation.mockResolvedValueOnce(activeInstallation({
      installationId: '457', accountId: '790', accountLogin: 'org-two',
      repositories: [{ owner: 'Org-Two', repository: 'Repo-Two', contents: 'read' }]
    }));
    prove.mockResolvedValueOnce(ownerProof({ installationId: '457', accountId: '790', accountLogin: 'org-two', relation: 'organization_admin' }));
    await bind('principal-a', '457');

    expect(store.listInstallations('principal-a')).toHaveLength(2);
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({ status: 'granted', installationId: '456' });
    expect(store.getRepositoryGrant('principal-a', 'org-two', 'repo-two')).toMatchObject({ status: 'granted', installationId: '457' });

    // Reconcile: first installation 404 (uninstalled), second installation still active
    verifyInstallation.mockRejectedValueOnce(new HarnessError('NOT_FOUND', 'installation deleted', 404));
    verifyInstallation.mockResolvedValueOnce(activeInstallation({
      installationId: '457', accountId: '790', accountLogin: 'org-two',
      repositories: [{ owner: 'Org-Two', repository: 'Repo-Two', contents: 'read' }]
    }));

    await service.reconcile('principal-a');
    expect(store.getInstallation('principal-a', '456')).toMatchObject({ status: 'uninstalled' });
    expect(store.getInstallation('principal-a', '457')).toMatchObject({ status: 'active' });
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({ status: 'removed' });
    expect(store.getRepositoryGrant('principal-a', 'org-two', 'repo-two')).toMatchObject({ status: 'granted' });

    // Disconnect installation 457
    expect(service.disconnect('principal-a', '457')).toBe(true);
    expect(store.getInstallation('principal-a', '457')).toBeUndefined();
    expect(store.getRepositoryGrant('principal-a', 'org-two', 'repo-two')).toMatchObject({ status: 'removed' });
  });
});
