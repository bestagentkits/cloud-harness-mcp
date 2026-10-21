import { expect, type Page, type Request } from '@playwright/test';
import { answer, type ReadHandler } from './support';

/**
 * Helpers for the write-path suites. `stubBff` answers runner-backed reads and writes like
 * `stubReads`, but records every write (method, path, JSON body, CSRF header) so a test can
 * assert the exact body the classic Dashboard sends. `/session`, `/profile` and
 * `/preferences` stay real, so the CSRF token in a recorded write is the real in-process
 * BFF's token. `watchForLeaks` collects everything a secret could leak into.
 */

const API = '/dashboard/api/v1';
const SERVED_BY_API = new Set(['/session', '/profile', '/preferences']);

export type RecordedWrite = { method: string; path: string; body: unknown; csrf: string | undefined };

function parseBody(request: Request): unknown {
  const raw = request.postData();
  if (raw === null) return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

/**
 * `reads` maps a path to its answer (a list of handlers is used in order, the last one
 * repeating); `writes` maps `METHOD /path` to its answer, defaulting to `200 {data:{}}`.
 */
export async function stubBff(page: Page, { reads = {}, writes = {} }: {
  reads?: Record<string, ReadHandler | ReadHandler[]>;
  writes?: Record<string, ReadHandler | ReadHandler[]>;
} = {}): Promise<RecordedWrite[]> {
  // A write stub is keyed `METHOD /path`; a bare path would never match and silently fall
  // back to the default answer, so it fails the test instead.
  for (const key of Object.keys(writes)) {
    if (!/^(POST|PUT|PATCH|DELETE) \//.test(key)) throw new Error(`Write stub "${key}" must be keyed "METHOD /path".`);
  }
  const recorded: RecordedWrite[] = [];
  const calls = new Map<string, number>();
  const pick = (handler: ReadHandler | ReadHandler[] | undefined, key: string) => {
    const count = calls.get(key) ?? 0;
    calls.set(key, count + 1);
    return Array.isArray(handler) ? handler[Math.min(count, handler.length - 1)] : handler;
  };
  await page.route(`**${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(API.length);
    if (SERVED_BY_API.has(path)) return route.fallback();
    const method = request.method();
    if (method === 'GET') {
      return (pick(reads[path], path) ?? answer(200))(route);
    }
    recorded.push({ method, path, body: parseBody(request), csrf: request.headers()['x-csrf-token'] });
    const key = `${method} ${path}`;
    return (pick(writes[key], key) ?? answer(200, { data: {} }))(route);
  });
  return recorded;
}

/** The writes to `path` (any method), in order. */
export const writesTo = (recorded: RecordedWrite[], method: string, path: string) =>
  recorded.filter((entry) => entry.method === method && entry.path === path);

/**
 * Watches every place a secret may not appear: console output, read responses, and (on
 * `assertClean`) the DOM including form values, Web Storage, IndexedDB names, Cache Storage
 * and cookies. The TanStack Query cache is checked by the unit tests (`one-time-reveal.test.tsx`).
 */
export function watchForLeaks(page: Page) {
  const consoleText: string[] = [];
  const responses: Promise<string>[] = [];
  page.on('console', (message) => consoleText.push(message.text()));
  page.on('response', (response) => {
    // Reads only: a create legitimately answers with its one-time key, and nothing read after it may.
    if (response.url().includes('/dashboard/') && response.request().method() === 'GET') responses.push(response.text().catch(() => ''));
  });
  return {
    async assertClean(secret: string) {
      expect(consoleText.filter((line) => line.includes(secret))).toEqual([]);
      const bodies = await Promise.all(responses);
      expect(bodies.filter((body) => body.includes(secret))).toEqual([]);
      const surfaces = await page.evaluate(async () => {
        const values = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map((field) => field.value);
        const storage = (store: Storage) => Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`).join('\n');
        const databases = 'databases' in indexedDB ? (await indexedDB.databases()).map((entry) => entry.name ?? '') : [];
        // Cache Storage: every cached request URL and response body (the Dashboard keeps none).
        const cached: string[] = [];
        for (const name of await caches.keys()) {
          cached.push(name);
          const cache = await caches.open(name);
          for (const request of await cache.keys()) {
            cached.push(request.url, await (await cache.match(request))?.text() ?? '');
          }
        }
        return { html: document.documentElement.outerHTML, values, session: storage(sessionStorage), local: storage(localStorage), databases, cached, cookie: document.cookie };
      });
      expect(surfaces.html).not.toContain(secret);
      expect(surfaces.values.filter((value) => value.includes(secret))).toEqual([]);
      expect(surfaces.session).not.toContain(secret);
      expect(surfaces.local).not.toContain(secret);
      expect(surfaces.databases.join(',')).not.toContain(secret);
      expect(surfaces.cached.filter((entry) => entry.includes(secret))).toEqual([]);
      expect(surfaces.cookie).not.toContain(secret);
    }
  };
}
