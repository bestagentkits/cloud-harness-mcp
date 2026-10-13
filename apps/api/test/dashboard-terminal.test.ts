import { describe, expect, it, vi } from 'vitest';
import {
  READ_RETRY_LIMIT, TERMINAL_INPUT_CHUNK_BYTES, TERMINAL_WORKSPACE_ENDED_MESSAGE, base64ToBytes, bytesToBase64, createTerminalClient,
  createTerminalSession, encodeTerminalBinary, encodeTerminalText, installCspStyleAdapter, missedOutputNotice, takeInputChunk
} from '../dashboard/dashboard-terminal.js';
import {
  TERMINAL_LOST_MESSAGE, renderTerminalPanel, renderTerminalsIndex, renderWorkspaceTabs, terminalStatusDetail, terminalStatusLabel
} from '../dashboard/dashboard-render.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const terminalId = `term_${'t'.repeat(24)}`;
const view = (overrides: Record<string, unknown> = {}) => ({
  terminalId, workspaceId, status: 'running', cwd: '.', cols: 80, rows: 24,
  createdAt: '2026-10-13T00:00:00.000Z', lastActivityAt: '2026-10-13T00:00:00.000Z',
  idleExpiresAt: '2026-10-13T00:30:00.000Z', hardExpiresAt: '2026-10-13T08:00:00.000Z', ...overrides
});
const page = (overrides: Record<string, unknown> = {}) => ({
  data: { terminal: view(), data: '', cursor: '0', nextCursor: '0', missedBytes: 0, more: false, ...overrides }
});
const failure = (status: number, message = `status ${status}`) => Object.assign(new Error(message), { status });
const decoder = new TextDecoder();

/** A runner stand-in: reads resolve from a scripted queue, then park until the session aborts them. */
function fakeClient(script: Array<() => unknown> = []) {
  const reads: Array<{ cursor: string; waitMs: number }> = [];
  const inputs: string[] = [];
  const client = {
    list: vi.fn(),
    open: vi.fn(async (body: Record<string, unknown>) => ({ data: { terminal: view({ cols: body.cols ?? 80, rows: body.rows ?? 24 }) } })),
    read: vi.fn(async (_id: string, cursor: string, waitMs: number, signal: AbortSignal) => {
      reads.push({ cursor, waitMs });
      const next = script.shift();
      if (next) return next();
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    }),
    input: vi.fn(async (_id: string, data: string) => { inputs.push(data); return { data: { terminal: view() } }; }),
    resize: vi.fn(async (_id: string, cols: number, rows: number) => ({ data: { terminal: view({ cols, rows }) } })),
    close: vi.fn(async () => ({ data: { terminal: view({ status: 'closed' }) } }))
  };
  return { client, reads, inputs };
}

function harness(script: Array<() => unknown> = [], options: { delay?: (ms: number) => Promise<void> } = {}) {
  const fake = fakeClient(script);
  const written: string[] = [];
  const phases: string[] = [];
  const session = createTerminalSession({
    client: fake.client,
    sink: { write: (chunk: string | Uint8Array) => written.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk)) },
    onChange: (state: { phase: string }) => { if (phases.at(-1) !== state.phase) phases.push(state.phase); },
    delay: options.delay ?? (async () => {}),
    waitMs: 25_000
  });
  return { ...fake, session, written, phases };
}

describe('terminal byte helpers', () => {
  it('round-trips bytes through base64 and encodes keystrokes as UTF-8', () => {
    const bytes = new Uint8Array([0, 1, 27, 127, 128, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(Array.from(encodeTerminalText('é\r'))).toEqual([0xc3, 0xa9, 0x0d]);
    expect(Array.from(encodeTerminalBinary('\x1b[M \xff'))).toEqual([27, 91, 77, 32, 255]);
  });

  it('takes queued input in order and splits only the last chunk', () => {
    const queue = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7]), new Uint8Array([8])];
    expect(Array.from(takeInputChunk(queue, 5))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(takeInputChunk(queue, 5))).toEqual([6, 7, 8]);
    expect(queue).toHaveLength(0);
  });

  it('describes skipped output in a dim, visible line', () => {
    expect(missedOutputNotice(12_345)).toContain('12,345 bytes of earlier output are no longer retained');
    // Attributes left by earlier output are reset before the dim notice, and reset again after it.
    expect(missedOutputNotice(1).startsWith('\x1b[0m\x1b[2m')).toBe(true);
    expect(missedOutputNotice(1).endsWith('\x1b[0m\r\n')).toBe(true);
  });
});

describe('terminal client', () => {
  it('builds workspace-scoped BFF paths and never sends identity in a body', async () => {
    const api = vi.fn(async () => ({ data: {} }));
    const client = createTerminalClient(api, workspaceId);
    const signal = new AbortController().signal;
    await client.open({ cols: 90, rows: 30 });
    await client.read(terminalId, '12', 25_000, signal);
    await client.input(terminalId, 'aA==');
    await client.resize(terminalId, 100, 40);
    await client.close(terminalId);
    const base = `/workspaces/${workspaceId}/terminals`;
    expect(api.mock.calls).toEqual([
      [base, { method: 'POST', body: JSON.stringify({ cols: 90, rows: 30 }) }],
      [`${base}/${terminalId}/output?cursor=12&waitMs=25000`, { signal }],
      [`${base}/${terminalId}/input`, { method: 'POST', body: JSON.stringify({ data: 'aA==' }) }],
      [`${base}/${terminalId}/resize`, { method: 'POST', body: JSON.stringify({ cols: 100, rows: 40 }) }],
      [`${base}/${terminalId}/close`, { method: 'POST', body: '{}' }]
    ]);
  });
});

describe('terminal session', () => {
  it('opens with the fitted size, streams output, tracks the cursor, and long-polls', async () => {
    const h = harness([
      () => page({ data: btoa('hello '), nextCursor: '6', more: true }),
      () => page({ cursor: '6', data: btoa('world'), nextCursor: '11' })
    ]);
    await h.session.open({ cols: 132, rows: 43 });
    expect(h.client.open).toHaveBeenCalledWith({ cols: 132, rows: 43 });
    await vi.waitFor(() => expect(h.reads).toHaveLength(3));
    expect(h.reads.map((read) => read.cursor)).toEqual(['0', '6', '11']);
    expect(h.reads.every((read) => read.waitMs === 25_000)).toBe(true);
    expect(h.written.join('')).toBe('hello world');
    expect(h.phases).toEqual(['connecting', 'running']);
    h.session.dispose();
  });

  it('writes a missed-output notice before the replayed bytes', async () => {
    const h = harness([() => page({ data: btoa('tail'), missedBytes: 2048, nextCursor: '4096' })]);
    h.session.attach(view());
    await vi.waitFor(() => expect(h.written).toHaveLength(2));
    expect(h.written[0]).toBe(missedOutputNotice(2048));
    expect(h.written[1]).toBe('tail');
    expect(h.reads[0]?.cursor).toBe('0');
    h.session.dispose();
  });

  it('reports exited with the code, then stops reading', async () => {
    const h = harness([() => page({ terminal: view({ status: 'exited', exitCode: 3 }), data: btoa('bye'), nextCursor: '3' })]);
    await h.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(h.session.state.phase).toBe('exited'));
    expect(h.session.state.exitCode).toBe(3);
    expect(terminalStatusLabel(h.session.state)).toBe('Exited (code 3)');
    expect(h.reads).toHaveLength(1);
    expect(h.session.send(encodeTerminalText('ls'))).toBe(false);
  });

  it('turns a 404 on read into the lost state and never re-opens', async () => {
    const h = harness([() => { throw failure(404); }]);
    await h.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(h.session.state.phase).toBe('lost'));
    expect(h.client.open).toHaveBeenCalledTimes(1);
    expect(h.reads).toHaveLength(1);
    expect(terminalStatusDetail(h.session.state)).toBe(TERMINAL_LOST_MESSAGE);
    expect(TERMINAL_LOST_MESSAGE).toBe('This terminal is no longer available — it was closed, timed out, or the runner restarted. Terminals are not resumed after a runner restart.');
  });

  it('turns a 404 on input, resize, or close into the lost state', async () => {
    for (const action of ['input', 'resize', 'close'] as const) {
      const h = harness();
      await h.session.open({ cols: 80, rows: 24 });
      h.client[action].mockRejectedValueOnce(failure(404));
      if (action === 'input') h.session.send(encodeTerminalText('x'));
      if (action === 'resize') await h.session.resize(81, 24);
      if (action === 'close') await h.session.close();
      await vi.waitFor(() => expect(h.session.state.phase, action).toBe('lost'));
      h.session.dispose();
    }
  });

  it('turns a 410 (workspace closed or expired) into the lost state with a workspace message', async () => {
    const h = harness([() => { throw failure(410, 'Workspace expired.'); }]);
    await h.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(h.session.state.phase).toBe('lost'));
    expect(h.reads).toHaveLength(1);
    expect(terminalStatusLabel(h.session.state)).toBe('No longer available');
    expect(terminalStatusDetail(h.session.state)).toBe(TERMINAL_WORKSPACE_ENDED_MESSAGE);
    expect(h.session.send(encodeTerminalText('x'))).toBe(false);
  });

  it('turns a 410 on input, resize, or close into the lost state', async () => {
    for (const action of ['input', 'resize', 'close'] as const) {
      const h = harness();
      await h.session.open({ cols: 80, rows: 24 });
      h.client[action].mockRejectedValueOnce(failure(410));
      if (action === 'input') h.session.send(encodeTerminalText('x'));
      if (action === 'resize') await h.session.resize(81, 24);
      if (action === 'close') await h.session.close();
      await vi.waitFor(() => expect(h.session.state.phase, action).toBe('lost'));
      expect(h.session.state.message, action).toBe(TERMINAL_WORKSPACE_ENDED_MESSAGE);
      h.session.dispose();
    }
  });

  it('stops polling with a clear message on a non-retryable refusal', async () => {
    for (const status of [400, 403, 409]) {
      const delays: number[] = [];
      const h = harness([() => { throw failure(status, 'This item changed after you opened it.'); }], { delay: async (ms) => { delays.push(ms); } });
      await h.session.open({ cols: 80, rows: 24 });
      await vi.waitFor(() => expect(h.session.state.phase, String(status)).toBe('error'));
      expect(h.reads, String(status)).toHaveLength(1);
      expect(delays, String(status)).toEqual([]);
      expect(h.session.state.message).toContain('Output stopped: This item changed after you opened it.');
      expect(h.session.state.interrupted).toBe(false);
      expect(h.session.send(encodeTerminalText('x'))).toBe(false);
    }
  });

  it('retries a refusal the server marks retryable, and honours a non-retryable 5xx', async () => {
    const retryable = harness([
      () => { throw Object.assign(failure(409), { retryable: true }); },
      () => page({ data: btoa('ok'), nextCursor: '2' })
    ]);
    await retryable.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(retryable.written).toEqual(['ok']));
    expect(retryable.session.state.phase).toBe('running');
    retryable.session.dispose();

    const refused = harness([() => { throw Object.assign(failure(503), { retryable: false }); }]);
    await refused.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(refused.session.state.phase).toBe('error'));
    expect(refused.reads).toHaveLength(1);
  });

  it('caps the backoff for throttling and server errors, then stops polling', async () => {
    const delays: number[] = [];
    const statuses = [429, 500, 502, 503, 504, 0];
    const script = Array.from({ length: READ_RETRY_LIMIT + 1 }, (_, index) => () => { throw failure(statuses[index % statuses.length]!); });
    const h = harness(script, { delay: async (ms) => { delays.push(ms); } });
    await h.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(h.session.state.phase).toBe('error'));
    expect(h.reads).toHaveLength(READ_RETRY_LIMIT + 1);
    expect(delays).toHaveLength(READ_RETRY_LIMIT);
    expect(Math.max(...delays)).toBe(15_000);
    expect(h.session.state.message).toBe('Output stopped after repeated connection failures. Reload the page to reconnect.');
  });

  it('marks an interrupted output stream and recovers without changing state', async () => {
    const delays: number[] = [];
    const h = harness([
      () => { throw failure(503); },
      () => { throw failure(0, 'network'); },
      () => page({ data: btoa('ok'), nextCursor: '2' })
    ], { delay: async (ms) => { delays.push(ms); } });
    await h.session.open({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(h.written).toEqual(['ok']));
    expect(delays.slice(0, 2)).toEqual([500, 1_000]);
    expect(h.session.state.phase).toBe('running');
    expect(h.session.state.interrupted).toBe(false);
    h.session.dispose();
  });

  it('delivers input in order with one request in flight and retries a 429 at the front', async () => {
    const h = harness();
    await h.session.open({ cols: 80, rows: 24 });
    let inFlight = 0;
    let maxInFlight = 0;
    let rejectFirst = true;
    h.client.input.mockImplementation(async (_id: string, data: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (rejectFirst) { rejectFirst = false; throw failure(429); }
      h.inputs.push(data);
      return { data: { terminal: view() } };
    });
    h.session.send(encodeTerminalText('ab'));
    h.session.send(encodeTerminalText('c'));
    h.session.send(encodeTerminalText('d'));
    await vi.waitFor(() => expect(h.inputs.map((data) => decoder.decode(base64ToBytes(data))).join('')).toBe('abcd'));
    expect(maxInFlight).toBe(1);
    // The first request carried 'ab'; the 429 put it back at the front, so the retry coalesced it with 'c' and 'd'.
    expect(h.client.input.mock.calls.map((call) => decoder.decode(base64ToBytes(call[1] as string)))).toEqual(['ab', 'abcd']);
    h.session.dispose();
  });

  it('splits a large paste into bounded, ordered requests', async () => {
    const h = harness();
    await h.session.open({ cols: 80, rows: 24 });
    const paste = new Uint8Array(TERMINAL_INPUT_CHUNK_BYTES * 2 + 10).map((_, index) => index % 251);
    h.session.send(paste);
    await vi.waitFor(() => expect(h.inputs).toHaveLength(3));
    const sizes = h.inputs.map((data) => base64ToBytes(data).length);
    expect(sizes).toEqual([TERMINAL_INPUT_CHUNK_BYTES, TERMINAL_INPUT_CHUNK_BYTES, 10]);
    const joined = new Uint8Array(h.inputs.flatMap((data) => Array.from(base64ToBytes(data))));
    expect(joined).toEqual(paste);
    h.session.dispose();
  });

  it('drops unsent input and says so after a non-retryable failure', async () => {
    const h = harness();
    await h.session.open({ cols: 80, rows: 24 });
    h.client.input.mockRejectedValueOnce(failure(400, 'bad input'));
    h.session.send(encodeTerminalText('x'));
    await vi.waitFor(() => expect(h.session.state.message).toContain('Input was not delivered'));
    expect(h.session.state.phase).toBe('running');
    h.session.dispose();
  });

  it('skips a resize to the size it already has and reports a close truthfully', async () => {
    const h = harness();
    await h.session.open({ cols: 80, rows: 24 });
    await h.session.resize(80, 24);
    expect(h.client.resize).not.toHaveBeenCalled();
    await h.session.resize(100, 30);
    await h.session.resize(100, 30);
    expect(h.client.resize).toHaveBeenCalledTimes(1);
    await h.session.close();
    expect(h.session.state.phase).toBe('closed');
    expect(terminalStatusLabel(h.session.state)).toBe('Closed');
    expect(h.session.send(encodeTerminalText('x'))).toBe(false);
  });

  it('reports a failed open as an error, not a running terminal', async () => {
    const h = harness();
    h.client.open.mockRejectedValueOnce(failure(503, 'Terminals are temporarily unavailable.'));
    await h.session.open({ cols: 80, rows: 24 });
    expect(h.session.state).toMatchObject({ phase: 'error', message: 'Terminals are temporarily unavailable.' });
    expect(h.reads).toHaveLength(0);
  });

  it('labels every lifecycle state', () => {
    expect(terminalStatusLabel({ phase: 'connecting' })).toBe('Connecting…');
    expect(terminalStatusLabel({ phase: 'running' })).toBe('Running');
    expect(terminalStatusLabel({ phase: 'timed_out' })).toBe('Timed out');
    expect(terminalStatusLabel({ phase: 'failed' })).toBe('Failed');
    expect(terminalStatusLabel({ phase: 'lost' })).toBe('No longer available');
    expect(terminalStatusLabel({ phase: 'exited', exitCode: 0 })).toBe('Exited (code 0)');
  });
});

describe('terminal rendering', () => {
  it('adds a Terminal tab to the cockpit', () => {
    const tabs = renderWorkspaceTabs(workspaceId, 'terminal');
    expect(tabs).toContain(`href="/dashboard/workspaces/${workspaceId}/terminal" aria-current="page"`);
  });

  it('renders the pane with a live status region, a release hint, and no inline style', () => {
    const markup = renderTerminalPanel({ workspaceId, terminals: [] });
    expect(markup).toContain('id="terminal-panel"');
    expect(markup).toMatch(/role="status" aria-live="polite"/);
    expect(markup).toContain('<kbd>Ctrl+Shift+F6</kbd>');
    expect(markup).toContain('id="terminal-new"');
    expect(markup).toContain('id="terminal-close" class="danger" type="button" disabled');
    expect(markup).not.toContain('terminal-reattach');
    expect(markup).not.toMatch(/style=|<h1/);
  });

  it('offers re-attach only for running terminals', () => {
    const markup = renderTerminalPanel({
      workspaceId,
      terminals: [view(), view({ terminalId: `term_${'x'.repeat(24)}`, status: 'exited', exitCode: 0 })],
      now: Date.parse('2026-10-13T00:05:00.000Z')
    });
    expect(markup).toContain(`data-terminal-id="${terminalId}"`);
    expect(markup).not.toContain(`term_${'x'.repeat(24)}`);
    expect(markup).toContain('80×24');
  });

  it('lists terminals for the operator with links, size, age, expiry, and a guarded close', () => {
    const markup = renderTerminalsIndex({
      terminals: [view(), view({ terminalId: `term_${'y'.repeat(24)}`, status: 'timed_out' })],
      workspaces: [{ workspaceId, repositoryUrl: 'https://github.com/example/project.git' }],
      now: Date.parse('2026-10-13T02:00:00.000Z')
    });
    expect(markup).toContain(`href="/dashboard/workspaces/${workspaceId}/terminal"`);
    expect(markup).toContain('example/project');
    expect(markup).toContain('Idle expiry');
    expect(markup).toContain('80×24');
    expect(markup).toContain(`class="danger close-terminal" type="button" data-terminal-id="${terminalId}" data-workspace-id="${workspaceId}">Close`);
    expect(markup).toMatch(new RegExp(`data-terminal-id="term_${'y'.repeat(24)}"[^>]*disabled`));
    expect(markup).toContain('Timed out');
    expect(markup).toContain('<h2 id="terminals-heading">Terminals</h2>');
    expect(markup).toContain('Ended terminals stay listed briefly');
    expect(renderTerminalsIndex({ terminals: [] })).toContain('No terminals are running.');
  });

  it('escapes runner-supplied values', () => {
    const markup = renderTerminalsIndex({ terminals: [view({ terminalId: '<img src=x>', workspaceId: '"><script>' })] });
    expect(markup).not.toContain('<img src=x>');
    expect(markup).not.toContain('<script>');
  });
});

describe('CSP style adapter', () => {
  /** The smallest document the adapter touches: custom elements, CSSOM sheets, and element creation. */
  function fakeDocument() {
    class FakeElement {
      readonly attributes = new Map<string, string>();
      readonly style = { cssText: '' };
      hidden = false;
      ownerDocument: unknown;
      constructor(readonly tagName: string) {}
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    }
    class FakeSheet {
      css = '';
      replaceSync(text: string) { this.css = text; }
    }
    const registry = new Map<string, new () => FakeElement>();
    const documentRef: Record<string, unknown> & { adoptedStyleSheets: FakeSheet[] } = {
      adoptedStyleSheets: [],
      defaultView: {
        HTMLElement: class extends FakeElement { constructor() { super('custom'); } },
        CSSStyleSheet: FakeSheet,
        customElements: {
          get: (name: string) => registry.get(name),
          define: (name: string, constructor: new () => FakeElement) => { registry.set(name, constructor); }
        }
      },
      createElement(name: string) {
        const Custom = registry.get(name);
        const element = Custom ? new Custom() : new FakeElement(name);
        element.ownerDocument = documentRef;
        return element;
      }
    };
    return { documentRef, registry };
  }

  it('turns a script-created style element into an adopted stylesheet while it is connected', () => {
    const { documentRef, registry } = fakeDocument();
    installCspStyleAdapter(documentRef);
    expect(registry.has('ch-cssom-style')).toBe(true);
    const style = (documentRef.createElement as (name: string) => {
      textContent: string; hidden: boolean; connectedCallback(): void; disconnectedCallback(): void;
    })('STYLE');
    style.textContent = '.xterm { color: #fff; }';
    expect(style.textContent).toBe('.xterm { color: #fff; }');
    style.connectedCallback();
    expect(style.hidden).toBe(true);
    expect(documentRef.adoptedStyleSheets).toHaveLength(1);
    expect(documentRef.adoptedStyleSheets[0]!.css).toBe('.xterm { color: #fff; }');
    style.textContent = '.xterm { color: #000; }';
    expect(documentRef.adoptedStyleSheets[0]!.css).toBe('.xterm { color: #000; }');
    style.connectedCallback();
    expect(documentRef.adoptedStyleSheets).toHaveLength(1);
    style.disconnectedCallback();
    expect(documentRef.adoptedStyleSheets).toEqual([]);
  });

  it('maps setAttribute("style") to style.cssText and leaves other attributes alone', () => {
    const { documentRef } = fakeDocument();
    installCspStyleAdapter(documentRef);
    const element = (documentRef.createElement as (name: string) => {
      style: { cssText: string }; attributes: Map<string, string>; setAttribute(name: string, value: string): void;
    })('span');
    element.setAttribute('Style', 'color: #abcdef');
    element.setAttribute('class', 'xterm-fg-1');
    expect(element.style.cssText).toBe('color: #abcdef');
    expect(element.attributes.has('Style')).toBe(false);
    expect(element.attributes.get('class')).toBe('xterm-fg-1');
  });

  it('installs once per document', () => {
    const { documentRef } = fakeDocument();
    installCspStyleAdapter(documentRef);
    const patched = documentRef.createElement;
    installCspStyleAdapter(documentRef);
    expect(documentRef.createElement).toBe(patched);
    expect(documentRef.chCspStyleAdapter).toBe(true);
  });
});
