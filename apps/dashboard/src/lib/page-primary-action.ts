import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The page header's primary action. The header owns the button (label from the page
 * registry, same place on every page); a page that implements the action registers a
 * handler while it is mounted. With no handler the header falls back to the classic
 * Dashboard hand-off dialog, so a page that has not moved yet still has a working button.
 */
export type PrimaryActionHandler = { run: () => void; disabled?: boolean };

let current: { pageId: string; handler: { current: PrimaryActionHandler } } | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Register `handler` as `pageId`'s primary action for as long as the caller is mounted. */
export function usePagePrimaryAction(pageId: string, handler: PrimaryActionHandler): void {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  const disabled = handler.disabled ?? false;
  useEffect(() => {
    const entry = { pageId, handler: ref };
    current = entry;
    emit();
    return () => {
      if (current === entry) { current = null; emit(); }
    };
  }, [pageId]);
  // Re-render the header when only `disabled` changes.
  useEffect(() => { emit(); }, [disabled]);
}

let snapshot: { pageId: string; disabled: boolean } | null = null;
function getSnapshot() {
  const next = current ? { pageId: current.pageId, disabled: current.handler.current.disabled ?? false } : null;
  if (next?.pageId !== snapshot?.pageId || next?.disabled !== snapshot?.disabled) snapshot = next;
  return snapshot;
}

/** The header's view: whether `pageId` registered a handler, and a runner for it. */
export function useRegisteredPrimaryAction(pageId: string): { registered: boolean; disabled: boolean; run: () => void } {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const registered = state?.pageId === pageId;
  return {
    registered,
    disabled: registered ? state.disabled : false,
    run: () => { if (current?.pageId === pageId) current.handler.current.run(); }
  };
}
