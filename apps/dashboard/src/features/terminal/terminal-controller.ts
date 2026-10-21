/**
 * App-level terminal controllers, one per workspace, that outlive the Terminal tab's view.
 *
 * A route change unmounts the tab, but the shell keeps running in the runner until it is
 * closed, exits or reaches its idle expiry. The controller keeps the session, its output
 * cursor and the emulator (with its scrollback) in memory, so returning to the tab
 * re-attaches the same emulator and continues reading from where it stopped: nothing is
 * replayed, nothing is skipped and the operator does nothing. While no view shows a
 * terminal its read loop is paused, so a hidden terminal costs no requests.
 *
 * Only an explicit Close (or New session, which closes the running shell first) ends a
 * session. Nothing here touches browser storage: output and input live only in this
 * module's memory and in the emulator's buffer, and a reload starts from the re-attach list.
 *
 * The emulator module is a dynamic import, so this file (and the tab) stay out of the heavy
 * `xterm` chunk until a session starts.
 */
import { apiClient } from '@/lib/api-client';
import { bffPath } from '@/lib/bff-query';
import {
  createTerminalSession,
  encodeTerminalBinary,
  encodeTerminalText,
  type TerminalClient,
  type TerminalSession,
  type TerminalState,
  type TerminalView,
  TERMINAL_WAIT_MS
} from './terminal-protocol';
import type { Emulator, createEmulator } from './xterm';

const RESIZE_DEBOUNCE_MS = 150;

/** The BFF terminal calls for one workspace; every path segment is encoded. */
export function terminalClient(workspaceId: string): TerminalClient {
  const base = `${bffPath('workspaces', workspaceId)}/terminals`;
  const scoped = (terminalId: string) => `${base}/${encodeURIComponent(terminalId)}`;
  return {
    open: (body) => apiClient.request(base, { method: 'POST', body }),
    read: (terminalId, cursor, waitMs, signal) => apiClient.get(`${scoped(terminalId)}/output`, { query: { cursor, waitMs }, signal }),
    input: (terminalId, data) => apiClient.request(`${scoped(terminalId)}/input`, { method: 'POST', body: { data } }),
    resize: (terminalId, cols, rows) => apiClient.request(`${scoped(terminalId)}/resize`, { method: 'POST', body: { cols, rows } }),
    close: (terminalId) => apiClient.request(`${scoped(terminalId)}/close`, { method: 'POST', body: {} })
  };
}

export type TerminalSnapshot = TerminalState & {
  /** A start or re-attach is in progress. */
  starting: boolean;
};

let emulatorModule: Promise<{ createEmulator: typeof createEmulator }> | undefined;
function loadEmulator() {
  emulatorModule ??= import('./xterm').catch((error: unknown) => { emulatorModule = undefined; throw error; });
  return emulatorModule;
}

export class TerminalController {
  readonly workspaceId: string;
  /** The emulator's own element. It moves into whichever view is mounted and out again. */
  readonly host: HTMLDivElement;
  private readonly client: TerminalClient;
  private readonly listeners = new Set<() => void>();
  private snapshot: TerminalSnapshot = { phase: 'idle', starting: false };
  private session: TerminalSession | undefined;
  private emulator: Emulator | undefined;
  private mounted: HTMLElement | undefined;
  private releaseTarget: (() => void) | undefined;

  constructor(workspaceId: string, client: TerminalClient = terminalClient(workspaceId), private readonly waitMs = TERMINAL_WAIT_MS) {
    this.workspaceId = workspaceId;
    this.client = client;
    this.host = document.createElement('div');
    this.host.className = 'h-full w-full';
  }

  getSnapshot = (): TerminalSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: Partial<TerminalSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  get terminalId(): string | undefined {
    return this.session?.terminalId;
  }

  /**
   * Show the terminal in `container`. Returns the unmount: the emulator leaves the page, the
   * read loop pauses and the shell keeps running.
   */
  mount(container: HTMLElement, onRelease: () => void): () => void {
    this.mounted = container;
    this.releaseTarget = onRelease;
    container.append(this.host);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => this.fitAndResize(), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    this.fitAndResize();
    this.session?.resume();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      this.session?.pause();
      if (this.mounted === container) { this.mounted = undefined; this.releaseTarget = undefined; }
      this.host.remove();
    };
  }

  private fitAndResize() {
    if (!this.emulator || !this.mounted) return;
    const { cols, rows } = this.emulator.fit();
    void this.session?.resize(cols, rows);
  }

  focus() {
    this.emulator?.focus();
  }

  private async ensureEmulator(): Promise<Emulator> {
    if (this.emulator) return this.emulator;
    const { createEmulator } = await loadEmulator();
    this.emulator ??= createEmulator(this.host, {
      onData: (text) => { this.session?.send(encodeTerminalText(text)); },
      onBinary: (binary) => { this.session?.send(encodeTerminalBinary(binary)); },
      onRelease: () => this.releaseTarget?.()
    });
    return this.emulator;
  }

  private freshSession(emulator: Emulator): TerminalSession {
    this.session?.dispose();
    const session = createTerminalSession({
      client: this.client,
      sink: { write: (data) => emulator.write(data) },
      onChange: (state) => { if (this.session === session) this.publish(state); },
      waitMs: this.waitMs
    });
    this.session = session;
    emulator.reset();
    return session;
  }

  /** Open a new shell, or re-attach to `attachTo`, which is still running. */
  async start(attachTo?: TerminalView): Promise<void> {
    if (this.snapshot.starting) return;
    this.publish({ phase: 'connecting', starting: true, message: undefined, interrupted: false, terminal: attachTo, exitCode: undefined });
    try {
      const emulator = await this.ensureEmulator();
      const session = this.freshSession(emulator);
      if (!this.mounted) session.pause();
      if (attachTo) session.attach(attachTo);
      else {
        const { cols, rows } = emulator.fit();
        await session.open({ cols, rows });
      }
      this.fitAndResize();
      if (this.mounted) emulator.focus();
    } catch (error) {
      this.publish({ phase: 'error', message: error instanceof Error && error.message ? error.message : 'The terminal could not be opened.' });
    } finally {
      this.publish({ starting: false });
    }
  }

  /** End the running shell. Throws when the close request failed, so the caller can say so. */
  async close(): Promise<void> {
    await this.session?.close();
  }
}

const controllers = new Map<string, TerminalController>();

/** The workspace's controller, created on first use and kept for the life of the page. */
export function terminalController(workspaceId: string): TerminalController {
  let controller = controllers.get(workspaceId);
  if (!controller) {
    controller = new TerminalController(workspaceId);
    controllers.set(workspaceId, controller);
  }
  return controller;
}
