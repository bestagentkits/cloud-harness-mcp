import type { NotificationAdapter, NotificationDispatch, NotificationSendResult } from './notification-adapters.js';
import {
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_MS,
  notificationRetryDelay,
  type ClaimedNotificationDelivery,
  type NotificationDeliveryUpdate,
  type NotificationRetryPolicy,
  type NotificationStore
} from './notification-store.js';

// The retry policy lives with the store, which also applies it to lost leases; re-exported here for callers.
export { NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_RETRY_DELAYS_MS };
/** How long a claim is held; a dispatcher that stops mid-claim loses it after this. */
export const NOTIFICATION_LEASE_MS = 60_000;
/** How soon a mirror channel whose underlying delivery is still pending is checked again. */
export const NOTIFICATION_MIRROR_POLL_MS = 10_000;
const PURGE_INTERVAL_MS = 3_600_000;

export type NotificationDispatcherOptions = {
  store: NotificationStore;
  adapters: readonly NotificationAdapter[];
  now?: () => number;
  leaseMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  mirrorPollMs?: number;
  log?: (record: Record<string, string | number | boolean>) => void;
};

export type NotificationTickResult = {
  claimed: number; delivered: number; retried: number; failed: number; revoked: number; pending: number; lost: number;
};

const emptyResult = (): NotificationTickResult => ({ claimed: 0, delivered: 0, retried: 0, failed: 0, revoked: 0, pending: 0, lost: 0 });

/**
 * Drains push-channel deliveries: claim with a lease, send through the channel adapter, report with
 * the lease token. A report whose lease is no longer held (expired and re-claimed, or revoked by the
 * owner) changes nothing. Unhealthy channels are skipped, so their deliveries wait as PENDING. A tick
 * never throws and never overlaps another tick of the same dispatcher.
 */
export class NotificationDispatcher {
  private readonly store: NotificationStore;
  private readonly adapters: ReadonlyMap<string, NotificationAdapter>;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly retry: NotificationRetryPolicy;
  private readonly mirrorPollMs: number;
  private readonly log: (record: Record<string, string | number | boolean>) => void;
  private running: Promise<NotificationTickResult> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastPurgeAt = 0;
  private purgeOnly = false;

  constructor(options: NotificationDispatcherOptions) {
    this.store = options.store;
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.channel, adapter]));
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? NOTIFICATION_LEASE_MS;
    this.batchSize = options.batchSize ?? 20;
    this.retry = {
      maxAttempts: options.maxAttempts ?? NOTIFICATION_MAX_ATTEMPTS,
      retryDelaysMs: options.retryDelaysMs ?? NOTIFICATION_RETRY_DELAYS_MS
    };
    this.mirrorPollMs = options.mirrorPollMs ?? NOTIFICATION_MIRROR_POLL_MS;
    this.log = options.log ?? (() => undefined);
  }

  /** The push channels this dispatcher serves; the emitter creates delivery rows for exactly these. */
  channels(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Starts the loop. With `purgeOnly` (notifications turned off) it sends nothing and only applies
   * retention, so stored notifications still age out while the feature is disabled.
   */
  start(intervalMs = 5_000, options: { purgeOnly?: boolean } = {}): void {
    if (this.timer) return;
    this.purgeOnly = options.purgeOnly ?? false;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async tick(): Promise<NotificationTickResult> {
    if (this.running) return emptyResult();
    this.running = this.drain();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async drain(): Promise<NotificationTickResult> {
    const result = emptyResult();
    try {
      this.purge();
      if (this.purgeOnly) return result;
      const healthy: string[] = [];
      for (const adapter of this.adapters.values()) {
        if (await this.healthy(adapter)) healthy.push(adapter.channel);
      }
      const claimed = this.store.claim(healthy, this.batchSize, this.leaseMs, this.retry);
      result.claimed = claimed.length;
      for (const delivery of claimed) await this.deliver(delivery, result);
    } catch (error) {
      this.log({ event: 'notification_dispatch_failed', error: error instanceof Error ? error.name : 'unknown' });
    }
    return result;
  }

  private async healthy(adapter: NotificationAdapter): Promise<boolean> {
    try {
      return (await adapter.health()).ok;
    } catch {
      return false;
    }
  }

  private async deliver(delivery: ClaimedNotificationDelivery, result: NotificationTickResult): Promise<void> {
    const adapter = this.adapters.get(delivery.channel);
    if (!adapter) return;
    let sent: NotificationSendResult;
    try {
      sent = await adapter.send(dispatchFor(delivery));
    } catch {
      sent = { outcome: 'retry', errorClass: 'adapter_error' };
    }
    const update = this.updateFor(delivery, sent);
    const accepted = this.store.report(delivery.notificationId, delivery.channel, delivery.leaseToken, update);
    if (!accepted) {
      // The lease is gone: the owner revoked the delivery mid-send, or it expired and was re-claimed.
      result.lost += 1;
      if (this.store.deliveryState(delivery.notificationId, delivery.channel) === 'REVOKED') {
        await this.revokeQuietly(adapter, delivery.notificationId);
      }
      return;
    }
    if (update.state === 'DELIVERED') result.delivered += 1;
    else if (update.state === 'FAILED') result.failed += 1;
    else if (update.state === 'REVOKED') {
      result.revoked += 1;
      await this.revokeQuietly(adapter, delivery.notificationId);
    } else if (sent.outcome === 'pending') result.pending += 1;
    else result.retried += 1;
    if (update.state === 'FAILED') {
      this.log({ event: 'notification_delivery_failed', channel: delivery.channel, attempts: update.attempts, errorClass: update.errorClass ?? 'unknown' });
    }
  }

  private updateFor(delivery: ClaimedNotificationDelivery, sent: NotificationSendResult): NotificationDeliveryUpdate {
    const now = this.now();
    switch (sent.outcome) {
      case 'delivered':
        return { state: 'DELIVERED', attempts: delivery.attempts + 1, nextAttemptAt: now, errorClass: null };
      case 'pending':
        return { state: 'PENDING', attempts: delivery.attempts, nextAttemptAt: now + this.mirrorPollMs, errorClass: null };
      case 'revoked':
        return { state: 'REVOKED', attempts: delivery.attempts, nextAttemptAt: now, errorClass: boundedClass(sent.errorClass) };
      case 'failed':
        return { state: 'FAILED', attempts: delivery.attempts + 1, nextAttemptAt: now, errorClass: boundedClass(sent.errorClass) };
      case 'retry': {
        const attempts = delivery.attempts + 1;
        if (attempts >= this.retry.maxAttempts) return { state: 'FAILED', attempts, nextAttemptAt: now, errorClass: boundedClass(sent.errorClass) };
        return { state: 'PENDING', attempts, nextAttemptAt: now + notificationRetryDelay(this.retry, attempts), errorClass: boundedClass(sent.errorClass) };
      }
    }
  }

  private async revokeQuietly(adapter: NotificationAdapter, notificationId: string): Promise<void> {
    try {
      await adapter.revoke(notificationId);
    } catch {
      this.log({ event: 'notification_revoke_failed', channel: adapter.channel });
    }
  }

  private purge(): void {
    const now = this.now();
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    const removed = this.store.purge(now);
    if (removed > 0) this.log({ event: 'notifications_purged', removed });
  }
}

function dispatchFor(delivery: ClaimedNotificationDelivery): NotificationDispatch {
  let link: string | null = null;
  try {
    const payload = JSON.parse(delivery.payloadJson) as { link?: unknown };
    link = typeof payload.link === 'string' ? payload.link : null;
  } catch {
    link = null;
  }
  return {
    notificationId: delivery.notificationId,
    principalId: delivery.principalId,
    channel: delivery.channel,
    kind: delivery.kind,
    subjectType: delivery.subjectType,
    subjectId: delivery.subjectId,
    title: delivery.title,
    link,
    attempt: delivery.attempts + 1,
    idempotencyKey: `${delivery.notificationId}:${delivery.channel}`
  };
}

function boundedClass(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/gu, '_').slice(0, 40);
  return normalized.length > 0 ? normalized : 'unknown';
}
