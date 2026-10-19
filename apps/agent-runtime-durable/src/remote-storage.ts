import type { Context, JsonValue } from '@earendil-works/chord';
import {
  StorageRequestError,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord
} from '@earendil-works/pi-durable';
import type { StorageErrorCode, StorageMethod, StorageRequestRecord, StorageResponseRecord } from './protocol.js';

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

export interface RemoteStorageOptions {
  /** How long one attempt waits for its response before it is sent again under the same id. */
  readonly requestTimeoutMs?: number;
  /** Attempts per call, the first included, before a transport failure becomes fatal. */
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/** A storage error reported by the runner; the code says why, the message is the store's own. */
export class StorageRpcError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageRpcError';
    this.code = code;
  }
}

class TransportError extends Error {}

interface PendingCall {
  resolve(response: StorageResponseRecord): void;
  reject(error: Error): void;
}

const DEFAULTS = { requestTimeoutMs: 30_000, maxAttempts: 5, baseBackoffMs: 25, maxBackoffMs: 2_000 } as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function cancellation(context: Context): Error {
  const reason: unknown = context.abortSignal?.reason;
  return reason instanceof Error ? reason : new Error('storage read cancelled');
}

/**
 * The pi-durable `Storage` contract carried as bounded RPC records to the runner, which owns the
 * database. Transport failures (a failed write, a missing response, a retryable refusal) are
 * retried here under the same request id, because the Storage contract makes any thrown error
 * fatal to the session; the runner answers a repeated id with its first result. Only reads
 * honour context cancellation; `commit` and `mintId` always run to completion.
 */
export class RemoteStorage implements Storage {
  readonly #send: (record: StorageRequestRecord) => Promise<void>;
  readonly #options: Required<RemoteStorageOptions>;
  readonly #pending = new Map<string, PendingCall>();
  #nextId = 0;
  #closed = false;
  #failure: Error | undefined;
  #lastError: StorageRpcError | undefined;

  constructor(send: (record: StorageRequestRecord) => Promise<void>, options: RemoteStorageOptions = {}) {
    this.#send = send;
    this.#options = { ...DEFAULTS, ...options };
    if (!(this.#options.maxAttempts >= 1) || !(this.#options.requestTimeoutMs > 0)) {
      throw new Error('remote storage needs at least one attempt and a positive timeout');
    }
  }

  /** Delivers a runner response; a response nobody waits for (late, duplicate or cancelled) is dropped. */
  accept(response: StorageResponseRecord): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    pending.resolve(response);
  }

  /** The channel to the runner is gone: every pending and later call fails. */
  shutdown(error: Error): void {
    this.#failure ??= error;
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** The last runner refusal that was fatal to the session, so the worker can say why its session closed. */
  get lastError(): StorageRpcError | undefined {
    return this.#lastError;
  }

  async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    void _context;
    return await this.#call('commit', [writes]) as Seq;
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    return await this.#call('mintId', []) as I;
  }

  async conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
    return await this.#call('conversation', [id], context) as ConversationRecord | undefined;
  }

  async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<ConversationRecord, Cursor>> {
    return await this.#call('scanConversations', [query, limit, cursor], context) as Page<ConversationRecord, Cursor>;
  }

  entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
  async entry(first: ConversationId | EntryId, second: EntryId | Context, third?: Context): Promise<StoredEntry | undefined> {
    if (typeof second === 'number') {
      if (!third) throw new Error('entry lookup by conversation needs a context');
      return await this.#call('entry', [first, second], third) as StoredEntry | undefined;
    }
    return await this.#call('entry', [first], second) as StoredEntry | undefined;
  }

  async findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return await this.#call('findLatestHeadMarker', [conversationId, atOrBeforeEntryId], context) as (EntryRecord & { readonly head: EntryId }) | undefined;
  }

  async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<EntryRecord, Cursor>> {
    return await this.#call('scanEntries', [query, limit, cursor], context) as Page<EntryRecord, Cursor>;
  }

  async task(id: TaskId, context: Context): Promise<StoredTask | undefined> {
    return await this.#call('task', [id], context) as StoredTask | undefined;
  }

  async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<StoredTask, Cursor>> {
    return await this.#call('scanTasks', [query, limit, cursor], context) as Page<StoredTask, Cursor>;
  }

  async submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
    return await this.#call('submission', [id], context) as SubmissionRecord | undefined;
  }

  async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<SubmissionRecord, Cursor>> {
    return await this.#call('scanSubmissions', [query, limit, cursor], context) as Page<SubmissionRecord, Cursor>;
  }

  async submissionByRequest(conversationId: ConversationId, requestId: string, context: Context): Promise<SubmissionRecord | undefined> {
    return await this.#call('submissionByRequest', [conversationId, requestId], context) as SubmissionRecord | undefined;
  }

  async findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
    return await this.#call('findDocument', [address, at], context) as DocumentRecord | undefined;
  }

  async document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
    return await this.#call('document', [id, at], context) as StoredDocument | undefined;
  }

  async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<DocumentRecord, Cursor>> {
    return await this.#call('scanDocuments', [query, limit, cursor], context) as Page<DocumentRecord, Cursor>;
  }

  async close(_context: Context): Promise<void> {
    void _context;
    if (this.#closed) return;
    try {
      await this.#call('close', []);
    } finally {
      this.#closed = true;
    }
  }

  /**
   * One storage call. The result is the runner's JSON copy of what the trusted SqliteStorage
   * returned for this session, so it is handed back with the method's declared type.
   */
  async #call(method: StorageMethod, args: readonly unknown[], context?: Context): Promise<unknown> {
    if (this.#closed) throw new Error('storage is closed');
    if (this.#failure) throw this.#failure;
    if (context?.abortSignal?.aborted) throw cancellation(context);
    this.#nextId += 1;
    // JSON has no undefined: an omitted optional argument travels as null.
    const record: StorageRequestRecord = {
      type: 'storage_request',
      id: `storage-${this.#nextId}`,
      method,
      args: args.map((value) => value === undefined ? null : value)
    };
    for (let attempt = 1; ; attempt += 1) {
      let response: StorageResponseRecord;
      try {
        response = await this.#attempt(record, context);
      } catch (error) {
        if (!(error instanceof TransportError) || attempt >= this.#options.maxAttempts || this.#failure) throw error;
        await delay(this.#backoff(attempt));
        continue;
      }
      if (response.ok) return response.result;
      if (response.error.retryable && attempt < this.#options.maxAttempts) {
        await delay(this.#backoff(attempt));
        continue;
      }
      if (response.error.code === 'request') throw new StorageRequestError(response.error.message);
      this.#lastError = new StorageRpcError(response.error.code, response.error.message);
      throw this.#lastError;
    }
  }

  #attempt(record: StorageRequestRecord, context: Context | undefined): Promise<StorageResponseRecord> {
    const { promise, resolve, reject } = Promise.withResolvers<StorageResponseRecord>();
    const signal = context?.abortSignal;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.#pending.get(record.id) === pending) this.#pending.delete(record.id);
    };
    const pending: PendingCall = {
      resolve: (response) => { cleanup(); resolve(response); },
      reject: (error) => { cleanup(); reject(error); }
    };
    const onAbort = () => pending.reject(cancellation(context as Context));
    const timer = setTimeout(() => pending.reject(new TransportError(`storage ${record.method} timed out`)), this.#options.requestTimeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#pending.set(record.id, pending);
    try {
      void this.#send(record).catch((error: unknown) => {
        pending.reject(new TransportError(error instanceof Error ? error.message : 'storage request could not be sent'));
      });
    } catch (error) {
      pending.reject(new TransportError(error instanceof Error ? error.message : 'storage request could not be sent'));
    }
    return promise;
  }

  #backoff(attempt: number): number {
    return Math.min(this.#options.maxBackoffMs, this.#options.baseBackoffMs * 2 ** (attempt - 1));
  }
}
