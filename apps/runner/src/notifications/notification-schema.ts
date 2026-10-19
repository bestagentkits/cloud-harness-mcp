import type { DatabaseSync } from 'node:sqlite';

/**
 * Creates the notification inbox tables. Additive and idempotent, with no schema version bump and no
 * foreign keys, so a code revert leaves inert tables. The inbox does not reuse `event_outbox`: the
 * outbox writes nothing when no MCP subscription matches, while an inbox row must exist regardless.
 *
 * - `notifications` holds one logical row per `dedupe_key` (`<principal>:<subject>:<transition>`),
 *   so duplicate claims and restarts can never create a second notification.
 * - `notification_deliveries` holds one row per enabled channel. `lease_token` makes a claim a
 *   compare-and-swap: only the holder of the current lease can report an outcome.
 * - `notification_preferences` stores owner overrides; a missing row means the channel is on.
 * - The mark-all watermark is the implicit rowid, which relies on rowids only growing: retention deletes
 *   only old settled rows and nothing VACUUMs. If either changes, switch to an AUTOINCREMENT sequence column.
 */
export function initializeNotificationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_principal_created ON notifications(principal_id, created_at, notification_id);
    CREATE INDEX IF NOT EXISTS notifications_principal_unread ON notifications(principal_id, read_at);
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      notification_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','CLAIMED','DELIVERED','FAILED','REVOKED')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      lease_until INTEGER,
      lease_token TEXT,
      next_attempt_at INTEGER NOT NULL,
      last_error_class TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(notification_id, channel)
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_due ON notification_deliveries(state, next_attempt_at);
    CREATE TABLE IF NOT EXISTS notification_preferences (
      principal_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id, channel, kind)
    );
  `);
}
