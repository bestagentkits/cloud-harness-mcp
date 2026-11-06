/**
 * The terminal emulator chunk. This module and the xterm packages it imports form the one
 * heavy lazy chunk named `xterm` (`scripts/build-output-check.mjs` `LAZY_HEAVY`); it loads
 * only when an operator starts or re-attaches a terminal.
 *
 * CSP: xterm's DOM renderer writes its theme and cell metrics into `<style>` elements and
 * sets true-colour cells with `setAttribute('style', …)`. The Dashboard CSP (`style-src
 * 'self'` plus a nonce, no `unsafe-inline`) blocks both. Instead of patching the global
 * `document` (as the classic shell does), the emulator gets its own `documentOverride`: a
 * view of the real document whose `createElement` routes those two paths through CSSOM,
 * which the CSP permits. A created `<style>` is an inert element whose text becomes a
 * constructed stylesheet adopted by the document until the element is removed; a `style`
 * attribute set on an element the emulator created becomes `style.cssText`. Nothing outside
 * the emulator sees the adapter, and markup-delivered styles stay blocked.
 *
 * xterm 6.0.0 does not use the override everywhere: its scrollbar `<style>` comes from the
 * real document (an operator-precedence slip in `open()`), and its DOM row factory builds cell
 * spans from the global `document`. So `open()` runs with the real document's `createElement`
 * pointed at the view for that one synchronous call (restored before it returns, so no other
 * code ever sees it), and `scopeRowFactory` points the row factory at the view afterwards.
 * The package is pinned exactly; `e2e/terminal.spec.ts` fails on an upgrade that moves either
 * (truecolour cells would lose their colour, and the CSP violations are console errors).
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/** The `<style>` stand-in: xterm only sets `textContent` and calls `remove()` on it. */
function cssomStyleElement(documentRef: Document): HTMLElement {
  const element = nativeCreateElement.call(documentRef, 'template');
  const sheet = new CSSStyleSheet();
  let css = '';
  let adopted = false;
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get: () => css,
    set: (value: unknown) => {
      css = String(value ?? '');
      sheet.replaceSync(css);
      if (!adopted) { documentRef.adoptedStyleSheets = [...documentRef.adoptedStyleSheets, sheet]; adopted = true; }
    }
  });
  const remove = element.remove.bind(element);
  Object.defineProperty(element, 'remove', {
    configurable: true,
    value: () => {
      documentRef.adoptedStyleSheets = documentRef.adoptedStyleSheets.filter((entry) => entry !== sheet);
      adopted = false;
      remove();
    }
  });
  return element;
}

/** `setAttribute('style', …)` through CSSOM on one emulator-created element. */
function routeStyleAttribute(element: Element): Element {
  const setAttribute = element.setAttribute.bind(element);
  Object.defineProperty(element, 'setAttribute', {
    configurable: true,
    value: (name: string, value: string) => {
      if (name.toLowerCase() === 'style' && 'style' in element) { (element as HTMLElement).style.cssText = String(value); return; }
      setAttribute(name, value);
    }
  });
  return element;
}

/**
 * The emulator's document. xterm checks `instanceof Document`, which a Proxy keeps because
 * its prototype is the real document's; every method runs bound to the real document.
 */
const nativeCreateElement = Document.prototype.createElement;

export function cspSafeDocument(documentRef: Document): Document {
  const createElement = (name: string, options?: ElementCreationOptions) => {
    if (name.toLowerCase() === 'style') return cssomStyleElement(documentRef);
    return routeStyleAttribute(nativeCreateElement.call(documentRef, name, options));
  };
  return new Proxy(documentRef, {
    get(target, property) {
      if (property === 'createElement') return createElement;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

/** Resolve a token to `#rrggbb` or `rgba(...)`: xterm does not parse `oklch()`. */
function colorResolver(documentRef: Document) {
  const canvas = documentRef.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const styles = getComputedStyle(documentRef.documentElement);
  return (token: string, fallback: string) => {
    const value = styles.getPropertyValue(token).trim();
    if (!value || !context) return fallback;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = fallback;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 255] = context.getImageData(0, 0, 1, 1).data;
    if (alpha < 255) return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`;
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };
}

/** The xterm theme from the live Dashboard tokens (`src/styles/tokens.css`), so every theme follows. */
export function readTerminalTheme(documentRef: Document = document): ITheme {
  const color = colorResolver(documentRef);
  return {
    background: color('--surface', 'black'),
    foreground: color('--surface-foreground', 'white'),
    cursor: color('--ring', 'white'),
    cursorAccent: color('--surface', 'black'),
    selectionBackground: color('--accent', 'gray'),
    selectionForeground: color('--accent-foreground', 'white'),
    black: color('--border', 'black'),
    red: color('--destructive', 'red'),
    green: color('--success', 'green'),
    yellow: color('--warning', 'olive'),
    blue: color('--info', 'blue'),
    magenta: color('--info', 'purple'),
    cyan: color('--ring', 'teal'),
    white: color('--muted-foreground', 'silver'),
    brightBlack: color('--muted-foreground', 'gray'),
    brightRed: color('--destructive', 'red'),
    brightGreen: color('--success', 'lime'),
    brightYellow: color('--warning', 'yellow'),
    brightBlue: color('--info', 'blue'),
    brightMagenta: color('--info', 'fuchsia'),
    brightCyan: color('--ring', 'aqua'),
    brightWhite: color('--foreground', 'white')
  };
}

/** Point the DOM renderer's row factory at the emulator's document (see the module comment). */
function scopeRowFactory(term: Terminal, documentView: Document): boolean {
  const core = (term as unknown as { _core?: { _renderService?: { _renderer?: { value?: { _rowFactory?: { _document?: unknown } } } } } })._core;
  const factory = core?._renderService?._renderer?.value?._rowFactory;
  if (!factory || !('_document' in factory)) return false;
  factory._document = documentView;
  return true;
}

export type EmulatorCallbacks = {
  onData: (text: string) => void;
  onBinary: (binary: string) => void;
  /** The release chord was pressed: move focus out of the emulator. */
  onRelease: () => void;
};

export type Emulator = {
  readonly cols: number;
  readonly rows: number;
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  focus: () => void;
  /** Fit to the host's size; returns the resulting grid. */
  fit: () => { cols: number; rows: number };
  dispose: () => void;
};

/** Open an emulator in `host`, which must be attached to the document. */
export function createEmulator(host: HTMLElement, callbacks: EmulatorCallbacks): Emulator {
  const documentRef = host.ownerDocument;
  const view = documentRef.defaultView ?? window;
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fontFamily = getComputedStyle(documentRef.documentElement).getPropertyValue('--font-family-mono').trim() || 'monospace';
  const documentView = cspSafeDocument(documentRef);
  const term = new Terminal({
    documentOverride: documentView,
    cursorBlink: !reducedMotion,
    fontFamily,
    fontSize: 13,
    scrollback: 5_000,
    // Output colours are the program's; xterm lifts any that would fall below WCAG AA text contrast.
    minimumContrastRatio: 4.5,
    theme: readTerminalTheme(documentRef)
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Only for this synchronous call; see the module comment.
  Object.defineProperty(documentRef, 'createElement', { configurable: true, writable: true, value: documentView.createElement });
  try {
    term.open(host);
  } finally {
    delete (documentRef as { createElement?: unknown }).createElement;
  }
  scopeRowFactory(term, documentView);
  fitAddon.fit();
  const subscriptions = [term.onData(callbacks.onData), term.onBinary(callbacks.onBinary)];
  // Tab and Escape belong to the shell; this one chord leaves the emulator.
  term.attachCustomKeyEventHandler((event) => {
    if (event.ctrlKey && event.shiftKey && event.key === 'F6') {
      if (event.type === 'keydown') {
        event.preventDefault();
        callbacks.onRelease();
      }
      return false;
    }
    return true;
  });
  const retheme = () => { term.options.theme = readTerminalTheme(documentRef); };
  const themeObserver = new view.MutationObserver(retheme);
  themeObserver.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-contrast'] });
  const scheme = view.matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', retheme);
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    write: (data) => term.write(data),
    reset: () => term.reset(),
    focus: () => term.focus(),
    fit: () => {
      fitAddon.fit();
      return { cols: term.cols, rows: term.rows };
    },
    dispose: () => {
      themeObserver.disconnect();
      scheme.removeEventListener('change', retheme);
      for (const subscription of subscriptions) subscription.dispose();
      term.dispose();
    }
  };
}
