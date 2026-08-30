import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/redaction.js';

describe('runtime output redaction', () => {
  it('removes registered leases, bearer values, sensitive keys, and stack traces before bounding output', () => {
    const redactor = createRedactor(['one-use-lease-value']);
    const value = redactor.value({
      authorization: 'Bearer one-use-lease-value',
      nested: { apiKey: 'sk-sensitive-value', message: 'lease=one-use-lease-value' }
    }, 512);
    const encoded = JSON.stringify(value);
    expect(encoded).not.toContain('one-use-lease-value');
    expect(encoded).not.toContain('sk-sensitive-value');
    expect(encoded).toContain('[REDACTED]');

    const error = new Error(`provider failed with Bearer one-use-lease-value\n${'x'.repeat(10_000)}`);
    error.stack = 'private stack path';
    const safe = redactor.error(error);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(4_096);
    expect(safe).not.toContain('private stack path');
    expect(safe).not.toContain('one-use-lease-value');
  });
});
