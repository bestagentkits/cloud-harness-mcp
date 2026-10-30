/**
 * Recovers from a lazily loaded chunk that no longer exists, which happens when a deploy
 * replaces the hashed assets while a tab still runs the previous build. The fix is one full
 * reload, which fetches the new `index.html`. There is deliberately no fallback to
 * previous-release assets.
 *
 * Exactly one reload, with one shared guard:
 * - a route chunk that fails to import reaches TanStack's `lazyRouteComponent`, which
 *   reloads once under `tanstack_router_reload:<message>`;
 * - anything else (a CSS preload, a later failure) reaches the router error page, which
 *   calls `reloadOnceForChunkError`. It checks and sets both TanStack's key and its own
 *   per-build key, so neither path reloads after the other already did.
 * Vite's `vite:preloadError` is left alone: cancelling it would hide the failure from
 * both guards and let the import resolve to `undefined`.
 */
const STORAGE_KEY = 'ch-dashboard-chunk-reload';
const ROUTER_KEY_PREFIX = 'tanstack_router_reload:';
const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** This module is bundled into the hashed entry chunk, so its URL changes with every build. */
const RUNNING_BUILD = import.meta.url;

export function isChunkLoadError(error: unknown): error is Error {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

type ReloadOptions = { build?: string; storage?: Pick<Storage, 'getItem' | 'setItem'>; reload?: () => void };

/**
 * Reloads the page unless this build, or TanStack's lazy-route guard for the same error,
 * already reloaded once in this tab. Returns whether it reloaded.
 */
export function reloadOnceForChunkError(error: Error, {
  build = RUNNING_BUILD,
  storage = window.sessionStorage,
  reload = () => window.location.reload()
}: ReloadOptions = {}): boolean {
  const routerKey = `${ROUTER_KEY_PREFIX}${error.message}`;
  try {
    if (storage.getItem(STORAGE_KEY) === build || storage.getItem(routerKey)) return false;
    storage.setItem(STORAGE_KEY, build);
    storage.setItem(routerKey, '1');
  } catch {
    // Without storage the guard cannot hold, so never reload rather than risk a loop.
    return false;
  }
  reload();
  return true;
}
