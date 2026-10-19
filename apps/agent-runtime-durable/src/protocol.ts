/**
 * Pi-free view of the agent stdio protocol used by the durable runtime. The wire schemas that
 * validate these records live in apps/agent-runtime/src/protocol-schemas.ts (worker side) and
 * apps/runner/src/agent-protocol.ts (runner side); the lists below must stay aligned with them.
 */

export const PROXY_OPERATIONS = [
  'files_list',
  'files_read',
  'files_write',
  'files_apply_patch',
  'files_delete',
  'files_move',
  'files_mkdir',
  'grep_search',
  'symbols_search',
  'symbols_references'
] as const;
export type ProxyOperation = typeof PROXY_OPERATIONS[number];

/**
 * Read-only operations: re-running one after a crash cannot change the workspace, so the durable
 * runtime registers them as replay-safe. Every other operation is replay-unsafe.
 */
export const REPLAY_SAFE_OPERATIONS: ReadonlySet<ProxyOperation> = new Set<ProxyOperation>([
  'files_list',
  'files_read',
  'grep_search',
  'symbols_search',
  'symbols_references'
]);

/** The Storage methods carried over the storage RPC; anything else is refused by the runner. */
export const STORAGE_METHODS = [
  'commit',
  'mintId',
  'conversation',
  'scanConversations',
  'entry',
  'findLatestHeadMarker',
  'scanEntries',
  'task',
  'scanTasks',
  'submission',
  'scanSubmissions',
  'submissionByRequest',
  'findDocument',
  'document',
  'scanDocuments',
  'close'
] as const;
export type StorageMethod = typeof STORAGE_METHODS[number];

/** Error classes a storage response may carry. `retryable` errors are retried by the client. */
export const STORAGE_ERROR_CODES = ['request', 'closed', 'fenced', 'limit', 'rate_limited', 'unavailable', 'failed'] as const;
export type StorageErrorCode = typeof STORAGE_ERROR_CODES[number];

export interface StorageRequestRecord {
  type: 'storage_request';
  id: string;
  method: StorageMethod;
  args: unknown[];
}

export type StorageResponseRecord = {
  type: 'storage_response';
  id: string;
  ok: true;
  result?: unknown;
} | {
  type: 'storage_response';
  id: string;
  ok: false;
  error: { code: StorageErrorCode; message: string; retryable: boolean };
};

export type TerminalState = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LIMIT_EXCEEDED' | 'INTERRUPTED';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface DurableStartRecord {
  type: 'start';
  requestId: string;
  agentId: string;
  prompt: string;
  tools: readonly ProxyOperation[];
  gateway: { profile: string; lease: string };
  model: {
    id: string;
    name: string;
    api: 'openai-completions' | 'openai-responses';
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  limits: {
    deadlineMs: number;
    maxEvents: number;
    maxOutputBytes: number;
    maxEventBytes: number;
    maxToolResultBytes: number;
  };
  runtime?: 'pi-coding' | 'pi-durable' | undefined;
  session?: unknown;
}

export interface ToolResultRecord {
  type: 'tool_result';
  requestId: string;
  final: boolean;
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

export type DurableInputRecord =
  | ToolResultRecord
  | { type: 'tool_cancel'; requestId: string; reason?: string | undefined }
  | { type: 'message'; requestId: string; behavior: 'steer' | 'followUp'; text: string }
  | { type: 'cancel'; requestId: string; reason?: string | undefined }
  | StorageResponseRecord
  | { type: 'start' };

export type SafeEvent =
  | { kind: 'lifecycle'; phase: 'started' | 'turn_started' | 'turn_ended' | 'settled' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool'; phase: 'started' | 'updated' | 'ended'; toolCallId: string; name: ProxyOperation; isError?: boolean; text?: string }
  | { kind: 'queue'; steering: number; followUp: number }
  | { kind: 'notice'; message: string };

/** Output records that count against the caller's event and byte budget. */
export type DurableOutputRecord =
  | { type: 'event'; sequence: number; event: SafeEvent }
  | { type: 'tool_request'; requestId: string; toolCallId: string; operation: ProxyOperation; input: unknown }
  | { type: 'tool_cancel'; requestId: string; reason?: string }
  | { type: 'usage'; sequence: number; usage: Usage };

export interface DurableRedactor {
  addSecret(secret: string): void;
  text(value: unknown, maxBytes?: number): string;
  value(value: unknown, maxBytes?: number): unknown;
  error(error: unknown): string;
}

/** What the agent-runtime entry point hands the durable runtime: bounded output, storage transport and redaction. */
export interface DurableWorkerIo {
  readonly gatewayBaseUrl: string;
  readonly redactor: DurableRedactor;
  configureOutput(limits: { maxEvents: number; maxOutputBytes: number; maxEventBytes: number }): void;
  /** Writes a budgeted record; throws synchronously when a caller limit is exceeded. */
  emit(record: DurableOutputRecord): Promise<void>;
  /** Whether an error thrown by `emit` means the caller's output budget is spent. */
  isOutputLimitError(error: unknown): boolean;
  /** Writes a storage RPC request; runner state traffic, never counted against the caller's budget. */
  sendStorage(record: StorageRequestRecord): Promise<void>;
  terminal(state: TerminalState, usage: Usage, error?: string): Promise<void>;
}

/** The running durable worker, with the same surface the entry point uses for the default worker. */
export interface DurableWorker {
  receive(record: DurableInputRecord): void;
  interrupt(error: unknown): void;
  readonly completion: Promise<void>;
}

export const ZERO_USAGE: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
