import { HarnessError, type RunnerConfig } from '@cloud-harness/contracts';

/**
 * What a GitHub user authorization proved about one installation. The user access token that
 * produced it is used only inside `proveInstallationAdministration` and is never returned,
 * stored, or logged.
 */
export type GitHubUserInstallationProof = {
  userId: string;
  userLogin: string;
  appId: string;
  installationId: string;
  accountId: string;
  accountLogin: string;
  /** `owner`: the personal account itself. `organization_admin`: an active organization owner. */
  relation: 'owner' | 'organization_admin';
};

export interface GitHubUserAuthorizer {
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /**
   * Exchanges the authorization code (with its PKCE verifier) for a user access token and proves
   * that the GitHub user can access the installation and owns or administers its account.
   * Membership alone is not ownership, so an organization member who is not an owner is refused.
   */
  proveInstallationAdministration(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    installationId: string;
  }): Promise<GitHubUserInstallationProof>;
}

type GitHubAppCredentials = Pick<NonNullable<RunnerConfig['githubApp']>, 'appId'> & { clientId: string; clientSecret: string };

type TokenPayload = { access_token?: unknown; token_type?: unknown; error?: unknown };
type UserPayload = { id?: unknown; login?: unknown };
type UserInstallationsPayload = {
  total_count?: unknown;
  installations?: Array<{ id?: unknown; app_id?: unknown; account?: { id?: unknown; login?: unknown; type?: unknown } | null }>;
};
type MembershipPayload = { state?: unknown; role?: unknown };

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const REVOKE_TIMEOUT_MS = 5_000;

export class GitHubApiUserAuthorizer implements GitHubUserAuthorizer {
  constructor(
    private readonly githubApp: GitHubAppCredentials,
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.githubApp.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async proveInstallationAdministration(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    installationId: string;
  }): Promise<GitHubUserInstallationProof> {
    const deadline = this.now() + this.timeoutMs;
    const token = await this.exchangeCode(input, deadline);
    try {
      return await this.proveWithToken(token, input.installationId, deadline);
    } finally {
      await this.revokeToken(token);
    }
  }

  private async proveWithToken(token: string, installationId: string, deadline: number): Promise<GitHubUserInstallationProof> {
    const user = await this.get<UserPayload>('/user', token, deadline);
    if (!user || !isId(user.id) || typeof user.login !== 'string' || !user.login) throw invalidProviderResponse();
    const installation = await this.findUserInstallation(token, installationId, deadline);
    const account = installation.account;
    if (!account || !isId(account.id) || typeof account.login !== 'string' || !account.login || !isId(installation.app_id)) {
      throw invalidProviderResponse();
    }
    const proof = {
      userId: String(user.id),
      userLogin: user.login,
      appId: String(installation.app_id),
      installationId,
      accountId: String(account.id),
      accountLogin: account.login
    };
    if (String(installation.app_id) !== String(this.githubApp.appId)) throw notAccessible(installationId);
    if (account.type === 'User') {
      if (proof.accountId !== proof.userId) {
        throw new HarnessError('FORBIDDEN', `Only the owner of the GitHub account ${account.login} can connect its installation. Sign in to GitHub as ${account.login}, then start again.`, 403);
      }
      return { ...proof, relation: 'owner' };
    }
    if (account.type === 'Organization') {
      const membership = await this.get<MembershipPayload>(
        `/user/memberships/orgs/${encodeURIComponent(account.login)}`, token, deadline, { notFound: 'refused' }
      );
      if (membership?.state !== 'active' || membership.role !== 'admin') {
        throw new HarnessError(
          'FORBIDDEN',
          `GitHub did not confirm that you are an owner of the ${account.login} organization. An organization owner must connect it, and the GitHub App needs the Members (read) organization permission.`,
          403
        );
      }
      return { ...proof, relation: 'organization_admin' };
    }
    throw new HarnessError('FORBIDDEN', 'Only personal-account and organization installations can be connected.', 403);
  }

  /**
   * Deletes the user access token at GitHub so it does not outlive the proof. Best effort: a
   * failure only leaves the token to expire on GitHub's schedule. The token is never logged.
   */
  private async revokeToken(token: string): Promise<void> {
    try {
      const basic = Buffer.from(`${this.githubApp.clientId}:${this.githubApp.clientSecret}`).toString('base64');
      const response = await this.request(
        `https://api.github.com/applications/${encodeURIComponent(this.githubApp.clientId)}/token`,
        {
          method: 'DELETE',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Basic ${basic}`,
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28'
          },
          body: JSON.stringify({ access_token: token }),
          redirect: 'error',
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS)
        }
      );
      await response.body?.cancel();
    } catch {
      // Ignored: revocation is best effort.
    }
  }

  private async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }, deadline: number): Promise<string> {
    const response = await this.send('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.githubApp.clientId,
        client_secret: this.githubApp.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier
      })
    }, deadline);
    if (!response.ok) throw unavailable();
    const payload = await this.json<TokenPayload>(response, deadline);
    if (payload.error === 'bad_verification_code') {
      throw new HarnessError('FORBIDDEN', 'GitHub authorization code is invalid or expired. Start the connection again.', 403);
    }
    if (payload.error === 'redirect_uri_mismatch') {
      throw new HarnessError('UNAVAILABLE', 'The GitHub App Callback URL does not match this dashboard', 503, false);
    }
    if (payload.error !== undefined || typeof payload.access_token !== 'string' || !payload.access_token ||
      (typeof payload.token_type === 'string' && payload.token_type.toLowerCase() !== 'bearer')) {
      throw unavailable();
    }
    return payload.access_token;
  }

  private async findUserInstallation(token: string, installationId: string, deadline: number) {
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await this.get<UserInstallationsPayload>(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, token, deadline);
      if (!payload || typeof payload.total_count !== 'number' || !Array.isArray(payload.installations)) throw invalidProviderResponse();
      const match = payload.installations.find((installation) => isId(installation.id) && String(installation.id) === installationId);
      if (match) return match;
      seen += payload.installations.length;
      if (seen >= payload.total_count || payload.installations.length < PAGE_SIZE) break;
    }
    throw notAccessible(installationId);
  }

  private async get<T>(path: string, token: string, deadline: number, options: { notFound?: 'refused' } = {}): Promise<T | undefined> {
    const response = await this.send(new URL(path, 'https://api.github.com').toString(), {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' }
    }, deadline);
    if (options.notFound && response.status === 404) return undefined;
    if (options.notFound && response.status === 403 && !isRateLimited(response)) return undefined;
    if (!response.ok) throw unavailable();
    return await this.json<T>(response, deadline);
  }

  private async send(url: string, init: RequestInit, deadline: number): Promise<Response> {
    const remainingMs = deadline - this.now();
    if (remainingMs <= 0) throw timedOut();
    try {
      return await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(remainingMs) });
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw timedOut();
      throw unavailable();
    }
  }

  private async json<T>(response: Response, deadline: number): Promise<T> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw invalidProviderResponse();
    }
    if (this.now() >= deadline) throw timedOut();
    if (!payload || typeof payload !== 'object') throw invalidProviderResponse();
    return payload as T;
  }
}

function isRateLimited(response: Response): boolean {
  return response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
}

function isId(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value));
}

function notAccessible(installationId: string): HarnessError {
  return new HarnessError(
    'FORBIDDEN',
    `Your GitHub account cannot access installation ${installationId}. Sign in to GitHub as the account owner or an organization owner, then start again.`,
    403
  );
}

function unavailable(): HarnessError {
  return new HarnessError('UNAVAILABLE', 'GitHub user authorization failed', 502, true);
}

function invalidProviderResponse(): HarnessError {
  return new HarnessError('UNAVAILABLE', 'GitHub returned an invalid user authorization response', 502, true);
}

function timedOut(): HarnessError {
  return new HarnessError('TIMEOUT', 'GitHub user authorization timed out', 504, true);
}
