import { describe, expect, it } from 'vitest';
import { assertProviderRequestUrl, assertPublicMetadataUrl, createLineSplitter, createProviderHttpClient, isUnsafeProviderAddress, redactSecret } from '../src/model-provider-http.js';

describe('model provider HTTP policy', () => {
  it('allows only registry hosts for registry providers', () => {
    expect(assertProviderRequestUrl('google', 'https://generativelanguage.googleapis.com/v1beta/openai/models').hostname)
      .toBe('generativelanguage.googleapis.com');
    expect(() => assertProviderRequestUrl('openai', 'https://evil.example.org/v1/models')).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('openai', 'http://api.openai.com/v1/models')).toThrow('HTTPS');
    expect(() => assertProviderRequestUrl('openai', 'https://user:pw@api.openai.com/v1/models')).toThrow('credential-free');
  });

  it('keeps each registry provider on its own hosts', () => {
    expect(assertProviderRequestUrl('openrouter', 'https://openrouter.ai/api/v1/key').hostname).toBe('openrouter.ai');
    expect(() => assertProviderRequestUrl('openai', 'https://api.anthropic.com/v1/models')).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('openai', 'https://openrouter.ai/api/v1/models')).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('anthropic', 'https://api.openai.com/v1/models')).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('google', 'https://api.deepseek.com/models')).toThrow('not allowed');
    expect(assertProviderRequestUrl('opencode-go', 'https://opencode.ai/inference/go/v1/models').hostname).toBe('opencode.ai');
    expect(assertProviderRequestUrl('opencode-go', 'https://opencode.ai/inference/go/openai/v1/chat/completions').hostname).toBe('opencode.ai');
    expect(() => assertProviderRequestUrl('opencode-go', 'https://api.openai.com/v1/chat/completions')).toThrow('not allowed');
    expect(() => assertProviderRequestUrl('opencode-go', 'https://evil.opencode.ai.example.org/inference/go/v1/models')).toThrow('not allowed');
  });

  it('allows only the public metadata hosts for credential-free metadata reads', () => {
    expect(assertPublicMetadataUrl('https://models.dev/api.json').hostname).toBe('models.dev');
    expect(() => assertPublicMetadataUrl('http://models.dev/api.json')).toThrow('HTTPS');
    expect(() => assertPublicMetadataUrl('https://user:pw@models.dev/api.json')).toThrow('credential-free');
    expect(() => assertPublicMetadataUrl('https://models.dev.example.org/api.json')).toThrow('not allowed');
    expect(() => assertPublicMetadataUrl('https://opencode.ai/inference/go/v1/models')).toThrow('not allowed');
    // A provider request, which may carry a credential, never reaches the metadata host.
    expect(() => assertProviderRequestUrl('opencode-go', 'https://models.dev/api.json')).toThrow('not allowed');
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

  it('refuses IPv4-compatible, SIIT and Teredo prefixes and malformed IPv6, matching the gateway', () => {
    for (const address of ['::', '::a00:1', '::808:808', '::ffff:0:a00:1', '::ffff:0:808:808', '2001:0:4136:e378::1', '0:0:0:0:0:ffff:7f00:1', '1:2:3:4:5:6:7:8:9']) {
      expect(isUnsafeProviderAddress(address)).toBe(true);
    }
    expect(isUnsafeProviderAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('refuses NAT64 and 6to4 prefixes that embed an IPv4 address', () => {
    for (const address of ['64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::a9fe:a9fe', '2002:a00:1::1', '2002:7f00:1::', '2002:808:808::1']) {
      expect(isUnsafeProviderAddress(address)).toBe(true);
    }
  });

  it('times out a slow name lookup within the request deadline', async () => {
    const client = createProviderHttpClient({
      lookup: () => new Promise((resolve) => setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 1_000))
    });
    const startedAt = Date.now();
    await expect(client.request({ url: 'https://api.openai.com/v1/models', method: 'GET', timeoutMs: 50, maxResponseBytes: 1024 }))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it('keeps a multibyte character split across chunks intact', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => { lines.push(line); });
    const bytes = Buffer.from('data: héllo 日本\r\nlast ✓', 'utf8');
    // Cut inside the three-byte "日" and inside the "✓".
    const cuts = [9, bytes.indexOf(Buffer.from('日')) + 1, bytes.length - 1];
    let start = 0;
    for (const cut of [...cuts, bytes.length]) {
      expect(splitter.push(bytes.subarray(start, cut))).toBe(true);
      start = cut;
    }
    splitter.end();
    expect(lines).toEqual(['data: héllo 日本', 'last ✓']);
  });

  it('stops splitting once the line consumer asks to stop', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => { lines.push(line); return line !== 'stop'; });
    expect(splitter.push(Buffer.from('a\nstop\nb\n'))).toBe(false);
    expect(lines).toEqual(['a', 'stop']);
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
