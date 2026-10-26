import type { NotificationAdapter, NotificationDispatch, NotificationSendResult } from '../../src/notifications/notification-adapters.js';

/** A scripted response: an HTTP status the fake channel answers with, or a thrown transport error. */
export type FakeChannelResponse = number | 'throw';

/**
 * Second-channel conformance fake for the NotificationAdapter port, with failure injection. It
 * answers from a scripted queue of HTTP statuses (then `fallback`), can be marked unhealthy, can hold
 * a send open until released, and records every send and revocation. A 2xx delivers, 429 and 5xx
 * retry, any other 4xx fails, and `throw` simulates a transport error. Deliveries are deduplicated by
 * idempotency key, so `uniqueDeliveries` counts what a real receiver would have shown.
 */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly sends: NotificationDispatch[] = [];
  readonly revocations: string[] = [];
  readonly deliveredKeys: string[] = [];
  healthy = true;
  fallback: FakeChannelResponse = 200;
  private readonly script: FakeChannelResponse[] = [];
  private gate: Promise<void> | undefined;

  constructor(readonly channel = 'fake_chat') {}

  /** Queues responses for the next sends, in order. */
  respondWith(...responses: FakeChannelResponse[]): this {
    this.script.push(...responses);
    return this;
  }

  /** Holds every send open until the returned release function runs. */
  hold(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => { release = resolve; });
    return () => { this.gate = undefined; release(); };
  }

  get uniqueDeliveries(): number {
    return new Set(this.deliveredKeys).size;
  }

  async send(delivery: NotificationDispatch): Promise<NotificationSendResult> {
    this.sends.push(delivery);
    if (this.gate) await this.gate;
    const response = this.script.shift() ?? this.fallback;
    if (response === 'throw') throw new Error('fake channel transport error');
    if (response >= 200 && response < 300) {
      this.deliveredKeys.push(delivery.idempotencyKey);
      return { outcome: 'delivered' };
    }
    if (response === 429) return { outcome: 'retry', errorClass: 'http_429' };
    if (response >= 500) return { outcome: 'retry', errorClass: 'http_5xx' };
    return { outcome: 'failed', errorClass: 'http_4xx' };
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: this.healthy };
  }

  async revoke(notificationId: string): Promise<void> {
    this.revocations.push(notificationId);
  }
}
