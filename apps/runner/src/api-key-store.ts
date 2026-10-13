import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { API_KEY_MAX_EXPIRY_DAYS, ApiKeyValueSchema, type ApiKeyMetadata, type RunnerPrincipalSelector } from '@cloud-harness/contracts';

type ApiKeyRow = {
  id: string; principal_id: string; name: string; display_prefix: string; secret_hash: Uint8Array;
  state: 'ACTIVE' | 'REVOKED'; generation: number; created_at: number; expires_at: number;
  last_used_at: number | null; revoked_at: number | null;
};

const DAY_MS = 86_400_000;
const USAGE_INTERVAL_MS = 300_000;
const MAX_ACTIVE_KEYS = 10;
type RandomBytes = (size: number) => Buffer;

const digest = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function view(row: ApiKeyRow, now = Date.now()): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.display_prefix,
    state: row.state === 'REVOKED' ? 'REVOKED' : row.expires_at <= now ? 'EXPIRED' : 'ACTIVE',
    generation: row.generation,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

export type ApiKeyAudit = (
  database: DatabaseSync,
  principalId: string,
  action: string,
  key: ApiKeyMetadata
) => void;

export class ApiKeyStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly audit: ApiKeyAudit,
    private readonly now = Date.now,
    private readonly random: RandomBytes = randomBytes
  ) {}

  list(principalId: string): ApiKeyMetadata[] {
    const now = this.now();
    return (this.database.prepare('SELECT * FROM api_keys WHERE principal_id = ? ORDER BY created_at DESC, id').all(principalId) as ApiKeyRow[])
      .map((row) => view(row, now));
  }

  create(principalId: string, name: string, expiresInDays: number): { key: ApiKeyMetadata; apiKey: string } {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 100 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > API_KEY_MAX_EXPIRY_DAYS) {
      throw new Error('invalid API key request');
    }
    return transaction(this.database, () => {
      const now = this.now();
      const active = this.database.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE principal_id = ? AND state = 'ACTIVE' AND expires_at > ?")
        .get(principalId, now) as { count: number };
      if (active.count >= MAX_ACTIVE_KEYS) throw new Error('active API key limit reached');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = `apk_${this.random(18).toString('base64url')}`;
        const secret = this.random(32).toString('base64url');
        const apiKey = `chm_key_${id}.${secret}`;
        const expiresAt = now + expiresInDays * DAY_MS;
        const displayPrefix = `chm_key_${id.slice(0, 12)}…`;
        try {
          this.database.prepare(`INSERT INTO api_keys
            (id, principal_id, name, display_prefix, secret_hash, state, generation, created_at, expires_at, last_used_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, NULL, NULL)`)
            .run(id, principalId, normalizedName, displayPrefix, digest(secret), now, expiresAt);
          const key = this.byOwner(principalId, id, now)!;
          this.audit(this.database, principalId, 'api_key.created', key);
          return { key, apiKey };
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (!message.includes('UNIQUE constraint failed') || attempt === 4) throw error;
        }
      }
      throw new Error('unable to allocate API key identity');
    });
  }

  revoke(principalId: string, keyId: string, expectedGeneration: number): ApiKeyMetadata | undefined {
    return transaction(this.database, () => {
      const now = this.now();
      const result = this.database.prepare(`UPDATE api_keys
        SET state = 'REVOKED', generation = generation + 1, revoked_at = ?
        WHERE principal_id = ? AND id = ? AND generation = ? AND state = 'ACTIVE'`)
        .run(now, principalId, keyId, expectedGeneration);
      if (result.changes !== 1) return undefined;
      const key = this.byOwner(principalId, keyId, now)!;
      this.audit(this.database, principalId, 'api_key.revoked', key);
      return key;
    });
  }

  verify(apiKey: string): { principal: RunnerPrincipalSelector; keyId: string } | undefined {
    if (!ApiKeyValueSchema.safeParse(apiKey).success) return undefined;
    const match = /^chm_key_(apk_[A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/.exec(apiKey);
    if (!match) return undefined;
    const [, keyId, secret] = match;
    const row = this.database.prepare(`SELECT keys.*, principals.issuer, principals.subject, principals.email, principals.name AS principal_name
      FROM api_keys keys JOIN principals ON principals.id = keys.principal_id WHERE keys.id = ?`).get(keyId!) as
      (ApiKeyRow & { issuer: string; subject: string; email: string | null; principal_name: string | null }) | undefined;
    const now = this.now();
    if (!row || row.state !== 'ACTIVE' || row.expires_at <= now) return undefined;
    const actual = digest(secret!);
    const expected = Buffer.from(row.secret_hash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    if (row.last_used_at === null || row.last_used_at <= now - USAGE_INTERVAL_MS) {
      try {
        this.database.prepare(`UPDATE api_keys SET last_used_at = ?
          WHERE id = ? AND state = 'ACTIVE' AND expires_at > ? AND (last_used_at IS NULL OR last_used_at <= ?)`)
          .run(now, row.id, now, now - USAGE_INTERVAL_MS);
      } catch {
        // Usage timestamps are non-authoritative telemetry; a write failure must not deny a verified key.
      }
    }
    return {
      keyId: row.id,
      principal: {
        kind: 'external', issuer: row.issuer, subject: row.subject,
        ...(row.email ? { email: row.email } : {}), ...(row.principal_name ? { name: row.principal_name } : {})
      }
    };
  }

  private byOwner(principalId: string, keyId: string, now: number): ApiKeyMetadata | undefined {
    const row = this.database.prepare('SELECT * FROM api_keys WHERE principal_id = ? AND id = ?').get(principalId, keyId) as ApiKeyRow | undefined;
    return row ? view(row, now) : undefined;
  }
}
