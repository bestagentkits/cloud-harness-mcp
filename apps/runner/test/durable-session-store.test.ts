import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDurableSessionFiles,
  DurableSessionStore,
  MAX_STORAGE_SCAN_LIMIT,
  type DurableStorageBackendLoader
} from '../src/durable-session-store.js';

const LINEAGE = `agent_${'l'.repeat(24)}`;
const OWNER = `agent_${'o'.repeat(24)}`;
const SUCCESSOR = `agent_${'s'.repeat(24)}`;

const dirs: string[] = [];
const stores: DurableSessionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'durable-store-'));
  dirs.push(dir);
  return join(dir, 'sessions');
}

async function createStore(options: Partial<ConstructorParameters<typeof DurableSessionStore>[0]> = {}): Promise<DurableSessionStore> {
  const store = new DurableSessionStore({ stateDir: await stateDir(), enabled: true, ...options });
  stores.push(store);
  return store;
}

/**
 * A storage backend that reports the task statuses in `live` and grows its database file by
 * `commitBytes` per commit, so size and pending-work checks run without the real engine.
 */
function fakeBackend(commitBytes = 0) {
  const state = {
    live: new Set<string>(),
    queries: [] as Array<{ status: string; abortRequested: boolean }>,
    commits: 0,
    documentReads: 0,
    closed: 0,
    loader: undefined as unknown as DurableStorageBackendLoader
  };
  let minted = 0;
  state.loader = {
    isRequestError: () => false,
    async open(path: string) {
      // Like the SQLite storage, a closed backend refuses every later call.
      let open = true;
      return {
        async mintId() { minted += 1; return minted; },
        async commit() {
          state.commits += 1;
          await appendFile(path, Buffer.alloc(commitBytes));
          return state.commits;
        },
        async document() {
          state.documentReads += 1;
          return { id: state.documentReads, body: 'd'.repeat(1_048_576) };
        },
        async scanTasks(query: { status: string; abortRequested: boolean }) {
          if (!open) throw new Error('SqliteStorage is closed');
          state.queries.push(query);
          return { items: state.live.has(query.status) ? [{ id: 1 }] : [], next: undefined };
        },
        async close() { open = false; state.closed += 1; }
      } as never;
    }
  };
  return state;
}

function request(id: string, method: string, args: unknown[] = []): unknown {
  return { type: 'storage_request', id, method, args };
}

/** What a claim keeps in memory for repeated request ids; the claim object is the store's own state. */
function remembered(claim: object): { count: number; bytes: number; lastCommit: boolean } {
  const state = claim as { responses: Map<string, unknown>; rememberedBytes: number; lastCommit: unknown };
  return { count: state.responses.size, bytes: state.rememberedBytes, lastCommit: state.lastCommit !== undefined };
}
const NOTHING_REMEMBERED = { count: 0, bytes: 0, lastCommit: false };

describe('DurableSessionStore', () => {
  it('runs an allowed storage method for the current claim', async () => {
    const store = await createStore();
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const response = await store.handle(claim, request('r-1', 'mintId'));
    expect(response).toMatchObject({ type: 'storage_response', id: 'r-1', ok: true });
  });

  it('refuses a method outside the allowlist without calling the backend', async () => {
    const store = await createStore();
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    for (const method of ['exec', 'prepare', '__proto__', 'constructor', 'commitRaw']) {
      const response = await store.handle(claim, request('r-1', method, ['DROP TABLE entries']));
      expect(response).toMatchObject({ ok: false, error: { code: 'failed', message: 'storage method is not allowed', retryable: false } });
    }
  });

  it('refuses a request over the byte bound', async () => {
    const store = await createStore({ maxRequestBytes: 1_024 });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const response = await store.handle(claim, request('r-1', 'submissionByRequest', [1, 'x'.repeat(2_048)]));
    expect(response).toMatchObject({ ok: false, error: { code: 'limit', retryable: false } });
  });

  it('refuses arguments of the wrong shape as an invalid request', async () => {
    const store = await createStore();
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const response = await store.handle(claim, request('r-1', 'conversation', ['not-an-id']));
    expect(response).toMatchObject({ ok: false, error: { code: 'request', retryable: false } });
  });

  it('bounds the request rate per lineage and reports it as retryable', async () => {
    let now = 0;
    const store = await createStore({ rate: { burst: 2, perSecond: 1 }, now: () => now });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    expect(await store.handle(claim, request('r-1', 'mintId'))).toMatchObject({ ok: true });
    expect(await store.handle(claim, request('r-2', 'mintId'))).toMatchObject({ ok: true });
    expect(await store.handle(claim, request('r-3', 'mintId'))).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } });
    now += 1_000;
    expect(await store.handle(claim, request('r-3', 'mintId'))).toMatchObject({ ok: true });
  });

  it('answers a repeated request id with its first result', async () => {
    const store = await createStore();
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const first = await store.handle(claim, request('r-1', 'mintId'));
    const repeated = await store.handle(claim, request('r-1', 'mintId'));
    const next = await store.handle(claim, request('r-2', 'mintId'));
    expect(repeated).toEqual(first);
    expect(next).not.toEqual(first);
  });

  it('runs a repeated read again instead of retaining its result', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const first = await store.handle(claim, request('r-1', 'document', [1, 'current']));
    const repeated = await store.handle(claim, request('r-1', 'document', [1, 'current']));
    expect(first).toMatchObject({ ok: true, result: { id: 1 } });
    expect(repeated).toMatchObject({ ok: true, result: { id: 2 } });
    expect(backend.documentReads).toBe(2);
    expect(remembered(claim)).toEqual(NOTHING_REMEMBERED);
  });

  it('bounds the remembered responses of a claim by their total size', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader, maxRememberedBytes: 300 });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const responses = [];
    for (let index = 1; index <= 8; index += 1) responses.push(await store.handle(claim, request(`r-${index}`, 'mintId')));
    const held = remembered(claim);
    expect(held.bytes).toBeLessThanOrEqual(300);
    expect(held.count).toBeLessThan(8);
    // The newest response is still answered from memory; the oldest was evicted and runs again.
    expect(await store.handle(claim, request('r-8', 'mintId'))).toEqual(responses[7]);
    expect(await store.handle(claim, request('r-1', 'mintId'))).not.toEqual(responses[0]);
  });

  it('answers a retried commit from its first result after newer requests evicted it', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader, maxRememberedBytes: 300 });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const first = await store.handle(claim, request('c-1', 'commit', [[]]));
    for (let index = 1; index <= 300; index += 1) await store.handle(claim, request(`m-${index}`, 'mintId'));
    expect(await store.handle(claim, request('c-1', 'commit', [[]]))).toEqual(first);
    expect(backend.commits).toBe(1);
  });

  it('drops the remembered responses when its claim is released or sealed', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader });
    const released = await store.claim(LINEAGE, OWNER, 1, 0);
    await store.handle(released, request('c-1', 'commit', [[]]));
    expect(remembered(released)).toMatchObject({ count: 1, lastCommit: true });
    await store.release(released);
    expect(remembered(released)).toEqual(NOTHING_REMEMBERED);
    const sealed = await store.claim(LINEAGE, OWNER, 1, 1);
    await store.handle(sealed, request('c-1', 'commit', [[]]));
    await store.seal(sealed);
    expect(remembered(sealed)).toEqual(NOTHING_REMEMBERED);
  });

  it('fences a superseded claim and refuses a stale one', async () => {
    const store = await createStore();
    const first = await store.claim(LINEAGE, OWNER, 1, 0);
    const successor = await store.claim(LINEAGE, SUCCESSOR, 2, 0);
    expect(await store.handle(first, request('r-1', 'mintId'))).toMatchObject({ ok: false, error: { code: 'fenced', retryable: false } });
    expect(await store.handle(successor, request('r-1', 'mintId'))).toMatchObject({ ok: true });
    await expect(store.claim(LINEAGE, OWNER, 1, 5)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.claim(LINEAGE, OWNER, 2, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    // Releasing a fenced claim leaves the current owner untouched.
    await store.release(first);
    expect(await store.handle(successor, request('r-2', 'mintId'))).toMatchObject({ ok: true });
  });

  it('keeps the ownership mark across a runner restart', async () => {
    const dir = await stateDir();
    const before = new DurableSessionStore({ stateDir: dir, enabled: true });
    await before.claim(LINEAGE, SUCCESSOR, 3, 1);
    await before.close();
    const after = new DurableSessionStore({ stateDir: dir, enabled: true });
    stores.push(after);
    await expect(after.claim(LINEAGE, OWNER, 3, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    const resumed = await after.claim(LINEAGE, SUCCESSOR, 3, 1);
    expect(await after.handle(resumed, request('r-1', 'mintId'))).toMatchObject({ ok: true });
  });

  it('returns the current claim for a repeated identical claim', async () => {
    const store = await createStore();
    const first = await store.claim(LINEAGE, OWNER, 1, 0);
    const again = await store.claim(LINEAGE, OWNER, 1, 0);
    expect(again).toBe(first);
  });

  it('refuses claims and never loads the backend when disabled', async () => {
    const loader: DurableStorageBackendLoader = { open: vi.fn(), isRequestError: () => false };
    const store = await createStore({ enabled: false, loader });
    await expect(store.claim(LINEAGE, OWNER, 1, 0)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(loader.open).not.toHaveBeenCalled();
  });

  it('rejects lineage ids that could escape the state directory', async () => {
    const store = await createStore();
    await expect(store.claim('../agent_aaaaaaaaaaaaaaaaaaaaaaaa', OWNER, 1, 0)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.claim(LINEAGE, OWNER, -1, 0)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('deletes the lineage database and fences its claim', async () => {
    const dir = await stateDir();
    const store = new DurableSessionStore({ stateDir: dir, enabled: true });
    stores.push(store);
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    await store.handle(claim, request('r-1', 'mintId'));
    expect(existsSync(join(dir, `${LINEAGE}.sqlite`))).toBe(true);
    await store.delete(LINEAGE);
    expect(existsSync(join(dir, `${LINEAGE}.sqlite`))).toBe(false);
    expect(existsSync(join(dir, `${LINEAGE}.owner.json`))).toBe(false);
    expect(await store.handle(claim, request('r-2', 'mintId'))).toMatchObject({ ok: false, error: { code: 'fenced' } });
  });

  it('removes session files without the storage backend', async () => {
    const dir = await stateDir();
    await expect(deleteDurableSessionFiles(dir, LINEAGE)).resolves.toBeUndefined();
    await expect(deleteDurableSessionFiles(dir, 'not-a-lineage')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reports unfinished tasks when a claim is sealed or an unclaimed lineage is inspected', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    backend.live.add('running');
    expect(await store.seal(claim)).toEqual({ pendingTasks: true });
    // A sealed claim is released: it is fenced and the database is closed.
    expect(await store.handle(claim, request('r-1', 'mintId'))).toMatchObject({ ok: false, error: { code: 'fenced' } });
    expect(backend.closed).toBe(1);
    expect(await store.inspectPending(LINEAGE)).toEqual({ pendingTasks: true });
    backend.live.clear();
    expect(await store.inspectPending(LINEAGE)).toEqual({ pendingTasks: false });
    // Only tasks nobody asked to abort count as unfinished.
    expect(backend.queries.every((query) => query.abortRequested === false)).toBe(true);
    expect(new Set(backend.queries.map((query) => query.status))).toEqual(new Set(['pending', 'running', 'waiting']));
  });

  it('refuses a scan whose page size is not a bounded positive integer', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    expect(await store.handle(claim, request('s-1', 'scanTasks', [{ status: 'pending' }, MAX_STORAGE_SCAN_LIMIT, null])))
      .toMatchObject({ ok: true });
    for (const [index, limit] of [MAX_STORAGE_SCAN_LIMIT + 1, 0, -1, 2.5].entries()) {
      expect(await store.handle(claim, request(`s-bad-${index}`, 'scanTasks', [{ status: 'pending' }, limit, null])))
        .toMatchObject({ ok: false, error: { code: 'request' } });
    }
    expect(backend.queries).toHaveLength(1);
  });

  it('keeps the database open through a worker close, so the seal still sees unfinished tasks', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    backend.live.add('pending');
    expect(await store.handle(claim, request('close-1', 'close'))).toEqual({ type: 'storage_response', id: 'close-1', ok: true });
    expect(backend.closed).toBe(0);
    expect(await store.seal(claim)).toEqual({ pendingTasks: true });
    // The runner closes the database once, when the run's claim ends.
    expect(backend.closed).toBe(1);
  });

  it('reports no unfinished tasks for a superseded claim, an absent database, or a disabled store', async () => {
    const backend = fakeBackend();
    const store = await createStore({ loader: backend.loader });
    const first = await store.claim(LINEAGE, OWNER, 1, 0);
    await store.claim(LINEAGE, SUCCESSOR, 1, 1);
    backend.live.add('pending');
    expect(await store.seal(first)).toEqual({ pendingTasks: false });
    expect(await store.inspectPending(OWNER)).toEqual({ pendingTasks: false });
    const disabled = await createStore({ enabled: false, loader: backend.loader });
    expect(await disabled.inspectPending(LINEAGE)).toEqual({ pendingTasks: false });
  });

  it('refuses commits once the lineage database outgrows its cap, and keeps reads working', async () => {
    const backend = fakeBackend(600);
    const store = await createStore({ loader: backend.loader, maxLineageBytes: 1_000 });
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    expect(await store.handle(claim, request('r-1', 'commit', [[]]))).toMatchObject({ ok: true });
    expect(store.limitExceeded(claim)).toBe(false);
    // This commit lands, but leaves the database over the cap.
    expect(await store.handle(claim, request('r-2', 'commit', [[]]))).toMatchObject({ ok: true });
    expect(store.limitExceeded(claim)).toBe(true);
    expect(await store.handle(claim, request('r-3', 'commit', [[]]))).toMatchObject({ ok: false, error: { code: 'limit', retryable: false } });
    expect(backend.commits).toBe(2);
    expect(await store.handle(claim, request('r-4', 'mintId'))).toMatchObject({ ok: true });
  });

  it('refuses the first commit of a lineage already over its cap, as after a restart', async () => {
    const backend = fakeBackend(2_000);
    const dir = await stateDir();
    const before = new DurableSessionStore({ stateDir: dir, enabled: true, loader: backend.loader });
    const claim = await before.claim(LINEAGE, OWNER, 1, 0);
    await before.handle(claim, request('r-1', 'commit', [[]]));
    await before.close();
    const after = new DurableSessionStore({ stateDir: dir, enabled: true, loader: backend.loader, maxLineageBytes: 1_000 });
    stores.push(after);
    const resumed = await after.claim(LINEAGE, SUCCESSOR, 2, 1);
    expect(await after.handle(resumed, request('r-2', 'commit', [[]]))).toMatchObject({ ok: false, error: { code: 'limit' } });
    expect(after.limitExceeded(resumed)).toBe(true);
    expect(backend.commits).toBe(1);
  });

  it('deletes every listed lineage once', async () => {
    const dir = await stateDir();
    const store = new DurableSessionStore({ stateDir: dir, enabled: true });
    stores.push(store);
    for (const lineage of [LINEAGE, SUCCESSOR]) {
      const claim = await store.claim(lineage, OWNER, 1, 0);
      await store.handle(claim, request('r-1', 'mintId'));
    }
    await store.deleteLineages([LINEAGE, SUCCESSOR, LINEAGE]);
    expect(existsSync(join(dir, `${LINEAGE}.sqlite`))).toBe(false);
    expect(existsSync(join(dir, `${SUCCESSOR}.sqlite`))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps the database and its directory private to the runner user', async () => {
    // POSIX permission bits; Windows ACLs do not map onto these modes.
    const dir = await stateDir();
    const store = new DurableSessionStore({ stateDir: dir, enabled: true });
    stores.push(store);
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    await store.handle(claim, request('r-1', 'mintId'));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${LINEAGE}.sqlite`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, `${LINEAGE}.owner.json`))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('keeps the write-ahead log and shared-memory files private after a write', async () => {
    // POSIX permission bits; Windows ACLs do not map onto these modes.
    const dir = await stateDir();
    const store = new DurableSessionStore({ stateDir: dir, enabled: true });
    stores.push(store);
    const claim = await store.claim(LINEAGE, OWNER, 1, 0);
    const previous = process.umask(0o022);
    try {
      expect(await store.handle(claim, request('c-1', 'commit', [[]]))).toMatchObject({ ok: true });
    } finally {
      process.umask(previous);
    }
    for (const suffix of ['-wal', '-shm']) {
      expect((await stat(join(dir, `${LINEAGE}.sqlite${suffix}`))).mode & 0o777).toBe(0o600);
    }
  });
});
