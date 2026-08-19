import { createAppAuth } from '@octokit/auth-app';
import { request as octokitRequest } from '@octokit/request';
import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';
import type { GitHubInstallationVerifier } from './github-binding-service.js';
import type { VerifiedGitHubInstallation } from './github-installation-store.js';

type InstallationPayload = {
  id?: number; app_id?: number; suspended_at?: string | null;
  account?: { id?: number; login?: string };
};
type RepositoriesPayload = {
  total_count?: number;
  repositories?: Array<{ name?: string; owner?: { login?: string }; permissions?: { contents?: string; push?: boolean; pull?: boolean } }>;
};

type VerificationLimits = {
  maxPages?: number;
  maxRepositories?: number;
  timeoutMs?: number;
};

const PAGE_SIZE = 100;

export class GitHubApiInstallationVerifier implements GitHubInstallationVerifier {
  readonly #maxPages: number;
  readonly #maxRepositories: number;
  readonly #timeoutMs: number;

  constructor(
    private readonly githubApp: NonNullable<RunnerConfig['githubApp']>,
    private readonly request: typeof fetch = fetch,
    limits: VerificationLimits = {},
    private readonly now: () => number = Date.now,
    private readonly authFactory: typeof createAppAuth = createAppAuth
  ) {
    this.#maxPages = positiveLimit(limits.maxPages, 10, 'page');
    this.#maxRepositories = positiveLimit(limits.maxRepositories, 1_000, 'repository');
    this.#timeoutMs = positiveLimit(limits.timeoutMs, 10_000, 'time');
  }

  async verifyInstallation(installationId: string): Promise<VerifiedGitHubInstallation> {
    const deadline = this.now() + this.#timeoutMs;
    const boundedRequest = octokitRequest.defaults({
      request: {
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const remainingMs = deadline - this.now();
          if (remainingMs <= 0) throw verificationTimedOut();
          return await this.request(input, { ...init, signal: AbortSignal.timeout(remainingMs) });
        }
      }
    });
    const auth = this.authFactory({
      appId: this.githubApp.appId, installationId: Number(installationId),
      privateKey: this.githubApp.privateKey, request: boundedRequest
    });
    let appAuthentication;
    try {
      appAuthentication = await this.withinDeadline(auth({ type: 'app' }), deadline);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const msg = error instanceof Error ? error.message : 'GitHub App authentication failed';
      throw new HarnessError('UNAVAILABLE', `GitHub App authentication failed: ${msg}`, 502, true);
    }
    const installation = await this.get<InstallationPayload>(
      `/app/installations/${encodeURIComponent(installationId)}`,
      appAuthentication.token,
      deadline
    );
    let installationAuthentication;
    try {
      installationAuthentication = await this.withinDeadline(
        auth({ type: 'installation', installationId: Number(installationId) }), deadline
      );
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const msg = error instanceof Error ? error.message : 'GitHub installation token creation failed';
      throw new HarnessError('UNAVAILABLE', `GitHub installation token creation failed: ${msg}`, 502, true);
    }
    const repositories = await this.getAllRepositories(installationAuthentication.token, deadline);
    if (!installation.id || !installation.app_id || !installation.account?.id || !installation.account.login) {
      throw new HarnessError('UNAVAILABLE', 'GitHub returned an invalid installation record', 502, true);
    }
    return {
      appId: installation.app_id,
      installationId: installation.id,
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      status: installation.suspended_at ? 'suspended' : 'active',
      repositories: repositories.map((repository) => {
        const permissions = repository.permissions;
        const contents = permissions?.contents === 'write' || permissions?.push === true
          ? 'write'
          : 'read';
        return { owner: repository.owner!.login!, repository: repository.name!, contents } as const;
      })
    };
  }

  private async getAllRepositories(token: string, deadline: number): Promise<NonNullable<RepositoriesPayload['repositories']>> {
    const collected: NonNullable<RepositoriesPayload['repositories']> = [];
    const repositoryKeys = new Set<string>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const payload = await this.get<RepositoriesPayload>(
        `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
        token,
        deadline
      );
      const totalCount = payload.total_count;
      if (!Number.isSafeInteger(totalCount) || totalCount === undefined || totalCount < 0 || !Array.isArray(payload.repositories)) {
        throw invalidProviderResponse('GitHub returned an invalid repository page');
      }
      if (expectedTotal === undefined) {
        expectedTotal = totalCount;
        if (totalCount > this.#maxRepositories) throw repositoryLimitExceeded();
      } else if (totalCount !== expectedTotal) {
        throw invalidProviderResponse('GitHub repository pagination changed during verification');
      }
      for (const repository of payload.repositories) {
        if (!repository.owner?.login || !repository.name) {
          throw invalidProviderResponse('GitHub returned an invalid repository record');
        }
        const key = `${repository.owner.login.toLowerCase()}\0${repository.name.toLowerCase()}`;
        if (repositoryKeys.has(key)) throw invalidProviderResponse('GitHub returned a duplicate repository record');
        repositoryKeys.add(key);
        collected.push(repository);
        if (collected.length > this.#maxRepositories || collected.length > totalCount) throw repositoryLimitExceeded();
      }
      if (collected.length === totalCount) return collected;
      if (payload.repositories.length !== PAGE_SIZE) {
        throw invalidProviderResponse('GitHub returned an incomplete repository list');
      }
    }
    throw repositoryLimitExceeded();
  }

  private async get<T>(path: string, token: string, deadline: number): Promise<T> {
    const remainingMs = deadline - this.now();
    if (remainingMs <= 0) throw verificationTimedOut();
    let response: Response;
    try {
      response = await this.request(new URL(path, 'https://api.github.com'), {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(remainingMs)
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw verificationTimedOut();
      }
      throw new HarnessError('UNAVAILABLE', 'GitHub installation verification failed', 502, true);
    }
    if (this.now() >= deadline) throw verificationTimedOut();
    if (!response.ok) {
      if (response.status === 404) throw new HarnessError('NOT_FOUND', 'GitHub installation not found', 404, false);
      throw new HarnessError('UNAVAILABLE', 'GitHub installation verification failed', 502, true);
    }
    const payload = await response.json() as T;
    if (this.now() >= deadline) throw verificationTimedOut();
    return payload;
  }

  private async withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const remainingMs = deadline - this.now();
    if (remainingMs <= 0) throw verificationTimedOut();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(verificationTimedOut()), remainingMs);
          timer.unref();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`GitHub verification ${name} limit must be positive`);
  return resolved;
}

function invalidProviderResponse(message: string): HarnessError {
  return new HarnessError('UNAVAILABLE', message, 502, true);
}

function repositoryLimitExceeded(): HarnessError {
  return new HarnessError('LIMIT_EXCEEDED', 'GitHub repository verification exceeded its completeness bound', 413, false);
}

function verificationTimedOut(): HarnessError {
  return new HarnessError('TIMEOUT', 'GitHub installation verification timed out', 504, true);
}
