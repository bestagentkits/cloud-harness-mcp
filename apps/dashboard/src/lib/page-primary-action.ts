import { useEffect, useSyncExternalStore } from 'react';
import type { PageId } from '@/app/page-registry';

/**
 * Lets a page own its registry-declared primary action. The shell renders the header
 * button in the same frame as the click (it never waits for page code), and a page that
 * has a real handler registers it here; until then the header keeps its classic-Dashboard
 * link dialog. The registration carries no data, only the handler and its enabled state.
 */
export type PagePrimaryAction = {
  onSelect: () => void;
  /** A short reason shown as the button's description when the action is unavailable. */
  disabledReason?: string | undefined;
};

const actions = new Map<PageId, PagePrimaryAction>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Registers the page's primary action while the page is mounted. */
export function usePagePrimaryAction(pageId: PageId, action: PagePrimaryAction): void {
  const { onSelect, disabledReason } = action;
  useEffect(() => {
    actions.set(pageId, { onSelect, disabledReason });
    emit();
    return () => {
      if (actions.get(pageId)?.onSelect === onSelect) actions.delete(pageId);
      emit();
    };
  }, [pageId, onSelect, disabledReason]);
}

/** The header's view: the page's registered action, or undefined for the fallback dialog. */
export function useRegisteredPrimaryAction(pageId: PageId): PagePrimaryAction | undefined {
  return useSyncExternalStore(subscribe, () => actions.get(pageId), () => undefined);
}
