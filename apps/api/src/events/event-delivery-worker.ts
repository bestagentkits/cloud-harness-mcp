import type { McpEventClaimedDelivery, McpEventsRunnerRequest, McpEventsRunnerResponse } from '@cloud-harness/contracts';
import { McpEventsRunnerDataSchemas } from '@cloud-harness/contracts';
import type { WebhookOutcome, WebhookSender } from './webhook-sender.js';

/**
 * Drains the runner's MCP Events delivery queue from the API process. The runner leases due
 * deliveries (with decrypted signing secrets) over the service channel; this worker signs and
 * POSTs them through the SSRF-guarded sender and reports each outcome against its lease token.
 * Delivery is at least once: a crash between POST and report re-sends the same event id after the
 * lease expires, and receivers dedupe on `webhook-id`.
 */

export type EventDeliveryWorkerOptions = {
  callRunner(request: McpEventsRunnerRequest, signal?: AbortSignal): Promise<McpEventsRunnerResponse>;
  sender: WebhookSender;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  concurrency?: number;
  onError?: (stage: 'claim' | 'deliver' | 'report', reason: string) => void;
};

export type DeliveryReport = { deliveryId: string; leaseToken: string; outcome: 'delivered' | 'failed' | 'rejected'; error?: WebhookOutcomeError };
type WebhookOutcomeError = Extract<WebhookOutcome, { ok: false }>['reason'];

/** 410 Gone and 413 Payload Too Large are permanent per the webhook profile; other failures retry. */
export function classifyOutcome(outcome: WebhookOutcome): Pick<DeliveryReport, 'outcome' | 'error'> {
  if (outcome.ok) return { outcome: 'delivered' };
  if (outcome.status === 410 || outcome.status === 413) return { outcome: 'rejected', error: outcome.reason };
  return { outcome: 'failed', error: outcome.reason };
}

export class EventDeliveryWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly abort = new AbortController();

  constructor(private readonly options: EventDeliveryWorkerOptions) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.concurrency = options.concurrency ?? 5;
  }

  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.running?.catch(() => undefined);
  }

  /** Runs one claim → deliver → report pass unless one is already in flight. */
  async tick(): Promise<void> {
    if (this.running || this.abort.signal.aborted) return await this.running;
    this.running = this.drain().finally(() => { this.running = undefined; });
    return await this.running;
  }

  /** Never rejects: the timer fires it unawaited, so every failure is reported through `onError`. */
  private async drain(): Promise<void> {
    try {
      await this.pass();
    } catch (error) {
      this.options.onError?.('claim', error instanceof Error ? error.name : 'unknown');
    }
  }

  private async pass(): Promise<void> {
    const signal = this.abort.signal;
    const claimed = await this.options.callRunner({
      version: 1, operation: 'events_delivery_claim', input: { limit: this.batchSize, leaseMs: this.leaseMs }
    }, signal);
    if (!claimed.ok) {
      this.options.onError?.('claim', claimed.error.code);
      return;
    }
    const parsed = McpEventsRunnerDataSchemas.events_delivery_claim.safeParse(claimed.data);
    if (!parsed.success) {
      this.options.onError?.('claim', 'invalid_response');
      return;
    }
    const queue = [...parsed.data.deliveries];
    const reports: DeliveryReport[] = [];
    const work = async (): Promise<void> => {
      for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
        if (signal.aborted) return;
        const report = await this.deliver(delivery, signal);
        // An attempt cut short by shutdown is left to its lease so it is retried, not counted as failed.
        if (report && !signal.aborted) reports.push(report);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, work));
    if (reports.length === 0) return;
    // Reported even during shutdown so finished attempts are not re-sent after the lease lapses.
    let reported: McpEventsRunnerResponse;
    try {
      reported = await this.options.callRunner({ version: 1, operation: 'events_delivery_report', input: { results: reports } });
    } catch (error) {
      this.options.onError?.('report', error instanceof Error ? error.name : 'unknown');
      return;
    }
    if (!reported.ok) this.options.onError?.('report', reported.error.code);
  }

  private async deliver(delivery: McpEventClaimedDelivery, signal: AbortSignal): Promise<DeliveryReport | undefined> {
    let outcome: WebhookOutcome;
    try {
      outcome = await this.options.sender.post({
        url: delivery.url,
        webhookId: delivery.eventId,
        subscriptionId: delivery.subscriptionId,
        secrets: delivery.secrets,
        body: delivery.body,
        signal
      });
    } catch (error) {
      // The lease lapses and the delivery is retried; the sender never throws for transport failures.
      this.options.onError?.('deliver', error instanceof Error ? error.name : 'unknown');
      return undefined;
    }
    return { deliveryId: delivery.deliveryId, leaseToken: delivery.leaseToken, ...classifyOutcome(outcome) };
  }
}
