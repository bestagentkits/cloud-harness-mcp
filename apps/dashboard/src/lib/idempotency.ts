import { useCallback, useRef } from 'react';

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * One idempotency key per operator intent. The key is created once when the form opens,
 * kept across every retry of the same submission (a timeout or a lost answer cannot deliver
 * the message twice), and renewed only after the server accepted it, so the next intent is
 * a new delivery.
 */
export function useIdempotencyKey(): { current: () => string; renew: () => void } {
  const key = useRef<string | null>(null);
  const current = useCallback(() => {
    key.current ??= newKey();
    return key.current;
  }, []);
  const renew = useCallback(() => { key.current = newKey(); }, []);
  return { current, renew };
}
