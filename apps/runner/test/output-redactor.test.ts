import { describe, expect, it } from 'vitest';
import { SecretSnapshotRedactor } from '../src/output-redactor.js';

describe('SecretSnapshotRedactor', () => {
  it('passes through text unmodified when no secrets are configured', () => {
    const redactor = new SecretSnapshotRedactor({});
    expect(redactor.active).toBe(false);
    const stream = redactor.createStream();
    const chunk = Buffer.from('hello world', 'utf8');
    expect(stream.processChunk(chunk)).toEqual(chunk);
    expect(stream.flush()).toEqual(Buffer.alloc(0));
  });

  it('redacts secret values in a single chunk', () => {
    const redactor = new SecretSnapshotRedactor({
      STRIPE_KEY: 'sk_test_123456789',
      DB_PASS: 'super_secret_password'
    });

    const stream = redactor.createStream();
    const chunk = Buffer.from('Connecting with super_secret_password and sk_test_123456789 now.', 'utf8');
    const result = stream.processChunk(chunk);
    const final = Buffer.concat([result, stream.flush()]);
    expect(final.toString('utf8')).toBe('Connecting with [REDACTED_SECRET: DB_PASS] and [REDACTED_SECRET: STRIPE_KEY] now.');
  });

  it('redacts secret values split across chunk boundaries', () => {
    const redactor = new SecretSnapshotRedactor({
      API_TOKEN: 'secret_token_123'
    });

    const stream = redactor.createStream();
    const chunk1 = Buffer.from('Prefix: secret_', 'utf8');
    const chunk2 = Buffer.from('token_123 :Suffix', 'utf8');

    const out1 = stream.processChunk(chunk1);
    const out2 = stream.processChunk(chunk2);
    const out3 = stream.flush();

    const fullOutput = Buffer.concat([out1, out2, out3]).toString('utf8');
    expect(fullOutput).toBe('Prefix: [REDACTED_SECRET: API_TOKEN] :Suffix');
  });

  it('maintains independent stream states for stdout and stderr without channel crosstalk', () => {
    const redactor = new SecretSnapshotRedactor({
      KEY_A: 'token_alpha_123',
      KEY_B: 'token_beta_456'
    });

    const stdoutStream = redactor.createStream();
    const stderrStream = redactor.createStream();

    // Partial key in stdout, followed by non-matching in stderr
    const out1 = stdoutStream.processChunk(Buffer.from('stdout: token_alpha_', 'utf8'));
    const err1 = stderrStream.processChunk(Buffer.from('stderr: random message', 'utf8'));
    const out2 = stdoutStream.processChunk(Buffer.from('123 done', 'utf8'));

    const fullStdout = Buffer.concat([out1, out2, stdoutStream.flush()]).toString('utf8');
    const fullStderr = Buffer.concat([err1, stderrStream.flush()]).toString('utf8');

    expect(fullStdout).toBe('stdout: [REDACTED_SECRET: KEY_A] done');
    expect(fullStderr).toBe('stderr: random message');
  });

  it('prefers longest match for overlapping secrets', () => {
    const redactor = new SecretSnapshotRedactor({
      SHORT_KEY: 'token_prefix',
      LONG_KEY: 'token_prefix_extended_123'
    });

    const stream = redactor.createStream();
    const chunk = Buffer.from('Using token_prefix_extended_123 for auth.', 'utf8');
    const out = Buffer.concat([stream.processChunk(chunk), stream.flush()]).toString('utf8');
    expect(out).toBe('Using [REDACTED_SECRET: LONG_KEY] for auth.');
  });

  it('handles trailing partial match that is not a full secret upon flush', () => {
    const redactor = new SecretSnapshotRedactor({
      SECRET_KEY: 'SECRET_XYZ'
    });

    const stream = redactor.createStream();
    const chunk = Buffer.from('Almost SECRET_ABC', 'utf8');
    const out1 = stream.processChunk(chunk);
    const out2 = stream.flush();

    expect(Buffer.concat([out1, out2]).toString('utf8')).toBe('Almost SECRET_ABC');
  });

  it('sanitizes strings and structured objects recursively', () => {
    const redactor = new SecretSnapshotRedactor({
      TOKEN: 'my_auth_token_999'
    });

    expect(redactor.sanitizeString('Bearer my_auth_token_999')).toBe('Bearer [REDACTED_SECRET: TOKEN]');

    const payload = {
      message: 'Failed with my_auth_token_999',
      data: {
        command: 'curl -H "Authorization: my_auth_token_999"',
        outputs: ['log 1', 'error with my_auth_token_999']
      }
    };

    expect(redactor.sanitizeObject(payload)).toEqual({
      message: 'Failed with [REDACTED_SECRET: TOKEN]',
      data: {
        command: 'curl -H "Authorization: [REDACTED_SECRET: TOKEN]"',
        outputs: ['log 1', 'error with [REDACTED_SECRET: TOKEN]']
      }
    });
  });
});
