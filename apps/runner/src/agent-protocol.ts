import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { AgentProxyOperationSchema, HarnessError } from '@cloud-harness/contracts';

// Wire limits must remain aligned with apps/agent-runtime/src/protocol-schemas.ts.
export const MAX_PROTOCOL_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_PROTOCOL_QUEUE_BYTES = 16 * 1024 * 1024;
export const MAX_TOOL_RESULT_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_RESULT_RECORD_BYTES = 4 * 1024 * 1024;

const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const boundedJson = z.unknown().refine((value) => {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_PROTOCOL_RECORD_BYTES;
  } catch {
    return false;
  }
}, 'protocol JSON exceeds the record limit');
const usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  cost: z.number().finite().nonnegative()
}).strict();

export const AgentOutputRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), sequence: z.number().int().positive(), event: boundedJson }).strict(),
  z.object({
    type: z.literal('tool_request'), requestId, toolCallId: requestId,
    operation: AgentProxyOperationSchema, input: boundedJson
  }).strict(),
  z.object({ type: z.literal('tool_cancel'), requestId, reason: z.string().max(1_024).optional() }).strict(),
  z.object({ type: z.literal('usage'), sequence: z.number().int().positive(), usage }).strict(),
  z.object({
    type: z.literal('terminal'),
    state: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED']),
    usage,
    error: z.string().max(4_096).optional()
  }).strict()
]);

export type AgentOutputRecord = z.infer<typeof AgentOutputRecordSchema>;
export type AgentStartRecord = {
  type: 'start';
  requestId: string;
  agentId: string;
  prompt: string;
  tools: string[];
  gateway: { profile: string; lease: string };
  model: {
    id: string;
    name: string;
    api: 'openai-completions';
    reasoning: false;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  limits: { deadlineMs: number; maxEvents: number; maxOutputBytes: number; maxEventBytes: number; maxToolResultBytes: number };
};
export type AgentInputRecord = AgentStartRecord | {
  type: 'message'; requestId: string; behavior: 'steer' | 'followUp'; text: string;
} | { type: 'cancel'; requestId: string; reason?: string } | {
  type: 'tool_result'; requestId: string; final: true; isError: boolean;
  content: Array<{ type: 'text'; text: string }>; details?: unknown;
} | { type: 'tool_cancel'; requestId: string; reason?: string };

export class AgentProtocolChannel {
  private pending = Buffer.alloc(0);
  private writeChain = Promise.resolve();
  private readChain = Promise.resolve();
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
    stderr: Readable,
    private readonly onRecord: (record: AgentOutputRecord) => Promise<void>,
    private readonly onStderr: (content: string) => Promise<void>,
    private readonly onError: (error: Error) => void
  ) {
    output.on('data', (chunk: Buffer) => this.feed(chunk));
    output.once('end', () => {
      if (this.pending.byteLength !== 0) this.fail(new Error('agent protocol ended with a partial record'));
    });
    output.once('error', (error) => this.fail(error));
    stderr.on('data', (chunk: Buffer) => {
      const text = chunk.subarray(0, 16_384).toString('utf8');
      if (text) this.readChain = this.readChain.then(() => this.onStderr(text)).catch((error: unknown) => this.fail(asError(error)));
    });
    stderr.once('error', (error) => this.fail(error));
  }

  send(record: AgentInputRecord): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessError('CONFLICT', 'agent protocol channel is closed', 409, false));
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
    if (encoded.byteLength > MAX_PROTOCOL_RECORD_BYTES) return Promise.reject(new HarnessError('LIMIT_EXCEEDED', 'agent protocol input exceeds the record limit', 413, false));
    this.writeChain = this.writeChain.then(async () => {
      if (!this.input.write(encoded)) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            this.input.off('drain', onDrain);
            this.input.off('error', onError);
          };
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (error: Error) => { cleanup(); reject(error); };
          const timeout = setTimeout(() => {
            cleanup();
            reject(new HarnessError('TIMEOUT', 'agent protocol write timed out', 504, true));
          }, 5_000);
          timeout.unref();
          this.input.once('drain', onDrain);
          this.input.once('error', onError);
        });
      }
    });
    return this.writeChain;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([this.writeChain, this.readChain]);
  }
  async drainWrites(): Promise<void> {
    await Promise.allSettled([this.writeChain]);
  }

  closeInput(): void {
    this.closed = true;
    this.input.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.byteLength > MAX_PROTOCOL_QUEUE_BYTES) {
      this.fail(new Error('agent protocol receive queue exceeded its bound'));
      return;
    }
    for (;;) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) {
        if (this.pending.byteLength > MAX_PROTOCOL_RECORD_BYTES) this.fail(new Error('agent protocol record exceeds its bound'));
        return;
      }
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.byteLength === 0 || line.byteLength > MAX_PROTOCOL_RECORD_BYTES) {
        this.fail(new Error('agent protocol record is invalid'));
        return;
      }
      try {
        const record = AgentOutputRecordSchema.parse(JSON.parse(line.toString('utf8')));
        this.readChain = this.readChain.then(() => this.onRecord(record)).catch((error: unknown) => this.fail(asError(error)));
      } catch (error) {
        this.fail(asError(error));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.onError(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
