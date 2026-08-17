import {
  InternalRunnerRequestSchema,
  InternalRunnerResponseSchema,
  MetadataRunnerRequestSchema,
  RunnerRequestSchema,
  RunnerResponseSchema,
  type ApiConfig,
  type InternalRunnerOperation,
  type MetadataRunnerOperation,
  type RunnerOperation,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';

export class RunnerClient {
  constructor(private readonly config: ApiConfig) {}

  async call(operation: RunnerOperation, input: Record<string, unknown>, principal: RunnerPrincipalSelector, signal?: AbortSignal): Promise<RunnerResponse> {
    return await this.request('/v1/operations', RunnerRequestSchema.parse({ version: 2, principal, operation, input }), RunnerResponseSchema, signal);
  }

  async callInternal(operation: InternalRunnerOperation | MetadataRunnerOperation, input: Record<string, unknown>, principal: RunnerPrincipalSelector, signal?: AbortSignal): Promise<RunnerResponse> {
    const candidate = { version: 2, principal, operation, input };
    const request = InternalRunnerRequestSchema.safeParse(candidate).success
      ? InternalRunnerRequestSchema.parse(candidate)
      : MetadataRunnerRequestSchema.parse(candidate);
    return await this.request('/v1/internal/dashboard-operations', request, InternalRunnerResponseSchema, signal);
  }

  async closeWorkspaceFenced(workspaceId: string, expectedGeneration: number, principal: RunnerPrincipalSelector, signal?: AbortSignal): Promise<RunnerResponse> {
    return await this.callInternal('workspace_close_fenced', { workspaceId, expectedGeneration }, principal, signal);
  }

  private async request(
    path: string,
    body: unknown,
    schema: typeof RunnerResponseSchema,
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(new URL(path, this.config.runnerUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.runnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined
      });
      const responseBody: unknown = await response.json();
      return schema.parse(responseBody);
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
