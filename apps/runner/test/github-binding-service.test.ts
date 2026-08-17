import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import { GitHubBindingService, GitHubSetupStateStore } from '../src/github-binding-service.js';
import { mintPrincipalRepositoryToken } from '../src/github-app-broker.js';
import {
  InMemoryGitHubInstallationStore,
  type VerifiedGitHubInstallation
} from '../src/github-installation-store.js';

const activeInstallation = (overrides: Partial<VerifiedGitHubInstallation> = {}): VerifiedGitHubInstallation => ({
  appId: '123',
  installationId: '456',
  accountId: '789',
  accountLogin: 'example',
  status: 'active',
  repositories: [{ owner: 'Example', repository: 'Private-Repo', contents: 'write' }],
  ...overrides
});

describe('GitHub installation binding', () => {
  let now: number;
  let store: InMemoryGitHubInstallationStore;
  let verifyInstallation: ReturnType<typeof vi.fn<(installationId: string) => Promise<VerifiedGitHubInstallation>>>;
  let service: GitHubBindingService;

  beforeEach(() => {
    now = 1_000;
    store = new InMemoryGitHubInstallationStore();
    verifyInstallation = vi.fn(async () => activeInstallation());
    service = new GitHubBindingService(new GitHubSetupStateStore(), store, { verifyInstallation }, () => now);
  });

  it('binds verified App, account, and installation metadata once for the initiating principal', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123', expectedAccountId: '789' });
    const record = await service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    });

    expect(record).toMatchObject({ principalId: 'principal-a', status: 'active', generation: 1, createdAt: now, checkedAt: now });
    expect(store.getRepositoryGrant('principal-a', 'example', 'private-repo')).toMatchObject({
      status: 'granted', contents: 'write', generation: 1
    });
    await expect(service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    })).rejects.toThrow('invalid or expired');
    expect(verifyInstallation).toHaveBeenCalledTimes(1);
  });

  it('denies cross-principal state swaps without consuming the owner state', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123' });
    await expect(service.completeSetup({
      principalId: 'principal-b', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    })).rejects.toThrow('invalid or expired');
    expect(store.getInstallation('principal-b')).toBeUndefined();

    await expect(service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    })).resolves.toMatchObject({ principalId: 'principal-a' });
  });

  it.each([
    ['callback App', { appId: '999' }, activeInstallation()],
    ['verified App', {}, activeInstallation({ appId: '999' })],
    ['verified account', { accountId: '999' }, activeInstallation()],
    ['verified installation', {}, activeInstallation({ installationId: '999' })]
  ])('rejects a wrong %s and consumes the setup state', async (_label, callback, verified) => {
    verifyInstallation.mockResolvedValueOnce(verified);
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123', expectedAccountId: '789' });
    const input = {
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456', ...callback
    };
    await expect(service.completeSetup(input)).rejects.toThrow('invalid or expired');
    await expect(service.completeSetup(input)).rejects.toThrow('invalid or expired');
    expect(store.getInstallation('principal-a')).toBeUndefined();
  });

  it('expires setup state before provider verification', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123', ttlMs: 50 });
    now += 50;
    await expect(service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    })).rejects.toThrow('invalid or expired');
    expect(verifyInstallation).not.toHaveBeenCalled();
  });

  it('reconciles repository removal, suspension, and uninstall with generations and timestamps', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123' });
    await service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    });

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

  it('turns a provider 404 into an uninstall and removes every repository grant', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123' });
    await service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    });
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
      installations: store
    })).rejects.toThrow('not authorized');
  });

  it('rolls back an installation mutation when its in-transaction audit callback fails', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123' });
    await expect(service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    }, () => { throw new Error('audit unavailable'); })).rejects.toThrow('audit unavailable');
    expect(store.getInstallation('principal-a')).toBeUndefined();
    expect(store.listRepositoryGrants('principal-a')).toEqual([]);
  });

  it('rejects a provider installation identity change during reconciliation', async () => {
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123' });
    await service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    });
    verifyInstallation.mockResolvedValueOnce(activeInstallation({ installationId: '999' }));
    await expect(service.reconcile('principal-a')).rejects.toThrow('identity changed');
    expect(store.getInstallation('principal-a')).toMatchObject({ installationId: '456', generation: 1 });
  });

  it('does not retain provider tokens or private keys in installation records', async () => {
    verifyInstallation.mockResolvedValueOnce({
      ...activeInstallation(), providerToken: 'provider-secret', privateKey: 'private-key-secret'
    } as VerifiedGitHubInstallation);
    const setup = service.beginSetup({ principalId: 'principal-a', expectedAppId: '123' });
    await service.completeSetup({
      principalId: 'principal-a', state: setup.state, appId: '123', accountId: '789', installationId: '456'
    });
    const persisted = JSON.stringify({ installation: store.getInstallation('principal-a'), grants: store.listRepositoryGrants('principal-a') });
    expect(persisted).not.toContain('provider-secret');
    expect(persisted).not.toContain('private-key-secret');
  });
});
