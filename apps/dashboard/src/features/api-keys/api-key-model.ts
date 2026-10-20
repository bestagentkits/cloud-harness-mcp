import { apiClient } from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';

export type ApiKeyState = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type ApiKeyMetadata = {
  id: string;
  name: string;
  displayPrefix: string;
  state: ApiKeyState;
  generation: number;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};
export type ApiKeyList = { keys?: ApiKeyMetadata[]; readiness: { ready: boolean; publicUrl?: string | null } };

export const MAX_ACTIVE_KEYS = 10;
export const EXPIRY_PRESETS = [7, 30, 90, 365] as const;
const KEY_PATTERN = /^chm_key_apk_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/;

export const STATE_LABELS: Record<ApiKeyState, string> = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' };

/** The static-client endpoint, shown only when it is a well-formed `https://…/mcp` URL. */
export function staticEndpoint(publicUrl: string | null | undefined): string | undefined {
  if (!publicUrl) return undefined;
  try {
    const url = new URL(publicUrl);
    return url.protocol === 'https:' && url.pathname.endsWith('/mcp') ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function apiKeyInput(name: string, days: string): { name: string; expiresInDays: number } {
  const trimmed = name.trim();
  const expiresInDays = Number(days);
  if (!trimmed || trimmed.length > 100 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) {
    throw new ClientValidationError('Enter a key name and an expiry from 1 to 3650 whole days.');
  }
  return { name: trimmed, expiresInDays };
}

export const apiKeysApi = {
  /**
   * Creates a key and hands the one-time plaintext to `onKey` only. The returned value is
   * the metadata, so the plaintext never reaches a cache, a mutation state or a log.
   */
  async create(input: { name: string; expiresInDays: number }, onKey: (key: string) => void): Promise<ApiKeyMetadata> {
    const body = await apiClient.request<{ data: { key: ApiKeyMetadata; apiKey: unknown } }>('/api-keys', { method: 'POST', body: input });
    const plaintext = body.data.apiKey;
    if (typeof plaintext !== 'string' || !KEY_PATTERN.test(plaintext)) throw new ClientValidationError('The new API key was unavailable. Create a replacement key.');
    onKey(plaintext);
    return body.data.key;
  },
  revoke: (key: ApiKeyMetadata) => apiClient.request(`/api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE', body: { expectedGeneration: key.generation } })
};
