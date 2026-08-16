import { RunnerResponseSchema, type ApiConfig, type RunnerOperation, type RunnerResponse } from '@cloud-harness/contracts';

export class RunnerClient {
  constructor(private readonly config: ApiConfig) {}

  async call(operation: RunnerOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<RunnerResponse> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(new URL('/v1/operations', this.config.runnerUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.runnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, ownerId: this.config.ownerId, operation, input }),
        signal: combined
      });
      const body: unknown = await response.json();
      return RunnerResponseSchema.parse(body);
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError' ? 'Runner request timed out' : 'Runner is unavailable';
      return { ok: false, message, error: { code: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNAVAILABLE', message, retryable: true }, truncated: false };
    }
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/healthz', this.config.runnerUrl), { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch { return false; }
  }
}
