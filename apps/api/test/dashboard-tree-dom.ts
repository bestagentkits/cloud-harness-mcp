import { vi } from 'vitest';

/**
 * A minimal element tree for driving a dashboard controller that renders markup
 * and then queries it. `FakeElement` keeps markup as a string, which is enough
 * for controllers that never look inside what they render; the model wizard does,
 * so this double parses the trusted renderer output into elements that support
 * the selectors the controller uses: tag, `#id`, `[attr]`, `[attr="value"]`, and
 * the descendant combinator. Element identity changes only when a region is
 * re-rendered, which is what focus-loss tests need to observe.
 */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

type Listener = (event: any) => void;

export class TreeElement {
  readonly attributes = new Map<string, string>();
  children: TreeElement[] = [];
  parent: TreeElement | null = null;
  value = '';
  checked = false;
  hidden = false;
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  focus = vi.fn();
  private ownText = '';
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly tag: string, attributes: Array<[string, string]> = []) {
    for (const [name, value] of attributes) this.attributes.set(name, value);
    this.value = this.attributes.get('value') ?? '';
    this.checked = this.attributes.has('checked');
    this.hidden = this.attributes.has('hidden');
    this.disabled = this.attributes.has('disabled');
    for (const [name, value] of this.attributes) {
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    }
  }

  get id() { return this.attributes.get('id') ?? ''; }
  get name() { return this.attributes.get('name') ?? ''; }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.children = []; this.ownText = value; }

  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }

  /** Replaces the children with parsed markup, the way the dashboard's `insertRendered` does. */
  render(markup: string) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.ownText = '';
    parseInto(this, markup);
  }

  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+/);
    if (!matchesCompound(this, parts[parts.length - 1])) return false;
    let index = parts.length - 2;
    let ancestor = this.parent;
    while (index >= 0 && ancestor) {
      if (matchesCompound(ancestor, parts[index])) index -= 1;
      ancestor = ancestor.parent;
    }
    return index < 0;
  }

  closest(selector: string): TreeElement | null {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  querySelectorAll(selector: string): TreeElement[] {
    const found: TreeElement[] = [];
    const visit = (node: TreeElement) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } };
    visit(this);
    return found;
  }

  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }

  showModal() { this.open = true; }
  /** Like a real dialog, closing fires `close` once. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch('close', {});
  }
}

function matchesCompound(node: TreeElement, compound: string) {
  const tag = /^[a-z][\w-]*/i.exec(compound)?.[0];
  if (tag && tag.toLowerCase() !== node.tag) return false;
  for (const [, id] of compound.matchAll(/#([\w-]+)/g)) if (node.id !== id) return false;
  for (const [, name, value] of compound.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!node.attributes.has(name)) return false;
    if (value !== undefined && node.attributes.get(name) !== value) return false;
  }
  return true;
}

function parseInto(root: TreeElement, markup: string) {
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  for (const match of markup.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (match[1]) {
      const tag = match[1].toLowerCase();
      const index = stack.map((node) => node.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
    } else if (match[2]) {
      const attributes = [...(match[3] ?? '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, decode(value ?? '')] as [string, string]);
      const node = new TreeElement(match[2].toLowerCase(), attributes);
      node.parent = top;
      top.children.push(node);
      if (!VOID_ELEMENTS.has(node.tag)) stack.push(node);
    } else if (match[4]) {
      const text = new TreeElement('#text');
      text.textContent = decode(match[4]);
      text.parent = top;
      top.children.push(text);
    }
  }
}
