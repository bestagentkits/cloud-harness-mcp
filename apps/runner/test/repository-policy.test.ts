import { describe, expect, it } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { mintRepositoryToken } from '../src/github-app-broker.js';
import { validateRepositoryUrl } from '../src/repository-policy.js';

const baseConfig: RunnerConfig = {
  host: '127.0.0.1',
  port: 3001,
  serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
  jobsRoot: '/tmp/jobs',
  stateDb: '/tmp/state.db',
  executorImage: 'cloud-harness-executor:local',
  allowedGitHosts: ['github.com'],
  networkProfile: 'network-none',
  wallTtlSeconds: 300,
  idleTtlSeconds: 180,
  maxOutputBytes: 262_144,
  minFreeBytes: 104_857_600,
  maxWorkspaceBytes: 536_870_912,
  reaperIntervalSeconds: 30
};

describe('repository URL policy', () => {
  it('rejects local, credentialed, non-HTTPS, and non-allowlisted repositories', async () => {
    await expect(validateRepositoryUrl('file:///etc/passwd', ['github.com'])).rejects.toThrow();
    await expect(validateRepositoryUrl('https://token@github.com/owner/repo.git', ['github.com'])).rejects.toThrow();
    await expect(validateRepositoryUrl('https://127.0.0.1/repo.git', ['127.0.0.1'])).rejects.toThrow();
    await expect(validateRepositoryUrl('https://example.com/repo.git', ['github.com'])).rejects.toThrow();
  });

  it('does not mint credentials unless the optional GitHub App broker is configured', async () => {
    await expect(mintRepositoryToken(baseConfig, new URL('https://github.com/owner/repo.git'))).resolves.toBeUndefined();
  });

  it('rejects ambiguous GitHub repository paths before contacting the broker', async () => {
    const config: RunnerConfig = {
      ...baseConfig,
      githubApp: { appId: '1', installationId: '2', privateKey: 'not-used' }
    };
    await expect(mintRepositoryToken(config, new URL('https://github.com/owner/repo/extra.git'))).rejects.toThrow(
      'GitHub repository URL must identify one owner and repository'
    );
  });
});
