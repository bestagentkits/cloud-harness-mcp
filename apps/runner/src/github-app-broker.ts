import { createAppAuth } from '@octokit/auth-app';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import type { GitHubInstallationStore } from './github-installation-store.js';

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
  const installation = input.installations.getInstallation(input.principalId);
  const grant = input.installations.getRepositoryGrant(input.principalId, owner, repository);
  const requiredPermission = input.requiredPermission ?? 'read';
  if (
    !installation ||
    installation.status !== 'active' ||
    String(input.config.githubApp.appId) !== installation.appId ||
    !grant ||
    grant.installationId !== installation.installationId ||
    grant.status !== 'granted' ||
    (requiredPermission === 'write' && grant.contents !== 'write')
  ) throw new HarnessError('FORBIDDEN', 'GitHub repository access is not authorized', 403);

  return mintForInstallation(input.config.githubApp, installation.installationId, repository);
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
