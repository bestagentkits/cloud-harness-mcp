import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '@cloud-harness/contracts';
import type {
  GitHubInstallationRecord,
  GitHubInstallationMutationAudit,
  GitHubInstallationStore,
  VerifiedGitHubInstallation
} from './github-installation-store.js';

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

export class GitHubBindingService {
  constructor(
    private readonly states: GitHubSetupStateStore,
    private readonly installations: GitHubInstallationStore,
    private readonly verifier: GitHubInstallationVerifier,
    private readonly now: () => number = Date.now
  ) {}

  beginSetup(input: {
    principalId: string;
    expectedAppId: string | number;
    expectedAccountId?: string | number;
    ttlMs?: number;
  }): { state: string; expiresAt: number } {
    return this.states.create({ ...input, now: this.now(), ttlMs: input.ttlMs ?? 10 * 60_000 });
  }

  async completeSetup(input: {
    principalId: string;
    state: string;
    appId?: string | number;
    accountId?: string | number;
    installationId: string | number;
  }, audit?: GitHubInstallationMutationAudit): Promise<GitHubInstallationRecord> {
    const setup = this.states.consume(input.state, input.principalId, this.now());
    const verified = await this.verifier.verifyInstallation(String(input.installationId));
    if (
      !sameId(setup.expectedAppId, verified.appId) ||
      !sameId(input.installationId, verified.installationId) ||
      (input.appId !== undefined && !sameId(setup.expectedAppId, input.appId)) ||
      (input.accountId !== undefined && !sameId(input.accountId, verified.accountId)) ||
      (setup.expectedAccountId !== undefined && !sameId(setup.expectedAccountId, verified.accountId))
    ) throw invalidSetupState();
    return this.installations.replaceVerified(input.principalId, verified, this.now(), audit);
  }

  async reconcile(
    principalId: string,
    audit?: GitHubInstallationMutationAudit
  ): Promise<GitHubInstallationRecord | undefined> {
    const installation = this.installations.getInstallation(principalId);
    if (!installation) return undefined;
    let verified: VerifiedGitHubInstallation;
    try {
      verified = await this.verifier.verifyInstallation(installation.installationId);
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'NOT_FOUND') {
        return this.installations.markUninstalled(principalId, this.now(), audit);
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
    return this.installations.replaceVerified(principalId, verified, this.now(), audit);
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

function invalidSetupState(): HarnessError {
  return new HarnessError('FORBIDDEN', 'GitHub installation setup is invalid or expired', 403);
}
