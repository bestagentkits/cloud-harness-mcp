import { createHash } from 'node:crypto';
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

export type ToolRecordEmitter = (record: Exclude<OutputRecord, { type: 'terminal' | 'session_message' }>) => void;
function boundedToolCallId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return value;
  return `call_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/** The part of Pi's tool context the broker reads: the session's recorded entries. */
type ToolSessionContext = { sessionManager?: { getEntries?: () => readonly unknown[] } } | undefined;

/**
 * The proxy request ID of a tool call ID at a use index. It must stay identical to
 * `effectRequestId` in apps/runner/src/agent-effect-reconciler.ts, which finds a call's effect
 * from the transcript alone.
 */
export function proxyRequestId(toolCallId: string, index: number): string {
  const base = boundedToolCallId(toolCallId);
  return index === 0 ? base : `call_${createHash('sha256').update(`${base}#${index}`).digest('hex').slice(0, 32)}`;
}

/** One tool call block of a transcript, with the index of its message and its request ID. */
export type TranscriptToolCall = { toolCallId: string; arguments: unknown; requestId: string; message: number };

/**
 * Every tool call block of a transcript, in order, with its request ID. A block's use index is the
 * number of earlier tool call blocks in the transcript with the same ID, whether or not Pi executed
 * them, so a provider that repeats or reuses IDs still gets one request ID per call, and a replay
 * of the same history derives the same IDs. It must stay identical to `transcriptToolCalls` in
 * apps/runner/src/agent-effect-reconciler.ts; both sides pin it with the same test vector.
 */
export function transcriptToolCalls(messages: readonly unknown[]): TranscriptToolCall[] {
  const seen = new Map<string, number>();
  const calls: TranscriptToolCall[] = [];
  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      if (typeof block !== 'object' || block === null) continue;
      const { type, id, arguments: args } = block as { type?: unknown; id?: unknown; arguments?: unknown };
      if (type !== 'toolCall' || typeof id !== 'string') continue;
      const use = seen.get(id) ?? 0;
      seen.set(id, use + 1);
      calls.push({ toolCallId: id, arguments: args, requestId: proxyRequestId(id, use), message: index });
    }
  }
  return calls;
}

/** The session's recorded messages, including replayed history, or undefined when Pi exposes none. */
function sessionMessages(ctx: ToolSessionContext): unknown[] | undefined {
  try {
    const entries = ctx?.sessionManager?.getEntries?.();
    if (!entries) return undefined;
    const messages: unknown[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { type, message } = entry as { type?: unknown; message?: unknown };
      if (type === 'message' && typeof message === 'object' && message !== null) messages.push(message);
    }
    return messages;
  } catch {
    return undefined;
  }
}

function sameArguments(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export class ToolResultLimitError extends Error {}


export class ProxyToolBroker {
  readonly #emit: ToolRecordEmitter;
  readonly #redactor: Redactor;
  readonly #maxResultBytes: number;
  readonly #pending = new Map<string, PendingToolCall>();
  readonly #cancelled = new Set<string>();
  /** Request IDs this run has already proxied, so a repeated tool call ID picks its next block. */
  readonly #issued = new Set<string>();
  /** Use counts for calls the session transcript does not show, which fall back to issue order. */
  readonly #fallbackUses = new Map<string, number>();

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
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        this.#execute(operation, toolCallId, params, signal, onUpdate, ctx as ToolSessionContext)
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
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ctx?: ToolSessionContext
  ): Promise<AgentToolResult<unknown>> {
    const input = BoundedJsonSchema.parse(params);
    const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
    if (signal?.aborted) {
      reject(new Error('tool call aborted'));
      return promise;
    }
    const requestId = this.#requestIdFor(toolCallId, params, ctx);
    if (this.#pending.has(requestId)) {
      reject(new Error('tool call is already in flight'));
      return promise;
    }
    this.#cancelled.delete(requestId);
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
      input
    });
    return promise;
  }

  /**
   * Derives the proxy request ID from the model's tool call ID, so the runner can recognize the
   * same call when it is delivered again, including by a continuation replaying this session. Pi
   * records the assistant message before it executes its tool calls, so the call is located in the
   * recorded transcript and gets the request ID `transcriptToolCalls` derives for its block. When
   * the latest assistant message repeats the ID, the block with the same arguments that this run has
   * not yet proxied is chosen, else the first one not yet proxied.
   */
  #requestIdFor(toolCallId: string, params: unknown, ctx: ToolSessionContext): string {
    const messages = sessionMessages(ctx);
    const calls = messages ? transcriptToolCalls(messages).filter((call) => call.toolCallId === toolCallId) : [];
    const latest = calls.at(-1)?.message;
    const candidates = calls.filter((call) => call.message === latest && !this.#issued.has(call.requestId));
    const chosen = candidates.find((call) => sameArguments(call.arguments, params)) ?? candidates[0];
    let requestId: string;
    if (chosen) {
      requestId = chosen.requestId;
    } else {
      // Without the call in the transcript, issue order is the only deterministic index left.
      const base = boundedToolCallId(toolCallId);
      const index = this.#fallbackUses.get(base) ?? 0;
      this.#fallbackUses.set(base, index + 1);
      requestId = proxyRequestId(toolCallId, index);
    }
    this.#issued.add(requestId);
    return requestId;
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
