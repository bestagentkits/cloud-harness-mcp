import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InputRecordQueue, JsonlWriter } from '../src/jsonl.js';
import { createStartRecord } from './helpers.js';

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

describe('bounded LF JSONL protocol', () => {
  it('parses records across arbitrary chunks without treating U+2028 or U+2029 as delimiters', () => {
    const queue = new InputRecordQueue();
    const encoded = Buffer.from(`${JSON.stringify(createStartRecord({ prompt: 'left\u2028middle\u2029right' }))}\n`);
    queue.feed(encoded.subarray(0, 7));
    queue.feed(encoded.subarray(7, encoded.length - 2));
    expect(queue.size).toBe(0);
    queue.feed(encoded.subarray(encoded.length - 2));
    expect(queue.shift()).toMatchObject({ type: 'start', prompt: 'left\u2028middle\u2029right' });
  });

  it('rejects invalid UTF-8, invalid JSON, CRLF, and unterminated input', () => {
    expect(() => new InputRecordQueue().feed(Buffer.from([0xff, 0x0a]))).toThrow('valid UTF-8');
    expect(() => new InputRecordQueue().feed(Buffer.from('{nope}\n'))).toThrow('valid JSON');
    expect(() => new InputRecordQueue().feed(Buffer.from('{}\r\n'))).toThrow('LF delimiters');
    const queue = new InputRecordQueue();
    queue.feed(Buffer.from('{}'));
    expect(() => queue.end()).toThrow('unterminated');
  });

  it('rejects oversized records and record queue overflow', () => {
    const oversized = new InputRecordQueue({ maxRecordBytes: 32 });
    expect(() => oversized.feed(Buffer.from(`${'x'.repeat(33)}\n`))).toThrow('byte limit');

    const queue = new InputRecordQueue({ maxQueuedRecords: 1 });
    const record = `${JSON.stringify(createStartRecord())}\n`;
    expect(() => queue.feed(Buffer.from(record + record))).toThrow('queue overflow');
  });

  it('rejects forbidden operations and caller-supplied gateway URLs', () => {
    const unsafeOperation = { ...createStartRecord(), tools: ['exec_run'] };
    expect(() => new InputRecordQueue().feed(Buffer.from(`${JSON.stringify(unsafeOperation)}\n`))).toThrow('schema');

    const start = createStartRecord();
    const unsafeGateway = { ...start, gateway: { ...start.gateway, baseUrl: 'https://attacker.example/v1' } };
    expect(() => new InputRecordQueue().feed(Buffer.from(`${JSON.stringify(unsafeGateway)}\n`))).toThrow('schema');
  });

  it('rejects duplicate terminal records, records after terminal, and writes after close', async () => {
    const stream = new PassThrough();
    const writer = new JsonlWriter(stream);
    await writer.write({ type: 'terminal', state: 'SUCCEEDED', usage: ZERO_USAGE });
    expect(() => writer.write({ type: 'terminal', state: 'SUCCEEDED', usage: ZERO_USAGE })).toThrow('duplicate terminal');
    expect(() => writer.write({ type: 'usage', sequence: 1, usage: ZERO_USAGE })).toThrow('after terminal');
    await writer.close();
    expect(() => writer.write({ type: 'usage', sequence: 2, usage: ZERO_USAGE })).toThrow('closed');
  });
});
