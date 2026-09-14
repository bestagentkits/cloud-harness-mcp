import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';

const authMocks = vi.hoisted(() => ({
  installationAuth: vi.fn(async () => ({
    token: 'repository-scoped-token',
    permissions: { issues: 'write', pull_requests: 'write' }
  })),
  createAppAuth: vi.fn()
}));

authMocks.createAppAuth.mockImplementation(() => authMocks.installationAuth);
vi.mock('@octokit/auth-app', () => ({ createAppAuth: authMocks.createAppAuth }));

import {
  mintPrincipalRepositoryScopedToken,
  mintPrincipalRepositoryToken,
  mintRepositoryToken,
  requiredGitHubPermissions
} from '../src/github-app-broker.js';
import { InMemoryGitHubInstallationStore } from '../src/github-installation-store.js';

const config = {
  githubApp: { appId: 123, installationId: 456, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' }
} as RunnerConfig;

const activeInstallation = (overrides: Partial<{
  appId: number; installationId: number | string; accountId: number | string; accountLogin: string;
  issues: 'none' | 'read' | 'write' | null; pullRequests: 'none' | 'read' | 'write' | null;
  status: 'active' | 'suspended' | 'uninstalled';
  repositories: { owner: string; repository: string; contents: 'read' | 'write' }[];
}> = {}) => ({
  appId: 123,
  installationId: 555,
  accountId: 888,
  accountLogin: 'octocat',
  issues: null,
  pullRequests: null,
  status: 'active' as const,
  repositories: [{ owner: 'octocat', repository: 'hello-world', contents: 'read' as const }],
  ...overrides
});

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
      issues: null,
      pullRequests: null,
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
      issues: null,
      pullRequests: null,
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
      appId: 123, installationId: 456, accountId: 789, accountLogin: 'example', issues: null, pullRequests: null,
      status: 'active', repositories: []
    }, 2_000);
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-a', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 456, accountId: 789, accountLogin: 'example', issues: null, pullRequests: null,
      status: 'suspended', repositories: []
    }, 3_000);
    await expect(mintPrincipalRepositoryToken({
      ...request, principalId: 'principal-a', requiredPermission: 'write'
    })).rejects.toThrow('not authorized');
    expect(authMocks.createAppAuth).not.toHaveBeenCalled();
  });

  it('selects the correct installation when principal has multiple active installations', async () => {
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 101, accountId: 201, accountLogin: 'user-org', issues: null, pullRequests: null,
      status: 'active', repositories: [{ owner: 'user-org', repository: 'repo-one', contents: 'read' }]
    }, 1_000);
    installations.replaceVerified('principal-a', {
      appId: 123, installationId: 102, accountId: 202, accountLogin: 'other-org', issues: null, pullRequests: null,
      status: 'active', repositories: [{ owner: 'other-org', repository: 'repo-two', contents: 'write' }]
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
    installations.replaceVerified('principal-a', activeInstallation({ installationId: 555, issues: 'read', pullRequests: 'read' }), 1_000);

    const accessConfig = { ...config, authMode: 'cloudflare-access' as const };
    const ownerBearerConfig = { ...config, authMode: 'owner-bearer' as const };
    const granted = { token: 'repository-scoped-token', permissions: { issues: 'write', pull_requests: 'write' } };

    // 1. Pull requests read (cloudflare-access)
    await expect(mintPrincipalRepositoryScopedToken({
      config: accessConfig, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'pull_requests',
      requiredPermission: 'read'
    })).resolves.toEqual(granted);
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
    })).resolves.toEqual(granted);
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
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'repository_not_authorized' }
    });

    // 4. Static installation in owner-bearer mode (even if installations store is passed)
    await expect(mintPrincipalRepositoryScopedToken({
      config: ownerBearerConfig, principalId: 'owner',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).resolves.toEqual(granted);
    expect(authMocks.createAppAuth).toHaveBeenLastCalledWith(expect.objectContaining({ installationId: 456 }));
  });

  it.each([
    ['issue_list', 'issues', false],
    ['issue_view', 'issues', false],
    ['issue_create', 'issues', true],
    ['issue_comment', 'issues', true],
    ['issue_comment_update', 'issues', true],
    ['issue_update', 'issues', true],
    ['issue_publish', 'issues', true],
    ['label_create', 'issues', true],
    ['issue_labels_add', 'issues', true],
    ['issue_labels_remove', 'issues', true],
    ['pr_list', 'pull_requests', false],
    ['pr_view', 'pull_requests', false],
    ['pr_create', 'pull_requests', true],
    ['pr_update', 'pull_requests', true],
    ['pr_comment', 'pull_requests', true]
  ])('requires the exact GitHub permission for %s', (action, scope, write) => {
    expect(requiredGitHubPermissions(action)).toEqual({ scope, write });
  });

  it('reports no requirement for an action the broker does not serve', () => {
    expect(requiredGitHubPermissions('release_create')).toBeUndefined();
  });

  it('mints one token carrying the scope the action needs', async () => {
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', activeInstallation({ installationId: 555, issues: 'write', pullRequests: 'write' }), 1_000);
    const accessConfig = { ...config, authMode: 'cloudflare-access' as const };

    await expect(mintPrincipalRepositoryScopedToken({
      config: accessConfig, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'pull_requests',
      requiredPermission: 'write'
    })).resolves.toEqual({ token: 'repository-scoped-token', permissions: { issues: 'write', pull_requests: 'write' } });
    expect(authMocks.installationAuth).toHaveBeenCalledTimes(1);
    expect(authMocks.installationAuth).toHaveBeenLastCalledWith({
      type: 'installation',
      repositoryNames: ['hello-world'],
      permissions: { pull_requests: 'write' }
    });
  });

  it('returns the permissions GitHub granted rather than the requested scope', async () => {
    authMocks.installationAuth.mockResolvedValueOnce({ token: 'short-token', permissions: { issues: 'read' } });
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', activeInstallation({ issues: 'read', pullRequests: 'none' }), 1_000);

    await expect(mintPrincipalRepositoryScopedToken({
      config: { ...config, authMode: 'owner-bearer' as const }, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).resolves.toEqual({ token: 'short-token', permissions: { issues: 'read' } });
  });

  it.each([
    [{ status: 422 }],
    [{ response: { status: 422 } }]
  ])('classifies a rejected grant %o as FORBIDDEN with its required scope', async (rejection) => {
    authMocks.installationAuth.mockRejectedValueOnce(rejection);
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', activeInstallation({ issues: 'write', pullRequests: 'write' }), 1_000);

    await expect(mintPrincipalRepositoryScopedToken({
      config: { ...config, authMode: 'owner-bearer' as const }, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'permission_not_granted', requiredScopes: ['issues'] }
    });
  });

  it('keeps a mint failure that is not a rejected grant as UNAVAILABLE', async () => {
    authMocks.installationAuth.mockRejectedValueOnce({ status: 500 });
    const installations = new InMemoryGitHubInstallationStore();
    installations.replaceVerified('principal-a', activeInstallation({ issues: 'write', pullRequests: 'write' }), 1_000);

    await expect(mintPrincipalRepositoryScopedToken({
      config: { ...config, authMode: 'owner-bearer' as const }, principalId: 'principal-a',
      repositoryUrl: new URL('https://github.com/octocat/hello-world.git'),
      installations,
      permissionScope: 'issues',
      requiredPermission: 'write'
    })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
