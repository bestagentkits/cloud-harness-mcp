import { describe, expect, it } from 'vitest';
import { assertProviderRequestUrl, createProviderHttpClient, isUnsafeProviderAddress, redactSecret } from '../src/model-provider-http.js';

describe('model provider HTTP policy', () => {
  it('allows only registry hosts for registry providers', () => {
    expect(assertProviderRequestUrl('google', 'https://generativelanguage.googleapis.com/v1beta/openai/models').hostname)
      .toBe('generativelanguage.googleapis.com');
    expect(() => assertProviderRequestUrl('openai', 'https://evil.example.org/v1/models')).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('openai', 'http://api.openai.com/v1/models')).toThrow('HTTPS');
    expect(() => assertProviderRequestUrl('openai', 'https://user:pw@api.openai.com/v1/models')).toThrow('credential-free');
  });

  it('limits a custom provider to its own public upstream host', () => {
    const upstream = 'https://llm.example.org/v1/chat/completions';
    expect(assertProviderRequestUrl('custom', 'https://llm.example.org/v1/models', upstream).pathname).toBe('/v1/models');
    expect(() => assertProviderRequestUrl('custom', 'https://other.example.org/v1/models', upstream)).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('custom', 'https://127.0.0.1/v1/models', 'https://127.0.0.1/v1/chat/completions')).toThrow('private');
    expect(() => assertProviderRequestUrl('custom', 'https://metadata.internal/v1', 'https://metadata.internal/v1')).toThrow('private');
  });

  it('classifies private, reserved and mapped addresses as unsafe', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:a00:1']) {
      expect(isUnsafeProviderAddress(address)).toBe(true);
    }
    expect(isUnsafeProviderAddress('8.8.8.8')).toBe(false);
    expect(isUnsafeProviderAddress('2606:4700::1111')).toBe(false);
  });

  it('refuses a hostname that resolves only to private addresses before connecting', async () => {
    const client = createProviderHttpClient({ lookup: async () => [{ address: '10.1.2.3', family: 4 }] });
    await expect(client.request({ url: 'https://api.openai.com/v1/models', method: 'GET', timeoutMs: 1000, maxResponseBytes: 1024 }))
      .rejects.toThrow('private or reserved');
  });

  it('redacts a credential from provider text', () => {
    expect(redactSecret('bad key sk-abcdef123 rejected', 'sk-abcdef123')).toBe('bad key [redacted] rejected');
  });
});
