import { createAppAuth } from '@octokit/auth-app';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';

export async function mintRepositoryToken(config: RunnerConfig, repositoryUrl: URL): Promise<string | undefined> {
  if (!config.githubApp || repositoryUrl.hostname.toLowerCase() !== 'github.com') return undefined;
  const parts = repositoryUrl.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
  const repositoryName = parts[1];
  if (parts.length !== 2 || !repositoryName) throw new HarnessError('INVALID_INPUT', 'GitHub repository URL must identify one owner and repository');
  try {
    const auth = createAppAuth({
      appId: config.githubApp.appId,
      installationId: config.githubApp.installationId,
      privateKey: config.githubApp.privateKey
    });
    const authentication = await auth({ type: 'installation', repositoryNames: [repositoryName] });
    return authentication.token;
  } catch {
    throw new HarnessError('UNAVAILABLE', 'GitHub App could not mint a repository-scoped installation token', 502, true);
  }
}
