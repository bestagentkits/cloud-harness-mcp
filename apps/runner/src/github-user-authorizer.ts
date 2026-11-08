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

/** What a `user` authorization produced. Expiry times are epoch milliseconds. The tokens never leave the runner process. */
export type GitHubUserTokenExchange = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  userId: string;
  login: string;
};

/** The outcome of renewing a user authorization: a rotated pair, or GitHub's refusal of the refresh token. */
export type GitHubUserTokenRefresh =
  | { status: 'refreshed'; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }
  | { status: 'revoked'; reasonCode: 'bad_refresh_token' };

/**
 * GitHub answered 401 for a user access token: it expired, a refresh rotated it, or the person revoked
 * the App. This alone proves none of them, so it never revokes anything; the caller refreshes to find out.
 */
export class GitHubUserTokenRejectedError extends Error {
  constructor() {
    super('GitHub rejected the user access token');
    this.name = 'GitHubUserTokenRejectedError';
  }
}

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
  /** The authorize URL of the `user` purpose: `authorizeUrl` plus `scope=offline_access`, which requests a refresh token. */
  authorizeUserUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /**
   * Exchanges the code for the token pair the `user` purpose keeps. It fails closed, and revokes what
   * GitHub issued, when the response lacks `refresh_token`, `expires_in`, or `refresh_token_expires_in`.
   */
  exchangeUserCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GitHubUserTokenExchange>;
  /** Redeems a refresh token. GitHub answers HTTP 200 with an `error` body; `bad_refresh_token` is the revoked outcome. */
  refresh(refreshToken: string): Promise<GitHubUserTokenRefresh>;
  /** Deletes one user access token at GitHub, best effort and never throwing. It does not remove the person's grant of the App. */
  revoke(accessToken: string): Promise<void>;
  /**
   * The lowercased account logins of the installations of this App that the user token can reach
   * (`GET /user/installations`), with bounded paging. Throws `GitHubUserTokenRejectedError` on 401 and
   * a retryable error on a rate limit or outage.
   */
  userInstallationOwners(accessToken: string): Promise<ReadonlySet<string>>;
}

type GitHubAppCredentials = Pick<NonNullable<RunnerConfig['githubApp']>, 'appId'> & { clientId: string; clientSecret: string };

type TokenPayload = {
  access_token?: unknown;
  token_type?: unknown;
  error?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
};
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

  authorizeUserUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.authorizeUrl(input));
    url.searchParams.set('scope', 'offline_access');
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
      await this.revoke(token);
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
   * Deletes one user access token at GitHub so it does not outlive its purpose. Best effort: a
   * failure only leaves the token to expire on GitHub's schedule. The token is never logged.
   * `DELETE /applications/{client_id}/token` removes this token only, never the person's grant.
   */
  async revoke(token: string): Promise<void> {
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

  async exchangeUserCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GitHubUserTokenExchange> {
    const deadline = this.now() + this.timeoutMs;
    const issuedAt = this.now();
    const payload = await this.postToken({
      client_id: this.githubApp.clientId,
      client_secret: this.githubApp.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier
    }, deadline);
    this.refuseCodeExchange(payload);
    if (payload.error !== undefined) throw unavailable();
    let pair: UserTokenPair;
    try {
      pair = userTokenPair(payload, issuedAt);
    } catch (error) {
      // A token GitHub issued must not outlive a connection that was refused.
      if (typeof payload.access_token === 'string' && payload.access_token) await this.revoke(payload.access_token);
      throw error;
    }
    try {
      const user = await this.get<UserPayload>('/user', pair.accessToken, deadline);
      if (!user || !isId(user.id) || typeof user.login !== 'string' || !user.login) throw invalidProviderResponse();
      return { ...pair, userId: String(user.id), login: user.login };
    } catch (error) {
      await this.revoke(pair.accessToken);
      throw error;
    }
  }

  async refresh(refreshToken: string): Promise<GitHubUserTokenRefresh> {
    const deadline = this.now() + this.timeoutMs;
    const issuedAt = this.now();
    const payload = await this.postToken({
      client_id: this.githubApp.clientId,
      client_secret: this.githubApp.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }, deadline);
    // The token endpoint answers HTTP 200 with the error in the body.
    if (payload.error === 'bad_refresh_token') return { status: 'revoked', reasonCode: 'bad_refresh_token' };
    if (payload.error !== undefined) throw unavailable();
    try {
      return { status: 'refreshed', ...userTokenPair(payload, issuedAt) };
    } catch (error) {
      // GitHub already rotated the pair, so an access token it sent without a usable refresh pair is
      // dropped rather than kept as a credential that could never be renewed.
      if (typeof payload.access_token === 'string' && payload.access_token) await this.revoke(payload.access_token);
      throw error;
    }
  }

  async userInstallationOwners(accessToken: string): Promise<ReadonlySet<string>> {
    const deadline = this.now() + this.timeoutMs;
    const owners = new Set<string>();
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.send(new URL(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, 'https://api.github.com').toString(), {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'x-github-api-version': '2022-11-28' }
      }, deadline);
      if (response.status === 401) {
        await response.body?.cancel();
        throw new GitHubUserTokenRejectedError();
      }
      if (response.status === 429 || (response.status === 403 && isRateLimited(response))) {
        await response.body?.cancel();
        throw new HarnessError('GITHUB_RATE_LIMITED', 'GitHub rate limit reached for the connected GitHub user. Retry later.', 429, true);
      }
      if (!response.ok) throw unavailable();
      const payload = await this.json<UserInstallationsPayload>(response, deadline);
      if (typeof payload.total_count !== 'number' || !Array.isArray(payload.installations)) throw invalidProviderResponse();
      for (const installation of payload.installations) {
        const account = installation.account;
        if (isId(installation.app_id) && String(installation.app_id) === String(this.githubApp.appId) &&
          account && typeof account.login === 'string' && account.login) {
          owners.add(account.login.toLowerCase());
        }
      }
      seen += payload.installations.length;
      if (seen >= payload.total_count || payload.installations.length < PAGE_SIZE) break;
    }
    return owners;
  }

  private async postToken(body: Record<string, string>, deadline: number): Promise<TokenPayload> {
    const response = await this.send('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, deadline);
    if (!response.ok) throw unavailable();
    return await this.json<TokenPayload>(response, deadline);
  }

  /** The two code-exchange errors a person can act on; every other error is the provider's. */
  private refuseCodeExchange(payload: TokenPayload): void {
    if (payload.error === 'bad_verification_code') {
      throw new HarnessError('FORBIDDEN', 'GitHub authorization code is invalid or expired. Start the connection again.', 403);
    }
    if (payload.error === 'redirect_uri_mismatch') {
      throw new HarnessError('UNAVAILABLE', 'The GitHub App Callback URL does not match this dashboard', 503, false);
    }
  }

  private async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }, deadline: number): Promise<string> {
    const payload = await this.postToken({
      client_id: this.githubApp.clientId,
      client_secret: this.githubApp.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier
    }, deadline);
    this.refuseCodeExchange(payload);
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

type UserTokenPair = { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number };

function isLifetimeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The pair a `user` authorization keeps. It fails closed: a token without a refresh token and both
 * lifetimes is one the runner could neither renew nor know the end of, so it is never stored.
 * `issuedAt` is taken before the request, which can only make the recorded expiry earlier.
 */
function userTokenPair(payload: TokenPayload, issuedAt: number): UserTokenPair {
  if (typeof payload.access_token !== 'string' || !payload.access_token ||
    (typeof payload.token_type === 'string' && payload.token_type.toLowerCase() !== 'bearer')) {
    throw unavailable();
  }
  if (typeof payload.refresh_token !== 'string' || !payload.refresh_token ||
    !isLifetimeSeconds(payload.expires_in) || !isLifetimeSeconds(payload.refresh_token_expires_in)) {
    throw new HarnessError(
      'UNAVAILABLE',
      'GitHub did not return a refresh token with its expiry times (refresh_token, expires_in, refresh_token_expires_in) for this authorization, so it was not stored.',
      502,
      false
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpiresAt: issuedAt + payload.expires_in * 1_000,
    refreshExpiresAt: issuedAt + payload.refresh_token_expires_in * 1_000
  };
}
