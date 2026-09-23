import { createAppAuth } from '@octokit/auth-app';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import type { GitHubInstallationStore } from './github-installation-store.js';

export type GitHubPermissionScope = 'issues' | 'pull_requests' | 'contents';

export type GitHubAuthorizationFailureReason = 'permission_not_granted' | 'repository_not_authorized';

type GitHubActionPermissions = {
  scope: GitHubPermissionScope;
  write: boolean;
};

const GITHUB_ACTION_PERMISSIONS: Record<string, GitHubActionPermissions> = {
  issue_list: { scope: 'issues', write: false },
  issue_view: { scope: 'issues', write: false },
  issue_create: { scope: 'issues', write: true },
  issue_comment: { scope: 'issues', write: true },
  issue_comment_update: { scope: 'issues', write: true },
  issue_update: { scope: 'issues', write: true },
  issue_publish: { scope: 'issues', write: true },
  label_create: { scope: 'issues', write: true },
  issue_labels_add: { scope: 'issues', write: true },
  issue_labels_remove: { scope: 'issues', write: true },
  pr_list: { scope: 'pull_requests', write: false },
  pr_view: { scope: 'pull_requests', write: false },
  pr_create: { scope: 'pull_requests', write: true },
  pr_update: { scope: 'pull_requests', write: true },
  pr_comment: { scope: 'pull_requests', write: true },
  commit_list: { scope: 'contents', write: false },
  compare: { scope: 'contents', write: false },
  release_list: { scope: 'contents', write: false },
  tag_list: { scope: 'contents', write: false }
};

export function requiredGitHubPermissions(
  action: string
): { scope: GitHubPermissionScope; write: boolean } | undefined {
  return GITHUB_ACTION_PERMISSIONS[action];
}

export type MintedInstallationToken = {
  token: string;
  permissions: Record<string, string>;
};

export async function mintRepositoryToken(config: RunnerConfig, repositoryUrl: URL): Promise<string | undefined> {
  if (!config.githubApp || repositoryUrl.hostname.toLowerCase() !== 'github.com') return undefined;
  if (!config.githubApp.installationId) return undefined;
  const { repository } = parseGitHubRepository(repositoryUrl);
  return mintForInstallation(config.githubApp, config.githubApp.installationId, repository);
}

export async function mintPrincipalRepositoryToken(input: {
  config: RunnerConfig;
  principalId: string;
  repositoryUrl: URL;
  installations: GitHubInstallationStore;
  requiredPermission?: 'read' | 'write';
}): Promise<string | undefined> {
  if (!input.config.githubApp || input.repositoryUrl.hostname.toLowerCase() !== 'github.com') return undefined;
  const { owner, repository } = parseGitHubRepository(input.repositoryUrl);
  const grant = input.installations.getRepositoryGrant(input.principalId, owner, repository);
  const requiredPermission = input.requiredPermission ?? 'read';

  if (!grant || grant.status !== 'granted') {
    if (requiredPermission === 'write') {
      throw repositoryNotAuthorized();
    }
    return undefined;
  }

  if (requiredPermission === 'write' && grant.contents !== 'write') {
    throw repositoryNotAuthorized();
  }

  const installation = input.installations.getInstallation(input.principalId, grant.installationId);
  if (
    !installation ||
    installation.status !== 'active' ||
    String(input.config.githubApp.appId) !== installation.appId
  ) throw repositoryNotAuthorized();

  return mintForInstallation(input.config.githubApp, installation.installationId, repository);
}

export async function mintPrincipalRepositoryScopedToken(input: {
  config: RunnerConfig;
  principalId: string;
  repositoryUrl: URL;
  installations?: GitHubInstallationStore | undefined;
  permissionScope: GitHubPermissionScope;
  requiredPermission: 'read' | 'write';
}): Promise<MintedInstallationToken | undefined> {
  if (!input.config.githubApp || input.repositoryUrl.hostname.toLowerCase() !== 'github.com') return undefined;
  const { owner, repository } = parseGitHubRepository(input.repositoryUrl);
  const authMode = input.config.authMode ?? 'owner-bearer';

  if (authMode === 'cloudflare-access') {
    if (!input.installations) {
      if (input.requiredPermission === 'write') {
        throw repositoryNotAuthorized();
      }
      return undefined;
    }
    const grant = input.installations.getRepositoryGrant(input.principalId, owner, repository);
    if (!grant || grant.status !== 'granted') {
      if (input.requiredPermission === 'write') {
        throw repositoryNotAuthorized();
      }
      return undefined;
    }

    const installation = input.installations.getInstallation(input.principalId, grant.installationId);
    if (
      !installation ||
      installation.status !== 'active' ||
      String(input.config.githubApp.appId) !== installation.appId
    ) {
      throw repositoryNotAuthorized();
    }

    return mintForInstallationScoped(
      input.config.githubApp,
      installation.installationId,
      repository,
      input.permissionScope,
      input.requiredPermission
    );
  }

  if (input.config.githubApp.installationId) {
    return mintForInstallationScoped(
      input.config.githubApp,
      input.config.githubApp.installationId,
      repository,
      input.permissionScope,
      input.requiredPermission
    );
  }

  if (input.requiredPermission === 'write') {
    throw repositoryNotAuthorized();
  }
  return undefined;
}

function repositoryNotAuthorized(): HarnessError {
  return new HarnessError('FORBIDDEN', 'GitHub repository access is not authorized', 403, false, {
    reason: 'repository_not_authorized'
  });
}

async function mintForInstallationScoped(
  githubApp: NonNullable<RunnerConfig['githubApp']>,
  installationId: string | number,
  repositoryName: string,
  permissionScope: GitHubPermissionScope,
  requiredPermission: 'read' | 'write'
): Promise<MintedInstallationToken> {
  try {
    const auth = createAppAuth({
      appId: githubApp.appId,
      installationId,
      privateKey: githubApp.privateKey
    });
    const authentication = await auth({
      type: 'installation',
      repositoryNames: [repositoryName],
      // The action scope alone is not enough: `gh` resolves repository metadata (for
      // example `defaultBranchRef`) through the GraphQL API, and a token narrowed to a
      // single scope is refused with `Resource not accessible by integration`, which
      // breaks pr_view, pr_list, issue_view and pr_create. Always carry contents: read
      // beside the action scope; a contents-scoped token already asks for the level the
      // action needs.
      permissions: permissionScope === 'contents'
        ? { contents: requiredPermission }
        : { [permissionScope]: requiredPermission, contents: 'read' }
    });
    return { token: authentication.token, permissions: authentication.permissions };
  } catch (error) {
    if (installationTokenStatus(error) === 422) {
      // GitHub answers 422 both for permissions the installation does not grant and
      // for other validation failures, so keep its own message for diagnosis while
      // the type still tells the caller which remedy applies.
      const detail = error instanceof Error ? error.message : '';
      throw new HarnessError(
        'FORBIDDEN',
        `GitHub App installation cannot grant the requested permissions${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        403,
        false,
        {
          reason: 'permission_not_granted',
          requiredScopes: [permissionScope]
        }
      );
    }
    throw new HarnessError('UNAVAILABLE', `GitHub App could not mint an installation token with ${permissionScope} permission`, 502, true);
  }
}

function installationTokenStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('status' in error && typeof error.status === 'number') return error.status;
  if ('response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'status' in response && typeof response.status === 'number') {
      return response.status;
    }
  }
  return undefined;
}

function parseGitHubRepository(repositoryUrl: URL): { owner: string; repository: string } {
  const parts = repositoryUrl.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HarnessError('INVALID_INPUT', 'GitHub repository URL must identify one owner and repository');
  }
  return { owner: parts[0].toLowerCase(), repository: parts[1].toLowerCase() };
}

async function mintForInstallation(
  githubApp: NonNullable<RunnerConfig['githubApp']>,
  installationId: string | number,
  repositoryName: string
): Promise<string> {
  try {
    const auth = createAppAuth({ appId: githubApp.appId, installationId, privateKey: githubApp.privateKey });
    const authentication = await auth({ type: 'installation', repositoryNames: [repositoryName] });
    return authentication.token;
  } catch {
    throw new HarnessError('UNAVAILABLE', 'GitHub App could not mint a repository-scoped installation token', 502, true);
  }
}
