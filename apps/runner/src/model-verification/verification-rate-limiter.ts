import { HarnessError } from '@cloud-harness/contracts';

/**
 * Per-principal sliding-window limit on connection checks. Each check can spend provider
 * tokens and makes outbound requests, so a stuck button or script cannot turn the
 * dashboard into a load generator. In memory only: a runner restart resets the window.
 */
export class VerificationRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow = 6,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  take(principalId: string): void {
    const at = this.now();
    const recent = (this.attempts.get(principalId) ?? []).filter((time) => at - time < this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      this.attempts.set(principalId, recent);
      const retryInSeconds = Math.max(1, Math.ceil((recent[0]! + this.windowMs - at) / 1000));
      throw new HarnessError(
        'LIMIT_EXCEEDED',
        `Connection checks are limited to ${this.maxPerWindow} per minute. Retry in ${retryInSeconds} s.`,
        429,
        true
      );
    }
    recent.push(at);
    this.attempts.set(principalId, recent);
    this.prune(at);
  }

  private prune(at: number): void {
    if (this.attempts.size < 1_000) return;
    for (const [principalId, times] of this.attempts) {
      if (times.every((time) => at - time >= this.windowMs)) this.attempts.delete(principalId);
    }
  }
}
