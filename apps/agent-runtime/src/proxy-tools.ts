import { createHash, randomUUID } from 'node:crypto';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { defineTool, type AgentToolResult, type AgentToolUpdateCallback, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { BoundedJsonSchema, type AgentProxyOperation, type OutputRecord, type ToolResultRecord } from './protocol-schemas.js';
import type { Redactor } from './redaction.js';
const PATH = Type.String({ minLength: 1, maxLength: 1_024, description: 'Workspace-relative path' });
const SHA256 = Type.Optional(Type.String({ minLength: 64, maxLength: 64 }));
const PROXY_PARAMETERS: Record<AgentProxyOperation, TSchema> = {
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


interface PendingToolCall {
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  resolve(result: AgentToolResult<unknown>): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

export type ToolRecordEmitter = (record: Exclude<OutputRecord, { type: 'terminal' }>) => void;
function boundedToolCallId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return value;
  return `call_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export class ToolResultLimitError extends Error {}


export class ProxyToolBroker {
  readonly #emit: ToolRecordEmitter;
  readonly #redactor: Redactor;
  readonly #maxResultBytes: number;
  readonly #pending = new Map<string, PendingToolCall>();
  readonly #cancelled = new Set<string>();

  constructor(emit: ToolRecordEmitter, redactor: Redactor, maxResultBytes: number) {
    this.#emit = emit;
    this.#redactor = redactor;
    this.#maxResultBytes = maxResultBytes;
  }

  createDefinitions(operations: readonly AgentProxyOperation[]): ToolDefinition[] {
    return operations.map((operation) => defineTool({
      name: operation,
      label: operation,
      description: `Execute the bounded ${operation} operation in the validated workspace.`,
      parameters: PROXY_PARAMETERS[operation],
      execute: (toolCallId, params, signal, onUpdate) =>
        this.#execute(operation, toolCallId, params, signal, onUpdate)
    }));
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
    const result: AgentToolResult<unknown> = {
      content: record.content.map((item) => ({ type: 'text' as const, text: item.text })),
      details: record.details
    };
    if (!record.final) {
      if (record.isError) this.#settleError(record.requestId, new Error(this.#redactor.text(record.content.map((item) => item.text).join('\\n'))));
      else pending.onUpdate?.(result);
      return;
    }
    this.#pending.delete(record.requestId);
    pending.removeAbortListener();
    if (record.isError) pending.reject(new Error(this.#redactor.text(record.content.map((item) => item.text).join('\\n'))));
    else pending.resolve(result);
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
    operation: AgentProxyOperation,
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined
  ): Promise<AgentToolResult<unknown>> {
    const input = BoundedJsonSchema.parse(params);
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
    if (signal?.aborted) {
      reject(new Error('tool call aborted'));
      return promise;
    }
    const abort = () => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      this.#rememberCancelled(requestId);
      pending.removeAbortListener();
      this.#emit({ type: 'tool_cancel', requestId, reason: 'agent tool call aborted' });
      reject(new Error('tool call aborted'));
    };
    const removeAbortListener = () => signal?.removeEventListener('abort', abort);
    this.#pending.set(requestId, { onUpdate, resolve, reject, removeAbortListener });
    signal?.addEventListener('abort', abort, { once: true });

    this.#emit({
      type: 'tool_request',
      requestId,
      toolCallId: boundedToolCallId(toolCallId),
      operation,
      input: this.#redactor.value(input, 128 * 1024)
    });
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
    pending.removeAbortListener();
    pending.reject(error);
  }

  #rememberCancelled(requestId: string): void {
    this.#cancelled.add(requestId);
    if (this.#cancelled.size <= 256) return;
    const oldest = this.#cancelled.values().next().value as string | undefined;
    if (oldest) this.#cancelled.delete(oldest);
  }
}
