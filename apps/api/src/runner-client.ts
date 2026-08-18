import {
  InternalRunnerRequestSchema,
  InternalRunnerResponseSchema,
  MetadataRunnerRequestSchema,
  ApiKeyAuthenticationRequestSchema,
  ApiKeyAuthenticationResponseSchema,
  ApiKeyManagementRequestSchema,
  ApiKeyManagementResponseSchema,
  RunnerRequestSchema,
  RunnerResponseSchema,
  type ApiConfig,
  type ApiKeyAuthenticationResponse,
  type ApiKeyManagementOperation,
  type ApiKeyManagementResponse,
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

  async callApiKeys(operation: ApiKeyManagementOperation, input: Record<string, unknown>, principal: RunnerPrincipalSelector): Promise<ApiKeyManagementResponse> {
    const request = ApiKeyManagementRequestSchema.parse({ version: 1, principal, operation, input });
    return await this.requestJson('/v1/internal/api-keys', request, ApiKeyManagementResponseSchema, () => ({
      ok: false, message: 'Runner is unavailable',
      error: { code: 'UNAVAILABLE', message: 'Runner is unavailable', retryable: true }, truncated: false
    }));
  }

  async authenticateApiKey(apiKey: string): Promise<ApiKeyAuthenticationResponse> {
    const request = ApiKeyAuthenticationRequestSchema.safeParse({ version: 1, apiKey });
    if (!request.success) return { ok: false, error: 'authentication_failed' };
    return await this.requestJson('/v1/internal/api-keys', request.data, ApiKeyAuthenticationResponseSchema, () => ({
      ok: false, error: 'authentication_failed'
    }));
  }

  private async request(
    path: string,
    body: unknown,
    schema: typeof RunnerResponseSchema,
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    return await this.requestJson(path, body, schema, (error) => {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const message = timedOut ? 'Runner request timed out' : 'Runner is unavailable';
      return { ok: false, message, error: { code: timedOut ? 'TIMEOUT' : 'UNAVAILABLE', message, retryable: true }, truncated: false };
    }, signal);
  }

  private async requestJson<T>(
    path: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    fallback: (error: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
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
      return fallback(error);
    }
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/healthz', this.config.runnerUrl), { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch { return false; }
  }
}
