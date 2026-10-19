import { createHash } from 'node:crypto';
import type { Context, JsonValue } from '@earendil-works/chord';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionResult, type ToolRegistration } from '@earendil-works/pi-durable';
import {
  REPLAY_SAFE_OPERATIONS,
  type DurableOutputRecord,
  type DurableRedactor,
  type ProxyOperation,
  type ToolResultRecord
} from './protocol.js';

// The same parameter schemas the default runtime offers; a test keeps the two in step.
const PATH = Type.String({ minLength: 1, maxLength: 1_024, description: 'Workspace-relative path' });
const SHA256 = Type.Optional(Type.String({ minLength: 64, maxLength: 64 }));
export const PROXY_PARAMETERS: Record<ProxyOperation, TSchema> = {
  files_list: Type.Object({
    path: Type.Optional(PATH),
    cursor: Type.Optional(Type.String({ maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
  }, { additionalProperties: false }),
  files_read: Type.Object({
    path: PATH,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 262_144 }))
  }, { additionalProperties: false }),
  files_write: Type.Object({
    path: PATH,
    content: Type.String({ maxLength: 1_048_576 }),
    expectedSha256: SHA256
  }, { additionalProperties: false }),
  files_apply_patch: Type.Object({
    path: PATH,
    oldText: Type.String({ maxLength: 262_144 }),
    newText: Type.String({ maxLength: 262_144 }),
    expectedSha256: SHA256
  }, { additionalProperties: false }),
  files_delete: Type.Object({
    path: PATH,
    recursive: Type.Optional(Type.Boolean()),
    expectedSha256: SHA256
  }, { additionalProperties: false }),
  files_move: Type.Object({
    source: PATH,
    destination: PATH,
    overwrite: Type.Optional(Type.Boolean())
  }, { additionalProperties: false }),
  files_mkdir: Type.Object({
    path: PATH,
    recursive: Type.Optional(Type.Boolean())
  }, { additionalProperties: false }),
  grep_search: Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: 4_096 }),
    path: Type.Optional(PATH),
    glob: Type.Optional(Type.String({ maxLength: 512 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
  }, { additionalProperties: false }),
  symbols_search: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 256 }),
    path: Type.Optional(PATH),
    language: Type.Optional(Type.String({ maxLength: 40 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
  }, { additionalProperties: false }),
  symbols_references: Type.Object({
    symbol: Type.String({ minLength: 1, maxLength: 256 }),
    path: Type.Optional(PATH),
    glob: Type.Optional(Type.String({ maxLength: 512 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
  }, { additionalProperties: false })
};

type ToolRecord = Extract<DurableOutputRecord, { type: 'tool_request' | 'tool_cancel' }>;
type DurableToolResult = ToolExecutionResult;

interface PendingToolCall {
  output(text: string): void;
  resolve(result: DurableToolResult): void;
  reject(error: Error): void;
}

export class ToolResultLimitError extends Error {}

export function boundedToolCallId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return value;
  return `call_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/**
 * The run's request id for one durable tool task. The task id is assigned when the call is admitted
 * and survives a resume, so a replay-safe call that reruns asks the runner under the same id.
 */
export function durableToolRequestId(taskId: number): string {
  return `durable-task-${taskId}`;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Forwards every proxy tool call to the runner as a `tool_request` and resolves it from the
 * matching `tool_result`. Read-only operations are registered replay-safe; every operation that
 * can change the workspace is replay-unsafe, so the harness never reruns it after a crash.
 */
export class DurableToolBroker {
  readonly #emit: (record: ToolRecord) => void;
  readonly #redactor: DurableRedactor;
  readonly #maxResultBytes: number;
  readonly #pending = new Map<string, PendingToolCall>();
  readonly #cancelled = new Set<string>();

  constructor(emit: (record: ToolRecord) => void, redactor: DurableRedactor, maxResultBytes: number) {
    this.#emit = emit;
    this.#redactor = redactor;
    this.#maxResultBytes = maxResultBytes;
  }

  createTools(operations: readonly ProxyOperation[]): ToolRegistration[] {
    return operations.map((operation) => defineTool({
      name: operation,
      description: `Execute the bounded ${operation} operation in the validated workspace.`,
      parameters: PROXY_PARAMETERS[operation],
      replay: REPLAY_SAFE_OPERATIONS.has(operation) ? 'safe' : 'unsafe',
      execute: (args, api, context) => this.#execute(operation, args, api.taskId, api.callId, (text) => api.output(text), context)
    }) as ToolRegistration);
  }

  acceptResult(record: ToolResultRecord): void {
    const pending = this.#pending.get(record.requestId);
    if (!pending) {
      if (this.#cancelled.delete(record.requestId)) return;
      throw new Error('tool result references an unknown request');
    }
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > this.#maxResultBytes) {
      this.#settleError(record.requestId, new ToolResultLimitError('tool result exceeds job byte limit'));
      throw new ToolResultLimitError('tool result exceeds job byte limit');
    }
    const text = record.content.map((item) => item.text).join('\n');
    if (!record.final) {
      if (record.isError) this.#settleError(record.requestId, new Error(this.#redactor.text(text)));
      else pending.output(text);
      return;
    }
    this.#pending.delete(record.requestId);
    const content = record.content.map((item) => ({ type: 'text' as const, text: record.isError ? this.#redactor.text(item.text) : item.text }));
    const details = toJsonValue(record.details);
    pending.resolve({ output: content, isError: record.isError, ...(details === undefined ? {} : { details }) });
  }

  acceptCancel(requestId: string, reason?: string): void {
    this.#settleError(requestId, new Error(this.#redactor.text(reason ?? 'tool request cancelled', 1_024)));
  }

  cancelAll(reason: string): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#emit({ type: 'tool_cancel', requestId, reason: this.#redactor.text(reason, 1_024) });
      this.#settleError(requestId, new Error(reason));
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #execute(
    operation: ProxyOperation,
    args: unknown,
    taskId: number,
    callId: string,
    output: (text: string) => void,
    context: Context
  ): Promise<DurableToolResult> {
    const requestId = durableToolRequestId(taskId);
    const { promise, resolve, reject } = Promise.withResolvers<DurableToolResult>();
    const signal = context.abortSignal;
    if (signal?.aborted) {
      reject(new Error('tool call aborted'));
      return promise;
    }
    if (this.#pending.has(requestId)) {
      reject(new Error('tool request is already in flight'));
      return promise;
    }
    const abort = () => {
      if (!this.#pending.has(requestId)) return;
      this.#pending.delete(requestId);
      this.#rememberCancelled(requestId);
      try {
        this.#emit({ type: 'tool_cancel', requestId, reason: 'agent tool call aborted' });
      } finally {
        reject(new Error('tool call aborted'));
      }
    };
    const removeAbortListener = () => signal?.removeEventListener('abort', abort);
    this.#pending.set(requestId, {
      output,
      resolve: (result) => { removeAbortListener(); resolve(result); },
      reject: (error) => { removeAbortListener(); reject(error); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.#emit({ type: 'tool_request', requestId, toolCallId: boundedToolCallId(callId), operation, input: args });
    } catch (error) {
      this.#pending.delete(requestId);
      removeAbortListener();
      reject(error instanceof Error ? error : new Error('tool request could not be sent'));
    }
    return promise;
  }

  #settleError(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) {
      if (this.#cancelled.delete(requestId)) return;
      throw new Error('tool cancellation references an unknown request');
    }
    this.#pending.delete(requestId);
    this.#rememberCancelled(requestId);
    pending.reject(error);
  }

  #rememberCancelled(requestId: string): void {
    this.#cancelled.add(requestId);
    if (this.#cancelled.size <= 256) return;
    const oldest = this.#cancelled.values().next().value as string | undefined;
    if (oldest) this.#cancelled.delete(oldest);
  }
}
