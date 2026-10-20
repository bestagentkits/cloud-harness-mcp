import { useCallback, useEffect, useRef, useState } from 'react';

/** Prefix for wizard restore entries in `sessionStorage`. */
export const RESTORE_STORAGE_PREFIX = 'ch-dashboard-restore:';

function read(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(RESTORE_STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) as unknown : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) window.sessionStorage.removeItem(RESTORE_STORAGE_PREFIX + key);
    else window.sessionStorage.setItem(RESTORE_STORAGE_PREFIX + key, JSON.stringify(value));
  } catch { /* storage unavailable or full: restore is a convenience, not a requirement */ }
}

/**
 * Wizard step state that survives a reload of the tab (ADR 0005 "non-secret UI state
 * restore"). `parse` is the allowlist: it must accept only non-secret fields (step,
 * choices, names) and return `undefined` for anything else, so a key, token or secret
 * value can never be written or read back. Forms that take secret values keep them out of
 * this state entirely. `clear` removes the entry (on finish or cancel).
 */
export function useRestorableState<T>(key: string, parse: (raw: unknown) => T | undefined, initial: () => T) {
  const [state, setState] = useState<T>(() => parse(read(key)) ?? initial());
  // After `clear`, the reset value itself is not written back: nothing is stored until the
  // operator makes a new choice. Comparing against the reset value (instead of a one-shot
  // flag) also holds when `clear` runs while the state already equals it.
  const cleared = useRef<{ value: T } | null>(null);
  useEffect(() => {
    if (cleared.current && Object.is(cleared.current.value, state)) return;
    cleared.current = null;
    write(key, state);
  }, [key, state]);
  const clear = useCallback(() => {
    write(key, undefined);
    const reset = initial();
    cleared.current = { value: reset };
    setState(reset);
  }, [initial, key]);
  return [state, setState, clear] as const;
}

/** Drops a restore entry without a mounted hook (e.g. after a successful submit elsewhere). */
export function clearRestorableState(key: string): void {
  write(key, undefined);
}
