import {
  ApiKeyAuthenticationRequestSchema,
  ApiKeyManagementRequestSchema,
  HarnessError,
  type ApiKeyAuthenticationResponse,
  type ApiKeyManagementRequest,
  type ApiKeyManagementResponse
} from '@cloud-harness/contracts';
import type { ApiKeyStore } from './api-key-store.js';
import type { StateStore } from './state-store.js';

export class ApiKeyService {
  constructor(private readonly principals: StateStore, private readonly keys: ApiKeyStore) {}

  manage(request: unknown): ApiKeyManagementResponse {
    const parsed = ApiKeyManagementRequestSchema.parse(request);
    const principalId = this.principals.resolvePrincipal(parsed.principal);
    try {
      return this.executeManagement(principalId, parsed);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (message === 'active API key limit reached') {
        throw new HarnessError('LIMIT_EXCEEDED', 'active API key limit reached', 429, false);
      }
      throw error;
    }
  }

  authenticate(request: unknown): ApiKeyAuthenticationResponse {
    const parsed = ApiKeyAuthenticationRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'authentication_failed' };
    const verified = this.keys.verify(parsed.data.apiKey);
    return verified ? { ok: true, data: verified } : { ok: false, error: 'authentication_failed' };
  }

  private executeManagement(principalId: string, request: ApiKeyManagementRequest): ApiKeyManagementResponse {
    switch (request.operation) {
      case 'api_key_list':
        return { ok: true, operation: request.operation, data: { keys: this.keys.list(principalId) }, truncated: false };
      case 'api_key_create': {
        const created = this.keys.create(principalId, request.input.name, request.input.expiresInDays);
        return { ok: true, operation: request.operation, data: created, truncated: false };
      }
      case 'api_key_revoke': {
        const key = this.keys.revoke(principalId, request.input.keyId, request.input.expectedGeneration);
        if (!key) throw new HarnessError('CONFLICT', 'resource generation changed or resource is unavailable', 409, false);
        return { ok: true, operation: request.operation, data: { key }, truncated: false };
      }
    }
  }
}
