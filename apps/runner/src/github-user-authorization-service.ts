import {
  HarnessError,
  type GitHubUserAuthorizationReasonCode,
  type GitHubUserAuthorizationStatus,
  type GitHubUserAuthorizationView
} from '@cloud-harness/contracts';
import { githubUserAuthorizationRequired } from './github-user-lane.js';
import { GitHubUserTokenRejectedError, type GitHubUserAuthorizer, type GitHubUserTokenExchange } from './github-user-authorizer.js';
import type {
  GitHubUserAuthorizationLoaded, GitHubUserAuthorizationRecord, GitHubUserAuthorizationStore, GitHubUserTokenPair
} from './github-user-authorization-store.js';

/** A token is renewed before use once less than this much of its life remains. */
const REFRESH_WINDOW_MS = 5 * 60_000;
/** How long the set of installation owners a user can reach is trusted. */
const OWNERS_CACHE_TTL_MS = 5 * 60_000;
/** Re-reads allowed while a concurrent Disconnect, reconnect, or refresh keeps replacing the row. */
const MAX_READS = 3;

/** The access token of one stored generation, which is what a later rejection is attributed to. */
export type GitHubUserAccessToken = { token: string; generation: number; login: string };

/**
 * What the user token lane decides for one repository owner:
 * - `legacy`: no authorization, or the person disconnected it; the legacy fallback lane may apply.
 * - `owner-not-visible`: connected, but this owner has no installation the user can reach. No
 *   credential applies, and the legacy lane never does.
 * - `user`: connected and the owner is reachable; the token is final for the operation.
 * A `revoked` authorization is none of these: it throws `GITHUB_USER_AUTHORIZATION_REQUIRED`.
 */
export type GitHubUserLane =
  | { lane: 'legacy' }
  | { lane: 'owner-not-visible' }
  | { lane: 'user'; credential: GitHubUserAccessToken };

/** The start of one `user` completion, taken before its code exchange and committed against afterwards. */
export type GitHubUserCompletionTicket = { readonly principalId: string; readonly sequence: number };

type RefreshOutcome =
  | { kind: 'refreshed'; credential: GitHubUserAccessToken }
  | { kind: 'revoked'; reasonCode: GitHubUserAuthorizationReasonCode }
  | { kind: 'superseded' };

/** The installation owners a user can reach, with the generation of the token that read them. */
type OwnersAtGeneration = { owners: ReadonlySet<string>; generation: number };

/** What `github_status` reports: no token, no ciphertext, no generation. */
export function githubUserAuthorizationView(record: GitHubUserAuthorizationRecord): GitHubUserAuthorizationView {
  return {
    status: record.status,
    login: record.login,
    githubUserId: record.githubUserId,
    refreshExpiresAt: record.status === 'connected' ? record.refreshExpiresAt : null,
    reasonCode: record.status === 'revoked' ? record.reasonCode : null
  };
}

function authorizationChanged(): HarnessError {
  return new HarnessError('UNAVAILABLE', 'The GitHub user authorization changed while this request ran. Retry it.', 503, true);
}

function unreadable(): HarnessError {
  return new HarnessError('UNAVAILABLE', 'The stored GitHub user authorization could not be read. Check the secret keyring.', 503, false);
}

/**
 * The lifecycle of a principal's GitHub App user access token: reading a usable token, renewing it
 * ahead of expiry, and classifying what GitHub's refusals mean.
 *
 * Renewal is single-flight per principal in this process, and every state change goes through the
 * store's generation compare-and-swap, so none of these can be undone by a slower one:
 * - a refresh that finishes after a Disconnect finds the row no longer `connected` at its generation,
 *   drops the pair GitHub just issued (and revokes it) instead of restoring it;
 * - a 401 for a token of an older generation is answered with the current token and revokes nothing;
 * - `bad_refresh_token` revokes only the generation that was refreshed.
 * A completion (a reconnect) is ordered by tickets taken before its code exchange, which also covers a
 * principal with no row yet; see `beginCompletion`. No transaction is held across a GitHub request. A
 * crash after GitHub rotates the refresh token and before the store is written loses that refresh
 * token; the person reconnects.
 */
export class GitHubUserAuthorizationService {
  readonly #refreshing = new Map<string, Promise<RefreshOutcome>>();
  readonly #owners = new Map<string, { generation: number; expiresAt: number; owners: ReadonlySet<string> }>();
  /** One owners request per principal and generation: a request for an authorization that was replaced is never joined. */
  readonly #loadingOwners = new Map<string, Promise<OwnersAtGeneration>>();
  /** Per principal: completions begun so far, and the highest sequence a Disconnect or a later commit has voided. */
  readonly #completions = new Map<string, { issued: number; voidedThrough: number }>();

  constructor(
    private readonly store: GitHubUserAuthorizationStore,
    private readonly authorizer: GitHubUserAuthorizer,
    private readonly now: () => number = Date.now,
    private readonly ownersTtlMs = OWNERS_CACHE_TTL_MS,
    private readonly refreshWindowMs = REFRESH_WINDOW_MS
  ) {}

  /** The stored status without decrypting anything; `undefined` when the principal never authorized. */
  status(principalId: string): GitHubUserAuthorizationStatus | undefined {
    return this.store.get(principalId)?.status;
  }

  /** What `github_status` reports: no token, no ciphertext, no generation. */
  view(principalId: string): GitHubUserAuthorizationView | undefined {
    const record = this.store.get(principalId);
    return record ? githubUserAuthorizationView(record) : undefined;
  }

  /**
   * Marks the start of one `user` completion, before its code exchange. The exchange runs for as long as
   * GitHub takes, so whatever happens to the authorization meanwhile decides whether its result may be
   * stored, and the ticket is what the commit is checked against:
   * - a Disconnect voids every completion begun before it, whether or not the principal had a row;
   * - a completion that commits voids every one begun before it, so a response that arrives late can never
   *   overwrite a connection made after it started, while a later completion still replaces an earlier one.
   * The ordering lives in this process because the exchange it guards runs in this process: a restart ends
   * the exchange with it, and the OAuth return that follows begins a new completion.
   */
  beginCompletion(principalId: string): GitHubUserCompletionTicket {
    const state = this.completionState(principalId);
    state.issued += 1;
    return { principalId, sequence: state.issued };
  }

  /**
   * Stores the pair a completion's exchange returned, the only way to `connected`. A completion that was
   * voided, or that cannot be stored, revokes the pair it just received at GitHub and fails, so a pair that
   * lost a race never stays alive. A pair this one replaces is revoked after the commit, best effort.
   */
  async complete(ticket: GitHubUserCompletionTicket, exchange: GitHubUserTokenExchange): Promise<GitHubUserAuthorizationView> {
    let committed: { record: GitHubUserAuthorizationRecord; replaced?: GitHubUserTokenPair };
    try {
      const state = this.completionState(ticket.principalId);
      if (ticket.sequence <= state.voidedThrough) {
        throw new HarnessError('FORBIDDEN', 'The GitHub user connection changed while it was being completed. Start the connection again.', 403, false);
      }
      committed = this.store.connect(ticket.principalId, {
        githubUserId: exchange.userId,
        login: exchange.login,
        tokens: { accessToken: exchange.accessToken, refreshToken: exchange.refreshToken },
        accessExpiresAt: exchange.accessExpiresAt,
        refreshExpiresAt: exchange.refreshExpiresAt
      });
      state.voidedThrough = ticket.sequence;
    } catch (error) {
      await this.authorizer.revoke(exchange.accessToken);
      throw error;
    }
    this.#owners.delete(ticket.principalId);
    if (committed.replaced) await this.authorizer.revoke(committed.replaced.accessToken);
    return githubUserAuthorizationView(committed.record);
  }

  /** Begins and commits a completion whose exchange is already done. */
  async connect(principalId: string, exchange: GitHubUserTokenExchange): Promise<GitHubUserAuthorizationView> {
    return await this.complete(this.beginCompletion(principalId), exchange);
  }

  /**
   * The person chose Disconnect. It voids every completion begun so far. The row keeps only its non-secret
   * status; the access token it held is revoked at GitHub after the commit
   * (`DELETE /applications/{client_id}/token`, never the grant). An authorization already disconnected,
   * or never made, is left as it is.
   */
  async disconnect(principalId: string): Promise<GitHubUserAuthorizationView | undefined> {
    const state = this.completionState(principalId);
    state.voidedThrough = state.issued;
    const result = this.store.disconnect(principalId);
    this.#owners.delete(principalId);
    if (result?.removed) await this.authorizer.revoke(result.removed.accessToken);
    return result ? githubUserAuthorizationView(result.record) : undefined;
  }

  /**
   * Decides the user token lane for one repository owner. `revoked` throws; no row and `disconnected`
   * leave the legacy lane open; `connected` answers with a token only when the owner has an
   * installation the user can reach. Nothing here ever falls back to another credential.
   */
  async credentialFor(principalId: string, repositoryOwner: string): Promise<GitHubUserLane> {
    for (let attempt = 0; attempt < MAX_READS; attempt += 1) {
      // Every pass decides from the stored state as it is now, so a Disconnect or a revocation that lands while
      // the owners are being read answers as itself instead of as the state the pass started from.
      const record = this.store.get(principalId);
      if (!record || record.status === 'disconnected') return { lane: 'legacy' };
      if (record.status === 'revoked') throw githubUserAuthorizationRequired(record.reasonCode);
      const credential = await this.accessToken(principalId);
      const { owners, generation } = await this.installationOwners(principalId, credential);
      // The owners and the token handed out must come from one generation. Loading the owners can recover a
      // rejected token by refreshing it, and a reconnect can replace the authorization altogether, so the pair
      // is accepted only while both still agree with what is stored, and the pass is repeated otherwise.
      const stored = this.store.get(principalId);
      if (stored?.status !== 'connected' || stored.generation !== generation) continue;
      const current = await this.accessToken(principalId);
      if (current.generation !== generation) continue;
      return owners.has(repositoryOwner.toLowerCase()) ? { lane: 'user', credential: current } : { lane: 'owner-not-visible' };
    }
    throw authorizationChanged();
  }

  /**
   * Whether the owner is known, from the cache alone and without a request, to be reachable
   * (`true`), unreachable (`false`), or not yet known (`undefined`). Capability reporting uses it.
   */
  cachedOwnerVisible(principalId: string, repositoryOwner: string): boolean | undefined {
    const record = this.store.get(principalId);
    const cached = this.#owners.get(principalId);
    if (!record || record.status !== 'connected' || !cached || cached.generation !== record.generation || cached.expiresAt <= this.now()) {
      return undefined;
    }
    return cached.owners.has(repositoryOwner.toLowerCase());
  }

  /**
   * A usable access token for a `connected` authorization, renewed first when less than five minutes
   * of its life remain. Throws `GITHUB_USER_AUTHORIZATION_REQUIRED` for a revoked one, including one
   * revoked here because its refresh token expired or GitHub refused it, and a retryable
   * `UNAVAILABLE` when GitHub cannot be reached.
   */
  async accessToken(principalId: string): Promise<GitHubUserAccessToken> {
    for (let attempt = 0; attempt < MAX_READS; attempt += 1) {
      const current = this.read(principalId);
      if (!current || current.record.status === 'disconnected') throw authorizationChanged();
      const { record, tokens } = current;
      if (record.status === 'revoked' || !tokens) throw githubUserAuthorizationRequired(record.reasonCode);
      if (record.refreshExpiresAt !== null && record.refreshExpiresAt <= this.now()) {
        this.store.markRevoked(principalId, record.generation, 'refresh_token_expired');
        this.#owners.delete(principalId);
        continue;
      }
      if (record.accessExpiresAt !== null && record.accessExpiresAt - this.now() > this.refreshWindowMs) {
        return { token: tokens.accessToken, generation: record.generation, login: record.login };
      }
      const outcome = await this.refresh(principalId, record.generation);
      if (outcome.kind === 'refreshed') return outcome.credential;
      if (outcome.kind === 'revoked') throw githubUserAuthorizationRequired(outcome.reasonCode);
    }
    throw authorizationChanged();
  }

  /**
   * GitHub rejected (401) the token of `rejectedGeneration`. A 401 alone is not a revocation: the token
   * may have expired, or a refresh may have rotated it. So a rejection of an older generation is
   * answered with the current token and touches nothing; a rejection of the current generation
   * refreshes once, and only GitHub refusing that refresh revokes. The caller retries once with the
   * token returned here and treats a second refusal as final.
   */
  async recoverRejected(principalId: string, rejectedGeneration: number): Promise<GitHubUserAccessToken> {
    const current = this.read(principalId);
    if (!current || current.record.status === 'disconnected') throw authorizationChanged();
    if (current.record.status === 'revoked') throw githubUserAuthorizationRequired(current.record.reasonCode);
    if (current.record.generation !== rejectedGeneration) return await this.accessToken(principalId);
    const outcome = await this.refresh(principalId, rejectedGeneration);
    if (outcome.kind === 'refreshed') return outcome.credential;
    if (outcome.kind === 'revoked') throw githubUserAuthorizationRequired(outcome.reasonCode);
    return await this.accessToken(principalId);
  }

  private completionState(principalId: string): { issued: number; voidedThrough: number } {
    let state = this.#completions.get(principalId);
    if (!state) {
      state = { issued: 0, voidedThrough: 0 };
      this.#completions.set(principalId, state);
    }
    return state;
  }

  private read(principalId: string): GitHubUserAuthorizationLoaded | undefined {
    try {
      return this.store.load(principalId);
    } catch {
      throw unreadable();
    }
  }

  // One flight per principal, not per generation: a caller that joins it may hold a different generation, so safety rests on the superseded outcome and the callers' re-read loops.
  private refresh(principalId: string, generation: number): Promise<RefreshOutcome> {
    const inFlight = this.#refreshing.get(principalId);
    if (inFlight) return inFlight;
    const started = this.runRefresh(principalId, generation).finally(() => this.#refreshing.delete(principalId));
    this.#refreshing.set(principalId, started);
    return started;
  }

  private async runRefresh(principalId: string, generation: number): Promise<RefreshOutcome> {
    const current = this.read(principalId);
    if (!current || current.record.generation !== generation || current.record.status !== 'connected' || !current.tokens) {
      return { kind: 'superseded' };
    }
    const result = await this.authorizer.refresh(current.tokens.refreshToken);
    if (result.status === 'revoked') {
      // Only the generation that was refreshed is revoked: a reconnect that finished meanwhile is newer.
      const revoked = this.store.markRevoked(principalId, generation, result.reasonCode);
      this.#owners.delete(principalId);
      return revoked ? { kind: 'revoked', reasonCode: result.reasonCode } : { kind: 'superseded' };
    }
    const rotated = this.store.rotate(principalId, generation, {
      tokens: { accessToken: result.accessToken, refreshToken: result.refreshToken },
      accessExpiresAt: result.accessExpiresAt,
      refreshExpiresAt: result.refreshExpiresAt
    });
    if (!rotated) {
      // Disconnected, revoked, or reconnected while GitHub rotated the pair: the new pair is dropped
      // and revoked, never written back.
      await this.authorizer.revoke(result.accessToken);
      return { kind: 'superseded' };
    }
    this.#owners.delete(principalId);
    return { kind: 'refreshed', credential: { token: result.accessToken, generation: rotated.generation, login: rotated.login } };
  }

  private installationOwners(principalId: string, credential: GitHubUserAccessToken): Promise<OwnersAtGeneration> {
    const cached = this.#owners.get(principalId);
    if (cached && cached.generation === credential.generation && cached.expiresAt > this.now()) {
      return Promise.resolve({ owners: cached.owners, generation: cached.generation });
    }
    const key = `${principalId}\0${credential.generation}`;
    const loading = this.#loadingOwners.get(key);
    if (loading) return loading;
    const started = this.loadInstallationOwners(principalId, credential).finally(() => this.#loadingOwners.delete(key));
    this.#loadingOwners.set(key, started);
    return started;
  }

  private async loadInstallationOwners(principalId: string, credential: GitHubUserAccessToken): Promise<OwnersAtGeneration> {
    let current = credential;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const owners = await this.authorizer.userInstallationOwners(current.token);
        // Published only while the authorization is still the one these owners were read for. A reconnect
        // or a refresh since then means they describe something that no longer exists, and the callers
        // that asked will read again.
        const stored = this.store.get(principalId);
        if (stored?.status === 'connected' && stored.generation === current.generation) {
          this.#owners.set(principalId, { generation: current.generation, expiresAt: this.now() + this.ownersTtlMs, owners });
        }
        return { owners, generation: current.generation };
      } catch (error) {
        if (!(error instanceof GitHubUserTokenRejectedError) || attempt > 0) throw error instanceof GitHubUserTokenRejectedError ? authorizationChanged() : error;
        current = await this.recoverRejected(principalId, current.generation);
      }
    }
  }
}
