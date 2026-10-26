import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONFIGURABLE_NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  NotificationRelatedLinksSchema,
  type NotificationDelivery,
  type NotificationDeliveryState,
  type NotificationKind,
  type NotificationPreference,
  type NotificationSubjectType,
  type NotificationSummary
} from '@cloud-harness/contracts';
import { eventIdForSource } from '../event-outbox.js';

/** Finished notifications are kept this long, then the purge removes them. */
export const NOTIFICATION_RETENTION_MS = 30 * 86_400_000;
/**
 * A delivery still unsettled this long after its notification was created is failed as `expired`, so
 * a channel that never answers cannot pin a notification past retention.
 */
export const NOTIFICATION_HARD_CUTOFF_MS = NOTIFICATION_RETENTION_MS * 2;
/** Delay before the next attempt after the Nth failed or lost attempt (429, 5xx, adapter error, lost lease). */
export const NOTIFICATION_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
/** A delivery whose attempts reach this count without success is FAILED. */
export const NOTIFICATION_MAX_ATTEMPTS = NOTIFICATION_RETRY_DELAYS_MS.length + 1;

/** How many attempts a delivery gets and how long it waits between them. */
export type NotificationRetryPolicy = { maxAttempts: number; retryDelaysMs: readonly number[] };

/** The wait before the attempt that follows `attempts` failed ones. */
export function notificationRetryDelay(policy: NotificationRetryPolicy, attempts: number): number {
  return policy.retryDelaysMs[Math.min(attempts, policy.retryDelaysMs.length) - 1] ?? policy.retryDelaysMs[0] ?? 5_000;
}

const DEFAULT_RETRY_POLICY: NotificationRetryPolicy = {
  maxAttempts: NOTIFICATION_MAX_ATTEMPTS, retryDelaysMs: NOTIFICATION_RETRY_DELAYS_MS
};

/** Notifications kept per principal; the oldest settled ones are removed first. */
export const NOTIFICATION_MAX_PER_PRINCIPAL = 5_000;
const CHANNEL_ORDER = ['inbox', 'mcp_event', 'github'];

export class NotificationStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_INPUT', message: string) {
    super(message);
  }
}

export type NotificationRowInput = {
  notificationId: string;
  principalId: string;
  kind: NotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  dedupeKey: string;
  title: string;
  payloadJson: string;
  createdAt: number;
};

/** A delivery leased to one dispatcher. Only `leaseToken` may report its outcome. */
export type ClaimedNotificationDelivery = {
  notificationId: string;
  principalId: string;
  channel: string;
  kind: NotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  title: string;
  payloadJson: string;
  attempts: number;
  leaseToken: string;
};

/** The settled result a dispatcher reports for one leased delivery. */
export type NotificationDeliveryUpdate = {
  state: 'PENDING' | 'DELIVERED' | 'FAILED' | 'REVOKED';
  attempts: number;
  nextAttemptAt: number;
  errorClass: string | null;
};

type NotificationRow = {
  notification_id: string; principal_id: string; kind: NotificationKind; subject_type: NotificationSubjectType;
  subject_id: string; title: string; payload_json: string; read_at: number | null; created_at: number;
};
type DeliveryRow = {
  notification_id: string; channel: string; state: NotificationDeliveryState; attempts: number;
  last_error_class: string | null; updated_at: number;
};

const iso = (value: number): string => new Date(value).toISOString();

function immediate<T>(database: DatabaseSync, action: () => T): T {
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

/**
 * Stops the MCP event behind revoked `mcp_event` deliveries: its still-pending webhook deliveries are
 * abandoned, so the API egress worker never sends them. A webhook already leased to the worker may
 * still be in flight, but its report is refused and it is never retried. Runs in the caller's transaction.
 */
function abandonNotificationEvents(database: DatabaseSync, notificationIds: readonly string[], now: number): void {
  const abandon = database.prepare(`UPDATE event_deliveries SET status = 'ABANDONED', completed_at = ?, lease_token = NULL,
    lease_until = NULL, last_error = 'preference_disabled' WHERE event_id = ? AND status = 'PENDING'`);
  for (const notificationId of notificationIds) abandon.run(now, eventIdForSource(`notification:${notificationId}`));
}

/** Inserts one notification unless its dedupe key exists. Runs inside the caller's savepoint. */
export function insertNotification(database: DatabaseSync, row: NotificationRowInput): boolean {
  const result = database.prepare(`INSERT OR IGNORE INTO notifications
    (notification_id, principal_id, kind, subject_type, subject_id, dedupe_key, title, payload_json, read_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .run(row.notificationId, row.principalId, row.kind, row.subjectType, row.subjectId, row.dedupeKey, row.title, row.payloadJson, row.createdAt);
  return Number(result.changes) === 1;
}

export function insertNotificationDelivery(
  database: DatabaseSync, notificationId: string, channel: string, state: 'PENDING' | 'DELIVERED', now: number
): void {
  database.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (notification_id, channel, state, attempts, next_attempt_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`)
    .run(notificationId, channel, state, now, now);
}

/** A channel is on unless the principal stored an explicit `enabled = 0` for it and the kind. */
export function notificationPreferenceEnabled(database: DatabaseSync, principalId: string, channel: string, kind: string): boolean {
  const row = database.prepare('SELECT enabled FROM notification_preferences WHERE principal_id = ? AND channel = ? AND kind = ?')
    .get(principalId, channel, kind) as { enabled: number } | undefined;
  return row === undefined || row.enabled === 1;
}

function encodeCursor(createdAt: number, notificationId: string): string {
  return Buffer.from(`${createdAt}.${notificationId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: number; notificationId: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^(\d{1,16})\.(ntf_[a-f0-9]{32})$/u.exec(text);
  if (!match) throw new NotificationStoreError('INVALID_INPUT', 'invalid cursor');
  return { createdAt: Number(match[1]), notificationId: match[2]! };
}

function channelRank(channel: string): number {
  const index = CHANNEL_ORDER.indexOf(channel);
  return index === -1 ? CHANNEL_ORDER.length : index;
}

/**
 * Principal-scoped inbox reads and writes plus the leased delivery queue. Every read and write that
 * names a notification filters by principal, so another principal's notification is indistinguishable
 * from one that does not exist.
 */
export class NotificationStore {
  constructor(readonly database: DatabaseSync, private readonly now: () => number = Date.now) {}

  /**
   * Leases due deliveries of the given channels. A row is due when it is PENDING and its next attempt
   * time has passed, or CLAIMED with an expired lease (its dispatcher stopped mid-claim). The lease is
   * a compare-and-swap on the row's current state and token, so two dispatchers never hold the same
   * delivery. A delivery whose channel the owner has since turned off is revoked instead of leased.
   *
   * An expired lease is not leased again at once. Its dispatcher stopped mid-send, so the lost lease
   * counts as a failed attempt (`lease_lost`): the delivery is FAILED when that reaches the attempt cap,
   * and otherwise waits out the retry delay as PENDING. A delivery that crashes its dispatcher every
   * time therefore backs off and stops, like one that keeps failing.
   */
  claim(
    channels: readonly string[], limit: number, leaseMs: number, policy: NotificationRetryPolicy = DEFAULT_RETRY_POLICY
  ): ClaimedNotificationDelivery[] {
    if (channels.length === 0) return [];
    return immediate(this.database, () => {
      const now = this.now();
      type Row = NotificationRow & { channel: string; state: NotificationDeliveryState; attempts: number; lease_token: string | null };
      const rows = this.database.prepare(`SELECT n.*, d.channel, d.state, d.attempts, d.lease_token
        FROM notification_deliveries d JOIN notifications n ON n.notification_id = d.notification_id
        WHERE d.channel IN (${channels.map(() => '?').join(', ')})
          AND ((d.state = 'PENDING' AND d.next_attempt_at <= ?) OR (d.state = 'CLAIMED' AND d.lease_until <= ?))
        ORDER BY d.next_attempt_at, d.notification_id LIMIT ?`).all(...channels, now, now, limit) as Row[];
      const claimed: ClaimedNotificationDelivery[] = [];
      for (const row of rows) {
        if (!notificationPreferenceEnabled(this.database, row.principal_id, row.channel, row.kind)) {
          const revoked = this.database.prepare(`UPDATE notification_deliveries SET state = 'REVOKED', lease_token = NULL, lease_until = NULL,
            last_error_class = 'preference_disabled', updated_at = ? WHERE notification_id = ? AND channel = ? AND state = ?`)
            .run(now, row.notification_id, row.channel, row.state);
          if (Number(revoked.changes) === 1 && row.channel === 'mcp_event') abandonNotificationEvents(this.database, [row.notification_id], now);
          continue;
        }
        if (row.state === 'CLAIMED') {
          const attempts = row.attempts + 1;
          const exhausted = attempts >= policy.maxAttempts;
          this.database.prepare(`UPDATE notification_deliveries SET state = ?, attempts = ?, next_attempt_at = ?, lease_token = NULL,
              lease_until = NULL, last_error_class = 'lease_lost', updated_at = ?
            WHERE notification_id = ? AND channel = ? AND state = 'CLAIMED' AND lease_token IS ?`)
            .run(exhausted ? 'FAILED' : 'PENDING', attempts, exhausted ? now : now + notificationRetryDelay(policy, attempts), now,
              row.notification_id, row.channel, row.lease_token);
          continue;
        }
        const leaseToken = randomBytes(16).toString('base64url');
        const leased = this.database.prepare(`UPDATE notification_deliveries SET state = 'CLAIMED', lease_token = ?, lease_until = ?, updated_at = ?
          WHERE notification_id = ? AND channel = ? AND state = 'PENDING' AND lease_token IS ?`)
          .run(leaseToken, now + leaseMs, now, row.notification_id, row.channel, row.lease_token);
        if (Number(leased.changes) !== 1) continue;
        claimed.push({
          notificationId: row.notification_id, principalId: row.principal_id, channel: row.channel, kind: row.kind,
          subjectType: row.subject_type, subjectId: row.subject_id, title: row.title, payloadJson: row.payload_json,
          attempts: row.attempts, leaseToken
        });
      }
      return claimed;
    });
  }

  /**
   * Settles one leased delivery. Returns false, changing nothing, when the lease is no longer held:
   * it expired and another dispatcher re-claimed it, or the owner revoked the delivery meanwhile.
   */
  report(notificationId: string, channel: string, leaseToken: string, update: NotificationDeliveryUpdate): boolean {
    const now = this.now();
    const result = this.database.prepare(`UPDATE notification_deliveries SET state = ?, attempts = ?, next_attempt_at = ?,
      last_error_class = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE notification_id = ? AND channel = ? AND state = 'CLAIMED' AND lease_token = ?`)
      .run(update.state, update.attempts, update.nextAttemptAt, update.errorClass, now, notificationId, channel, leaseToken);
    return Number(result.changes) === 1;
  }

  deliveryState(notificationId: string, channel: string): NotificationDeliveryState | undefined {
    const row = this.database.prepare('SELECT state FROM notification_deliveries WHERE notification_id = ? AND channel = ?')
      .get(notificationId, channel) as { state: NotificationDeliveryState } | undefined;
    return row?.state;
  }

  list(principalId: string, options: { cursor?: string | undefined; limit: number; unreadOnly: boolean }): {
    notifications: NotificationSummary[]; nextCursor: string | null; readThrough: number | null;
  } {
    // The page is sorted by `created_at`, the transition time, and a row can be written well after it.
    // Only the watermark uses insertion order (rowid), so it alone bounds "everything that existed now".
    const watermark = this.database.prepare('SELECT max(rowid) AS through FROM notifications WHERE principal_id = ?')
      .get(principalId) as { through: number | null };
    const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    const rows = this.database.prepare(`SELECT * FROM notifications WHERE principal_id = ?
        ${options.unreadOnly ? 'AND read_at IS NULL' : ''}
        ${after ? 'AND (created_at < ? OR (created_at = ? AND notification_id < ?))' : ''}
      ORDER BY created_at DESC, notification_id DESC LIMIT ?`)
      .all(principalId, ...(after ? [after.createdAt, after.createdAt, after.notificationId] : []), options.limit + 1) as NotificationRow[];
    const page = rows.slice(0, options.limit);
    const deliveries = new Map<string, NotificationDelivery[]>();
    if (page.length > 0) {
      const deliveryRows = this.database.prepare(`SELECT notification_id, channel, state, attempts, last_error_class, updated_at
        FROM notification_deliveries WHERE notification_id IN (${page.map(() => '?').join(', ')})`)
        .all(...page.map((row) => row.notification_id)) as DeliveryRow[];
      deliveryRows.sort((left, right) => channelRank(left.channel) - channelRank(right.channel) || left.channel.localeCompare(right.channel));
      for (const row of deliveryRows) {
        const list = deliveries.get(row.notification_id) ?? [];
        list.push({ channel: row.channel, state: row.state, attempts: row.attempts, lastErrorClass: row.last_error_class, updatedAt: iso(row.updated_at) });
        deliveries.set(row.notification_id, list);
      }
    }
    const last = page.at(-1);
    return {
      notifications: page.map((row) => {
        const payload = JSON.parse(row.payload_json) as { link?: unknown; links?: unknown };
        const links = payload.links === undefined ? undefined : NotificationRelatedLinksSchema.safeParse(payload.links);
        return {
          notificationId: row.notification_id,
          kind: row.kind,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          title: row.title,
          link: typeof payload.link === 'string' ? payload.link : null,
          ...(links?.success ? { links: links.data } : {}),
          createdAt: iso(row.created_at),
          readAt: row.read_at === null ? null : iso(row.read_at),
          deliveries: deliveries.get(row.notification_id) ?? []
        };
      }),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last.created_at, last.notification_id) : null,
      readThrough: watermark.through === null ? null : Number(watermark.through)
    };
  }

  unreadCount(principalId: string): number {
    const row = this.database.prepare('SELECT count(*) AS count FROM notifications WHERE principal_id = ? AND read_at IS NULL')
      .get(principalId) as { count: number };
    return Number(row.count);
  }

  /**
   * Marks notifications read. Every named id must belong to the principal; otherwise nothing changes
   * and NOT_FOUND is returned, so a foreign id reveals nothing about its existence. `all` marks only
   * notifications written up to the `readThrough` watermark of a list, so one written after the owner
   * loaded the inbox stays unread, however old its transition time.
   */
  markRead(principalId: string, target: { notificationIds: readonly string[] } | { all: true; through: number }): number {
    return immediate(this.database, () => {
      const now = this.now();
      if ('all' in target) {
        if (!Number.isSafeInteger(target.through) || target.through < 1) throw new NotificationStoreError('INVALID_INPUT', 'invalid watermark');
        return Number(this.database.prepare(`UPDATE notifications SET read_at = ? WHERE principal_id = ? AND read_at IS NULL
          AND rowid <= ?`).run(now, principalId, target.through).changes);
      }
      const ids = [...new Set(target.notificationIds)];
      const placeholders = ids.map(() => '?').join(', ');
      const owned = this.database.prepare(`SELECT count(*) AS count FROM notifications WHERE principal_id = ? AND notification_id IN (${placeholders})`)
        .get(principalId, ...ids) as { count: number };
      if (Number(owned.count) !== ids.length) throw new NotificationStoreError('NOT_FOUND', 'notification not found');
      return Number(this.database.prepare(`UPDATE notifications SET read_at = ? WHERE principal_id = ? AND read_at IS NULL
        AND notification_id IN (${placeholders})`).run(now, principalId, ...ids).changes);
    });
  }

  /** The full channel x kind matrix for the configurable channels, with defaults filled in. */
  preferences(principalId: string): NotificationPreference[] {
    const stored = this.database.prepare('SELECT channel, kind, enabled FROM notification_preferences WHERE principal_id = ?')
      .all(principalId) as { channel: string; kind: string; enabled: number }[];
    const overrides = new Map(stored.map((row) => [`${row.channel}:${row.kind}`, row.enabled === 1]));
    return CONFIGURABLE_NOTIFICATION_CHANNELS.flatMap((channel) => NOTIFICATION_KINDS.map((kind) => ({
      channel, kind, enabled: overrides.get(`${channel}:${kind}`) ?? true
    })));
  }

  /**
   * Stores preferences. Turning a channel off for a kind revokes that principal's pending and
   * in-flight deliveries of it at once: a dispatcher still holding a lease can no longer report, so
   * no further send happens. Returns the number of deliveries revoked.
   */
  setPreferences(principalId: string, preferences: readonly { channel: string; kind: string; enabled: boolean }[]): number {
    return immediate(this.database, () => {
      const now = this.now();
      let revoked = 0;
      for (const preference of preferences) {
        this.database.prepare(`INSERT INTO notification_preferences (principal_id, channel, kind, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(principal_id, channel, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
          .run(principalId, preference.channel, preference.kind, preference.enabled ? 1 : 0, now);
        if (preference.enabled) continue;
        const ids = (this.database.prepare(`SELECT d.notification_id FROM notification_deliveries d
            JOIN notifications n ON n.notification_id = d.notification_id
          WHERE d.channel = ? AND d.state IN ('PENDING', 'CLAIMED') AND n.principal_id = ? AND n.kind = ?`)
          .all(preference.channel, principalId, preference.kind) as { notification_id: string }[]).map((row) => row.notification_id);
        const revoke = this.database.prepare(`UPDATE notification_deliveries SET state = 'REVOKED', lease_token = NULL, lease_until = NULL,
          last_error_class = 'preference_disabled', updated_at = ? WHERE notification_id = ? AND channel = ? AND state IN ('PENDING', 'CLAIMED')`);
        for (const id of ids) revoked += Number(revoke.run(now, id, preference.channel).changes);
        if (preference.channel === 'mcp_event') abandonNotificationEvents(this.database, ids, now);
      }
      return revoked;
    });
  }

  /**
   * Removes notifications past retention, and the oldest beyond the per-principal cap, together with
   * their deliveries. A notification with a delivery still pending or leased is kept, until the hard
   * cutoff fails that delivery as `expired` so it can no longer pin the notification.
   */
  purge(now: number = this.now()): number {
    return immediate(this.database, () => {
      this.database.prepare(`UPDATE notification_deliveries SET state = 'FAILED', lease_token = NULL, lease_until = NULL,
          last_error_class = 'expired', updated_at = ?
        WHERE state IN ('PENDING', 'CLAIMED') AND notification_id IN (SELECT notification_id FROM notifications WHERE created_at < ?)`)
        .run(now, now - NOTIFICATION_HARD_CUTOFF_MS);
      const unsettled = `NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id = notifications.notification_id
        AND d.state IN ('PENDING', 'CLAIMED'))`;
      let removed = Number(this.database.prepare(`DELETE FROM notifications WHERE created_at < ? AND ${unsettled}`)
        .run(now - NOTIFICATION_RETENTION_MS).changes);
      removed += Number(this.database.prepare(`DELETE FROM notifications WHERE notification_id IN (
          SELECT notification_id FROM (
            SELECT notification_id, ROW_NUMBER() OVER (PARTITION BY principal_id ORDER BY created_at DESC, notification_id DESC) AS position
            FROM notifications) WHERE position > ?) AND ${unsettled}`)
        .run(NOTIFICATION_MAX_PER_PRINCIPAL).changes);
      if (removed > 0) {
        this.database.prepare(`DELETE FROM notification_deliveries WHERE NOT EXISTS (
          SELECT 1 FROM notifications n WHERE n.notification_id = notification_deliveries.notification_id)`).run();
      }
      return removed;
    });
  }
}
