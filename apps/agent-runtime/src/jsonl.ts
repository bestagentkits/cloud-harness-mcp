import { once } from 'node:events';
import type { Writable } from 'node:stream';
import type { z } from 'zod';
import {
  InputRecordSchema,
  MAX_PROTOCOL_QUEUE_BYTES,
  MAX_PROTOCOL_RECORD_BYTES,
  MAX_QUEUED_RECORDS,
  OutputRecordSchema,
  type InputRecord,
  type OutputRecord
} from './protocol-schemas.js';

export class ProtocolError extends Error {}

interface QueuedRecord<T> {
  record: T;
  bytes: number;
}
interface RecordQueueOptions {
  maxRecordBytes?: number;
  maxQueuedRecords?: number;
  maxQueuedBytes?: number;
}


export class JsonlRecordQueue<T> {
  readonly #schema: z.ZodType<T>;
  readonly #maxRecordBytes: number;
  readonly #maxQueuedRecords: number;
  readonly #maxQueuedBytes: number;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #records: Array<QueuedRecord<T>> = [];
  #queuedBytes = 0;
  #ended = false;

  constructor(schema: z.ZodType<T>, options: RecordQueueOptions = {}) {
    this.#schema = schema;
    this.#maxRecordBytes = options.maxRecordBytes ?? MAX_PROTOCOL_RECORD_BYTES;
    this.#maxQueuedRecords = options.maxQueuedRecords ?? MAX_QUEUED_RECORDS;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? MAX_PROTOCOL_QUEUE_BYTES;
  }

  feed(chunk: Buffer): void {
    if (this.#ended) throw new ProtocolError('protocol input is closed');
    if (!Buffer.isBuffer(chunk)) throw new ProtocolError('protocol chunks must be buffers');
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > this.#maxQueuedBytes + this.#maxRecordBytes) {
      throw new ProtocolError('protocol input buffer overflow');
    }

    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > this.#maxRecordBytes) throw new ProtocolError('protocol record exceeds byte limit');
        return;
      }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#parseLine(line);
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#buffer.length !== 0) throw new ProtocolError('unterminated protocol record');
  }

  shift(): T | undefined {
    const queued = this.#records.shift();
    if (!queued) return undefined;
    this.#queuedBytes -= queued.bytes;
    return queued.record;
  }

  get size(): number {
    return this.#records.length;
  }

  #parseLine(line: Buffer): void {
    if (line.length === 0) throw new ProtocolError('empty protocol record');
    if (line.length > this.#maxRecordBytes) throw new ProtocolError('protocol record exceeds byte limit');
    if (line.includes(0x0d)) throw new ProtocolError('protocol records must use LF delimiters');
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
    } catch {
      throw new ProtocolError('protocol record is not valid UTF-8');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new ProtocolError('protocol record is not valid JSON');
    }
    const result = this.#schema.safeParse(parsed);
    if (!result.success) throw new ProtocolError('protocol record does not match schema');
    const bytes = line.length + 1;
    if (this.#records.length >= this.#maxQueuedRecords || this.#queuedBytes + bytes > this.#maxQueuedBytes) {
      throw new ProtocolError('protocol record queue overflow');
    }
    this.#records.push({ record: result.data, bytes });
    this.#queuedBytes += bytes;
  }
}

export class InputRecordQueue extends JsonlRecordQueue<InputRecord> {
  constructor(options: RecordQueueOptions = {}) {
    super(InputRecordSchema, options);
  }
}

export class JsonlWriter {
  readonly #output: Writable;
  readonly #maxRecordBytes: number;
  #closed = false;
  #terminalWritten = false;
  #pending: Promise<void> = Promise.resolve();

  constructor(output: Writable, maxRecordBytes = MAX_PROTOCOL_RECORD_BYTES) {
    this.#output = output;
    this.#maxRecordBytes = maxRecordBytes;
  }

  write(record: OutputRecord): Promise<void> {
    if (this.#closed) throw new ProtocolError('protocol output is closed');
    if (this.#terminalWritten) {
      if (record.type === 'terminal') throw new ProtocolError('duplicate terminal record');
      throw new ProtocolError('protocol output received after terminal record');
    }
    const parsed = OutputRecordSchema.parse(record);
    if (parsed.type === 'terminal') this.#terminalWritten = true;
    const encoded = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
    if (encoded.length > this.#maxRecordBytes) throw new ProtocolError('protocol output record exceeds byte limit');
    this.#pending = this.#pending.then(async () => {
      if (!this.#output.write(encoded)) await once(this.#output, 'drain');
    });
    return this.#pending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
  }

  get terminalWritten(): boolean {
    return this.#terminalWritten;
  }
}
