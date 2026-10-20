/**
 * Recovers from a lazily loaded chunk that no longer exists, which happens when a deploy
 * replaces the hashed assets while a tab still runs the previous build. The fix is one full
 * reload, which fetches the new `index.html`. The guard is keyed by the running build (the
 * hashed entry URL), so a chunk that is still missing after the reload surfaces as an error
 * instead of reloading in a loop. There is deliberately no fallback to previous-release assets.
 */
const STORAGE_KEY = 'ch-dashboard-chunk-reload';
const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** This module is bundled into the hashed entry chunk, so its URL changes with every build. */
const RUNNING_BUILD = import.meta.url;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

type ReloadOptions = { build?: string; storage?: Pick<Storage, 'getItem' | 'setItem'>; reload?: () => void };

/** Reloads the page unless this build already reloaded once in this tab. Returns whether it reloaded. */
export function reloadOnceForChunkError({
  build = RUNNING_BUILD,
  storage = window.sessionStorage,
  reload = () => window.location.reload()
}: ReloadOptions = {}): boolean {
  try {
    if (storage.getItem(STORAGE_KEY) === build) return false;
    storage.setItem(STORAGE_KEY, build);
  } catch {
    // Without storage the guard cannot hold, so never reload rather than risk a loop.
    return false;
  }
  reload();
  return true;
}

/** Vite dispatches `vite:preloadError` when a dynamic import or its preloaded CSS fails. */
export function installChunkReload(target: Window = window, options: ReloadOptions = {}): void {
  target.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForChunkError(options)) event.preventDefault();
  });
}
