import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ShortcutHandlers, useGlobalShortcuts } from './use-global-shortcuts';

function press(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function handlers(searchVisible: boolean): ShortcutHandlers {
  return { togglePalette: vi.fn(), toggleSidebar: vi.fn(), focusSearch: vi.fn(() => searchVisible) };
}

describe('useGlobalShortcuts', () => {
  it('consumes `/` only when a search box took focus', () => {
    const visible = handlers(true);
    const { unmount } = renderHook(() => useGlobalShortcuts(visible));
    expect(press('/').defaultPrevented).toBe(true);
    unmount();

    const hidden = handlers(false);
    renderHook(() => useGlobalShortcuts(hidden));
    const event = press('/');
    expect(hidden.focusSearch).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores every shortcut inside a terminal', () => {
    const all = handlers(true);
    renderHook(() => useGlobalShortcuts(all));
    const terminal = document.createElement('div');
    terminal.setAttribute('data-terminal', '');
    const input = document.createElement('textarea');
    terminal.append(input);
    document.body.append(terminal);
    press('/', input);
    press('[', input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(all.focusSearch).not.toHaveBeenCalled();
    expect(all.toggleSidebar).not.toHaveBeenCalled();
    expect(all.togglePalette).not.toHaveBeenCalled();
    terminal.remove();
  });
});
