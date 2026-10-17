import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '@cloud-harness/contracts';

/** How long a model tool's idempotency key replays its first result. */
export const MODEL_TOOL_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Idempotency records of the model profile tools, keyed by principal, operation,
 * and key, and bound to a fingerprint of the input. The table is additive: an
 * older runner ignores it. Only a committed change is recorded, so a refused or
 * failed call can be retried with the same key.
 */
export class ModelToolIdempotencyStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_tool_idempotency (
        principal_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, operation, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS model_tool_idempotency_created_at ON model_tool_idempotency(created_at);
    `);
  }

  /**
   * The stored result for this key, or undefined when the key is new or expired.
   * A key that was used with other input is refused rather than replayed.
   */
  lookup(principalId: string, operation: string, key: string, fingerprint: string): unknown {
    const row = this.database.prepare(`
      SELECT fingerprint, result_json FROM model_tool_idempotency
      WHERE principal_id = ? AND operation = ? AND idempotency_key = ? AND created_at > ?
    `).get(principalId, operation, key, this.now() - MODEL_TOOL_IDEMPOTENCY_TTL_MS) as { fingerprint: string; result_json: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) {
      throw new HarnessError('CONFLICT', 'idempotency key reused with different input; use a new idempotencyKey for a different change', 409, false);
    }
    return JSON.parse(row.result_json) as unknown;
  }

  /**
   * Records a committed result. Call it inside the transaction that commits the
   * change, so the change and its record land together. Expired rows are swept
   * first, so an expired key can be used again.
   */
  record(principalId: string, operation: string, key: string, fingerprint: string, result: unknown): void {
    this.database.prepare('DELETE FROM model_tool_idempotency WHERE created_at <= ?').run(this.now() - MODEL_TOOL_IDEMPOTENCY_TTL_MS);
    this.database.prepare(`
      INSERT INTO model_tool_idempotency (principal_id, operation, idempotency_key, fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(principalId, operation, key, fingerprint, JSON.stringify(result), this.now());
  }

  /** Replaces a recorded result, for a detail added after the change committed. */
  replace(principalId: string, operation: string, key: string, result: unknown): void {
    this.database.prepare(`
      UPDATE model_tool_idempotency SET result_json = ? WHERE principal_id = ? AND operation = ? AND idempotency_key = ?
    `).run(JSON.stringify(result), principalId, operation, key);
  }
}

/** sha256 of the canonical JSON of a validated input without its idempotency key. */
export function modelToolFingerprint(input: Record<string, unknown>): string {
  const rest = { ...input };
  delete rest.idempotencyKey;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
