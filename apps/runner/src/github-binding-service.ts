import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { HarnessError, type GitHubUserAuthorizationView } from '@cloud-harness/contracts';
import type {
  GitHubInstallationRecord,
  GitHubInstallationMutationAudit,
  GitHubInstallationStore,
  VerifiedGitHubInstallation
} from './github-installation-store.js';
import type { GitHubUserAuthorizationService } from './github-user-authorization-service.js';
import type { GitHubUserAuthorizer, GitHubUserInstallationProof } from './github-user-authorizer.js';

type SetupState = {
  principalId: string;
  expectedAppId: string;
  expectedAccountId?: string;
  expiresAt: number;
};

type SetupStateRow = {
  principal_id: string;
  expected_app_id: string;
  expected_account_id: string | null;
  expires_at: number;
};

/**
 * A pending GitHub user authorization. `codeVerifier` is the PKCE secret: it never leaves the
 * runner, so an authorization code intercepted in the browser cannot be redeemed elsewhere.
 * `browserBinding` is the SHA-256 of a nonce held in an HttpOnly cookie of the browser that
 * started the flow.
 *
 * `purpose` says what completing it does: `bind` proves the user owns or administers
 * `installationId` and binds it; `user` stores the principal's own user access token and names no
 * installation. It lives only here, server-side, and completion reads it from this state: the
 * browser never states a purpose on return, so a `bind` state cannot be replayed as `user` or the
 * reverse.
 */
type AuthorizationState = {
  principalId: string;
  browserBinding: string;
  purpose: GitHubAuthorizationPurpose;
  installationId?: string;
  expectedAppId: string;
  expectedAccountId?: string;
  redirectUri: string;
  codeVerifier: string;
  expiresAt: number;
};

export type GitHubAuthorizationPurpose = 'bind' | 'user';

type AuthorizationPayload = Omit<AuthorizationState, 'principalId' | 'browserBinding' | 'expiresAt'>;

/** A state persisted before purposes existed has none, and was always a `bind`. */
const AuthorizationPayloadSchema = z.object({
  purpose: z.enum(['bind', 'user']).default('bind'),
  installationId: z.string().optional(),
  expectedAppId: z.string(),
  expectedAccountId: z.string().optional(),
  redirectUri: z.string(),
  codeVerifier: z.string()
}).strict();

const DEFAULT_MAX_STATES_PER_PRINCIPAL = 8;

export interface GitHubInstallationVerifier {
  verifyInstallation(installationId: string): Promise<VerifiedGitHubInstallation>;
}

export class GitHubSetupStateStore {
  readonly #states = new Map<string, SetupState>();

  constructor(
    private readonly database?: DatabaseSync,
    private readonly maxStatesPerPrincipal = DEFAULT_MAX_STATES_PER_PRINCIPAL
  ) {
    if (!Number.isSafeInteger(maxStatesPerPrincipal) || maxStatesPerPrincipal <= 0) {
      throw new Error('GitHub setup state cap must be positive');
    }
    database?.exec(`
      CREATE TABLE IF NOT EXISTS github_setup_states (
        state_hash TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        expected_app_id TEXT NOT NULL,
        expected_account_id TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS github_setup_states_principal_expiry
        ON github_setup_states(principal_id, expires_at, created_at);
    `);
  }

  create(input: {
    principalId: string;
    expectedAppId: string | number;
    expectedAccountId?: string | number;
    now: number;
    ttlMs: number;
  }): { state: string; expiresAt: number } {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error('GitHub setup state TTL must be positive');
    const state = randomBytes(32).toString('base64url');
    const expiresAt = input.now + input.ttlMs;
    const setup: SetupState = {
      principalId: input.principalId,
      expectedAppId: String(input.expectedAppId),
      expiresAt
    };
    if (input.expectedAccountId !== undefined) setup.expectedAccountId = String(input.expectedAccountId);
    if (this.database) this.persist(hashState(state), setup, input.now);
    else {
      this.pruneMemory(input.now);
      const owned = [...this.#states.entries()]
        .filter(([, current]) => current.principalId === input.principalId)
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
      for (const [key] of owned.slice(0, Math.max(0, owned.length - this.maxStatesPerPrincipal + 1))) {
        this.#states.delete(key);
      }
      this.#states.set(hashState(state), setup);
    }
    return { state, expiresAt };
  }

  consume(state: string, principalId: string, now: number): SetupState {
    const key = hashState(state);
    if (this.database) return this.consumePersisted(key, principalId, now);
    this.pruneMemory(now);
    const setup = this.#states.get(key);
    if (!setup || setup.principalId !== principalId || setup.expiresAt <= now) {
      throw invalidSetupState();
    }
    this.#states.delete(key);
    return { ...setup };
  }

  private persist(stateHash: string, setup: SetupState, now: number): void {
    const database = this.database!;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM github_setup_states WHERE expires_at <= ?').run(now);
      const excess = database.prepare(`SELECT state_hash FROM github_setup_states
        WHERE principal_id = ? ORDER BY expires_at ASC, created_at ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM github_setup_states WHERE principal_id = ?) - ? + 1)`)
        .all(setup.principalId, setup.principalId, this.maxStatesPerPrincipal) as { state_hash: string }[];
      const remove = database.prepare('DELETE FROM github_setup_states WHERE state_hash = ?');
      for (const row of excess) remove.run(row.state_hash);
      database.prepare(`INSERT INTO github_setup_states
        (state_hash, principal_id, expected_app_id, expected_account_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(stateHash, setup.principalId, setup.expectedAppId, setup.expectedAccountId ?? null, setup.expiresAt, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  private consumePersisted(stateHash: string, principalId: string, now: number): SetupState {
    const database = this.database!;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM github_setup_states WHERE expires_at <= ?').run(now);
      const row = database.prepare(`SELECT principal_id, expected_app_id, expected_account_id, expires_at
        FROM github_setup_states WHERE state_hash = ? AND principal_id = ? AND expires_at > ?`)
        .get(stateHash, principalId, now) as SetupStateRow | undefined;
      if (!row) {
        database.exec('COMMIT');
        throw invalidSetupState();
      }
      const deleted = database.prepare('DELETE FROM github_setup_states WHERE state_hash = ? AND principal_id = ?')
        .run(stateHash, principalId);
      if (deleted.changes !== 1) throw invalidSetupState();
      database.exec('COMMIT');
      return {
        principalId: row.principal_id,
        expectedAppId: row.expected_app_id,
        ...(row.expected_account_id === null ? {} : { expectedAccountId: row.expected_account_id }),
        expiresAt: row.expires_at
      };
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  private pruneMemory(now: number): void {
    for (const [key, setup] of this.#states) if (setup.expiresAt <= now) this.#states.delete(key);
  }
}

export class GitHubAuthorizationStateStore {
  readonly #states = new Map<string, AuthorizationState>();

  constructor(
    private readonly database?: DatabaseSync,
    private readonly maxStatesPerPrincipal = DEFAULT_MAX_STATES_PER_PRINCIPAL
  ) {
    if (!Number.isSafeInteger(maxStatesPerPrincipal) || maxStatesPerPrincipal <= 0) {
      throw new Error('GitHub authorization state cap must be positive');
    }
    database?.exec(`
      CREATE TABLE IF NOT EXISTS github_authorization_states (
        state_hash TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        browser_binding TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS github_authorization_states_principal_expiry
        ON github_authorization_states(principal_id, expires_at, created_at);
    `);
  }

  create(pending: Omit<AuthorizationState, 'expiresAt'>, now: number, ttlMs: number): { state: string; expiresAt: number } {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('GitHub authorization state TTL must be positive');
    const state = randomBytes(32).toString('base64url');
    const record: AuthorizationState = { ...pending, expiresAt: now + ttlMs };
    const key = hashState(state);
    if (this.database) this.persist(key, record, now);
    else {
      this.pruneMemory(now);
      const owned = [...this.#states.entries()]
        .filter(([, current]) => current.principalId === pending.principalId)
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
      for (const [stale] of owned.slice(0, Math.max(0, owned.length - this.maxStatesPerPrincipal + 1))) this.#states.delete(stale);
      this.#states.set(key, record);
    }
    return { state, expiresAt: record.expiresAt };
  }

  /**
   * Consumes a state once. A state of another principal or another browser is left in place,
   * so a swapped or leaked state cannot cancel the owner's flow.
   */
  consume(state: string, principalId: string, browserBinding: string, now: number): AuthorizationState {
    const key = hashState(state);
    if (this.database) return this.consumePersisted(key, principalId, browserBinding, now);
    this.pruneMemory(now);
    const pending = this.#states.get(key);
    if (!pending || pending.principalId !== principalId || !sameId(pending.browserBinding, browserBinding) || pending.expiresAt <= now) {
      throw invalidAuthorizationState();
    }
    this.#states.delete(key);
    return { ...pending };
  }

  private persist(stateHash: string, record: AuthorizationState, now: number): void {
    const database = this.database!;
    const { principalId, browserBinding, expiresAt, ...payload } = record;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM github_authorization_states WHERE expires_at <= ?').run(now);
      const excess = database.prepare(`SELECT state_hash FROM github_authorization_states
        WHERE principal_id = ? ORDER BY expires_at ASC, created_at ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM github_authorization_states WHERE principal_id = ?) - ? + 1)`)
        .all(principalId, principalId, this.maxStatesPerPrincipal) as { state_hash: string }[];
      const remove = database.prepare('DELETE FROM github_authorization_states WHERE state_hash = ?');
      for (const row of excess) remove.run(row.state_hash);
      database.prepare(`INSERT INTO github_authorization_states
        (state_hash, principal_id, browser_binding, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(stateHash, principalId, browserBinding, JSON.stringify(payload satisfies AuthorizationPayload), expiresAt, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  private consumePersisted(stateHash: string, principalId: string, browserBinding: string, now: number): AuthorizationState {
    const database = this.database!;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM github_authorization_states WHERE expires_at <= ?').run(now);
      const row = database.prepare(`SELECT browser_binding, payload, expires_at FROM github_authorization_states
        WHERE state_hash = ? AND principal_id = ? AND expires_at > ?`)
        .get(stateHash, principalId, now) as { browser_binding: string; payload: string; expires_at: number } | undefined;
      if (!row || !sameId(row.browser_binding, browserBinding)) {
        database.exec('COMMIT');
        throw invalidAuthorizationState();
      }
      const deleted = database.prepare('DELETE FROM github_authorization_states WHERE state_hash = ? AND principal_id = ?')
        .run(stateHash, principalId);
      if (deleted.changes !== 1) throw invalidAuthorizationState();
      database.exec('COMMIT');
      return authorizationFrom(row.payload, principalId, row.browser_binding, row.expires_at);
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  private pruneMemory(now: number): void {
    for (const [key, pending] of this.#states) if (pending.expiresAt <= now) this.#states.delete(key);
  }
}

/** Present only when the GitHub App OAuth client credentials are configured. */
export type GitHubUserAuthorization = {
  states: GitHubAuthorizationStateStore;
  authorizer: GitHubUserAuthorizer;
  /**
   * Stores and renews the token pair a `user` authorization produces. Absent when no secret keyring
   * can protect a token, which leaves the `bind` purpose working and refuses the `user` one.
   */
  userAuthorizations?: GitHubUserAuthorizationService;
};

/** What completing an authorization did, as the stored state's purpose decided. */
export type GitHubAuthorizationCompletion =
  | { purpose: 'bind'; installation: GitHubInstallationRecord }
  | { purpose: 'user'; authorization: GitHubUserAuthorizationView };

const AUTHORIZATION_TTL_MS = 10 * 60_000;

export class GitHubBindingService {
  constructor(
    private readonly states: GitHubSetupStateStore,
    private readonly installations: GitHubInstallationStore,
    private readonly verifier: GitHubInstallationVerifier,
    private readonly now: () => number = Date.now,
    private readonly userAuthorization?: GitHubUserAuthorization
  ) {}

  /** Whether the GitHub App OAuth client credentials are configured, so a binding can be proven. */
  get userAuthorizationConfigured(): boolean {
    return this.userAuthorization !== undefined;
  }

  /** The principal's GitHub user token lifecycle; `undefined` while no keyring can protect a token. */
  get userAuthorizations(): GitHubUserAuthorizationService | undefined {
    return this.userAuthorization?.userAuthorizations;
  }

  beginSetup(input: {
    principalId: string;
    expectedAppId: string | number;
    expectedAccountId?: string | number;
    ttlMs?: number;
  }): { state: string; expiresAt: number } {
    return this.states.create({ ...input, now: this.now(), ttlMs: input.ttlMs ?? AUTHORIZATION_TTL_MS });
  }

  /**
   * Starts the GitHub user authorization that proves the principal's GitHub user owns or
   * administers `installationId`. A setup state from `beginSetup` is optional because GitHub
   * drops it when an already-installed App is configured; when present it is consumed and its
   * expected account carries over.
   */
  beginAuthorization(input: {
    principalId: string;
    installationId: string;
    expectedAppId: string | number;
    setupState?: string;
    redirectUri: string;
    browserBinding: string;
  }): { url: string; expiresAt: number } {
    const { states, authorizer } = this.requireUserAuthorization();
    const now = this.now();
    const setup = input.setupState === undefined ? undefined : this.states.consume(input.setupState, input.principalId, now);
    if (setup && !sameId(setup.expectedAppId, input.expectedAppId)) throw invalidSetupState();
    const codeVerifier = randomBytes(32).toString('base64url');
    const created = states.create({
      principalId: input.principalId,
      browserBinding: input.browserBinding,
      purpose: 'bind',
      installationId: input.installationId,
      expectedAppId: String(input.expectedAppId),
      ...(setup?.expectedAccountId === undefined ? {} : { expectedAccountId: setup.expectedAccountId }),
      redirectUri: input.redirectUri,
      codeVerifier
    }, now, AUTHORIZATION_TTL_MS);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { url: authorizer.authorizeUrl({ state: created.state, codeChallenge, redirectUri: input.redirectUri }), expiresAt: created.expiresAt };
  }

  /**
   * Starts the GitHub user authorization that stores the principal's own user access token. It names
   * no installation and consumes no setup state: GitHub decides what the token reaches, which is the
   * intersection of the App's installations and the user's own access.
   */
  beginUserAuthorization(input: {
    principalId: string;
    expectedAppId: string | number;
    redirectUri: string;
    browserBinding: string;
  }): { url: string; expiresAt: number } {
    const { states, authorizer } = this.requireUserAuthorization();
    this.requireUserAuthorizations();
    const codeVerifier = randomBytes(32).toString('base64url');
    const created = states.create({
      principalId: input.principalId,
      browserBinding: input.browserBinding,
      purpose: 'user',
      expectedAppId: String(input.expectedAppId),
      redirectUri: input.redirectUri,
      codeVerifier
    }, this.now(), AUTHORIZATION_TTL_MS);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { url: authorizer.authorizeUserUrl({ state: created.state, codeChallenge, redirectUri: input.redirectUri }), expiresAt: created.expiresAt };
  }

  /**
   * Completes the authorization the stored state describes. The purpose comes from that state only.
   *
   * `bind` binds the installation only after GitHub proves, with the user's own token, that the user
   * can access it and owns its account or administers its organization. The App JWT then verifies the
   * installation and its repositories; the user token is revoked at GitHub once the proof is read.
   * Because the proof establishes ownership, a binding held by another principal (for example one
   * created before user authorization existed) is replaced in the same transaction and reported to
   * `audit` as `replacedPrincipalId`.
   *
   * `user` keeps the token pair: it is stored encrypted under a generation, and a pair it replaces is
   * revoked at GitHub. The refusal and audit hooks belong to `bind`.
   */
  async completeAuthorization(input: {
    principalId: string;
    state: string;
    code: string;
    browserBinding: string;
  }, audit?: (record: GitHubInstallationRecord, proof: GitHubUserInstallationProof, replacedPrincipalId?: string) => void,
  refused?: (installationId: string | undefined, error: HarnessError) => void): Promise<GitHubAuthorizationCompletion> {
    const { states, authorizer } = this.requireUserAuthorization();
    let pending: AuthorizationState;
    try {
      pending = states.consume(input.state, input.principalId, input.browserBinding, this.now());
    } catch (error) {
      // Replay, another principal or browser, or expiry. The state is not deleted by this refusal.
      if (error instanceof HarnessError && !error.retryable) refused?.(undefined, error);
      throw error;
    }
    if (pending.purpose === 'user') return await this.completeUserAuthorization(input, pending);
    const installationId = pending.installationId;
    if (installationId === undefined) throw invalidAuthorizationState();
    try {
      const proof = await authorizer.proveInstallationAdministration({
        code: input.code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, installationId
      });
      const verified = await this.verifier.verifyInstallation(installationId);
      if (
        !sameId(installationId, proof.installationId) ||
        !sameId(installationId, verified.installationId) ||
        !sameId(pending.expectedAppId, proof.appId) ||
        !sameId(pending.expectedAppId, verified.appId) ||
        !sameId(proof.accountId, verified.accountId) ||
        (pending.expectedAccountId !== undefined && !sameId(pending.expectedAccountId, verified.accountId))
      ) {
        throw new HarnessError('FORBIDDEN', 'The GitHub installation does not match the connection you started. Start the connection again.', 403);
      }
      const installation = this.installations.replaceVerified(
        input.principalId, verified, this.now(),
        audit ? (record, replacedPrincipalId) => audit(record, proof, replacedPrincipalId) : undefined,
        { takeOver: true }
      );
      return { purpose: 'bind', installation };
    } catch (error) {
      // A refusal is a decision about this installation; a retryable provider failure is not.
      if (error instanceof HarnessError && !error.retryable) refused?.(installationId, error);
      throw error;
    }
  }

  private async completeUserAuthorization(input: { principalId: string; code: string }, pending: AuthorizationState): Promise<GitHubAuthorizationCompletion> {
    const { authorizer } = this.requireUserAuthorization();
    const userAuthorizations = this.requireUserAuthorizations();
    // The ticket is taken before the exchange: the exchange runs for as long as GitHub takes, and a
    // Disconnect or a newer completion during that time decides whether its result may be stored.
    const ticket = userAuthorizations.beginCompletion(input.principalId);
    const exchange = await authorizer.exchangeUserCode({ code: input.code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri });
    // A completion that cannot commit revokes the token GitHub just issued itself.
    return { purpose: 'user', authorization: await userAuthorizations.complete(ticket, exchange) };
  }

  async reconcile(
    principalId: string,
    audit?: GitHubInstallationMutationAudit,
    targetInstallationId?: string | number
  ): Promise<GitHubInstallationRecord | undefined> {
    const list = targetInstallationId !== undefined
      ? [this.installations.getInstallation(principalId, targetInstallationId)].filter((x): x is GitHubInstallationRecord => x !== undefined)
      : this.installations.listInstallations(principalId);
    if (list.length === 0) return undefined;

    let lastRecord: GitHubInstallationRecord | undefined;
    for (const installation of list) {
      if (installation.status === 'uninstalled') continue;
      let verified: VerifiedGitHubInstallation;
      try {
        verified = await this.verifier.verifyInstallation(installation.installationId);
      } catch (error) {
        if (error instanceof HarnessError && error.code === 'NOT_FOUND') {
          lastRecord = this.installations.markUninstalled(principalId, installation.installationId, this.now(), audit);
          continue;
        }
        throw error;
      }
      if (
        !sameId(installation.appId, verified.appId) ||
        !sameId(installation.accountId, verified.accountId) ||
        !sameId(installation.installationId, verified.installationId)
      ) {
        throw new HarnessError('CONFLICT', 'GitHub installation identity changed during reconciliation', 409);
      }
      lastRecord = this.installations.replaceVerified(principalId, verified, this.now(), audit);
    }
    return lastRecord ?? list[0];
  }

  disconnect(
    principalId: string,
    installationId: string | number,
    audit?: GitHubInstallationMutationAudit
  ): boolean {
    return this.installations.removeInstallation(principalId, installationId, this.now(), audit);
  }

  /** Disconnects the principal's GitHub user authorization; `undefined` when it never had one. */
  async disconnectUser(principalId: string): Promise<GitHubUserAuthorizationView | undefined> {
    return await this.requireUserAuthorizations().disconnect(principalId);
  }

  private requireUserAuthorization(): GitHubUserAuthorization {
    if (!this.userAuthorization) {
      throw new HarnessError('UNAVAILABLE', 'GitHub App user authorization is not configured: set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET', 503, false);
    }
    return this.userAuthorization;
  }

  private requireUserAuthorizations(): GitHubUserAuthorizationService {
    const userAuthorizations = this.userAuthorizations;
    if (!userAuthorizations) {
      throw new HarnessError('UNAVAILABLE', 'GitHub user authorization is not configured: it stores an encrypted token, so it needs SECRET_KEYRING', 503, false);
    }
    return userAuthorizations;
  }
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('base64url');
}

function sameId(expected: string | number, actual: string | number): boolean {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorizationFrom(payload: string, principalId: string, browserBinding: string, expiresAt: number): AuthorizationState {
  let stored: z.infer<typeof AuthorizationPayloadSchema>;
  try {
    stored = AuthorizationPayloadSchema.parse(JSON.parse(payload));
  } catch {
    throw invalidAuthorizationState();
  }
  return {
    principalId,
    browserBinding,
    expiresAt,
    purpose: stored.purpose,
    expectedAppId: stored.expectedAppId,
    redirectUri: stored.redirectUri,
    codeVerifier: stored.codeVerifier,
    ...(stored.installationId === undefined ? {} : { installationId: stored.installationId }),
    ...(stored.expectedAccountId === undefined ? {} : { expectedAccountId: stored.expectedAccountId })
  };
}

function invalidSetupState(): HarnessError {
  return new HarnessError('FORBIDDEN', 'GitHub installation setup is invalid or expired. Start the connection again.', 403);
}

function invalidAuthorizationState(): HarnessError {
  return new HarnessError('FORBIDDEN', 'GitHub authorization is invalid or expired. Start the connection again.', 403);
}
