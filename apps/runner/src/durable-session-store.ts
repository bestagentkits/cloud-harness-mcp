import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import {
  AGENT_STORAGE_METHODS,
  AgentStorageRequestRecordSchema,
  MAX_PROTOCOL_RECORD_BYTES,
  type AgentStorageErrorCode,
  type AgentStorageMethod,
  type AgentStorageResponseRecord
} from './agent-protocol.js';

/**
 * Runner-owned session storage for agents on the durable runtime.
 *
 * Each agent lineage (a root agent and the agents that continue it) has one SQLite database under
 * the store's state directory. The worker never sees the database: it sends one Storage method at
 * a time over the agent protocol, and this store runs it on behalf of the lineage's single current
 * owner. The upstream storage implementation is experimental third-party code; it runs here only
 * when durable sessions are enabled, is imported lazily on first use, and is handed JSON data only
 * (no SQL, no paths, no method outside the Storage allowlist).
 */

/** The subset of the upstream Storage surface this store calls, typed structurally. */
interface StorageBackend {
  close(context: RunnerContext): Promise<void>;
  [method: string]: unknown;
}

/** A context with no cancellation: runner-side storage calls always run to completion. */
interface RunnerContext {
  readonly abortSignal: AbortSignal | undefined;
  value<T>(key: unknown): T | undefined;
  toString(): string;
}

const RUNNER_CONTEXT: RunnerContext = Object.freeze({
  abortSignal: undefined,
  value: <T>(): T | undefined => undefined,
  toString: () => 'cloud-harness-runner'
});

export interface DurableStorageBackendLoader {
  /** Opens (creating when absent) the session database at `path`. */
  open(path: string): Promise<StorageBackend>;
  /** Whether `error` is the upstream "invalid read request" error, which is not fatal to a session. */
  isRequestError(error: unknown): boolean;
}

export interface DurableSessionStoreOptions {
  /** Where lineage databases live; without it the store refuses claims and deletes nothing. */
  readonly stateDir: string | undefined;
  /** Durable sessions are opt-in; a disabled store refuses claims and never loads the backend. */
  readonly enabled: boolean;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Token bucket per lineage: `burst` requests at once, refilled at `perSecond`. */
  readonly rate?: { readonly burst: number; readonly perSecond: number };
  /** On-disk size cap of one lineage's database, checked around every commit. */
  readonly maxLineageBytes?: number;
  readonly loader?: DurableStorageBackendLoader;
  readonly now?: () => number;
}

/** Exclusive right to use one lineage's database, held by one agent run until superseded or released. */
export interface DurableSessionClaim {
  readonly lineageRootId: string;
  readonly agentId: string;
  readonly epoch: number;
  readonly generation: number;
}

interface OwnerMark {
  agentId: string;
  epoch: number;
  generation: number;
}

interface ClaimState extends DurableSessionClaim {
  readonly storage: StorageBackend;
  readonly responses: Map<string, Promise<AgentStorageResponseRecord>>;
  /** Set once a commit left the database above its size cap; every later commit is refused. */
  limitExceeded: boolean;
}

interface LineageState {
  storage: StorageBackend | undefined;
  active: ClaimState | undefined;
  tokens: number;
  refilledAt: number;
}

const LINEAGE_ID = /^agent_[A-Za-z0-9_-]{20,80}$/;
const MAX_ERROR_MESSAGE_BYTES = 4_096;
const MAX_REMEMBERED_RESPONSES = 256;
// Room for the response envelope around the result.
const RESPONSE_ENVELOPE_BYTES = 1_024;
const DEFAULT_RATE = { burst: 1_000, perSecond: 200 } as const;
const DEFAULT_MAX_LINEAGE_BYTES = 256 * 1024 * 1024;
/** Task states from which a resumed harness continues work. */
const LIVE_TASK_STATUSES = ['pending', 'running', 'waiting'] as const;
const ALLOWED_METHODS: ReadonlySet<string> = new Set(AGENT_STORAGE_METHODS);

function assertLineageId(lineageRootId: string): void {
  if (!LINEAGE_ID.test(lineageRootId)) throw new HarnessError('INVALID_INPUT', 'durable session lineage id is invalid', 400, false);
}

function assertMark(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new HarnessError('INVALID_INPUT', `durable session ${name} is invalid`, 400, false);
}

function compareMarks(left: OwnerMark, right: OwnerMark): number {
  return left.epoch !== right.epoch ? left.epoch - right.epoch : left.generation - right.generation;
}

function sessionPaths(stateDir: string, lineageRootId: string): { database: string; owner: string } {
  assertLineageId(lineageRootId);
  return { database: join(stateDir, `${lineageRootId}.sqlite`), owner: join(stateDir, `${lineageRootId}.owner.json`) };
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'storage operation failed';
  const bytes = Buffer.from(message, 'utf8');
  return bytes.byteLength <= MAX_ERROR_MESSAGE_BYTES ? message : bytes.subarray(0, MAX_ERROR_MESSAGE_BYTES - 3).toString('utf8') + '...';
}

function failure(id: string, code: AgentStorageErrorCode, message: string, retryable = false): AgentStorageResponseRecord {
  return { type: 'storage_response', id, ok: false, error: { code, message: boundedMessage(new Error(message)), retryable } };
}

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isOptionalCursor = (value: unknown): boolean => value === undefined || isObject(value);
const isDocumentPoint = (value: unknown): boolean => value === 'current' || isNumber(value);
const SCAN = [isObject, isNumber, isOptionalCursor];

/** Argument shapes per method; values themselves are validated by the storage. */
const ARGUMENTS: Record<AgentStorageMethod, ReadonlyArray<ReadonlyArray<(value: unknown) => boolean>>> = {
  commit: [[Array.isArray]],
  mintId: [[]],
  conversation: [[isNumber]],
  scanConversations: [SCAN],
  entry: [[isNumber], [isNumber, isNumber]],
  findLatestHeadMarker: [[isNumber, (value) => value === undefined || isNumber(value)]],
  scanEntries: [SCAN],
  task: [[isNumber]],
  scanTasks: [SCAN],
  submission: [[isNumber]],
  scanSubmissions: [SCAN],
  submissionByRequest: [[isNumber, (value) => typeof value === 'string']],
  findDocument: [[isObject, isDocumentPoint]],
  document: [[isNumber, isDocumentPoint]],
  scanDocuments: [SCAN],
  close: [[]]
};

function argumentsMatch(method: AgentStorageMethod, args: readonly unknown[]): boolean {
  return ARGUMENTS[method].some((shape) => shape.length === args.length && shape.every((check, index) => check(args[index])));
}

/** Writes `content` to `path` through a private temporary file, so readers see the old or the new file only. */
async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readOwnerMark(path: string): Promise<OwnerMark | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<OwnerMark>;
  if (typeof parsed.agentId !== 'string' || !Number.isSafeInteger(parsed.epoch) || !Number.isSafeInteger(parsed.generation)) {
    throw new HarnessError('INTERNAL_ERROR', 'durable session owner record is corrupt', 500, false);
  }
  return { agentId: parsed.agentId, epoch: parsed.epoch as number, generation: parsed.generation as number };
}

/**
 * Removes one lineage's session files. Safe to call when they are absent, and independent of the
 * storage backend, so workspace cleanup can call it without loading durable support.
 */
export async function deleteDurableSessionFiles(stateDir: string, lineageRootId: string): Promise<void> {
  const paths = sessionPaths(stateDir, lineageRootId);
  await Promise.all([
    rm(paths.database, { force: true }),
    rm(`${paths.database}-wal`, { force: true }),
    rm(`${paths.database}-shm`, { force: true }),
    rm(`${paths.database}-journal`, { force: true }),
    rm(paths.owner, { force: true })
  ]);
}

/** Removes the session files of every lineage a closed workspace owned. */
export async function deleteDurableLineages(stateDir: string, lineageRootIds: Iterable<string>): Promise<void> {
  for (const lineageRootId of new Set(lineageRootIds)) await deleteDurableSessionFiles(stateDir, lineageRootId);
}

/** Whether a store holds a task a resumed harness would continue: live and not marked for abort. */
async function hasLiveTasks(storage: StorageBackend): Promise<boolean> {
  const scan = storage.scanTasks as (query: unknown, limit: number, cursor: unknown, context: RunnerContext) => Promise<{ items: readonly unknown[] }>;
  for (const status of LIVE_TASK_STATUSES) {
    const page = await scan.call(storage, { status, abortRequested: false }, 1, undefined, RUNNER_CONTEXT);
    if (page.items.length > 0) return true;
  }
  return false;
}

const nodeSqliteLoader: DurableStorageBackendLoader = (() => {
  let requestError: (new (...args: never[]) => Error) | undefined;
  return {
    async open(path: string): Promise<StorageBackend> {
      const [{ openNodeSqliteStorage }, { StorageRequestError }] = await Promise.all([
        import('@earendil-works/pi-durable/storage/sqlite/node'),
        import('@earendil-works/pi-durable')
      ]);
      requestError = StorageRequestError;
      return await openNodeSqliteStorage(path) as unknown as StorageBackend;
    },
    isRequestError(error: unknown): boolean {
      return requestError !== undefined && error instanceof requestError;
    }
  };
})();

export class DurableSessionStore {
  readonly #stateDir: string | undefined;
  readonly #enabled: boolean;
  readonly #maxLineageBytes: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #rate: { readonly burst: number; readonly perSecond: number };
  readonly #loader: DurableStorageBackendLoader;
  readonly #now: () => number;
  readonly #lineages = new Map<string, LineageState>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #directoryReady: Promise<void> | undefined;

  constructor(options: DurableSessionStoreOptions) {
    this.#stateDir = options.stateDir;
    this.#enabled = options.enabled;
    this.#maxLineageBytes = options.maxLineageBytes ?? DEFAULT_MAX_LINEAGE_BYTES;
    if (!Number.isSafeInteger(this.#maxLineageBytes) || this.#maxLineageBytes < 1) throw new Error('durable session size cap must be a positive integer');
    this.#maxRequestBytes = options.maxRequestBytes ?? MAX_PROTOCOL_RECORD_BYTES;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_PROTOCOL_RECORD_BYTES;
    this.#rate = options.rate ?? DEFAULT_RATE;
    this.#loader = options.loader ?? nodeSqliteLoader;
    this.#now = options.now ?? Date.now;
    if (!(this.#rate.burst >= 1) || !(this.#rate.perSecond > 0)) throw new Error('durable session rate bound must be positive');
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Makes `agentId` the only owner of the lineage's database. Ownership is ordered by
   * (epoch, generation): a higher claim supersedes and fences the current owner, an equal claim
   * by the same agent returns the current one, and anything lower or equal from another agent
   * is refused as stale. The mark is persisted, so a stale run stays fenced across restarts.
   */
  async claim(lineageRootId: string, agentId: string, epoch: number, generation: number): Promise<DurableSessionClaim> {
    const stateDir = this.#stateDir;
    if (!this.#enabled || stateDir === undefined) throw new HarnessError('UNAVAILABLE', 'durable agent sessions are disabled', 503, false);
    assertLineageId(lineageRootId);
    if (!LINEAGE_ID.test(agentId)) throw new HarnessError('INVALID_INPUT', 'durable session owner id is invalid', 400, false);
    assertMark(epoch, 'epoch');
    assertMark(generation, 'generation');
    return await this.#withLock(lineageRootId, async () => {
      await this.#ensureDirectory(stateDir);
      const paths = sessionPaths(stateDir, lineageRootId);
      const requested: OwnerMark = { agentId, epoch, generation };
      const stored = await readOwnerMark(paths.owner);
      const lineage = this.#lineage(lineageRootId);
      if (stored) {
        const order = compareMarks(requested, stored);
        if (order === 0 && stored.agentId === agentId && lineage.active && lineage.active.agentId === agentId) return lineage.active;
        if (order < 0 || (order === 0 && stored.agentId !== agentId)) {
          throw new HarnessError('CONFLICT', 'durable session is owned by a newer agent run', 409, false);
        }
      }
      if (!lineage.storage) lineage.storage = await this.#openDatabase(paths.database);
      if (!stored || compareMarks(requested, stored) !== 0 || stored.agentId !== agentId) {
        await writePrivateFile(paths.owner, JSON.stringify(requested));
      }
      const claim: ClaimState = {
        lineageRootId, agentId, epoch, generation, storage: lineage.storage, responses: new Map(), limitExceeded: false
      };
      lineage.active = claim;
      return claim;
    });
  }

  /** Ends a claim; the database closes when its current owner releases it. A fenced claim is a no-op. */
  async release(claim: DurableSessionClaim): Promise<void> {
    await this.#withLock(claim.lineageRootId, async () => {
      const lineage = this.#lineages.get(claim.lineageRootId);
      if (!lineage || lineage.active !== claim) return;
      lineage.active = undefined;
      await this.#closeLineage(claim.lineageRootId, lineage);
    });
  }

  /**
   * Ends a claim and reports whether its database still holds unfinished tasks, which a
   * continuation would resume. A claim that is no longer current reports none and changes nothing.
   */
  async seal(claim: DurableSessionClaim): Promise<{ pendingTasks: boolean }> {
    return await this.#withLock(claim.lineageRootId, async () => {
      const lineage = this.#lineages.get(claim.lineageRootId);
      if (!lineage || lineage.active !== claim) return { pendingTasks: false };
      let pendingTasks = false;
      try {
        pendingTasks = await hasLiveTasks(lineage.active.storage);
      } catch {
        // An unreadable store is reported as holding nothing to resume.
      }
      lineage.active = undefined;
      await this.#closeLineage(claim.lineageRootId, lineage);
      return { pendingTasks };
    });
  }

  /**
   * Reports whether an unclaimed lineage's database holds unfinished tasks, for an agent whose run
   * ended without a live claim (for example after a runner restart). A claimed lineage, a disabled
   * store, an absent database, or a read failure all report none.
   */
  async inspectPending(lineageRootId: string): Promise<{ pendingTasks: boolean }> {
    const stateDir = this.#stateDir;
    if (!this.#enabled || stateDir === undefined) return { pendingTasks: false };
    assertLineageId(lineageRootId);
    return await this.#withLock(lineageRootId, async () => {
      if (this.#lineages.get(lineageRootId)?.active) return { pendingTasks: false };
      const paths = sessionPaths(stateDir, lineageRootId);
      try {
        await stat(paths.database);
      } catch {
        return { pendingTasks: false };
      }
      let storage: StorageBackend | undefined;
      try {
        storage = await this.#openDatabase(paths.database);
        return { pendingTasks: await hasLiveTasks(storage) };
      } catch {
        return { pendingTasks: false };
      } finally {
        await storage?.close(RUNNER_CONTEXT).catch(() => undefined);
      }
    });
  }

  /** Whether a commit of this claim left its lineage's database above the size cap. */
  limitExceeded(claim: DurableSessionClaim): boolean {
    return (claim as Partial<ClaimState>).limitExceeded === true;
  }

  /** Closes the lineage's database, fences every claim and removes its files. */
  async delete(lineageRootId: string): Promise<void> {
    assertLineageId(lineageRootId);
    await this.#withLock(lineageRootId, async () => {
      const lineage = this.#lineages.get(lineageRootId);
      if (lineage) {
        lineage.active = undefined;
        await this.#closeLineage(lineageRootId, lineage);
      }
      if (this.#stateDir !== undefined) await deleteDurableSessionFiles(this.#stateDir, lineageRootId);
    });
  }

  /** Deletes the session stores of every listed lineage. */
  async deleteLineages(lineageRootIds: Iterable<string>): Promise<void> {
    for (const lineageRootId of new Set(lineageRootIds)) await this.delete(lineageRootId);
  }

  /** Runs one storage request for a claim and returns the response record to send back. */
  async handle(claim: DurableSessionClaim, request: unknown): Promise<AgentStorageResponseRecord> {
    const id = request && typeof request === 'object' && typeof (request as { id?: unknown }).id === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test((request as { id: string }).id) ? (request as { id: string }).id : 'invalid';
    const method = request && typeof request === 'object' ? (request as { method?: unknown }).method : undefined;
    if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) return failure(id, 'failed', 'storage method is not allowed');
    let encoded: string;
    try {
      encoded = JSON.stringify(request);
    } catch {
      return failure(id, 'failed', 'storage request is not JSON');
    }
    if (Buffer.byteLength(encoded, 'utf8') > this.#maxRequestBytes) return failure(id, 'limit', 'storage request exceeds the byte limit');
    const parsed = AgentStorageRequestRecordSchema.safeParse(request);
    if (!parsed.success) return failure(id, 'failed', 'storage request is malformed');
    const lineage = this.#lineages.get(claim.lineageRootId);
    const state = lineage?.active;
    if (!lineage || !state || state !== claim) return failure(id, 'fenced', 'durable session claim is no longer current');
    const remembered = state.responses.get(id);
    if (remembered) return await remembered;
    if (!this.#takeToken(lineage)) return failure(id, 'rate_limited', 'storage request rate exceeded', true);
    // JSON has no undefined: the worker sends an omitted argument as null.
    const args = parsed.data.args.map((value) => value === null ? undefined : value);
    if (!argumentsMatch(parsed.data.method, args)) return failure(id, 'request', `invalid arguments for storage ${parsed.data.method}`);
    if (parsed.data.method === 'commit') {
      if (state.limitExceeded || await this.#databaseBytes(claim.lineageRootId) > this.#maxLineageBytes) {
        state.limitExceeded = true;
        return failure(id, 'limit', 'durable session exceeds its size limit');
      }
    }
    const response = this.#run(id, state, parsed.data.method, args, lineage).then(async (result) => {
      if (parsed.data.method === 'commit' && result.ok && await this.#databaseBytes(claim.lineageRootId) > this.#maxLineageBytes) {
        state.limitExceeded = true;
      }
      return result;
    });
    state.responses.set(id, response);
    if (state.responses.size > MAX_REMEMBERED_RESPONSES) {
      const oldest = state.responses.keys().next().value as string | undefined;
      if (oldest !== undefined) state.responses.delete(oldest);
    }
    return await response;
  }

  /** Closes every open database. Used on runner shutdown. */
  async close(): Promise<void> {
    for (const [lineageRootId, lineage] of [...this.#lineages]) {
      await this.#withLock(lineageRootId, async () => {
        lineage.active = undefined;
        await this.#closeLineage(lineageRootId, lineage);
      });
    }
  }

  async #run(id: string, state: ClaimState, method: AgentStorageMethod, args: unknown[], lineage: LineageState): Promise<AgentStorageResponseRecord> {
    try {
      const target = state.storage[method];
      if (typeof target !== 'function') return failure(id, 'failed', 'storage method is unavailable');
      // mintId is the one Storage method without a context argument.
      const callArgs = method === 'mintId' ? args : [...args, RUNNER_CONTEXT];
      const result: unknown = await (target as (...values: unknown[]) => Promise<unknown>).apply(state.storage, callArgs);
      if (method === 'close' && lineage.storage === state.storage) lineage.storage = undefined;
      if (result !== undefined) {
        const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        if (bytes > this.#maxResponseBytes - RESPONSE_ENVELOPE_BYTES) return failure(id, 'limit', 'storage response exceeds the byte limit');
      }
      return result === undefined ? { type: 'storage_response', id, ok: true } : { type: 'storage_response', id, ok: true, result };
    } catch (error) {
      if (this.#loader.isRequestError(error)) return failure(id, 'request', boundedMessage(error));
      return failure(id, 'failed', boundedMessage(error));
    }
  }

  #takeToken(lineage: LineageState): boolean {
    const now = this.#now();
    const elapsed = Math.max(0, now - lineage.refilledAt);
    lineage.tokens = Math.min(this.#rate.burst, lineage.tokens + (elapsed / 1_000) * this.#rate.perSecond);
    lineage.refilledAt = now;
    if (lineage.tokens < 1) return false;
    lineage.tokens -= 1;
    return true;
  }

  #lineage(lineageRootId: string): LineageState {
    let lineage = this.#lineages.get(lineageRootId);
    if (!lineage) {
      lineage = { storage: undefined, active: undefined, tokens: this.#rate.burst, refilledAt: this.#now() };
      this.#lineages.set(lineageRootId, lineage);
    }
    return lineage;
  }

  async #closeLineage(lineageRootId: string, lineage: LineageState): Promise<void> {
    const storage = lineage.storage;
    lineage.storage = undefined;
    this.#lineages.delete(lineageRootId);
    if (!storage) return;
    try {
      await storage.close(RUNNER_CONTEXT);
    } catch {
      // A database that fails to close is already unusable; its files are still removable.
    }
  }

  async #openDatabase(path: string): Promise<StorageBackend> {
    // Create the file privately before SQLite opens it, so it never exists with a wider mode.
    const handle = await open(path, 'a', 0o600);
    await handle.close();
    await chmod(path, 0o600);
    const storage = await this.#loader.open(path);
    await Promise.all(['-wal', '-shm'].map(async (suffix) => {
      try {
        await chmod(`${path}${suffix}`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
    return storage;
  }

  /** The lineage database's size on disk, write-ahead log included. */
  async #databaseBytes(lineageRootId: string): Promise<number> {
    if (this.#stateDir === undefined) return 0;
    const { database } = sessionPaths(this.#stateDir, lineageRootId);
    let total = 0;
    for (const path of [database, `${database}-wal`]) {
      try {
        total += (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return total;
  }

  async #ensureDirectory(stateDir: string): Promise<void> {
    this.#directoryReady ??= (async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
    })();
    try {
      await this.#directoryReady;
    } catch (error) {
      this.#directoryReady = undefined;
      throw error;
    }
  }

  async #withLock<T>(lineageRootId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(lineageRootId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    this.#locks.set(lineageRootId, settled);
    try {
      return await next;
    } finally {
      if (this.#locks.get(lineageRootId) === settled) this.#locks.delete(lineageRootId);
    }
  }
}
