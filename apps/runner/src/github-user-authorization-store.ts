import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { GitHubUserAuthorizationReasonCode, GitHubUserAuthorizationStatus } from '@cloud-harness/contracts';
import { appendAudit, transaction } from './metadata-records.js';
import type { EncryptedSecret, SecretKeyring } from './secret-keyring.js';

/**
 * Principal-scoped, encrypted storage for a GitHub App user access token pair.
 *
 * One row per principal (`UNIQUE(principal_id)`); `github_user_id` is deliberately not unique,
 * because one person can be two principals. The token pair is one AES-GCM envelope whose context is
 * (`principalId`, `github_user_authorization`, `principalId`, `generation`), so an envelope cannot be
 * opened as anything else and a row's envelope is only valid at its own generation.
 *
 * Every transition is `UPDATE ... WHERE principal_id = ? AND generation = ?` with the generation
 * advanced by one, and a transition that changes no row has lost a race and reports that instead of
 * acting. That one rule is what stops an in-flight refresh from restoring a token the person
 * disconnected, and a stale rejection from revoking an authorization that was renewed since. The
 * store never calls the network, so no transaction here ever spans I/O.
 *
 * Revoking and disconnecting clear the envelope and keep the non-secret status, reason and login:
 * the status is what the credential policy keys on, and the login is what the dashboard shows. A
 * `connected` row is the only one that holds token material; the table's CHECK constraint enforces it.
 *
 * Decrypted tokens leave this module only through `load`, `connect` (the pair it replaced) and
 * `disconnect` (the pair it removed), so the caller can use or revoke them. No view type carries a
 * token.
 */

export const GITHUB_USER_AUTHORIZATION_CONTEXT = 'github_user_authorization';

type Row = {
  principal_id: string;
  generation: number;
  status: GitHubUserAuthorizationStatus;
  reason_code: GitHubUserAuthorizationReasonCode | null;
  github_user_id: string;
  github_login: string;
  access_expires_at: number | null;
  refresh_expires_at: number | null;
  key_version: number | null;
  nonce: Uint8Array | null;
  ciphertext: Uint8Array | null;
  auth_tag: Uint8Array | null;
  created_at: number;
  updated_at: number;
};

/** The columns that hold no secret: what the credential policy and the status view read. */
type PublicRow = Omit<Row, 'key_version' | 'nonce' | 'ciphertext' | 'auth_tag'>;

/** Non-secret view of a stored authorization. */
export type GitHubUserAuthorizationRecord = {
  principalId: string;
  generation: number;
  status: GitHubUserAuthorizationStatus;
  reasonCode: GitHubUserAuthorizationReasonCode | null;
  githubUserId: string;
  login: string;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type GitHubUserTokenPair = { accessToken: string; refreshToken: string };

/** A record and, while it is `connected`, the token pair decrypted from the same statement. */
export type GitHubUserAuthorizationLoaded = { record: GitHubUserAuthorizationRecord; tokens?: GitHubUserTokenPair };

export type GitHubUserTokenWrite = {
  tokens: GitHubUserTokenPair;
  accessExpiresAt: number;
  refreshExpiresAt: number;
};

const TokenPairSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) }).strict();

const toRecord = (row: PublicRow): GitHubUserAuthorizationRecord => ({
  principalId: row.principal_id,
  generation: row.generation,
  status: row.status,
  reasonCode: row.reason_code,
  githubUserId: row.github_user_id,
  login: row.github_login,
  accessExpiresAt: row.access_expires_at,
  refreshExpiresAt: row.refresh_expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const PUBLIC_COLUMNS = 'principal_id, generation, status, reason_code, github_user_id, github_login, access_expires_at, refresh_expires_at, created_at, updated_at';

/**
 * The non-secret authorization of a principal, straight from the database. It selects no token column
 * and needs no keyring, so the credential policy can always ask it, whatever the OAuth configuration or
 * the keyring's state is. A database whose ledger was never migrated holds no authorizations.
 */
export function readGitHubUserAuthorization(database: DatabaseSync, principalId: string): GitHubUserAuthorizationRecord | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_user_authorizations'").get()) return undefined;
  const row = database.prepare(`SELECT ${PUBLIC_COLUMNS} FROM github_user_authorizations WHERE principal_id = ?`)
    .get(principalId) as PublicRow | undefined;
  return row ? toRecord(row) : undefined;
}

export class GitHubUserAuthorizationStore {
  constructor(
    readonly database: DatabaseSync,
    private readonly keyring: SecretKeyring,
    private readonly now: () => number = () => Date.now()
  ) {
    // A row sealed with a key this keyring no longer holds could never be opened: refuse to start
    // with it rather than discover that on the first refresh.
    const versions = database.prepare('SELECT DISTINCT key_version FROM github_user_authorizations WHERE key_version IS NOT NULL')
      .all() as { key_version: number }[];
    keyring.assertAvailableVersions(versions.map((row) => row.key_version));
  }

  private row(principalId: string): Row | undefined {
    return this.database.prepare('SELECT * FROM github_user_authorizations WHERE principal_id = ?')
      .get(principalId) as Row | undefined;
  }

  private seal(principalId: string, generation: number, tokens: GitHubUserTokenPair): EncryptedSecret {
    return this.keyring.encrypt(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }), {
      principalId, environmentId: GITHUB_USER_AUTHORIZATION_CONTEXT, name: principalId, version: generation
    });
  }

  private open(row: Row): GitHubUserTokenPair {
    if (row.key_version === null || row.nonce === null || row.ciphertext === null || row.auth_tag === null) {
      throw new Error('GitHub user authorization holds no token envelope');
    }
    const plaintext = this.keyring.decrypt({
      keyVersion: row.key_version,
      nonce: Buffer.from(row.nonce),
      ciphertext: Buffer.from(row.ciphertext),
      authTag: Buffer.from(row.auth_tag)
    }, { principalId: row.principal_id, environmentId: GITHUB_USER_AUTHORIZATION_CONTEXT, name: row.principal_id, version: row.generation });
    return TokenPairSchema.parse(JSON.parse(plaintext));
  }

  /** The envelope of a pair this call is replacing or removing. A pair that cannot be opened cannot be revoked at GitHub either. */
  private openReplaced(row: Row): GitHubUserTokenPair | undefined {
    if (row.status !== 'connected') return undefined;
    try {
      return this.open(row);
    } catch {
      return undefined;
    }
  }

  /** The stored status without decrypting anything, so reading policy never needs the keyring. */
  get(principalId: string): GitHubUserAuthorizationRecord | undefined {
    const row = this.row(principalId);
    return row ? toRecord(row) : undefined;
  }

  /**
   * The record and, while it is `connected`, its decrypted token pair, read from one statement so the
   * pair always belongs to the generation reported beside it. Throws when the envelope cannot be opened.
   */
  load(principalId: string): GitHubUserAuthorizationLoaded | undefined {
    const row = this.row(principalId);
    if (!row) return undefined;
    return { record: toRecord(row), ...(row.status === 'connected' ? { tokens: this.open(row) } : {}) };
  }

  /**
   * Records a successful `user` authorization, replacing whatever the principal had: nothing, a
   * connected pair, a revoked row, or a disconnected one. This is the only way back to `connected`.
   * A pair it replaces is returned so the caller can revoke it at GitHub after the commit.
   */
  connect(principalId: string, input: GitHubUserTokenWrite & { githubUserId: string; login: string }): {
    record: GitHubUserAuthorizationRecord;
    replaced?: GitHubUserTokenPair;
  } {
    return transaction(this.database, () => {
      const now = this.now();
      const current = this.row(principalId);
      const generation = (current?.generation ?? 0) + 1;
      const sealed = this.seal(principalId, generation, input.tokens);
      const envelope = [sealed.keyVersion, sealed.nonce, sealed.ciphertext, sealed.authTag] as const;
      let replaced: GitHubUserTokenPair | undefined;
      if (current) {
        replaced = this.openReplaced(current);
        const result = this.database.prepare(`UPDATE github_user_authorizations SET
          generation = ?, status = 'connected', reason_code = NULL, github_user_id = ?, github_login = ?,
          access_expires_at = ?, refresh_expires_at = ?, key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?,
          updated_at = ?
          WHERE principal_id = ? AND generation = ?`).run(
          generation, input.githubUserId, input.login, input.accessExpiresAt, input.refreshExpiresAt, ...envelope, now,
          principalId, current.generation
        );
        if (Number(result.changes) !== 1) throw new Error('GitHub user authorization changed while it was being replaced');
      } else {
        this.database.prepare(`INSERT INTO github_user_authorizations
          (principal_id, generation, status, reason_code, github_user_id, github_login, access_expires_at,
           refresh_expires_at, key_version, nonce, ciphertext, auth_tag, created_at, updated_at)
          VALUES (?, ?, 'connected', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          principalId, generation, input.githubUserId, input.login, input.accessExpiresAt, input.refreshExpiresAt,
          ...envelope, now, now
        );
      }
      appendAudit(this.database, principalId, 'github.user_authorized', 'github_user_authorization', input.githubUserId, generation, {
        login: input.login, githubUserId: input.githubUserId
      }, now);
      const record = toRecord(this.row(principalId)!);
      return { record, ...(replaced ? { replaced } : {}) };
    });
  }

  /**
   * Stores the pair a refresh returned. It changes a row only while the row is still `connected` at
   * `expectedGeneration`; anything else (a Disconnect, a reconnect, a revocation) means the refresh
   * lost, and the caller drops the new pair instead of restoring it. A refresh is not audited.
   */
  rotate(principalId: string, expectedGeneration: number, input: GitHubUserTokenWrite): GitHubUserAuthorizationRecord | undefined {
    const generation = expectedGeneration + 1;
    const sealed = this.seal(principalId, generation, input.tokens);
    const result = this.database.prepare(`UPDATE github_user_authorizations SET
      generation = ?, access_expires_at = ?, refresh_expires_at = ?, key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?,
      updated_at = ?
      WHERE principal_id = ? AND generation = ? AND status = 'connected'`).run(
      generation, input.accessExpiresAt, input.refreshExpiresAt, sealed.keyVersion, sealed.nonce, sealed.ciphertext, sealed.authTag,
      this.now(), principalId, expectedGeneration
    );
    return Number(result.changes) === 1 ? this.get(principalId) : undefined;
  }

  /**
   * `connected` -> `revoked`: GitHub refused to renew the authorization. Clears the envelope. It
   * changes nothing unless the row is still `connected` at `expectedGeneration`, so a refusal that
   * arrives after a reconnect cannot revoke the newer authorization.
   */
  markRevoked(principalId: string, expectedGeneration: number, reasonCode: GitHubUserAuthorizationReasonCode): GitHubUserAuthorizationRecord | undefined {
    return transaction(this.database, () => {
      const now = this.now();
      const generation = expectedGeneration + 1;
      const result = this.database.prepare(`UPDATE github_user_authorizations SET
        generation = ?, status = 'revoked', reason_code = ?, access_expires_at = NULL, refresh_expires_at = NULL,
        key_version = NULL, nonce = NULL, ciphertext = NULL, auth_tag = NULL, updated_at = ?
        WHERE principal_id = ? AND generation = ? AND status = 'connected'`).run(generation, reasonCode, now, principalId, expectedGeneration);
      if (Number(result.changes) !== 1) return undefined;
      const record = toRecord(this.row(principalId)!);
      appendAudit(this.database, principalId, 'github.user_authorization_revoked', 'github_user_authorization', record.githubUserId, generation, {
        reasonCode
      }, now);
      return record;
    });
  }

  /**
   * The person chose Disconnect: `connected` or `revoked` -> `disconnected`. The only way a revoked
   * principal leaves `revoked`, and so the only way its legacy fallback lane opens again. Clears the
   * envelope; the removed access token is returned so the caller can revoke it at GitHub after the
   * commit. Disconnecting an already disconnected or absent authorization changes and audits nothing.
   */
  disconnect(principalId: string): { record: GitHubUserAuthorizationRecord; removed?: GitHubUserTokenPair } | undefined {
    return transaction(this.database, () => {
      const now = this.now();
      const current = this.row(principalId);
      if (!current) return undefined;
      if (current.status === 'disconnected') return { record: toRecord(current) };
      const removed = this.openReplaced(current);
      const generation = current.generation + 1;
      const result = this.database.prepare(`UPDATE github_user_authorizations SET
        generation = ?, status = 'disconnected', reason_code = NULL, access_expires_at = NULL, refresh_expires_at = NULL,
        key_version = NULL, nonce = NULL, ciphertext = NULL, auth_tag = NULL, updated_at = ?
        WHERE principal_id = ? AND generation = ?`).run(generation, now, principalId, current.generation);
      if (Number(result.changes) !== 1) throw new Error('GitHub user authorization changed while it was being disconnected');
      appendAudit(this.database, principalId, 'github.user_disconnected', 'github_user_authorization', current.github_user_id, generation, {}, now);
      return { record: toRecord(this.row(principalId)!), ...(removed ? { removed } : {}) };
    });
  }

  /**
   * Removes a principal's row. `principals` is `ON DELETE RESTRICT`, so whatever deletes a principal
   * must call this first, in the same transaction, or the delete is refused. Returns whether a row existed.
   */
  deleteForPrincipal(principalId: string): boolean {
    return Number(this.database.prepare('DELETE FROM github_user_authorizations WHERE principal_id = ?').run(principalId).changes) > 0;
  }

  /**
   * Moves every envelope that is not sealed with the active key onto it, for the `secrets:rekey`
   * maintenance command. Re-encryption does not change the plaintext, so the generation stays: a
   * refresh in flight must still win its own compare-and-swap. Each row is updated only while its
   * generation and key version are unchanged, so a concurrent save is never overwritten. Returns the
   * number of rows re-encrypted.
   */
  reencrypt(signal?: AbortSignal): number {
    const rows = this.database.prepare('SELECT * FROM github_user_authorizations WHERE key_version IS NOT NULL AND key_version <> ?')
      .all(this.keyring.activeVersion) as Row[];
    let changed = 0;
    for (const row of rows) {
      if (signal?.aborted) return changed;
      if (row.key_version === null || row.nonce === null || row.ciphertext === null || row.auth_tag === null) continue;
      const next = this.keyring.reencrypt({
        keyVersion: row.key_version,
        nonce: Buffer.from(row.nonce),
        ciphertext: Buffer.from(row.ciphertext),
        authTag: Buffer.from(row.auth_tag)
      }, { principalId: row.principal_id, environmentId: GITHUB_USER_AUTHORIZATION_CONTEXT, name: row.principal_id, version: row.generation });
      changed += Number(this.database.prepare(`UPDATE github_user_authorizations SET key_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?
        WHERE principal_id = ? AND generation = ? AND key_version = ?`)
        .run(next.keyVersion, next.nonce, next.ciphertext, next.authTag, row.principal_id, row.generation, row.key_version).changes);
    }
    return changed;
  }
}
