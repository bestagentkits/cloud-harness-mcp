/**
 * The terminal protocol controller: open, long-poll output, ordered input, resize, close and
 * the truthful lifecycle states, ported from the classic `createTerminalSession`
 * (`apps/api/dashboard/dashboard-terminal.js`). It touches no DOM, so unit tests drive it with
 * fakes. Two additions serve the React shell, where the view unmounts on every route change
 * while the shell keeps running in the runner:
 *
 * - `pause()` stops the read loop but keeps the terminal and its cursor; `resume()` continues
 *   from that cursor, so returning to the tab neither replays nor skips output;
 * - a session disposed while its `open` is in flight closes the PTY it was handed instead of
 *   leaving an unseen shell running until its idle expiry.
 *
 * States are only ever derived from what the runner reported. A 404 (terminal gone) or 410
 * (workspace ended) turns the session `lost` and stops every loop: a PTY the runner forgot
 * cannot be reconnected. A refused read, or a transient failure that outlasts the bounded
 * backoff, stops polling in the `error` state. There is no automatic re-open.
 */

/** The longest a read parks on the runner. The BFF clamps it again to its own runner timeout. */
export const TERMINAL_WAIT_MS = 25_000;
/** Raw bytes per input request: a large paste is split, in order, well under the body limit. */
export const TERMINAL_INPUT_CHUNK_BYTES = 16_384;
const INPUT_RETRY_LIMIT = 6;
/** Consecutive transient read failures (about a minute of backoff) before polling stops. */
export const READ_RETRY_LIMIT = 8;
/** Network failure (0) and throttling; every 5xx is retried as well. */
const RETRYABLE_STATUSES = new Set([0, 429]);
/** A read that returns empty this quickly means the long-poll is not parking: back off. */
const EMPTY_READ_FLOOR_MS = 250;

export const TERMINAL_WORKSPACE_ENDED_MESSAGE = 'This terminal ended with its workspace, which was closed or expired. Renew or recover the workspace, then start a new session.';
export const TERMINAL_LOST_MESSAGE = 'This terminal is no longer available — it was closed, timed out, or the runner restarted. Terminals are not resumed after a runner restart.';
/** Moves keyboard focus out of the emulator; Tab and Escape themselves belong to the shell. */
export const TERMINAL_RELEASE_SHORTCUT = 'Ctrl+Shift+F6';

export type TerminalStatus = 'running' | 'exited' | 'closed' | 'timed_out' | 'failed';
export type TerminalPhase = 'idle' | 'connecting' | TerminalStatus | 'lost' | 'error';

/** The runner's terminal view (`apps/runner` terminal service), as the BFF projects it. */
export type TerminalView = {
  terminalId: string;
  workspaceId?: string;
  cols?: number;
  rows?: number;
  status?: string;
  exitCode?: number | null;
  createdAt?: string;
  idleExpiresAt?: string;
  endReason?: string;
};

export type TerminalState = {
  phase: TerminalPhase;
  terminal?: TerminalView | undefined;
  exitCode?: number | null | undefined;
  message?: string | undefined;
  /** A transient read failure is being retried; `message` says when. */
  interrupted?: boolean | undefined;
};

type Envelope<T> = { data?: T } | undefined;
export type TerminalPage = { data?: string; nextCursor?: string; missedBytes?: number; more?: boolean; terminal?: TerminalView };

/** The BFF calls for one workspace; `apps/dashboard/src/features/terminal/terminal-client.ts` binds them. */
export type TerminalClient = {
  open: (body: { cwd?: string; cols?: number; rows?: number }) => Promise<Envelope<{ terminal?: TerminalView }>>;
  read: (terminalId: string, cursor: string, waitMs: number, signal: AbortSignal) => Promise<Envelope<TerminalPage>>;
  input: (terminalId: string, data: string) => Promise<Envelope<{ terminal?: TerminalView }>>;
  resize: (terminalId: string, cols: number, rows: number) => Promise<Envelope<{ terminal?: TerminalView }>>;
  close: (terminalId: string) => Promise<Envelope<{ terminal?: TerminalView }>>;
};

/** Where output goes: the emulator's `write`, which takes text or raw bytes. */
export type TerminalSink = { write: (data: string | Uint8Array) => void };

const PHASE_BY_STATUS: Record<string, TerminalStatus> = { running: 'running', exited: 'exited', closed: 'closed', timed_out: 'timed_out', failed: 'failed' };

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return globalThis.btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Keystrokes and pastes arrive as text; the PTY takes UTF-8 bytes. */
export const encodeTerminalText = (text: string): Uint8Array => new TextEncoder().encode(text);
/** xterm's binary events (some mouse reports) are byte strings: one char code per byte. */
export const encodeTerminalBinary = (binary: string): Uint8Array => Uint8Array.from(binary, (character) => character.charCodeAt(0) & 0xff);

/** A visible, dim line telling the operator the replay is incomplete instead of silently skipping. */
export function missedOutputNotice(missedBytes: number): string {
  // Reset first so attributes left by earlier output never restyle the notice.
  return `\x1b[0m\x1b[2m[${Number(missedBytes).toLocaleString('en-US')} bytes of earlier output are no longer retained and were skipped]\x1b[0m\r\n`;
}

/** Take up to `limit` bytes from the front of the queue, preserving order and splitting the last chunk. */
export function takeInputChunk(queue: Uint8Array[], limit = TERMINAL_INPUT_CHUNK_BYTES): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  while (queue.length && size < limit) {
    const next = queue[0]!;
    const room = limit - size;
    if (next.length <= room) { parts.push(queue.shift()!); size += next.length; continue; }
    parts.push(next.subarray(0, room));
    queue[0] = next.subarray(room);
    size += room;
  }
  const chunk = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { chunk.set(part, offset); offset += part.length; }
  return chunk;
}

/** The pill text. */
export function terminalStatusLabel(state: { phase?: string | undefined; exitCode?: number | null | undefined }): string {
  const phase = state.phase ?? 'idle';
  if (phase === 'connecting') return 'Connecting…';
  if (phase === 'running') return 'Running';
  if (phase === 'exited') return Number.isInteger(state.exitCode) ? `Exited (code ${state.exitCode})` : 'Exited';
  if (phase === 'closed') return 'Closed';
  if (phase === 'timed_out') return 'Timed out';
  if (phase === 'failed') return 'Failed';
  if (phase === 'lost') return 'No longer available';
  if (phase === 'error') return 'Could not connect';
  return 'Not started';
}

/** The sentence under the pill: what happened and what the operator can do next. */
export function terminalStatusDetail(state: TerminalState): string {
  const { phase } = state;
  if (phase === 'lost') return state.message ?? TERMINAL_LOST_MESSAGE;
  if (phase === 'timed_out') return 'The terminal reached its idle or lifetime limit and was ended. Start a new session to continue.';
  if (phase === 'failed') return `The terminal could not be kept running${state.terminal?.endReason ? `: ${state.terminal.endReason}` : '.'} Start a new session to continue.`;
  if (phase === 'exited') return 'The shell ended. Start a new session to continue.';
  if (phase === 'closed') return 'This terminal was closed. Start a new session to continue.';
  if (phase === 'error') return state.message ?? 'The terminal could not be opened.';
  if (phase === 'connecting') return 'Opening a shell in this workspace.';
  if (phase === 'running') return state.message ?? '';
  return 'Open a terminal to run commands in this workspace.';
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, ms); });
const statusOf = (error: unknown): number => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : 0;
};
const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError';
const messageOf = (error: unknown): string | undefined => {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : undefined;
};
/** A `retryable` flag from the server wins; otherwise only throttling, 5xx and network errors retry. */
const isRetryable = (error: unknown) => {
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  if (typeof flag === 'boolean') return flag;
  const status = statusOf(error);
  return RETRYABLE_STATUSES.has(status) || status >= 500;
};
/** 404: the runner forgot the terminal. 410: its workspace ended. Neither can come back. */
const isGone = (status: number) => status === 404 || status === 410;

export type TerminalSessionOptions = {
  client: TerminalClient;
  sink: TerminalSink;
  onChange?: (state: TerminalState) => void;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
};

export type TerminalSession = ReturnType<typeof createTerminalSession>;

export function createTerminalSession({ client, sink, onChange = () => {}, delay = defaultDelay, now = () => Date.now(), waitMs = TERMINAL_WAIT_MS }: TerminalSessionOptions) {
  let state: TerminalState = { phase: 'idle' };
  let terminalId: string | undefined;
  let cursor = '0';
  let disposed = false;
  let paused = false;
  let readController: AbortController | undefined;
  /** Bumped on every pause and re-attach, so a loop started earlier never touches newer state. */
  let loopGeneration = 0;
  let reading = false;
  let sending = false;
  let lastSize = '';
  const queue: Uint8Array[] = [];

  const update = (next: Partial<TerminalState>) => { state = { ...state, ...next }; onChange(state); };
  const live = () => !disposed && state.phase !== 'lost';
  function adoptView(view: TerminalView | undefined) {
    // A late answer (a resize or input sent before a read found the terminal gone) never revives it.
    if (!view || typeof view !== 'object' || !live()) return;
    const phase = PHASE_BY_STATUS[view.status ?? ''] ?? 'failed';
    update({ phase, terminal: view, exitCode: view.exitCode });
    if (phase !== 'running') queue.length = 0;
  }
  function lose(status: number) {
    readController?.abort();
    queue.length = 0;
    update({ phase: 'lost', message: status === 410 ? TERMINAL_WORKSPACE_ENDED_MESSAGE : undefined, interrupted: false });
  }

  async function readLoop() {
    if (reading || paused) return;
    reading = true;
    const generation = loopGeneration;
    const current = () => live() && !paused && generation === loopGeneration;
    let failures = 0;
    try {
      while (current() && terminalId) {
        const id = terminalId;
        readController = new AbortController();
        const startedAt = now();
        let page: TerminalPage | undefined;
        try {
          page = (await client.read(id, cursor, waitMs, readController.signal))?.data;
        } catch (error) {
          if (!current() || isAbort(error) || id !== terminalId) return;
          const status = statusOf(error);
          if (isGone(status)) { lose(status); return; }
          if (status === 401) { update({ phase: 'error', message: 'Your dashboard session ended. Sign in again.' }); return; }
          if (!isRetryable(error)) {
            update({ phase: 'error', interrupted: false, message: `Output stopped: ${messageOf(error) ?? 'the request was refused.'} Reload the page or start a new session.` });
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
        if (!current() || id !== terminalId || !page) return;
        if (failures || state.interrupted) { failures = 0; update({ interrupted: false, message: undefined }); }
        if (Number(page.missedBytes) > 0) sink.write(missedOutputNotice(Number(page.missedBytes)));
        if (page.data) sink.write(base64ToBytes(page.data));
        if (typeof page.nextCursor === 'string') cursor = page.nextCursor;
        adoptView(page.terminal);
        if (page.more === true) continue;
        // A terminal that ended has been drained once `more` is false: nothing else will arrive.
        if (state.phase !== 'running') return;
        if (!page.data && now() - startedAt < EMPTY_READ_FLOOR_MS) await delay(1_000);
      }
    } finally {
      if (generation === loopGeneration) reading = false;
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
            // Retried chunks go back to the front, so keystrokes arrive in order or not at all.
            queue.unshift(chunk);
            attempt += 1;
            await delay(Math.min(4_000, 250 * 2 ** (attempt - 1)));
            continue;
          }
          queue.length = 0;
          update({ message: status === 429 ? 'Input arrived faster than the terminal accepts it; unsent keystrokes were dropped.' : `Input was not delivered: ${messageOf(error) ?? 'the request failed.'}` });
          return;
        }
      }
    } finally {
      sending = false;
    }
  }

  /** Stop the current loop so a new one can start at once (pause, re-attach). */
  function restartLoop() {
    loopGeneration += 1;
    readController?.abort();
    reading = false;
  }

  return {
    get state() { return state; },
    get terminalId() { return terminalId; },
    get paused() { return paused; },
    /** Open a new PTY, then stream its output. */
    async open({ cols, rows, cwd }: { cols?: number; rows?: number; cwd?: string } = {}) {
      update({ phase: 'connecting', terminal: undefined, exitCode: undefined, message: undefined, interrupted: false });
      try {
        const result = await client.open({ ...(cwd ? { cwd } : {}), ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) });
        const view = result?.data?.terminal;
        if (disposed) {
          // Nobody will ever see this shell: end it now rather than at its idle expiry.
          if (view?.terminalId) void client.close(view.terminalId).catch(() => undefined);
          return;
        }
        if (!view?.terminalId) throw Object.assign(new Error('The terminal service returned no terminal.'), { status: 502 });
        terminalId = view.terminalId;
        cursor = '0';
        lastSize = `${view.cols}x${view.rows}`;
        adoptView(view);
        void readLoop();
      } catch (error) {
        if (!disposed) update({ phase: 'error', message: messageOf(error) ?? 'The terminal could not be opened.' });
      }
    },
    /** Re-attach to a terminal that is still running; the runner replays retained output from cursor 0. */
    attach(view: TerminalView) {
      restartLoop();
      terminalId = view.terminalId;
      cursor = '0';
      lastSize = `${view.cols}x${view.rows}`;
      update({ phase: 'connecting', terminal: view, exitCode: undefined, message: undefined, interrupted: false });
      void readLoop();
    },
    /** Stop reading while no view shows the output; the terminal and its cursor are kept. */
    pause() {
      if (paused) return;
      paused = true;
      restartLoop();
    },
    /** Continue reading from the kept cursor: nothing is replayed and nothing is skipped. */
    resume() {
      if (!paused) return;
      paused = false;
      if (terminalId && live() && (state.phase === 'running' || state.phase === 'connecting')) void readLoop();
    },
    send(bytes: Uint8Array): boolean {
      if (!live() || state.phase !== 'running' || !bytes.length) return false;
      queue.push(bytes);
      void pump();
      return true;
    },
    async resize(cols: number, rows: number) {
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
        adoptView(result?.data?.terminal ?? { ...state.terminal, terminalId, status: 'closed' });
        readController?.abort();
      } catch (error) {
        if (isGone(statusOf(error))) { lose(statusOf(error)); return; }
        throw error;
      }
    },
    dispose() {
      disposed = true;
      restartLoop();
      queue.length = 0;
    }
  };
}
