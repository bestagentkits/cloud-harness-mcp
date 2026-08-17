import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import type { createAppAuth } from '@octokit/auth-app';
import { GitHubApiInstallationVerifier } from '../src/github-api-installation-verifier.js';

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async (input: { type: string }) => ({ token: input.type === 'app' ? 'app-token' : 'installation-token' })
}));

const githubApp = {
  appId: 123,
  privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
} as NonNullable<RunnerConfig['githubApp']>;

const installation = { id: 456, app_id: 123, suspended_at: null, account: { id: 789, login: 'acme' } };
const repository = (index: number) => ({
  name: `repo-${index}`,
  owner: { login: 'acme' },
  permissions: { contents: index % 2 === 0 ? 'write' : 'read' }
});

describe('GitHub API installation verifier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('paginates until the declared repository set is complete', async () => {
    const requested: string[] = [];
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input); requested.push(url);
      if (url.includes('/app/installations/')) return Response.json(installation);
      if (url.includes('&page=1')) return Response.json({ total_count: 101, repositories: Array.from({ length: 100 }, (_, index) => repository(index)) });
      return Response.json({ total_count: 101, repositories: [repository(100)] });
    }) as typeof fetch;

    const verified = await new GitHubApiInstallationVerifier(githubApp, request).verifyInstallation('456');
    expect(verified.repositories).toHaveLength(101);
    expect(verified.repositories[0]).toMatchObject({ owner: 'acme', repository: 'repo-0', contents: 'write' });
    expect(requested.filter((url) => url.includes('/installation/repositories'))).toEqual([
      'https://api.github.com/installation/repositories?per_page=100&page=1',
      'https://api.github.com/installation/repositories?per_page=100&page=2'
    ]);
  });

  it('fails closed when the repository count exceeds the configured bound', async () => {
    const request = vi.fn(async (input: URL | RequestInfo) => String(input).includes('/app/installations/')
      ? Response.json(installation)
      : Response.json({ total_count: 101, repositories: Array.from({ length: 100 }, (_, index) => repository(index)) })) as typeof fetch;
    const verifier = new GitHubApiInstallationVerifier(githubApp, request, { maxRepositories: 100 });
    await expect(verifier.verifyInstallation('456')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('fails closed on an incomplete page instead of treating absent grants as removed', async () => {
    const request = vi.fn(async (input: URL | RequestInfo) => String(input).includes('/app/installations/')
      ? Response.json(installation)
      : Response.json({ total_count: 2, repositories: [repository(0)] })) as typeof fetch;
    await expect(new GitHubApiInstallationVerifier(githubApp, request).verifyInstallation('456'))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('preserves provider 404 as an explicit not-found reconciliation signal', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
    await expect(new GitHubApiInstallationVerifier(githubApp, request).verifyInstallation('456'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces one wall-clock deadline across installation and repository pages', async () => {
    let now = 0;
    const request = vi.fn(async (input: URL | RequestInfo) => {
      now += 3;
      return String(input).includes('/app/installations/')
        ? Response.json(installation)
        : Response.json({ total_count: 0, repositories: [] });
    }) as typeof fetch;
    const verifier = new GitHubApiInstallationVerifier(githubApp, request, { timeoutMs: 5 }, () => now);
    await expect(verifier.verifyInstallation('456')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('bounds installation-token acquisition within the same deadline', async () => {
    const request = vi.fn(async () => Response.json(installation)) as typeof fetch;
    const hangingAuth = (() => async (input: { type: string }) => {
      if (input.type === 'app') return { token: 'app-token' };
      return await new Promise<never>(() => undefined);
    }) as unknown as typeof createAppAuth;
    const verifier = new GitHubApiInstallationVerifier(
      githubApp, request, { timeoutMs: 10 }, Date.now, hangingAuth
    );
    await expect(verifier.verifyInstallation('456')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
