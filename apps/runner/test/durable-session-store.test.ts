import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDurableSessionFiles,
  DurableSessionStore,
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

function request(id: string, method: string, args: unknown[] = []): unknown {
  return { type: 'storage_request', id, method, args };
}

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
});
