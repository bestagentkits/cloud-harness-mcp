import { describe, expect, it } from 'vitest';
import {
  ApiKeyAuthenticationRequestSchema,
  ApiKeyManagementRequestSchema,
  ApiKeyManagementResponseSchema,
  RunnerOperationSchema
} from '../src/index.js';

const principal = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'subject' };

describe('managed API-key contracts', () => {
  it('keeps lifecycle operations outside the public MCP runner contract', () => {
    expect(RunnerOperationSchema.safeParse('api_key_create').success).toBe(false);
  });

  it('validates strict create bounds and a dedicated one-time response', () => {
    expect(ApiKeyManagementRequestSchema.parse({
      version: 1, principal, operation: 'api_key_create', input: { name: 'CLI', expiresInDays: 30 }
    }).operation).toBe('api_key_create');
    expect(ApiKeyManagementRequestSchema.safeParse({
      version: 1, principal, operation: 'api_key_create', input: { name: 'CLI', expiresInDays: 366 }
    }).success).toBe(false);
    const apiKey = `chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}`;
    expect(ApiKeyManagementResponseSchema.parse({
      ok: true, operation: 'api_key_create', truncated: false,
      data: { apiKey, key: { id: `apk_${'a'.repeat(24)}`, name: 'CLI', displayPrefix: 'chm_key_apk_aaaa…', state: 'ACTIVE', generation: 1, createdAt: 1, expiresAt: 2, lastUsedAt: null, revokedAt: null } }
    }).data).toHaveProperty('apiKey', apiKey);
  });

  it('rejects oversized and malformed presented keys before runner work', () => {
    expect(ApiKeyAuthenticationRequestSchema.safeParse({ version: 1, apiKey: 'x'.repeat(10_000) }).success).toBe(false);
    expect(ApiKeyAuthenticationRequestSchema.safeParse({ version: 1, apiKey: `chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}` }).success).toBe(true);
  });
});
