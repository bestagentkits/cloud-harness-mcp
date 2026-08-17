import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';

const authMocks = vi.hoisted(() => ({
  installationAuth: vi.fn(async () => ({ token: 'repository-scoped-token' })),
  createAppAuth: vi.fn()
}));

authMocks.createAppAuth.mockImplementation(() => authMocks.installationAuth);
vi.mock('@octokit/auth-app', () => ({ createAppAuth: authMocks.createAppAuth }));

import { mintPrincipalRepositoryToken, mintRepositoryToken } from '../src/github-app-broker.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';

const config = {
  githubApp: { appId: 123, installationId: 456, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' }
} as RunnerConfig;

describe('GitHub App broker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests an installation token scoped to only the cloned repository', async () => {
    await expect(mintRepositoryToken(config, new URL('https://github.com/example/private-repo.git'))).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenCalledWith(expect.objectContaining({ appId: 123, installationId: 456 }));
    expect(authMocks.installationAuth).toHaveBeenCalledWith({ type: 'installation', repositoryNames: ['private-repo'] });
  });

  it('authorizes the principal and repository before minting with the verified installation', async () => {
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', {
      appId: 123,
      installationId: 777,
      accountId: 789,
      accountLogin: 'example',
      status: 'active',
      repositories: [{ owner: 'example', repository: 'private-repo', contents: 'read' }]
    }, 1_000);

    await expect(mintPrincipalRepositoryToken({
      config,
      principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/example/private-repo.git'),
      installations
    })).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenCalledWith(expect.objectContaining({ installationId: '777' }));
  });

  it('denies cross-principal, removed, suspended, and insufficient grants before token creation', async () => {
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', {
      appId: 123,
      installationId: 456,
      accountId: 789,
      accountLogin: 'example',
      status: 'active',
      repositories: [{ owner: 'example', repository: 'private-repo', contents: 'read' }]
    }, 1_000);
    const request = {
      config,
      repositoryUrl: new URL('https://github.com/example/private-repo.git'),
      installations
    };

    await expect(mintPrincipalRepositoryToken({ ...request, principalId: 'principal-b' })).rejects.toThrow('not authorized');
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-a', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');

    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 456, accountId: 789, accountLogin: 'example', status: 'active', repositories: []
    }, 2_000);
    await expect(mintPrincipalRepositoryToken({ ...request, principalId: 'principal-a' })).rejects.toThrow('not authorized');
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 456, accountId: 789, accountLogin: 'example', status: 'suspended', repositories: []
    }, 3_000);
    await expect(mintPrincipalRepositoryToken({ ...request, principalId: 'principal-a' })).rejects.toThrow('not authorized');
    expect(authMocks.createAppAuth).not.toHaveBeenCalled();
  });
});
