import { useEffect } from 'react';

/** Terminal surfaces own every keystroke (xterm.js, or any element marked `data-terminal`). */
export function isInTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-terminal], .xterm'));
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export type ShortcutHandlers = {
  /** Ctrl/Cmd+K, also from text fields (it is not a text-editing chord), never from a terminal. */
  togglePalette: () => void;
  /** `[` outside text fields and terminals. */
  toggleSidebar: () => void;
  /** `/` outside text fields and terminals; returns false (the key is left alone) when no search box is visible. */
  focusSearch: () => boolean;
};

/**
 * Global keyboard shortcuts. None fires while focus is in a terminal, so shell programs
 * keep Ctrl+K (kill line) and every other key; the single-key shortcuts also stay out of
 * text fields.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || isInTerminal(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        handlers.togglePalette();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      if (event.key === '[') { event.preventDefault(); handlers.toggleSidebar(); }
      else if (event.key === '/' && handlers.focusSearch()) event.preventDefault();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
