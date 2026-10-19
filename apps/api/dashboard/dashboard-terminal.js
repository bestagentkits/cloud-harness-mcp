/**
 * The Dashboard Terminal: an xterm.js emulator wired to a runner PTY through the dashboard BFF.
 *
 * The module splits in two. `createTerminalSession` is the protocol controller (open, long-poll output,
 * ordered input, resize, close, and the truthful lifecycle states) and touches no DOM, so it is driven by
 * fakes in `apps/api/test/dashboard-terminal.test.ts`. `mountTerminalPane` owns the browser side: it loads
 * the emulator lazily from this release's asset namespace, maps the dashboard theme onto it, and keeps the
 * keyboard escapable.
 */
import { TERMINAL_RELEASE_SHORTCUT, terminalStatusDetail, terminalStatusLabel } from './dashboard-render.js';

/** The longest a read parks on the runner. The BFF clamps it again to its own runner timeout. */
export const TERMINAL_WAIT_MS = 25_000;
/** Raw bytes per input request: a large paste is split, in order, well under the request body limit. */
export const TERMINAL_INPUT_CHUNK_BYTES = 16_384;
const INPUT_RETRY_LIMIT = 6;
/** Consecutive transient read failures (about a minute of backoff) before the pane stops polling. */
export const READ_RETRY_LIMIT = 8;
/** Network failure (0) and throttling; every 5xx is retried as well. */
const RETRYABLE_STATUSES = new Set([0, 429]);
/** The workspace behind the terminal ended (closed, expired, or reaped): the PTY went with its executor. */
export const TERMINAL_WORKSPACE_ENDED_MESSAGE = 'This terminal ended with its workspace, which was closed or expired. Renew or recover the workspace, then start a new session.';
const RESIZE_DEBOUNCE_MS = 150;
/** A read that returns empty this quickly means the long-poll is not parking; back off instead of spinning. */
const EMPTY_READ_FLOOR_MS = 250;

const PHASE_BY_STATUS = { running: 'running', exited: 'exited', closed: 'closed', timed_out: 'timed_out', failed: 'failed' };

export function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return globalThis.btoa(binary);
}

export function base64ToBytes(value) {
  const binary = globalThis.atob(String(value ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Keystrokes and pastes arrive as text; the PTY takes UTF-8 bytes. */
export const encodeTerminalText = (text) => new globalThis.TextEncoder().encode(String(text ?? ''));
/** xterm's binary events (some mouse reports) are byte strings: one char code per byte. */
export const encodeTerminalBinary = (binary) => Uint8Array.from(String(binary ?? ''), (character) => character.charCodeAt(0) & 0xff);

/** A visible, dim line telling the operator the replay is incomplete instead of silently skipping output. */
export function missedOutputNotice(missedBytes) {
  // Reset first so attributes left by earlier output never restyle the notice.
  return `\x1b[0m\x1b[2m[${Number(missedBytes).toLocaleString('en-US')} bytes of earlier output are no longer retained and were skipped]\x1b[0m\r\n`;
}

/** Take up to `limit` bytes from the front of the queue, preserving order and splitting the last chunk. */
export function takeInputChunk(queue, limit = TERMINAL_INPUT_CHUNK_BYTES) {
  const parts = [];
  let size = 0;
  while (queue.length && size < limit) {
    const next = queue[0];
    const room = limit - size;
    if (next.length <= room) { parts.push(queue.shift()); size += next.length; continue; }
    parts.push(next.subarray(0, room));
    queue[0] = next.subarray(room);
    size += room;
  }
  const chunk = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { chunk.set(part, offset); offset += part.length; }
  return chunk;
}

/** The BFF calls for one workspace. Every path segment is encoded; the body never names a principal. */
export function createTerminalClient(api, workspaceId) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/terminals`;
  const scoped = (terminalId) => `${base}/${encodeURIComponent(terminalId)}`;
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  return {
    list: () => api(base),
    open: (body) => post(base, body),
    read: (terminalId, cursor, waitMs, signal) => api(`${scoped(terminalId)}/output?${new URLSearchParams({ cursor: String(cursor), waitMs: String(waitMs) })}`, { signal }),
    input: (terminalId, data) => post(`${scoped(terminalId)}/input`, { data }),
    resize: (terminalId, cols, rows) => post(`${scoped(terminalId)}/resize`, { cols, rows }),
    close: (terminalId) => post(`${scoped(terminalId)}/close`, {})
  };
}

const defaultDelay = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
const statusOf = (error) => (Number.isInteger(error?.status) ? error.status : 0);
const isAbort = (error) => error?.name === 'AbortError';
/** A `retryable` flag from the server wins when present; otherwise only throttling, 5xx, and network errors retry. */
const isRetryable = (error) => (typeof error?.retryable === 'boolean' ? error.retryable : RETRYABLE_STATUSES.has(statusOf(error)) || statusOf(error) >= 500);
/** 404: the runner forgot the terminal. 410: its workspace ended. Neither can come back. */
const isGone = (status) => status === 404 || status === 410;

/**
 * One terminal session. States are only ever derived from what the runner reported: a 404 (terminal gone) or
 * 410 (workspace ended) turns the session `lost` and stops every loop, because a PTY the runner forgot
 * (including every PTY from before a runner restart) cannot be reconnected. A refused read (another 4xx) or
 * a transient failure that outlasts the bounded backoff stops polling in the `error` state instead of
 * retrying forever. There is no automatic re-open.
 */
export function createTerminalSession({ client, sink, onChange = () => {}, delay = defaultDelay, now = () => Date.now(), waitMs = TERMINAL_WAIT_MS }) {
  let state = { phase: 'idle' };
  let terminalId;
  let cursor = '0';
  let disposed = false;
  let readController;
  let reading = false;
  let sending = false;
  let lastSize = '';
  const queue = [];

  const update = (next) => { state = { ...state, ...next }; onChange(state); };
  const live = () => !disposed && state.phase !== 'lost';
  function adoptView(view) {
    if (!view || typeof view !== 'object') return;
    const phase = PHASE_BY_STATUS[view.status] ?? 'failed';
    update({ phase, terminal: view, exitCode: view.exitCode });
    if (phase !== 'running') queue.length = 0;
  }
  function lose(status) {
    readController?.abort();
    queue.length = 0;
    update({ phase: 'lost', message: status === 410 ? TERMINAL_WORKSPACE_ENDED_MESSAGE : undefined, interrupted: false });
  }

  async function readLoop() {
    if (reading) return;
    reading = true;
    let failures = 0;
    try {
      while (live() && terminalId) {
        const id = terminalId;
        readController = new globalThis.AbortController();
        const startedAt = now();
        let page;
        try {
          page = (await client.read(id, cursor, waitMs, readController.signal))?.data;
        } catch (error) {
          if (!live() || isAbort(error) || id !== terminalId) return;
          const status = statusOf(error);
          if (isGone(status)) { lose(status); return; }
          if (status === 401) { update({ phase: 'error', message: 'Your dashboard session ended. Sign in again.' }); return; }
          if (!isRetryable(error)) {
            update({ phase: 'error', interrupted: false, message: `Output stopped: ${error?.message ?? 'the request was refused.'} Reload the page or start a new session.` });
            return;
          }
          failures += 1;
          if (failures > READ_RETRY_LIMIT) {
            update({ phase: 'error', interrupted: false, message: 'Output stopped after repeated connection failures. Reload the page to reconnect.' });
            return;
          }
          const wait = Math.min(15_000, 500 * 2 ** (failures - 1));
          update({ interrupted: true, message: `Output connection interrupted. Retrying in ${Math.ceil(wait / 1_000)} s.` });
          await delay(wait);
          continue;
        }
        if (!live() || id !== terminalId || !page) return;
        if (failures || state.interrupted) { failures = 0; update({ interrupted: false, message: undefined }); }
        if (Number(page.missedBytes) > 0) sink.write(missedOutputNotice(page.missedBytes));
        if (page.data) sink.write(base64ToBytes(page.data));
        if (typeof page.nextCursor === 'string') cursor = page.nextCursor;
        adoptView(page.terminal);
        if (page.more === true) continue;
        // A terminal that ended has been drained once `more` is false: nothing else will arrive.
        if (state.phase !== 'running') return;
        if (!page.data && now() - startedAt < EMPTY_READ_FLOOR_MS) await delay(1_000);
      }
    } finally {
      reading = false;
    }
  }

  async function pump() {
    if (sending) return;
    sending = true;
    let attempt = 0;
    try {
      while (queue.length && live() && terminalId && state.phase === 'running') {
        const chunk = takeInputChunk(queue);
        try {
          const result = await client.input(terminalId, bytesToBase64(chunk));
          attempt = 0;
          if (result?.data?.terminal) adoptView(result.data.terminal);
        } catch (error) {
          const status = statusOf(error);
          if (isGone(status)) { lose(status); return; }
          if (isRetryable(error) && attempt < INPUT_RETRY_LIMIT) {
            // Retried chunks go back to the front, so keystrokes are delivered in order or not at all.
            queue.unshift(chunk);
            attempt += 1;
            await delay(Math.min(4_000, 250 * 2 ** (attempt - 1)));
            continue;
          }
          queue.length = 0;
          update({ message: status === 429 ? 'Input arrived faster than the terminal accepts it; unsent keystrokes were dropped.' : `Input was not delivered: ${error?.message ?? 'the request failed.'}` });
          return;
        }
      }
    } finally {
      sending = false;
    }
  }

  return {
    get state() { return state; },
    get terminalId() { return terminalId; },
    /** Open a new PTY, then start streaming its output. */
    async open({ cols, rows, cwd } = {}) {
      update({ phase: 'connecting', terminal: undefined, exitCode: undefined, message: undefined, interrupted: false });
      try {
        const result = await client.open({ ...(cwd ? { cwd } : {}), ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) });
        if (disposed) return;
        const view = result?.data?.terminal;
        if (!view?.terminalId) throw Object.assign(new Error('The terminal service returned no terminal.'), { status: 502 });
        terminalId = view.terminalId;
        cursor = '0';
        lastSize = `${view.cols}x${view.rows}`;
        adoptView(view);
        void readLoop();
      } catch (error) {
        if (!disposed) update({ phase: 'error', message: error?.message ?? 'The terminal could not be opened.' });
      }
    },
    /** Re-attach to a terminal that is still running; the runner replays retained output from cursor 0. */
    attach(view) {
      terminalId = view.terminalId;
      cursor = '0';
      lastSize = `${view.cols}x${view.rows}`;
      update({ phase: 'connecting', terminal: view, exitCode: undefined, message: undefined, interrupted: false });
      void readLoop();
    },
    send(bytes) {
      if (!live() || state.phase !== 'running' || !bytes?.length) return false;
      queue.push(bytes);
      void pump();
      return true;
    },
    async resize(cols, rows) {
      const size = `${cols}x${rows}`;
      if (!live() || !terminalId || state.phase !== 'running' || size === lastSize) return;
      lastSize = size;
      try {
        const result = await client.resize(terminalId, cols, rows);
        if (result?.data?.terminal) adoptView(result.data.terminal);
      } catch (error) {
        if (isGone(statusOf(error))) lose(statusOf(error));
        else lastSize = '';
      }
    },
    async close() {
      if (!live() || !terminalId) return;
      try {
        const result = await client.close(terminalId);
        adoptView(result?.data?.terminal ?? { ...state.terminal, status: 'closed' });
        readController?.abort();
      } catch (error) {
        if (isGone(statusOf(error))) { lose(statusOf(error)); return; }
        throw error;
      }
    },
    dispose() {
      disposed = true;
      readController?.abort();
      queue.length = 0;
    }
  };
}

/**
 * CSP adapter. xterm's DOM renderer writes its theme and cell metrics into `<style>` elements and sets
 * true-colour cells with `setAttribute('style', …)`; the dashboard CSP (`style-src 'self'`, no
 * 'unsafe-inline') blocks both, which leaves the terminal colourless and logs a violation per cell. The
 * adapter routes those two script-only paths through CSSOM, which the CSP permits: a script-created
 * `<style>` becomes a constructed stylesheet adopted while its element is connected, and a script-set
 * `style` attribute becomes `style.cssText`. Markup-delivered styles stay blocked, so the policy itself
 * is unchanged; only code that could already call CSSOM is affected. Installed once, on first mount.
 */
export function installCspStyleAdapter(documentRef = globalThis.document) {
  if (!documentRef || documentRef.chCspStyleAdapter) return;
  const view = documentRef.defaultView ?? globalThis;
  const tag = 'ch-cssom-style';
  if (!view.customElements.get(tag)) {
    view.customElements.define(tag, class extends view.HTMLElement {
      #sheet = new view.CSSStyleSheet();
      #css = '';
      get textContent() { return this.#css; }
      set textContent(value) { this.#css = String(value ?? ''); this.#sheet.replaceSync(this.#css); }
      connectedCallback() {
        this.hidden = true;
        const owner = this.ownerDocument;
        if (!owner.adoptedStyleSheets.includes(this.#sheet)) owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, this.#sheet];
      }
      disconnectedCallback() {
        const owner = this.ownerDocument;
        owner.adoptedStyleSheets = owner.adoptedStyleSheets.filter((sheet) => sheet !== this.#sheet);
      }
    });
  }
  const create = documentRef.createElement.bind(documentRef);
  const createElement = (name, options) => {
    if (String(name).toLowerCase() === 'style') return create(tag);
    const element = create(name, options);
    const setAttribute = element.setAttribute;
    element.setAttribute = function setAttributeThroughCssom(attribute, value) {
      if (String(attribute).toLowerCase() === 'style') { this.style.cssText = String(value); return; }
      setAttribute.call(this, attribute, value);
    };
    return element;
  };
  Object.defineProperty(documentRef, 'createElement', { value: createElement, configurable: true, writable: true });
  Object.defineProperty(documentRef, 'chCspStyleAdapter', { value: true });
}

/** Resolve a token to `#rrggbb` (or `rgba(...)`): xterm does not parse every CSS colour syntax we author. */
function createColorResolver(documentRef) {
  const canvas = documentRef.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const styles = documentRef.defaultView.getComputedStyle(documentRef.documentElement);
  return (token, fallback) => {
    const value = styles.getPropertyValue(token).trim();
    if (!value || !context) return fallback;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = fallback;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (alpha < 255) return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`;
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };
}

/** The xterm theme, read from the live dashboard tokens so light, dark, and system all follow the shell. */
export function readTerminalTheme(documentRef = globalThis.document) {
  const color = createColorResolver(documentRef);
  return {
    background: color('--code-bg', 'black'),
    foreground: color('--ink', 'white'),
    cursor: color('--accent', 'white'),
    cursorAccent: color('--code-bg', 'black'),
    selectionBackground: color('--accent-soft', 'gray'),
    selectionForeground: color('--ink', 'white'),
    black: color('--line-strong', 'black'),
    red: color('--danger', 'red'),
    green: color('--success', 'green'),
    yellow: color('--warning', 'olive'),
    blue: color('--accent-strong', 'blue'),
    magenta: color('--info', 'purple'),
    cyan: color('--accent', 'teal'),
    white: color('--ink-muted', 'silver'),
    brightBlack: color('--ink-faint', 'gray'),
    brightRed: color('--danger-hover', 'red'),
    brightGreen: color('--success', 'lime'),
    brightYellow: color('--warning', 'yellow'),
    brightBlue: color('--accent-hover', 'blue'),
    brightMagenta: color('--info', 'fuchsia'),
    brightCyan: color('--accent-hover', 'aqua'),
    brightWhite: color('--ink', 'white')
  };
}

let emulatorModules;
/** The emulator and its stylesheet load from this release's asset namespace, only when a session starts. */
function loadEmulator(documentRef) {
  emulatorModules ??= (async () => {
    installCspStyleAdapter(documentRef);
    const href = new URL('./xterm.css', import.meta.url).href;
    if (![...documentRef.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === href)) {
      const link = documentRef.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      const loaded = new Promise((resolve, reject) => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', () => reject(new Error('The terminal stylesheet could not load.')), { once: true });
      });
      // Before the dashboard stylesheet, so the dashboard's own terminal rules win ties.
      documentRef.head.prepend(link);
      await loaded;
    }
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('./xterm.mjs'), import('./xterm-addon-fit.mjs')]);
    return { Terminal, FitAddon };
  })().catch((error) => { emulatorModules = undefined; throw error; });
  return emulatorModules;
}

/**
 * Mount the Terminal tab's behaviour onto the markup from `renderTerminalPanel`. Returns a handle whose
 * `dispose` stops loops and observers without closing the PTY, so leaving the tab keeps the shell running
 * for a later re-attach (until its idle expiry).
 */
export function mountTerminalPane({ root, workspaceId, api, announce = () => {}, onError = () => {}, terminals = [], idPrefix = '' }) {
  const documentRef = root.ownerDocument;
  const view = documentRef.defaultView;
  const client = createTerminalClient(api, workspaceId);
  const surface = root.querySelector('#' + idPrefix + 'terminal-surface');
  const statePill = root.querySelector('#' + idPrefix + 'terminal-state');
  const detail = root.querySelector('#' + idPrefix + 'terminal-detail');
  const closeButton = root.querySelector('#' + idPrefix + 'terminal-close');
  const newButton = root.querySelector('#' + idPrefix + 'terminal-new');
  const offers = root.querySelector('#' + idPrefix + 'terminal-reattach');
  const reducedMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const colorScheme = view.matchMedia?.('(prefers-color-scheme: light)');
  const cleanups = [];
  let session;
  let term;
  let fit;
  let disposed = false;
  let resizeTimer;

  function render(state) {
    statePill.className = `status ${state.phase === 'error' ? 'failed' : state.phase}`;
    statePill.textContent = terminalStatusLabel(state);
    detail.textContent = state.interrupted ? state.message : terminalStatusDetail(state);
    closeButton.disabled = state.phase !== 'running';
  }

  async function ensureEmulator() {
    if (term) return;
    const { Terminal, FitAddon } = await loadEmulator(documentRef);
    if (disposed) return;
    const styles = view.getComputedStyle(documentRef.documentElement);
    term = new Terminal({
      cursorBlink: !reducedMotion,
      fontFamily: styles.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      scrollback: 5_000,
      theme: readTerminalTheme(documentRef)
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    surface.hidden = false;
    term.open(surface);
    fit.fit();
    term.onData((text) => session?.send(encodeTerminalText(text)));
    term.onBinary((binary) => session?.send(encodeTerminalBinary(binary)));
    // Tab and Escape belong to the shell. This one chord leaves the emulator for the toolbar's
    // New session button, so Tab and Shift+Tab move through the page from outside the terminal.
    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.shiftKey && event.key === 'F6') {
        if (event.type === 'keydown') {
          event.preventDefault();
          newButton.focus();
        }
        return false;
      }
      return true;
    });
    // Tapping the surface focuses xterm's hidden textarea, which is what opens a soft keyboard.
    surface.addEventListener('click', () => term?.focus());
    const observer = new view.ResizeObserver(() => {
      view.clearTimeout(resizeTimer);
      resizeTimer = view.setTimeout(() => {
        if (!term || disposed || surface.hidden || surface.getClientRects?.().length === 0) return;
        fit.fit();
        void session?.resize(term.cols, term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(surface);
    cleanups.push(() => observer.disconnect());
    const retheme = () => { if (term) term.options.theme = readTerminalTheme(documentRef); };
    const themeObserver = new view.MutationObserver(retheme);
    themeObserver.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanups.push(() => themeObserver.disconnect());
    colorScheme?.addEventListener('change', retheme);
    cleanups.push(() => colorScheme?.removeEventListener('change', retheme));
  }

  function freshSession() {
    session?.dispose();
    session = createTerminalSession({ client, sink: { write: (data) => term?.write(data) }, onChange: render });
    term?.reset();
    return session;
  }

  async function start(attachTo) {
    newButton.disabled = true;
    try {
      render({ phase: 'connecting' });
      await ensureEmulator();
      if (disposed) return;
      if (offers) offers.hidden = true;
      const next = freshSession();
      if (attachTo) next.attach(attachTo);
      else await next.open({ cols: term.cols, rows: term.rows });
      if (disposed) return;
      fit.fit();
      void next.resize(term.cols, term.rows);
      term.focus();
      announce(attachTo ? 'Terminal re-attached.' : 'Terminal opened.');
    } catch (error) {
      render({ phase: 'error', message: error?.message ?? 'The terminal could not be opened.' });
      onError(error);
    } finally {
      newButton.disabled = false;
    }
  }

  newButton.addEventListener('click', async () => {
    // "New session" ends the running shell first, so the tab never leaves an unseen PTY behind.
    if (session?.state.phase === 'running') {
      try { await session.close(); } catch (error) { onError(error); return; }
    }
    await start();
  });
  closeButton.addEventListener('click', async () => {
    closeButton.disabled = true;
    try { await session?.close(); announce('Terminal closed.'); } catch (error) { onError(error); render(session?.state ?? { phase: 'idle' }); }
  });
  for (const button of root.querySelectorAll('.reattach-terminal')) {
    button.addEventListener('click', () => {
      const target = terminals.find((terminal) => terminal.terminalId === button.dataset.terminalId);
      if (target) void start(target);
    });
  }

  return {
    get session() { return session; },
    dispose() {
      disposed = true;
      view.clearTimeout(resizeTimer);
      session?.dispose();
      for (const cleanup of cleanups.splice(0)) cleanup();
      term?.dispose();
      term = undefined;
    }
  };
}

export { TERMINAL_RELEASE_SHORTCUT };
