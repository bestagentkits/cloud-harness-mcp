import {
  GITHUB_REPOSITORY_LISTING_MAX,
  HarnessError,
  isMultiPrincipal,
  type GitHubListedAccount,
  type GitHubListedRepository,
  type GitHubRepositoriesListInput,
  type GitHubRepositoriesListResult,
  type GitHubRepositoryListing,
  type GitHubUnreachableAccount,
  type GitHubUserAuthorizationStatus,
  type RunnerConfig,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { installationRevision, type GitHubInstallationRecord, type GitHubInstallationStore, type VerifiedGitHubInstallation } from './github-installation-store.js';
import type { GitHubUserRepository, GitHubUserRepositoryListing } from './github-user-authorizer.js';

const OPERATION = 'github_repositories_list';
/** How long one principal's listing is reused; paging and quick re-asks stay off GitHub's rate limit. */
const CACHE_TTL_MS = 60_000;
const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 500;
const MAX_ACCOUNTS = 1_000;

/** The stored, non-secret state of a principal's GitHub user authorization. */
export type GitHubUserAuthorizationState = { status: GitHubUserAuthorizationStatus; generation: number };

export type GitHubRepositoryListerOptions = {
  config: RunnerConfig;
  installations?: GitHubInstallationStore | undefined;
  /** Re-verifies one bound installation with the App JWT and rewrites its stored repository grants. */
  reconcileInstallation?: ((principalId: string, installationId: string) => Promise<void>) | undefined;
  /** Reads an installation live without storing it: the operator-configured one in owner-bearer mode. */
  verifyInstallation?: ((installationId: string) => Promise<VerifiedGitHubInstallation>) | undefined;
  /** The stored state of the principal's GitHub user authorization; never decrypts anything. */
  userAuthorization: (principalId: string) => GitHubUserAuthorizationState | undefined;
  /** The binding lifetime counter of an installation (see GitHubBindingService.bindingLifetime). */
  bindingLifetime?: ((installationId: string) => number) | undefined;
  /**
   * Reads what the connected GitHub user reaches, fenced to one authorization generation; absent when this
   * runner cannot use a stored user token. With `renew: false` it never renews or revokes the stored token.
   */
  userRepositories?: ((principalId: string, options: { renew: boolean }) => Promise<GitHubUserRepositoryListing & { login: string; generation: number }>) | undefined;
  now?: () => number;
  cacheTtlMs?: number;
};

type Candidate = Omit<GitHubListedRepository, 'fullName' | 'repositoryUrl'> & { installationId: string };
type CacheEntry = { fingerprint: string; synced: boolean; sequence: number; expiresAt: number; listing: GitHubRepositoryListing };

/**
 * Lists the GitHub repositories a principal can open. Lanes follow credential resolution: the principal's
 * bound installations (or, in owner-bearer mode, the operator-configured installation), then the connected
 * GitHub user's reachable installations. While a GitHub user is connected the result is limited to what
 * that user can access, with the user's permission as the ceiling. It never mints a token for the caller
 * and never returns one; a failing account becomes a warning so the others still list.
 *
 * `sync` decides whether bound installations are reconciled with GitHub, which rewrites their stored
 * grants; without it the stored grants are read as they are. Cached listings and shared in-flight reads
 * are keyed by an authorization fingerprint, so a disconnect, reconnect, or rebind never serves an answer
 * read for the previous state.
 */
export class GitHubRepositoryLister {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<{ listing: GitHubRepositoryListing; fingerprint: string }>>();
  /** How many reads have started per principal; the cache keeps the latest-started successful read. */
  readonly #started = new Map<string, number>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(private readonly options: GitHubRepositoryListerOptions) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  }

  /** The tool result: the synced listing filtered by owner and query, then paged by an offset cursor. */
  async list(principalId: string, input: GitHubRepositoriesListInput): Promise<RunnerResponse> {
    const listing = await this.listing(principalId, { refresh: input.refresh, sync: true });
    const owner = input.owner?.toLowerCase();
    const query = input.query?.toLowerCase();
    const matching = listing.repositories.filter((repository) =>
      (owner === undefined || repository.owner.toLowerCase() === owner) &&
      (query === undefined || repository.fullName.toLowerCase().includes(query)));
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    const page = matching.slice(offset, offset + input.limit);
    const next = offset + page.length < matching.length ? String(offset + page.length) : undefined;
    const data: GitHubRepositoriesListResult = { ...listing, repositories: page, totalCount: matching.length };
    return {
      ok: true,
      message: `${page.length} of ${matching.length} GitHub repositories listed`,
      data,
      truncated: next !== undefined,
      ...(next ? { cursor: next } : {})
    };
  }

  /**
   * The principal's whole listing, reused while the cache entry is fresh and the authorization unchanged.
   *
   * A request joins a read of the same mode already in flight (unless it forces a refresh) and accepts its
   * answer only if the authorization state the read ended on is still the current one; otherwise it reads
   * itself. Reads are numbered as they start, and the cache only ever moves to a later-started read, so a
   * slow older read can never replace what a newer refresh found.
   */
  async listing(principalId: string, options: { refresh?: boolean; sync: boolean }): Promise<GitHubRepositoryListing> {
    if (!this.options.config.githubApp) {
      throw new HarnessError('NOT_SUPPORTED', 'No GitHub App is configured on this harness; listing repositories needs one.', 400, false, { operation: OPERATION });
    }
    const cached = this.#cache.get(principalId);
    if (!options.refresh && cached && cached.expiresAt > this.#now() && cached.fingerprint === this.fingerprint(principalId) && (cached.synced || !options.sync)) {
      return cached.listing;
    }
    const key = `${principalId}\0${options.sync ? 'sync' : 'stored'}`;
    const running = this.#inFlight.get(key);
    if (running && !options.refresh) {
      const shared = await running;
      if (shared.fingerprint === this.fingerprint(principalId)) return shared.listing;
    }
    const sequence = (this.#started.get(principalId) ?? 0) + 1;
    this.#started.set(principalId, sequence);
    const promise = this.readFenced(principalId, options.sync)
      .then((result) => {
        const published = this.#cache.get(principalId);
        if (!published || published.sequence < sequence) {
          this.#cache.set(principalId, { fingerprint: result.fingerprint, synced: options.sync, sequence, expiresAt: this.#now() + this.#ttlMs, listing: result.listing });
        }
        return result;
      })
      .finally(() => {
        if (this.#inFlight.get(key) === promise) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, promise);
    return (await promise).listing;
  }

  /**
   * A listing whose rows are proven to belong to the current authorization state: the revisions the read
   * actually used (after its own reconciles) must equal the stored ones when it ends. Anything else, such as
   * a Disconnect or a rebind while GitHub was read, discards the answer and reads again, once.
   */
  private async readFenced(principalId: string, sync: boolean): Promise<{ listing: GitHubRepositoryListing; fingerprint: string }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { listing, observed } = await this.read(principalId, sync);
      const current = this.fingerprint(principalId);
      if (current === observed) return { listing, fingerprint: current };
    }
    throw new HarnessError('UNAVAILABLE', 'The GitHub connection changed while repositories were listed. Retry.', 503, true, { operation: OPERATION });
  }

  /** What a listing depends on: the user authorization generation and every bound installation's generation. */
  private fingerprint(principalId: string): string {
    const revisions = new Map((this.options.installations?.listInstallations(principalId) ?? [])
      .map((record) => [record.installationId, this.revisionOf(record)] as const));
    return fingerprintOf(this.userRevision(principalId), revisions);
  }

  /** A binding's stored revision plus its lifetime, which a Disconnect and a new binding always change. */
  private revisionOf(record: GitHubInstallationRecord): string {
    return `${installationRevision(record)}#${this.options.bindingLifetime?.(record.installationId) ?? 0}`;
  }

  private userRevision(principalId: string): string {
    const user = this.options.userAuthorization(principalId);
    return user ? `${user.status}:${user.generation}` : 'none';
  }

  private async read(principalId: string, sync: boolean): Promise<{ listing: GitHubRepositoryListing; observed: string }> {
    const githubApp = this.options.config.githubApp!;
    const listedAt = new Date(this.#now()).toISOString();
    const accounts: GitHubListedAccount[] = [];
    const warnings: string[] = [];
    const warn = (text: string) => { if (warnings.length < MAX_WARNINGS) warnings.push(text.slice(0, MAX_WARNING_CHARS)); };
    let incomplete = false;
    const installationLane: Candidate[] = [];
    // The user revision this read used: as stored at the start, then the generation the user lane actually read
    // with (a renewal during the read is the read's own write, not a concurrent change).
    let userRevision = this.userRevision(principalId);
    // The revisions this read used: taken at the start, then replaced by what each installation read back.
    const revisions = new Map((this.options.installations?.listInstallations(principalId) ?? [])
      .map((record) => [record.installationId, this.revisionOf(record)] as const));

    const multiPrincipal = isMultiPrincipal(this.options.config.authMode);
    if (multiPrincipal) {
      incomplete = await this.readBoundInstallations(principalId, String(githubApp.appId), sync, installationLane, accounts, warn, revisions) || incomplete;
    } else if (githubApp.installationId !== undefined) {
      incomplete = !await this.readConfiguredInstallation(String(githubApp.installationId), installationLane, accounts, warn) || incomplete;
    } else {
      warn('No GitHub App installation is configured for this harness (GITHUB_APP_INSTALLATION_ID).');
    }

    let userAuthorization: GitHubRepositoryListing['userAuthorization'] = 'not_applicable';
    let user: (GitHubUserRepositoryListing & { login: string; generation: number }) | undefined;
    let filterByUser = false;
    if (multiPrincipal) {
      const status = this.options.userAuthorization(principalId)?.status;
      userAuthorization = status ?? 'not_connected';
      if (status === 'revoked') {
        warn('Your GitHub user authorization was revoked; reconnect it on the dashboard (Integrations > GitHub > GitHub user) to list the repositories it reaches.');
      } else if (status === 'connected') {
        // Connected: the listing shows only what this user can access, so without the user's answer the
        // installation repositories cannot be shown either.
        filterByUser = true;
        if (!this.options.userRepositories) {
          userAuthorization = 'unavailable';
          warn('Your GitHub user is connected, but this runner cannot use the stored token (GitHub App OAuth client or secret keyring missing), so your access cannot be confirmed and no repository is listed.');
          incomplete = true;
        } else {
          try {
            // Only a syncing read may renew the user token; a plain read leaves the stored credential untouched.
            user = await this.options.userRepositories(principalId, { renew: sync });
            userRevision = `connected:${user.generation}`;
          } catch (error) {
            if (error instanceof HarnessError && error.code === 'GITHUB_USER_AUTHORIZATION_REQUIRED') userAuthorization = 'revoked';
            warn(`Your GitHub user's access could not be read, so no repository is listed: ${errorText(error)}`);
            incomplete = true;
          }
        }
      }
    }

    const repositories = new Map<string, GitHubListedRepository>();
    const counts = new Map<string, number>();
    const add = ({ installationId, ...candidate }: Candidate) => {
      const fullName = `${candidate.owner}/${candidate.name}`;
      const key = fullName.toLowerCase();
      if (repositories.has(key)) return;
      repositories.set(key, { fullName, repositoryUrl: `https://github.com/${fullName}.git`, ...candidate });
      counts.set(installationId, (counts.get(installationId) ?? 0) + 1);
    };

    if (!filterByUser) {
      for (const candidate of installationLane) add(candidate);
    } else if (user) {
      incomplete = this.mergeUserLane(user, installationLane, add, accounts, warn) || incomplete;
    }

    for (const account of accounts) account.repositoryCount = counts.get(account.installationId) ?? 0;

    const unreachableAccounts = user ? this.unreachableAccounts(principalId, user, warn) : [];
    if (user && user.installationsComplete && !user.organizationsComplete) incomplete = true;
    const sorted = [...repositories.values()].sort((left, right) => left.fullName.toLowerCase().localeCompare(right.fullName.toLowerCase()));
    if (sorted.length > GITHUB_REPOSITORY_LISTING_MAX || accounts.length > MAX_ACCOUNTS || unreachableAccounts.length > MAX_ACCOUNTS) incomplete = true;

    return {
      listing: {
        repositories: sorted.slice(0, GITHUB_REPOSITORY_LISTING_MAX),
        accounts: accounts.slice(0, MAX_ACCOUNTS),
        unreachableAccounts: unreachableAccounts.slice(0, MAX_ACCOUNTS),
        userAuthorization,
        listedAt,
        synced: sync,
        incomplete,
        warnings
      },
      observed: fingerprintOf(userRevision, revisions)
    };
  }

  /** The principal's bound installations, reconciled first when `sync`; returns whether any could not be read. */
  private async readBoundInstallations(
    principalId: string,
    appId: string,
    sync: boolean,
    lane: Candidate[],
    accounts: GitHubListedAccount[],
    warn: (text: string) => void,
    revisions: Map<string, string>
  ): Promise<boolean> {
    const store = this.options.installations;
    if (!store) return false;
    let incomplete = false;
    const bound = store.listInstallations(principalId).filter((record) => record.appId === appId && record.status !== 'uninstalled');
    for (const original of bound) {
      let live = false;
      let refreshFailure: string | undefined;
      const lifetime = this.options.bindingLifetime?.(original.installationId) ?? 0;
      if (sync && this.options.reconcileInstallation) {
        try {
          await this.options.reconcileInstallation(principalId, original.installationId);
          live = true;
        } catch (error) {
          refreshFailure = errorText(error);
        }
      }
      // What this read is about to use, after its own reconcile; checked against the store when the read ends.
      const record = store.getInstallation(principalId, original.installationId);
      if (record) revisions.set(record.installationId, this.revisionOf(record));
      else revisions.delete(original.installationId);
      // A binding removed meanwhile contributes nothing, not even a warning naming it.
      if (!record) continue;
      // A failure is reported only for the binding it was about; a new binding read since then is shown as stored.
      if (refreshFailure !== undefined) {
        incomplete = true;
        if ((this.options.bindingLifetime?.(record.installationId) ?? 0) === lifetime) {
          warn(`GitHub App installation on ${record.accountLogin} could not be refreshed; its stored repository grants are shown: ${refreshFailure}`);
        }
      }
      if (record.status === 'uninstalled') {
        warn(`The GitHub App was uninstalled from ${record.accountLogin}; reinstall it to reach its repositories.`);
        continue;
      }
      if (record.status === 'suspended') {
        warn(`The GitHub App installation on ${record.accountLogin} is suspended; an owner of the account must unsuspend it.`);
        continue;
      }
      if (record.contents === 'none') {
        warn(`The GitHub App installation on ${record.accountLogin} lacks the Contents permission; an owner must approve it.`);
        continue;
      }
      for (const grant of store.listRepositoryGrants(principalId, record.installationId)) {
        if (grant.status !== 'granted') continue;
        lane.push({ owner: grant.owner, name: grant.repository, access: grant.contents, via: 'installation', installationId: record.installationId });
      }
      accounts.push({ login: record.accountLogin, type: record.accountType ?? null, via: 'installation', installationId: record.installationId, repositoryCount: 0, live });
    }
    return incomplete;
  }

  /** Owner-bearer mode resolves every repository through the operator-configured installation; returns whether it was read. */
  private async readConfiguredInstallation(
    installationId: string,
    lane: Candidate[],
    accounts: GitHubListedAccount[],
    warn: (text: string) => void
  ): Promise<boolean> {
    if (!this.options.verifyInstallation) return false;
    let verified: VerifiedGitHubInstallation;
    try {
      verified = await this.options.verifyInstallation(installationId);
    } catch (error) {
      warn(`The configured GitHub App installation ${installationId} could not be read: ${errorText(error)}`);
      return false;
    }
    if (verified.status !== 'active') {
      warn(`The configured GitHub App installation on ${verified.accountLogin} is ${verified.status}.`);
      return true;
    }
    const id = String(verified.installationId);
    for (const repository of verified.repositories) {
      lane.push({ owner: repository.owner, name: repository.repository, access: repository.contents, via: 'installation', installationId: id });
    }
    accounts.push({ login: verified.accountLogin, type: verified.accountType ?? null, via: 'installation', installationId: id, repositoryCount: 0, live: true });
    return true;
  }

  /**
   * Keeps the installation repositories the user can access, capped at the user's permission, then adds the
   * rest of what the user reaches on the user lane. Returns whether the user's listing was incomplete.
   */
  private mergeUserLane(
    user: GitHubUserRepositoryListing,
    installationLane: Candidate[],
    add: (candidate: Candidate) => void,
    accounts: GitHubListedAccount[],
    warn: (text: string) => void
  ): boolean {
    let incomplete = !user.complete;
    const reachable = new Map<string, { repository: GitHubUserRepository; installationId: string }>();
    const known = new Set(accounts.map((account) => account.installationId));
    for (const installation of user.installations) {
      if (installation.failure) {
        warn(`${installation.accountLogin}: ${installation.failure}`);
        incomplete = true;
      }
      for (const repository of installation.repositories) {
        const key = `${repository.owner}/${repository.name}`.toLowerCase();
        if (!reachable.has(key)) reachable.set(key, { repository, installationId: installation.installationId });
      }
      if (known.has(installation.installationId)) continue;
      known.add(installation.installationId);
      accounts.push({
        login: installation.accountLogin, type: installation.accountType, via: 'user',
        installationId: installation.installationId, repositoryCount: 0, live: installation.complete && installation.failure === undefined
      });
    }
    for (const candidate of installationLane) {
      const seen = reachable.get(`${candidate.owner}/${candidate.name}`.toLowerCase());
      if (!seen) continue;
      const { access, private: isPrivate, archived, defaultBranch } = seen.repository;
      add({
        ...candidate,
        ...(isPrivate === undefined ? {} : { private: isPrivate }),
        ...(archived === undefined ? {} : { archived }),
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        access: candidate.access === 'write' && access === 'write' ? 'write' : 'read'
      });
    }
    for (const { repository, installationId } of reachable.values()) add({ ...repository, via: 'user', installationId });
    return incomplete;
  }

  /**
   * The user's own account and public organization memberships that none of the installations reachable by
   * this user covers. Reachability is the user token's installation list, not the principal's bindings. An
   * account the principal has a binding for is known to have the App (`installed`: the user lacks access, so
   * no install link); for any other the installation state is `unknown`. No hint is given when the user's
   * installation list could not be read completely.
   */
  private unreachableAccounts(principalId: string, user: GitHubUserRepositoryListing & { login: string }, warn: (text: string) => void): GitHubUnreachableAccount[] {
    if (!user.installationsComplete) {
      warn('The App installations your GitHub user reaches could not all be read, so accounts without a reachable installation are not named.');
      return [];
    }
    const reachable = new Set(user.installations.map((installation) => installation.accountLogin.toLowerCase()));
    const appId = String(this.options.config.githubApp?.appId);
    const installed = new Set((this.options.installations?.listInstallations(principalId) ?? [])
      .filter((record) => record.appId === appId && record.status !== 'uninstalled')
      .map((record) => record.accountLogin.toLowerCase()));
    const slug = this.options.config.githubApp?.appSlug;
    // The slug is the operator's own App name; a URL is built only from a slug GitHub could have issued.
    const installUrl = slug && /^[A-Za-z0-9-]{1,100}$/.test(slug) ? `https://github.com/apps/${slug}/installations/new` : undefined;
    const candidates: { login: string; type: 'Organization' | 'User' }[] = [{ login: user.login, type: 'User' }];
    if (!user.organizationsComplete) {
      warn(user.organizations === undefined
        ? 'GitHub did not list your public organization memberships, so organizations without a reachable App installation are not named.'
        : 'GitHub listed only part of your public organization memberships, so some organizations without a reachable App installation may be missing.');
    }
    candidates.push(...(user.organizations ?? []).map((login) => ({ login, type: 'Organization' as const })));
    const seen = new Set<string>();
    return candidates.flatMap((candidate): GitHubUnreachableAccount[] => {
      const key = candidate.login.toLowerCase();
      if (reachable.has(key) || seen.has(key)) return [];
      seen.add(key);
      if (installed.has(key)) return [{ ...candidate, installation: 'installed' }];
      return [{ ...candidate, installation: 'unknown', ...(installUrl ? { installUrl } : {}) }];
    });
  }
}

/** A short reason for a warning; provider and harness messages carry no token. */
function errorText(error: unknown): string {
  if (error instanceof HarnessError) return `${error.code}: ${error.message}`.slice(0, 300);
  return 'unexpected failure';
}

/** The fingerprint of one authorization state: the user authorization revision and each bound installation's. */
function fingerprintOf(userRevision: string, installations: ReadonlyMap<string, string>): string {
  return JSON.stringify([userRevision, [...installations].map(([id, revision]) => `${id}:${revision}`).sort()]);
}