import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, reloadOnceForChunkError } from './chunk-reload';

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const MISSING = new Error('Failed to fetch dynamically imported module: https://h/dashboard/assets/index-AbCdEf12.js');

describe('chunk reload guard', () => {
  it('recognises chunk load failures from each browser engine', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://h/dashboard/assets/index-AbCdEf12.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Unable to preload CSS for /dashboard/assets/style-AbCdEf12.css'
    ]) expect(isChunkLoadError(new Error(message)), message).toBe(true);
    expect(isChunkLoadError(new Error('Request failed with status 500'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('reloads once per build and never loops', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadOnceForChunkError(MISSING, { build: 'build-a', storage, reload })).toBe(true);
    expect(reloadOnceForChunkError(new Error('Unable to preload CSS for x'), { build: 'build-a', storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shares the guard with TanStack lazy-route reloads in both directions', () => {
    // TanStack already reloaded for this error: the error page must not reload again.
    const afterRouter = memoryStorage();
    afterRouter.setItem(`tanstack_router_reload:${MISSING.message}`, '1');
    const reload = vi.fn();
    expect(reloadOnceForChunkError(MISSING, { build: 'build-b', storage: afterRouter, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // The error page reloaded first: TanStack's key is set so it will not reload either.
    const first = memoryStorage();
    expect(reloadOnceForChunkError(MISSING, { build: 'build-b', storage: first, reload })).toBe(true);
    expect(first.values.get(`tanstack_router_reload:${MISSING.message}`)).toBe('1');
  });

  it('does not reload when the guard cannot be stored', () => {
    const reload = vi.fn();
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(reloadOnceForChunkError(MISSING, { build: 'build-a', storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
