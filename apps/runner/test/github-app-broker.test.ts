import { describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';

const authMocks = vi.hoisted(() => ({
  installationAuth: vi.fn(async () => ({ token: 'repository-scoped-token' })),
  createAppAuth: vi.fn()
}));

authMocks.createAppAuth.mockImplementation(() => authMocks.installationAuth);
vi.mock('@octokit/auth-app', () => ({ createAppAuth: authMocks.createAppAuth }));

import { mintRepositoryToken } from '../src/github-app-broker.js';

const config = {
  githubApp: { appId: 123, installationId: 456, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' }
} as RunnerConfig;

describe('GitHub App broker', () => {
  it('requests an installation token scoped to only the cloned repository', async () => {
    await expect(mintRepositoryToken(config, new URL('https://github.com/example/private-repo.git'))).resolves.toBe('repository-scoped-token');
    expect(authMocks.createAppAuth).toHaveBeenCalledWith(expect.objectContaining({ appId: 123, installationId: 456 }));
    expect(authMocks.installationAuth).toHaveBeenCalledWith({ type: 'installation', repositoryNames: ['private-repo'] });
  });
});
