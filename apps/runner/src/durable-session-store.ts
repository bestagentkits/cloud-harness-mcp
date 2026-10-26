import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
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

/** Names the aggregate session byte budget that `addedBytes` more stored bytes would exceed, if any. */
export type DurableSessionBudget = (addedBytes: number) => 'workspace' | 'principal' | 'instance' | undefined;

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
  /** Total encoded size of the responses one claim remembers for repeated request ids. */
  readonly maxRememberedBytes?: number;
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

interface RememberedResponse {
  readonly response: Promise<AgentStorageResponseRecord>;
  /** Encoded size once the response settled; 0 while it is still running. */
  bytes: number;
}

interface ClaimState extends DurableSessionClaim {
  readonly storage: StorageBackend;
  /**
   * Responses of the non-idempotent methods, so a request the worker sends again under the same id
   * (after a timeout or a lost response) gets its first result instead of running twice. Reads are
   * never kept: running one again is harmless, and its result can be megabytes.
   */
  readonly responses: Map<string, RememberedResponse>;
  rememberedBytes: number;
  /**
   * The latest commit, kept apart from the bounded memo above, so a retried commit is answered
   * from its first result even after a burst of newer requests evicted it there. A retry never
   * outlives its claim: a new run or a runner restart takes a new claim and fences the old worker.
   */
  lastCommit: { readonly id: string; readonly response: Promise<AgentStorageResponseRecord> } | undefined;
  /** Set once a commit left the database above its size cap or an aggregate budget; every later commit is refused. */
  limitExceeded: boolean;
  /** Set once the database's write-ahead log and shared-memory files were made private after a write. */
  sidecarsPrivate: boolean;
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
const DEFAULT_MAX_REMEMBERED_BYTES = 4 * 1024 * 1024;
/** Methods whose repetition would change the store: their responses are remembered per request id. */
const NON_IDEMPOTENT_METHODS: ReadonlySet<AgentStorageMethod> = new Set(['commit', 'mintId']);
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
/**
 * The most items one scan may ask for. The engine pages by 256; a larger page would only let one
 * request make the runner read and serialize more of the database before the response bound applies.
 */
export const MAX_STORAGE_SCAN_LIMIT = 1_000;
const isScanLimit = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_STORAGE_SCAN_LIMIT;
const SCAN = [isObject, isScanLimit, isOptionalCursor];

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

/**
 * Makes a database's write-ahead log and shared-memory files owner-only. SQLite creates them with
 * the main file's mode, but only on first use, so this runs after the open and after the first write.
 */
async function restrictSidecarFiles(database: string): Promise<void> {
  await Promise.all(['-wal', '-shm'].map(async (suffix) => {
    try {
      await chmod(`${database}${suffix}`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
}

/** Drops a claim's remembered responses; a claim that is no longer current never answers again. */
function forgetResponses(claim: ClaimState): void {
  claim.responses.clear();
  claim.rememberedBytes = 0;
  claim.lastCommit = undefined;
}

/** Ends the lineage's current claim, releasing the responses it remembered. */
function deactivate(lineage: LineageState): void {
  if (lineage.active) forgetResponses(lineage.active);
  lineage.active = undefined;
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
  readonly #maxRememberedBytes: number;
  readonly #rate: { readonly burst: number; readonly perSecond: number };
  readonly #loader: DurableStorageBackendLoader;
  readonly #now: () => number;
  readonly #lineages = new Map<string, LineageState>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Last measured on-disk size of each lineage database, by lineage root; counted toward the aggregate session budgets. */
  readonly #lineageSizes = new Map<string, number>();
  #directoryReady: Promise<void> | undefined;

  constructor(options: DurableSessionStoreOptions) {
    this.#stateDir = options.stateDir;
    this.#enabled = options.enabled;
    this.#maxLineageBytes = options.maxLineageBytes ?? DEFAULT_MAX_LINEAGE_BYTES;
    if (!Number.isSafeInteger(this.#maxLineageBytes) || this.#maxLineageBytes < 1) throw new Error('durable session size cap must be a positive integer');
    this.#maxRequestBytes = options.maxRequestBytes ?? MAX_PROTOCOL_RECORD_BYTES;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_PROTOCOL_RECORD_BYTES;
    this.#maxRememberedBytes = options.maxRememberedBytes ?? DEFAULT_MAX_REMEMBERED_BYTES;
    if (!Number.isSafeInteger(this.#maxRememberedBytes) || this.#maxRememberedBytes < 1) throw new Error('durable session response memo bound must be a positive integer');
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
        lineageRootId, agentId, epoch, generation, storage: lineage.storage,
        responses: new Map(), rememberedBytes: 0, lastCommit: undefined, limitExceeded: false, sidecarsPrivate: false
      };
      if (lineage.active) forgetResponses(lineage.active);
      lineage.active = claim;
      return claim;
    });
  }

  /** Ends a claim; the database closes when its current owner releases it. A fenced claim is a no-op. */
  async release(claim: DurableSessionClaim): Promise<void> {
    await this.#withLock(claim.lineageRootId, async () => {
      const lineage = this.#lineages.get(claim.lineageRootId);
      if (!lineage || lineage.active !== claim) return;
      deactivate(lineage);
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
      deactivate(lineage);
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

  /**
   * Measures every lineage database under the state directory, so stored durable sessions count
   * toward the aggregate session byte budgets from runner start, including stores an earlier run
   * left while the durable runtime is now off.
   */
  async measure(): Promise<void> {
    const stateDir = this.#stateDir;
    if (stateDir === undefined) return;
    let names: string[];
    try {
      names = await readdir(stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      const lineageRootId = name.endsWith('.sqlite') ? name.slice(0, -'.sqlite'.length) : '';
      if (!LINEAGE_ID.test(lineageRootId)) continue;
      await this.#withLock(lineageRootId, async () => await this.#measureLineage(lineageRootId));
    }
  }

  /** The last measured on-disk size of one lineage's database; 0 when it has none. */
  lineageBytes(lineageRootId: string): number {
    return this.#lineageSizes.get(lineageRootId) ?? 0;
  }

  /** The last measured on-disk size of every lineage database, including one no agent record names any more. */
  totalBytes(): number {
    let total = 0;
    for (const bytes of this.#lineageSizes.values()) total += bytes;
    return total;
  }

  /** Whether a commit of this claim left its lineage's database above the size cap or an aggregate budget. */
  limitExceeded(claim: DurableSessionClaim): boolean {
    return (claim as Partial<ClaimState>).limitExceeded === true;
  }

  /** Closes the lineage's database, fences every claim and removes its files. */
  async delete(lineageRootId: string): Promise<void> {
    assertLineageId(lineageRootId);
    await this.#withLock(lineageRootId, async () => {
      const lineage = this.#lineages.get(lineageRootId);
      if (lineage) {
        deactivate(lineage);
        await this.#closeLineage(lineageRootId, lineage);
      }
      if (this.#stateDir !== undefined) await deleteDurableSessionFiles(this.#stateDir, lineageRootId);
      this.#lineageSizes.delete(lineageRootId);
    });
  }

  /** Deletes the session stores of every listed lineage. */
  async deleteLineages(lineageRootIds: Iterable<string>): Promise<void> {
    for (const lineageRootId of new Set(lineageRootIds)) await this.delete(lineageRootId);
  }

  /**
   * Runs one storage request for a claim and returns the response record to send back. A commit is
   * refused once the lineage's database is over its size cap, or when `budget` reports that the
   * request's bytes would pass an aggregate session budget of the run's workspace, owner, or instance.
   */
  async handle(claim: DurableSessionClaim, request: unknown, budget?: DurableSessionBudget): Promise<AgentStorageResponseRecord> {
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
    const storageMethod = parsed.data.method;
    const remembers = NON_IDEMPOTENT_METHODS.has(storageMethod);
    if (remembers) {
      const remembered = state.responses.get(id)?.response
        ?? (storageMethod === 'commit' && state.lastCommit?.id === id ? state.lastCommit.response : undefined);
      if (remembered) return await remembered;
    }
    if (!this.#takeToken(lineage)) return failure(id, 'rate_limited', 'storage request rate exceeded', true);
    // JSON has no undefined: the worker sends an omitted argument as null.
    const args = parsed.data.args.map((value) => value === null ? undefined : value);
    if (!argumentsMatch(storageMethod, args)) return failure(id, 'request', `invalid arguments for storage ${storageMethod}`);
    if (storageMethod === 'commit') {
      if (state.limitExceeded || await this.#measureLineage(claim.lineageRootId) > this.#maxLineageBytes) {
        state.limitExceeded = true;
        return failure(id, 'limit', 'durable session exceeds its size limit');
      }
      // The request's encoded size stands in for what the commit adds; the size cap above catches the rest.
      const exceeded = budget?.(Buffer.byteLength(encoded, 'utf8'));
      if (exceeded) {
        state.limitExceeded = true;
        return failure(id, 'limit', `durable session would exceed the ${exceeded} agent session byte budget`);
      }
    }
    const response = this.#run(id, state, storageMethod, args).then(async (result) => {
      if (storageMethod !== 'commit' || !result.ok) return result;
      if (!state.sidecarsPrivate) {
        // SQLite may create the write-ahead log and shared-memory files only at the first write.
        await this.#restrictSidecars(claim.lineageRootId);
        state.sidecarsPrivate = true;
      }
      if (await this.#measureLineage(claim.lineageRootId) > this.#maxLineageBytes) state.limitExceeded = true;
      return result;
    });
    if (remembers) this.#remember(state, id, storageMethod, response);
    return await response;
  }

  /**
   * Keeps a non-idempotent response for repeated request ids, within a count and a byte bound per
   * claim; the oldest responses go first. The latest commit is also kept apart, outside both bounds.
   */
  #remember(state: ClaimState, id: string, method: AgentStorageMethod, response: Promise<AgentStorageResponseRecord>): void {
    const entry: RememberedResponse = { response, bytes: 0 };
    state.responses.set(id, entry);
    if (method === 'commit') state.lastCommit = { id, response };
    this.#evictRemembered(state);
    void response.then((record) => {
      // A claim that was released, or an entry already evicted, keeps nothing.
      if (state.responses.get(id) !== entry) return;
      entry.bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
      state.rememberedBytes += entry.bytes;
      this.#evictRemembered(state);
    }, () => {
      if (state.responses.get(id) === entry) state.responses.delete(id);
    });
  }

  #evictRemembered(state: ClaimState): void {
    while (state.responses.size > MAX_REMEMBERED_RESPONSES || state.rememberedBytes > this.#maxRememberedBytes) {
      const oldest = state.responses.entries().next().value as [string, RememberedResponse] | undefined;
      if (!oldest) break;
      state.responses.delete(oldest[0]);
      state.rememberedBytes -= oldest[1].bytes;
    }
  }

  /** Closes every open database. Used on runner shutdown. */
  async close(): Promise<void> {
    for (const [lineageRootId, lineage] of [...this.#lineages]) {
      await this.#withLock(lineageRootId, async () => {
        deactivate(lineage);
        await this.#closeLineage(lineageRootId, lineage);
      });
    }
  }

  async #run(id: string, state: ClaimState, method: AgentStorageMethod, args: unknown[]): Promise<AgentStorageResponseRecord> {
    // The runner owns the database's lifetime: a worker's close is acknowledged but never closes it,
    // so sealing the run can still read its unfinished tasks. Seal, release, delete, and shutdown
    // close it.
    if (method === 'close') return { type: 'storage_response', id, ok: true };
    try {
      const target = state.storage[method];
      if (typeof target !== 'function') return failure(id, 'failed', 'storage method is unavailable');
      // mintId is the one Storage method without a context argument.
      const callArgs = method === 'mintId' ? args : [...args, RUNNER_CONTEXT];
      const result: unknown = await (target as (...values: unknown[]) => Promise<unknown>).apply(state.storage, callArgs);
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
    if (storage) {
      try {
        await storage.close(RUNNER_CONTEXT);
      } catch {
        // A database that fails to close is already unusable; its files are still removable.
      }
    }
    // Closing, here or by the worker's own close request, checkpoints the write-ahead log, which
    // changes the size the budgets count.
    await this.#measureLineage(lineageRootId).catch(() => undefined);
  }

  async #openDatabase(path: string): Promise<StorageBackend> {
    // Create the file privately before SQLite opens it, so it never exists with a wider mode.
    const handle = await open(path, 'a', 0o600);
    await handle.close();
    await chmod(path, 0o600);
    const storage = await this.#loader.open(path);
    await restrictSidecarFiles(path);
    return storage;
  }

  async #restrictSidecars(lineageRootId: string): Promise<void> {
    if (this.#stateDir !== undefined) await restrictSidecarFiles(sessionPaths(this.#stateDir, lineageRootId).database);
  }

  /** Records and returns the lineage database's current size on disk; an absent database is forgotten. */
  async #measureLineage(lineageRootId: string): Promise<number> {
    const bytes = await this.#databaseBytes(lineageRootId);
    if (bytes > 0) this.#lineageSizes.set(lineageRootId, bytes);
    else this.#lineageSizes.delete(lineageRootId);
    return bytes;
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
