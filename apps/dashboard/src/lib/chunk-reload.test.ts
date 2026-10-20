import { describe, expect, it, vi } from 'vitest';
import { installChunkReload, isChunkLoadError, reloadOnceForChunkError } from './chunk-reload';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

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
    expect(reloadOnceForChunkError({ build: 'build-a', storage, reload })).toBe(true);
    expect(reloadOnceForChunkError({ build: 'build-a', storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // A newer deploy may legitimately need its own reload.
    expect(reloadOnceForChunkError({ build: 'build-b', storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when the guard cannot be stored', () => {
    const reload = vi.fn();
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(reloadOnceForChunkError({ build: 'build-a', storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('handles vite:preloadError once and lets a repeat failure surface', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    installChunkReload(window, { build: 'build-c', storage, reload });
    const first = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
