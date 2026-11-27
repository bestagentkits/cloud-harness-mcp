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

/** One repository a GitHub user token reaches through an installation of this App. */
export type GitHubUserRepository = {
  owner: string;
  name: string;
  /** `write` only when the user may push and the installation grants Contents: write. */
  access: 'read' | 'write';
  private?: boolean;
  archived?: boolean;
  defaultBranch?: string;
};

/** One installation of this App the user can reach, with the repositories of it the user can access. */
export type GitHubUserInstallationRepositories = {
  installationId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User' | null;
  repositories: GitHubUserRepository[];
  /** False when a listing bound stopped before every repository was read. */
  complete: boolean;
  /** Why GitHub refused this installation's repositories (for example SAML SSO); the others still list. */
  failure?: string;
};

/**
 * What a user token reaches: the installations of this App and their repositories, plus the user's
 * public organization memberships (`undefined` when GitHub could not list them). A GitHub App user token
 * cannot read private memberships: `GET /user/orgs` answers an empty list for it.
 */
export type GitHubUserRepositoryListing = {
  installations: GitHubUserInstallationRepositories[];
  organizations: string[] | undefined;
  /** False when the membership list stopped early (failure, rate limit, or bound): `organizations` is partial. */
  organizationsComplete: boolean;
  /** False when the installation list itself stopped at its bound, so an unlisted account proves nothing. */
  installationsComplete: boolean;
  complete: boolean;
};

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
  /**
   * Every installation of this App the user token reaches (`GET /user/installations`), the repositories of
   * each the user can access (`GET /user/installations/{id}/repositories`), and the user's public
   * organization memberships (`GET /users/{login}/orgs`, best effort). Bounded. Throws
   * `GitHubUserTokenRejectedError` on 401; any other failure after the installation list keeps the pages
   * already read and marks the listing incomplete.
   */
  userRepositoryListing(accessToken: string, login: string): Promise<GitHubUserRepositoryListing>;
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
/** The listing's shared budget; past it the listing reports itself incomplete instead of failing. */
const MAX_LISTED_REPOSITORIES = 10_000;
const LISTING_TIMEOUT_MS = 60_000;

type UserInstallationListPayload = {
  total_count?: unknown;
  installations?: Array<{ id?: unknown; app_id?: unknown; account?: { login?: unknown; type?: unknown } | null; permissions?: Record<string, unknown> | null }>;
};
type UserRepositoriesPayload = {
  total_count?: unknown;
  repositories?: Array<{
    name?: unknown; owner?: { login?: unknown } | null; private?: unknown; archived?: unknown; default_branch?: unknown;
    permissions?: { push?: unknown; pull?: unknown } | null;
  }>;
};
type OrganizationPayload = Array<{ login?: unknown }>;

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

  async userRepositoryListing(accessToken: string, login: string): Promise<GitHubUserRepositoryListing> {
    const deadline = this.now() + LISTING_TIMEOUT_MS;
    const installations: Array<{ id: string; login: string; type: 'Organization' | 'User' | null; contents: unknown }> = [];
    let seen = 0;
    let complete = true;
    let installationsComplete = true;
    // Set once GitHub rate-limits or the deadline passes: nothing more is requested with this token, and later
    // installations are reported as not listed.
    let stopped: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) { complete = false; installationsComplete = false; break; }
      let payload: UserInstallationListPayload;
      try {
        const response = await this.userGet(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, accessToken, deadline);
        if (!response.ok) throw unavailable();
        payload = await this.json<UserInstallationListPayload>(response, deadline);
        if (typeof payload.total_count !== 'number' || !Array.isArray(payload.installations)) throw invalidProviderResponse();
      } catch (error) {
        // Nothing is known before the first page; after it, the installations already found still list.
        if (page === 1 || error instanceof GitHubUserTokenRejectedError) throw error;
        complete = false;
        installationsComplete = false;
        if (stopsRequests(error)) stopped = (error as HarnessError).message;
        break;
      }
      for (const installation of payload.installations ?? []) {
        const account = installation.account;
        if (!isId(installation.id) || !isId(installation.app_id) || String(installation.app_id) !== String(this.githubApp.appId)) continue;
        if (!account || typeof account.login !== 'string' || !account.login) continue;
        installations.push({
          id: String(installation.id),
          login: account.login,
          type: account.type === 'Organization' || account.type === 'User' ? account.type : null,
          contents: installation.permissions?.contents
        });
      }
      const count = payload.installations?.length ?? 0;
      seen += count;
      if (seen >= Number(payload.total_count) || count < PAGE_SIZE) break;
    }

    const listed: GitHubUserInstallationRepositories[] = [];
    let total = 0;
    for (const installation of installations) {
      const entry: GitHubUserInstallationRepositories = {
        installationId: installation.id, accountLogin: installation.login, accountType: installation.type, repositories: [], complete: true
      };
      listed.push(entry);
      // Without Contents the installation's tokens cannot read through git, so it opens nothing.
      if (installation.contents !== 'read' && installation.contents !== 'write') {
        entry.failure = 'the GitHub App installation lacks the Contents permission';
        continue;
      }
      if (stopped !== undefined) {
        entry.failure = `not listed: ${stopped}`;
        entry.complete = false;
        complete = false;
        continue;
      }
      try {
        await this.readInstallationRepositories(accessToken, installation, entry, deadline, () => total, () => { total += 1; });
      } catch (error) {
        if (error instanceof GitHubUserTokenRejectedError) throw error;
        // The pages already read stay: a late outage must not erase what GitHub already answered.
        const reason = error instanceof HarnessError ? error.message : 'GitHub could not be read';
        entry.failure = `listing stopped early: ${reason}`;
        entry.complete = false;
        if (error instanceof HarnessError && (error.code === 'GITHUB_RATE_LIMITED' || error.code === 'TIMEOUT')) stopped = reason;
      }
      if (!entry.complete) complete = false;
    }

    const memberships = stopped === undefined ? await this.publicOrganizations(accessToken, login, deadline) : { organizations: undefined, complete: false };
    return { installations: listed, organizations: memberships.organizations, organizationsComplete: memberships.complete, installationsComplete, complete };
  }

  /** Reads one installation's repositories into `entry`, page by page, until done or a bound. */
  private async readInstallationRepositories(
    accessToken: string,
    installation: { id: string; login: string; contents: unknown },
    entry: GitHubUserInstallationRepositories,
    deadline: number,
    total: () => number,
    counted: () => void
  ): Promise<void> {
    let read = 0;
    for (let page = 1; ; page += 1) {
      if (total() >= MAX_LISTED_REPOSITORIES) {
        entry.complete = false;
        entry.failure = 'the repository listing stopped at its bound';
        return;
      }
      const response = await this.userGet(`/user/installations/${encodeURIComponent(installation.id)}/repositories?per_page=${PAGE_SIZE}&page=${page}`, accessToken, deadline);
      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        // SAML SSO and similar refusals are per organization: the other installations still list.
        entry.failure = response.status === 403
          ? `GitHub refused the repositories of ${installation.login}; if the organization enforces SAML SSO, authorize at https://github.com/orgs/${installation.login}/sso`
          : `GitHub no longer shows installation ${installation.id} to this user`;
        entry.complete = false;
        return;
      }
      if (!response.ok) throw unavailable();
      const payload = await this.json<UserRepositoriesPayload>(response, deadline);
      if (typeof payload.total_count !== 'number' || !Array.isArray(payload.repositories)) throw invalidProviderResponse();
      for (const repository of payload.repositories) {
        if (typeof repository.name !== 'string' || !repository.name || typeof repository.owner?.login !== 'string' || !repository.owner.login) {
          throw invalidProviderResponse();
        }
        if (repository.permissions?.pull === false) continue;
        const archived = repository.archived === true;
        entry.repositories.push({
          owner: repository.owner.login,
          name: repository.name,
          // An archived repository refuses every push, whatever the permission says.
          access: repository.permissions?.push === true && installation.contents === 'write' && !archived ? 'write' : 'read',
          ...(typeof repository.private === 'boolean' ? { private: repository.private } : {}),
          ...(typeof repository.archived === 'boolean' ? { archived: repository.archived } : {}),
          ...(typeof repository.default_branch === 'string' && repository.default_branch ? { defaultBranch: repository.default_branch } : {})
        });
        counted();
      }
      read += payload.repositories.length;
      if (read >= payload.total_count || payload.repositories.length < PAGE_SIZE) return;
    }
  }

  /**
   * The user's public organization memberships, or `undefined` when GitHub could not list them. A GitHub
   * App user token gets an empty answer from `GET /user/orgs`, so private memberships cannot be learned.
   */
  private async publicOrganizations(accessToken: string, login: string, deadline: number): Promise<{ organizations: string[] | undefined; complete: boolean }> {
    const organizations: string[] = [];
    // Pages already read stay: they are verified memberships whatever happens to the next page.
    const partial = () => ({ organizations: organizations.length ? organizations : undefined, complete: false });
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await this.userGet(`/users/${encodeURIComponent(login)}/orgs?per_page=${PAGE_SIZE}&page=${page}`, accessToken, deadline);
        if (!response.ok) {
          await response.body?.cancel();
          return partial();
        }
        const payload = await this.json<OrganizationPayload>(response, deadline);
        if (!Array.isArray(payload)) return partial();
        for (const organization of payload) {
          if (typeof organization.login === 'string' && organization.login) organizations.push(organization.login);
        }
        if (payload.length < PAGE_SIZE) return { organizations, complete: true };
      }
    } catch (error) {
      if (error instanceof GitHubUserTokenRejectedError) throw error;
      // Optional: a failure here never discards the repositories already read.
      return partial();
    }
    return partial();
  }

  /** A user-token GET that classifies a rejected token and a rate limit; every other status is the caller's. */
  private async userGet(path: string, accessToken: string, deadline: number): Promise<Response> {
    const response = await this.send(new URL(path, 'https://api.github.com').toString(), {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'x-github-api-version': '2022-11-28' }
    }, deadline);
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubUserTokenRejectedError();
    }
    if (response.status === 429 || (response.status === 403 && (isRateLimited(response) || await isSecondaryRateLimit(response)))) {
      await response.body?.cancel();
      throw new HarnessError('GITHUB_RATE_LIMITED', 'GitHub rate limit reached for the connected GitHub user. Retry later.', 429, true);
    }
    return response;
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

/**
 * GitHub's secondary (abuse) limits answer 403 without `Retry-After` or an exhausted quota; only the documented
 * message tells them apart from a permission or SSO refusal. The body is inspected, never echoed.
 */
async function isSecondaryRateLimit(response: Response): Promise<boolean> {
  try {
    return /secondary rate limit|abuse detection/i.test((await response.clone().text()).slice(0, 2_000));
  } catch {
    return false;
  }
}

/** A rate limit or an exhausted deadline: no further request with this token can succeed now. */
function stopsRequests(error: unknown): boolean {
  return error instanceof HarnessError && (error.code === 'GITHUB_RATE_LIMITED' || error.code === 'TIMEOUT');
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
