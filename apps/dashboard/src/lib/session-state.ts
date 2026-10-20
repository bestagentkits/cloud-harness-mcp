import { useSyncExternalStore } from 'react';

/**
 * Whether the dashboard session ended (a 401 from the BFF that a fresh `/session`
 * bootstrap could not recover). Kept in memory only; the shell shows a reload banner
 * instead of letting each page render its own sign-in error.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let ended = false;

export function markSessionEnded(): void {
  if (ended) return;
  ended = true;
  for (const listener of listeners) listener();
}

export function isSessionEnded(): boolean {
  return ended;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionEnded(): boolean {
  return useSyncExternalStore(subscribe, isSessionEnded, () => false);
}

/** Test seam. */
export function resetSessionStateForTests(): void {
  ended = false;
}
