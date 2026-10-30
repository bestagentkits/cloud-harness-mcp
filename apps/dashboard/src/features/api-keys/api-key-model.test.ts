import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import type * as ApiClientModule from '@/lib/api-client';
import { ClientValidationError } from '@/lib/bff-mutation';
import {
  apiKeyInput,
  apiKeysApi,
  type ApiKeyMetadata,
  EXPIRY_PRESETS,
  MAX_ACTIVE_KEYS,
  STATE_LABELS,
  staticEndpoint
} from './api-key-model';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, apiClient: { request: vi.fn() } };
});

const request = vi.mocked(apiClient.request);

// Obviously fake: the shape matches the key pattern, the characters do not carry any entropy.
const FAKE_KEY = `chm_key_apk_${'A'.repeat(24)}.${'B'.repeat(43)}`;

const metadata: ApiKeyMetadata = {
  id: 'key-1',
  name: 'CI runner',
  displayPrefix: 'chm_key_apk_AAAA',
  state: 'ACTIVE',
  generation: 4,
  createdAt: 1_700_000_000_000,
  expiresAt: 1_800_000_000_000,
  lastUsedAt: null,
  revokedAt: null
};

beforeEach(() => {
  request.mockReset();
});

describe('apiKeyInput', () => {
  it('trims the name and turns the expiry text into whole days', () => {
    expect(apiKeyInput('  CI runner  ', '30')).toEqual({ name: 'CI runner', expiresInDays: 30 });
  });

  it.each([
    ['empty name', '   ', '30'],
    ['name over 100 characters', 'n'.repeat(101), '30'],
    ['zero days', 'ci', '0'],
    ['days over 3650', 'ci', '3651'],
    ['fractional days', 'ci', '1.5'],
    ['blank days', 'ci', ''],
    ['non-numeric days', 'ci', 'thirty']
  ])('refuses %s with fixed copy and no request', (_label, name, days) => {
    expect(() => apiKeyInput(name, days)).toThrow(ClientValidationError);
    expect(() => apiKeyInput(name, days)).toThrow('Enter a key name and an expiry from 1 to 3650 whole days.');
  });

  it('accepts the boundaries: a 100 character name, 1 day and 3650 days', () => {
    expect(apiKeyInput('n'.repeat(100), '1').expiresInDays).toBe(1);
    expect(apiKeyInput('ci', '3650').expiresInDays).toBe(3650);
  });

  it('exposes the presets and the active-key cap the page offers', () => {
    expect(EXPIRY_PRESETS).toEqual([7, 30, 90, 365]);
    expect(MAX_ACTIVE_KEYS).toBe(10);
  });
});

describe('STATE_LABELS', () => {
  it('labels every key state', () => {
    expect(STATE_LABELS).toEqual({ ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' });
  });
});

describe('staticEndpoint', () => {
  it('returns an https URL ending in /mcp', () => {
    expect(staticEndpoint('https://harness.example.test/mcp')).toBe('https://harness.example.test/mcp');
  });

  it.each([
    ['plain http', 'http://harness.example.test/mcp'],
    ['no /mcp path', 'https://harness.example.test/'],
    ['trailing slash after /mcp', 'https://harness.example.test/mcp/'],
    ['a value that is not a URL', 'harness mcp'],
    ['null', null],
    ['undefined', undefined],
    ['empty string', '']
  ])('hides the endpoint for %s', (_label, value) => {
    expect(staticEndpoint(value)).toBeUndefined();
  });
});

describe('apiKeysApi.create', () => {
  it('posts the input as the body and hands the plaintext only to onKey', async () => {
    request.mockResolvedValueOnce({ data: { key: metadata, apiKey: FAKE_KEY } });
    const onKey = vi.fn();
    const result = await apiKeysApi.create({ name: 'CI runner', expiresInDays: 30 }, onKey);
    expect(request).toHaveBeenCalledWith('/api-keys', { method: 'POST', body: { name: 'CI runner', expiresInDays: 30 } });
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith(FAKE_KEY);
    expect(result).toBe(metadata);
  });

  it('keeps the plaintext out of the returned metadata', async () => {
    request.mockResolvedValueOnce({ data: { key: metadata, apiKey: FAKE_KEY } });
    const result = await apiKeysApi.create({ name: 'ci', expiresInDays: 7 }, () => undefined);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('refuses a response whose plaintext does not match the key shape, without calling onKey', async () => {
    request.mockResolvedValueOnce({ data: { key: metadata, apiKey: 'sk-test-not-real' } });
    const onKey = vi.fn();
    await expect(apiKeysApi.create({ name: 'ci', expiresInDays: 7 }, onKey)).rejects.toThrow('The new API key was unavailable. Create a replacement key.');
    expect(onKey).not.toHaveBeenCalled();
  });

  it('refuses a response with no plaintext at all', async () => {
    request.mockResolvedValueOnce({ data: { key: metadata, apiKey: undefined } });
    const onKey = vi.fn();
    await expect(apiKeysApi.create({ name: 'ci', expiresInDays: 7 }, onKey)).rejects.toBeInstanceOf(ClientValidationError);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('propagates a request failure and never calls onKey', async () => {
    request.mockRejectedValueOnce(new Error('network down'));
    const onKey = vi.fn();
    await expect(apiKeysApi.create({ name: 'ci', expiresInDays: 7 }, onKey)).rejects.toThrow('network down');
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe('apiKeysApi.revoke', () => {
  it('deletes by encoded id and fences on the key generation', async () => {
    request.mockResolvedValueOnce(undefined);
    await apiKeysApi.revoke({ ...metadata, id: 'key/with slash' });
    expect(request).toHaveBeenCalledWith('/api-keys/key%2Fwith%20slash', { method: 'DELETE', body: { expectedGeneration: 4 } });
  });

  it('uses the generation of the metadata it was given, not a later one', async () => {
    request.mockResolvedValueOnce(undefined);
    await apiKeysApi.revoke({ ...metadata, generation: 9 });
    expect(request).toHaveBeenCalledWith('/api-keys/key-1', { method: 'DELETE', body: { expectedGeneration: 9 } });
  });
});
