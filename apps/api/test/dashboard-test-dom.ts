import { vi } from 'vitest';

/**
 * The test environment has no DOM parser. Installing one here keeps the dashboard
 * client on a single parse path (`DOMParser` + `replaceChildren`) instead of
 * carrying a test-only raw-HTML fallback in shipped code.
 */
if (typeof (globalThis as { DOMParser?: unknown }).DOMParser !== 'function') {
  (globalThis as { DOMParser?: unknown }).DOMParser = class {
    parseFromString(markup: string) { return { body: { childNodes: [{ markup }] } }; }
  };
}

/**
 * The shared element double the dashboard suites drive controllers with.
 *
 * It lives here rather than inside one suite because the behaviour, skills, and mount suites all need
 * the same shape, and three copies would drift the moment one of them gains a method the controllers
 * call. It deliberately models only what the controllers actually touch.
 */
export class FakeElement {
  hidden = false;
  inert = false;
  disabled = false;
  open = false;
  textContent = '';
  value = '';
  items: FakeElement[] = [];
  bounds?: { top: number; bottom: number; left: number; right: number };
  focus = vi.fn();
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  /** The controllers adopt parsed nodes; the double keeps their markup for assertions. */
  replaceChildren(...nodes: Array<{ markup?: string }>) { this.markup = nodes.map((node) => node.markup ?? '').join(''); }
  markup = '';
  /** Markup adopted through `replaceChildren` is readable as `innerHTML`, so suites can assert on it. */
  set innerHTML(value: string) { this.markup = value; }
  get innerHTML() { return this.markup; }
  querySelectorAll() { return this.items; }
  getBoundingClientRect() { return this.bounds; }
  addEventListener(name: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(name) ?? new Set(); listeners.add(listener); this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string, event: any) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
