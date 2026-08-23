import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';

const authMocks = vi.hoisted(() => ({
  installationAuth: vi.fn(async () => ({ token: 'repository-scoped-token' })),
  createAppAuth: vi.fn()
}));

authMocks.createAppAuth.mockImplementation(() => authMocks.installationAuth);
vi.mock('@octokit/auth-app', () => ({ createAppAuth: authMocks.createAppAuth }));

import { mintPrincipalRepositoryScopedToken, mintPrincipalRepositoryToken, mintRepositoryToken } from '../src/github-app-broker.js';
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

    await expect(mintPrincipalRepositoryToken({ ...request, principalId: 'principal-b' })).resolves.toBeUndefined();
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-b', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-a', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 456, accountId: 789, accountLogin: 'example', status: 'active', repositories: []
    }, 2_000);
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-a', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 456, accountId: 789, accountLogin: 'example', status: 'suspended',
      repositories: []
    }, 3_000);
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-a', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
    expect(authMocks.createAppAuth).not.toHaveBeenCalled();
  });

  it('selects the correct installation when principal has multiple active installations', async () => {
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 101, accountId: 201, accountLogin: 'user-org', status: 'active',
      repositories: [{ owner: 'user-org', repository: 'repo-one', contents: 'read' }]
    }, 1_000);
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 102, accountId: 202, accountLogin: 'other-org', status: 'active',
      repositories: [{ owner: 'other-org', repository: 'repo-two', contents: 'write' }]
    }, 1_100);

    // Mint for repo in first installation
    await expect(mintPrincipalRepositoryToken({
      config, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/user-org/repo-one.git'),
      installations
    })).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenLastCalledWith(expect.objectContaining({ installationId: '101' }));
    expect(authMocks.installationAuth).toHaveBeenLastCalledWith({ type: 'installation', repositoryNames: ['repo-one'] });

    // Mint for repo in second installation
    await expect(mintPrincipalRepositoryToken({
      config, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/other-org/repo-two.git'),
      installations, requiredPermission: 'write'
    })).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenLastCalledWith(expect.objectContaining({ installationId: '102' }));
    expect(authMocks.installationAuth).toHaveBeenLastCalledWith({ type: 'installation', repositoryNames: ['repo-two'] });
  });

  it('mints action-scoped tokens for pull_requests and issues with granular permissions', async () => {
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 555, accountId: 888, accountLogin: 'octocat', status: 'active',
      repositories: [{ owner: 'octocat', repository: 'hello-world', contents: 'read' }]
    }, 1_000);

    const accessConfig = { ...config, authMode: 'cloudflare-access' as const };
    const ownerBearerConfig = { ...config, authMode: 'owner-bearer' as const };

    // 1. Pull requests read (cloudflare-access)
    await expect(mintPrincipalRepositoryScopedToken({
      config: accessConfig, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'pull_requests',
      requiredPermission: 'read'
    })).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenLastCalledWith(expect.objectContaining({ installationId: '555' }));
    expect(authMocks.installationAuth).toHaveBeenLastCalledWith({
      type: 'installation',
      repositoryNames: ['hello-world'],
      permissions: { pull_requests: 'read' }
    });

    // 2. Issues write (cloudflare-access)
    await expect(mintPrincipalRepositoryScopedToken({
      config: accessConfig, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).resolves.toBe('repository-scoped-token');
    expect(authMocks.installationAuth).toHaveBeenLastCalledWith({
      type: 'installation',
      repositoryNames: ['hello-world'],
      permissions: { issues: 'write' }
    });

    // 3. Cross-principal / ungranted write denied in cloudflare-access
    await expect(mintPrincipalRepositoryScopedToken({
      config: accessConfig, principalId: 'principal-b',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).rejects.toThrow('not authorized');

    // 4. Static installation in owner-bearer mode (even if installations store is passed)
    await expect(mintPrincipalRepositoryScopedToken({
      config: ownerBearerConfig, principalId: 'owner',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenLastCalledWith(expect.objectContaining({ installationId: 456 }));
  });
});
