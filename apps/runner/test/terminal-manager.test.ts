import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HarnessError,
  TERMINAL_MAX_READ_BYTES,
  TerminalReadResultSchema,
  TerminalViewSchema
} from '@cloud-harness/contracts';
import { DockerPtyClient, resolveDockerSocketPath, type PtyConnection, type PtyEnd, type PtyExecState, type PtyOpenRequest, type PtyTransport } from '../src/docker-pty.js';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readBody } from '../src/docker-pty.js';
import {
  OperationManager,
  TERMINAL_CLEANUP_RETRY_DELAYS_MS,
  TERMINAL_WORKSPACE_TOUCH_INTERVAL_MS,
  TerminalOutput,
  type TerminalLimits
} from '../src/operation-manager.js';
import { SecretSnapshotRedactor } from '../src/output-redactor.js';

class FakeConnection implements PtyConnection {
  writableLength = 0;
  readonly written: Buffer[] = [];
  closed = false;
  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly endListeners: Array<(end: PtyEnd) => void> = [];
  private ended = false;

  constructor(readonly execId: string, readonly request: PtyOpenRequest) {}

  write(data: Buffer): void {
    this.written.push(Buffer.from(data));
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onEnd(listener: (end: PtyEnd) => void): void {
    this.endListeners.push(listener);
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  emit(data: string | Buffer): void {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (const listener of this.dataListeners) listener(chunk);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.endListeners) listener(error ? { error } : {});
  }
}

class FakeTransport implements PtyTransport {
  readonly connections: FakeConnection[] = [];
  readonly resizes: Array<[string, number, number]> = [];
  readonly killed: Array<[string, string]> = [];
  execState: PtyExecState = { running: false, exitCode: 0 };
  inspectError: Error | undefined;
  openError: Error | undefined;
  /** Kills that fail before one succeeds; `Infinity` makes every kill fail. */
  killFailures = 0;
  killAttempts = 0;

  async open(request: PtyOpenRequest): Promise<PtyConnection> {
    if (this.openError) throw this.openError;
    const connection = new FakeConnection(`exec-${this.connections.length}`, request);
    this.connections.push(connection);
    return connection;
  }

  async resize(execId: string, cols: number, rows: number): Promise<void> {
    this.resizes.push([execId, cols, rows]);
  }

  async inspect(): Promise<PtyExecState> {
    if (this.inspectError) throw this.inspectError;
    return this.execState;
  }

  async killSession(container: string, terminalId: string): Promise<void> {
    this.killAttempts += 1;
    if (this.killFailures > 0) {
      this.killFailures -= 1;
      throw new HarnessError('UNAVAILABLE', 'terminal session could not be terminated', 503, true);
    }
    this.killed.push([container, terminalId]);
  }
}

const OWNER = 'owner-a';
const WORKSPACE = `ws_${'a'.repeat(24)}`;
const OTHER_WORKSPACE = `ws_${'b'.repeat(24)}`;

function setup(limits: Partial<TerminalLimits> = {}) {
  const transport = new FakeTransport();
  const manager = new OperationManager(undefined, 'boot', { transport, limits });
  const open = async (workspaceId = WORKSPACE, ownerId = OWNER) => await manager.openTerminal({
    ownerId, workspaceId, container: `container-${workspaceId}`, cwd: '.', cols: 80, rows: 24
  });
  const last = () => transport.connections.at(-1)!;
  return { transport, manager, open, last };
}

async function expectHarnessError(promise: Promise<unknown> | (() => unknown), code: string, status: number, retryable?: boolean) {
  let caught: unknown;
  try {
    if (typeof promise === 'function') promise(); else await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HarnessError);
  const harness = caught as HarnessError;
  expect(harness.code).toBe(code);
  expect(harness.status).toBe(status);
  if (retryable !== undefined) expect(harness.retryable).toBe(retryable);
}

const decode = (data: string) => Buffer.from(data, 'base64').toString('utf8');

afterEach(() => {
  vi.useRealTimers();
});

describe('terminal mode of the operation manager', () => {
  it('opens a PTY in the workspace directory and returns a schema-conformant view', async () => {
    const { manager, transport } = setup();
    const view = await manager.openTerminal({ ownerId: OWNER, workspaceId: WORKSPACE, container: 'exec-ctr', cwd: 'packages/app', cols: 132, rows: 40 });
    expect(TerminalViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({ workspaceId: WORKSPACE, status: 'running', cwd: 'packages/app', cols: 132, rows: 40 });
    expect(transport.connections[0]!.request).toEqual({
      container: 'exec-ctr', terminalId: view.terminalId, workingDir: '/workspace/packages/app', cols: 132, rows: 40
    });
    await manager.openTerminal({ ownerId: OWNER, workspaceId: WORKSPACE, container: 'exec-ctr', cwd: '.', cols: 80, rows: 24 });
    expect(transport.connections[1]!.request.workingDir).toBe('/workspace/');
    const listed = manager.listTerminals(OWNER, WORKSPACE);
    expect(z.object({ terminals: z.array(TerminalViewSchema) }).parse({ terminals: listed }).terminals).toHaveLength(2);
  });

  it('pages output by absolute cursor and reports missed bytes and more', async () => {
    const { manager, open, last } = setup({ retainedBytes: 10 });
    const { terminalId } = await open();
    last().emit('abcdefghij');
    last().emit('klmno');

    const first = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    expect(TerminalReadResultSchema.parse(first)).toEqual(first);
    expect(decode(first.data)).toBe('fghijklmno');
    expect(first).toMatchObject({ cursor: '0', nextCursor: '15', missedBytes: 5, more: false });

    const tail = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '12', 0);
    expect(decode(tail.data)).toBe('mno');
    expect(tail.missedBytes).toBe(0);

    const empty = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '15', 0);
    expect(empty).toMatchObject({ data: '', nextCursor: '15', more: false });

    await expectHarnessError(manager.readTerminal(OWNER, WORKSPACE, terminalId, '16', 0), 'INVALID_INPUT', 400);
  });

  it('caps one page at the read limit and flags more output', async () => {
    const { manager, open, last } = setup();
    const { terminalId } = await open();
    last().emit(Buffer.alloc(TERMINAL_MAX_READ_BYTES + 1_000, 0x61));
    const page = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    expect(Buffer.from(page.data, 'base64').length).toBe(TERMINAL_MAX_READ_BYTES);
    expect(page.more).toBe(true);
    const rest = await manager.readTerminal(OWNER, WORKSPACE, terminalId, page.nextCursor, 0);
    expect(Buffer.from(rest.data, 'base64').length).toBe(1_000);
    expect(rest.more).toBe(false);
  });

  it('wakes a parked read as soon as output arrives', async () => {
    const { manager, open, last } = setup();
    const { terminalId } = await open();
    const started = Date.now();
    const pending = manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 20_000);
    setTimeout(() => last().emit('hello'), 20);
    const page = await pending;
    expect(decode(page.data)).toBe('hello');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('wakes a parked read on a status change and returns after waitMs otherwise', async () => {
    const { manager, open } = setup();
    const { terminalId } = await open();
    const timed = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 30);
    expect(timed).toMatchObject({ data: '', nextCursor: '0' });

    const pending = manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 20_000);
    setTimeout(() => { void manager.closeTerminal(OWNER, WORKSPACE, terminalId); }, 20);
    const page = await pending;
    expect(page.terminal.status).toBe('closed');
  });

  it('releases a parked read as soon as its caller aborts', async () => {
    const { manager, open } = setup();
    const { terminalId } = await open();
    const controller = new AbortController();
    const started = Date.now();
    const pending = manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 20_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const page = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(page).toMatchObject({ data: '', nextCursor: '0' });
    await expect(manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 20_000, controller.signal)).resolves.toMatchObject({ data: '' });
  });

  it('forwards input bytes unchanged and refuses input once the socket is backed up', async () => {
    const { manager, open, last } = setup();
    const { terminalId } = await open();
    const bytes = Buffer.from([0x03, 0x1b, 0x5b, 0x41, 0x00, 0xff]);
    manager.writeTerminal(OWNER, WORKSPACE, terminalId, bytes);
    expect(Buffer.concat(last().written)).toEqual(bytes);

    last().writableLength = 262_145;
    await expectHarnessError(() => manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('x')), 'LIMIT_EXCEEDED', 429, true);
    expect(last().written).toHaveLength(1);
  });

  it('forwards resizes to the exec and records the new geometry', async () => {
    const { manager, open, transport, last } = setup();
    const { terminalId } = await open();
    const view = await manager.resizeTerminal(OWNER, WORKSPACE, terminalId, 120, 40);
    expect(transport.resizes).toEqual([[last().execId, 120, 40]]);
    expect(view).toMatchObject({ cols: 120, rows: 40 });
  });

  it('ends an idle terminal and lets activity postpone the idle deadline', async () => {
    vi.useFakeTimers();
    const { manager, open, transport } = setup({ idleTimeoutMs: 1_000, maxLifetimeMs: 100_000 });
    const { terminalId } = await open();
    await vi.advanceTimersByTimeAsync(600);
    manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('a'));
    await vi.advanceTimersByTimeAsync(600);
    expect(manager.listTerminals(OWNER, WORKSPACE)[0]!.status).toBe('running');
    await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.listTerminals(OWNER, WORKSPACE)[0]!.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2);
    const [view] = manager.listTerminals(OWNER, WORKSPACE);
    expect(view).toMatchObject({ status: 'timed_out', endReason: 'idle timeout' });
    expect(transport.killed).toEqual([[`container-${WORKSPACE}`, terminalId]]);
  });

  it('ends a terminal at its lifetime limit despite activity', async () => {
    vi.useFakeTimers();
    const { manager, open } = setup({ idleTimeoutMs: 1_000, maxLifetimeMs: 2_500 });
    const { terminalId } = await open();
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(600);
      manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('a'));
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.listTerminals(OWNER, WORKSPACE)[0]).toMatchObject({ status: 'timed_out', endReason: 'lifetime limit' });
  });

  it('limits live terminals per workspace without affecting other workspaces', async () => {
    const { manager, open } = setup();
    const opened = [];
    for (let index = 0; index < 4; index += 1) opened.push(await open());
    await expectHarnessError(open(), 'LIMIT_EXCEEDED', 429, false);
    await expect(open(OTHER_WORKSPACE)).resolves.toMatchObject({ workspaceId: OTHER_WORKSPACE });
    await manager.closeTerminal(OWNER, WORKSPACE, opened[0]!.terminalId);
    await expect(open()).resolves.toMatchObject({ status: 'running' });
  });

  it('releases the reserved slot when the PTY cannot be opened', async () => {
    const { manager, open, transport } = setup({ maxPerWorkspace: 1 });
    transport.openError = new HarnessError('UNAVAILABLE', 'workspace executor is unavailable', 503, true);
    await expectHarnessError(open(), 'UNAVAILABLE', 503);
    transport.openError = undefined;
    await expect(open()).resolves.toMatchObject({ status: 'running' });
    expect(manager.listTerminals(OWNER)).toHaveLength(1);
  });

  it('closes a terminal, hangs up the PTY, and kills its whole session', async () => {
    const { manager, open, transport, last } = setup();
    const { terminalId } = await open();
    const ended = vi.fn();
    manager.onTerminalEnd = ended;
    const view = await manager.closeTerminal(OWNER, WORKSPACE, terminalId);
    expect(view).toMatchObject({ status: 'closed', endReason: 'closed by user' });
    expect(view.endedAt).toBeDefined();
    expect(last().closed).toBe(true);
    expect(transport.killed).toEqual([[`container-${WORKSPACE}`, terminalId]]);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]![0]).toMatchObject({ ownerId: OWNER, view: { status: 'closed' } });

    await expect(manager.closeTerminal(OWNER, WORKSPACE, terminalId)).resolves.toMatchObject({ status: 'closed' });
    expect(transport.killed).toHaveLength(1);
    expect(ended).toHaveBeenCalledTimes(1);

    await expectHarnessError(() => manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('a')), 'CONFLICT', 409);
    await expectHarnessError(manager.resizeTerminal(OWNER, WORKSPACE, terminalId, 90, 30), 'CONFLICT', 409);
    const final = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    expect(final.terminal.status).toBe('closed');
  });

  it('surfaces the shell exit code when the shell exits by itself', async () => {
    const { manager, open, transport, last } = setup();
    const { terminalId } = await open();
    transport.execState = { running: false, exitCode: 7 };
    last().emit('bye\r\n');
    last().end();
    await vi.waitFor(() => expect(manager.listTerminals(OWNER, WORKSPACE)[0]!.status).toBe('exited'));
    const page = await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    expect(page.terminal).toMatchObject({ status: 'exited', exitCode: 7 });
    expect(decode(page.data)).toBe('bye\r\n');
    await vi.waitFor(() => expect(transport.killed).toHaveLength(1));
  });

  it('marks the terminal failed when the executor disappears or the stream errors', async () => {
    const { manager, open, transport } = setup();
    const gone = await open();
    transport.inspectError = new HarnessError('UNAVAILABLE', 'workspace executor is unavailable', 503, true);
    transport.connections[0]!.end();
    await vi.waitFor(async () => expect((await manager.readTerminal(OWNER, WORKSPACE, gone.terminalId, '0', 0)).terminal)
      .toMatchObject({ status: 'failed', endReason: 'workspace executor stopped' }));

    transport.inspectError = undefined;
    const broken = await open();
    transport.connections[1]!.end(new Error('socket reset'));
    await vi.waitFor(async () => expect((await manager.readTerminal(OWNER, WORKSPACE, broken.terminalId, '0', 0)).terminal)
      .toMatchObject({ status: 'failed', endReason: 'terminal stream failed' }));
  });

  it('answers NOT_FOUND for another workspace or another owner', async () => {
    const { manager, open } = setup();
    const { terminalId } = await open();
    await expectHarnessError(manager.readTerminal(OWNER, OTHER_WORKSPACE, terminalId, '0', 0), 'NOT_FOUND', 404);
    await expectHarnessError(manager.readTerminal('owner-b', WORKSPACE, terminalId, '0', 0), 'NOT_FOUND', 404);
    await expectHarnessError(() => manager.writeTerminal(OWNER, OTHER_WORKSPACE, terminalId, Buffer.from('a')), 'NOT_FOUND', 404);
    await expectHarnessError(manager.closeTerminal('owner-b', WORKSPACE, terminalId), 'NOT_FOUND', 404);
    expect(manager.listTerminals('owner-b')).toEqual([]);
    expect(manager.listTerminals(OWNER, OTHER_WORKSPACE)).toEqual([]);
    expect(manager.listTerminals(OWNER)).toHaveLength(1);
  });

  it('ends and forgets every terminal of a stopped workspace', async () => {
    const { manager, open, transport } = setup();
    const { terminalId } = await open();
    const other = await open(OTHER_WORKSPACE);
    const ended = vi.fn();
    manager.onTerminalEnd = ended;
    await manager.stopWorkspace(WORKSPACE, OWNER);
    expect(transport.connections[0]!.closed).toBe(true);
    expect(ended.mock.calls[0]![0]).toMatchObject({ view: { status: 'failed', endReason: 'workspace stopped' } });
    await expectHarnessError(manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0), 'NOT_FOUND', 404);
    expect(manager.listTerminals(OWNER).map((view) => view.terminalId)).toEqual([other.terminalId]);
  });

  it('redacts injected secret values even when they span output chunks', async () => {
    const { manager, open, last } = setup();
    manager.redactorProvider = () => new SecretSnapshotRedactor({ API_TOKEN: 'tok-s3cr3t-value' });
    const { terminalId } = await open();
    last().emit('echo: tok-s3c');
    last().emit('r3t-value\r\n$ ');
    last().emit('tok-s3');
    await manager.closeTerminal(OWNER, WORKSPACE, terminalId);
    const text = decode((await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0)).data);
    expect(text).toContain('echo: [REDACTED_SECRET: API_TOKEN]\r\n$ ');
    expect(text).not.toContain('s3cr3t');
    expect(text.endsWith('tok-s3')).toBe(true);
  });

  it('keeps ended terminals readable for a bounded window and count', async () => {
    vi.useFakeTimers();
    const { manager, open } = setup({ endedRetentionMs: 1_000, maxEndedPerWorkspace: 2 });
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      const { terminalId } = await open();
      ids.push(terminalId);
      await manager.closeTerminal(OWNER, WORKSPACE, terminalId);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(manager.listTerminals(OWNER, WORKSPACE).map((view) => view.terminalId)).toEqual(ids.slice(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await expectHarnessError(manager.readTerminal(OWNER, WORKSPACE, ids[2]!, '0', 0), 'NOT_FOUND', 404);
  });
});

describe('Docker Engine socket resolution for terminals', () => {
  it('uses the unix socket from DOCKER_HOST or the default path', () => {
    expect(resolveDockerSocketPath(undefined)).toBe('/var/run/docker.sock');
    expect(resolveDockerSocketPath('')).toBe('/var/run/docker.sock');
    expect(resolveDockerSocketPath('unix:///run/user/1000/docker.sock')).toBe('/run/user/1000/docker.sock');
  });

  it('refuses a non-unix Docker host before contacting it', async () => {
    for (const host of ['tcp://10.0.0.5:2375', 'ssh://docker@example.com', 'unix://relative.sock']) {
      expect(() => resolveDockerSocketPath(host)).toThrow('terminal requires a unix Docker socket');
    }
    const client = new DockerPtyClient('tcp://10.0.0.5:2375');
    await expectHarnessError(client.open({ container: 'c', terminalId: 't', workingDir: '/workspace/', cols: 80, rows: 24 }), 'UNAVAILABLE', 503);
  });
});

describe('terminal output retention', () => {
  it('keeps the chunk count small under a flood of one-byte writes', () => {
    const output = new TerminalOutput(1_048_576);
    for (let index = 0; index < 100_000; index += 1) output.append(Buffer.of(0x61 + (index % 26)));
    expect(output.chunkCount).toBeLessThanOrEqual(8);
    expect(output).toMatchObject({ start: 0, length: 100_000 });
    const tail = output.read(99_974, 26).toString('latin1');
    expect(tail).toBe('abcdefghijklmnopqrstuvwxyz'.slice(99_974 % 26) + 'abcdefghijklmnopqrstuvwxyz'.slice(0, 99_974 % 26));
  });

  it('trims by index and keeps absolute cursors when one-byte writes overflow the window', () => {
    const output = new TerminalOutput(1_000);
    for (let index = 0; index < 100_000; index += 1) output.append(Buffer.of(index % 256));
    expect(output.chunkCount).toBeLessThanOrEqual(2);
    expect(output).toMatchObject({ start: 99_000, length: 1_000, end: 100_000 });
    const page = output.read(99_000, 1_000);
    expect([...page]).toEqual(Array.from({ length: 1_000 }, (_, index) => (99_000 + index) % 256));
  });

  it('stores large writes without copying them into blocks and still trims across both kinds', () => {
    const output = new TerminalOutput(40_000);
    output.append(Buffer.alloc(30_000, 0x61));
    output.append(Buffer.from('xyz'));
    output.append(Buffer.alloc(20_000, 0x62));
    expect(output).toMatchObject({ start: 10_003, length: 40_000 });
    const all = output.read(output.start, 40_000).toString('latin1');
    expect(all).toBe('a'.repeat(20_000 - 3) + 'xyz' + 'b'.repeat(20_000));
  });
});

describe('terminal lifecycle hardening', () => {
  it('refreshes the workspace lease from reads and input of a running terminal, at most once per interval', async () => {
    vi.useFakeTimers();
    const { manager, open, last } = setup();
    const activity = vi.fn();
    manager.onTerminalActivity = activity;
    const { terminalId } = await open();
    await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    expect(activity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_TOUCH_INTERVAL_MS);
    await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('a'));
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenLastCalledWith(WORKSPACE);

    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_TOUCH_INTERVAL_MS);
    manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('b'));
    expect(activity).toHaveBeenCalledTimes(2);
    expect(Buffer.concat(last().written).toString()).toBe('ab');

    await manager.closeTerminal(OWNER, WORKSPACE, terminalId);
    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_TOUCH_INTERVAL_MS);
    await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0);
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it('refuses the request when the workspace lease can no longer be refreshed', async () => {
    vi.useFakeTimers();
    const { manager, open, last } = setup();
    const { terminalId } = await open();
    manager.onTerminalActivity = () => { throw new HarnessError('EXPIRED', 'workspace lifecycle changed', 410, false); };
    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_TOUCH_INTERVAL_MS);
    await expectHarnessError(() => manager.writeTerminal(OWNER, WORKSPACE, terminalId, Buffer.from('a')), 'EXPIRED', 410);
    expect(last().written).toEqual([]);
  });

  it('clamps the reported expiries to the workspace lease when it ends sooner', async () => {
    const { manager, open } = setup({ idleTimeoutMs: 900_000, maxLifetimeMs: 28_800_000 });
    const view = await open();
    const created = Date.parse(view.createdAt);
    expect(Date.parse(view.idleExpiresAt)).toBe(created + 900_000);
    expect(Date.parse(view.hardExpiresAt)).toBe(created + 28_800_000);

    const lease = { expiresAt: created + 300_000, hardExpiresAt: created + 900_000 };
    manager.terminalWorkspaceLease = (workspaceId) => (workspaceId === WORKSPACE ? lease : undefined);
    const [clamped] = manager.listTerminals(OWNER, WORKSPACE);
    expect(clamped!.idleExpiresAt).toBe(new Date(lease.expiresAt).toISOString());
    expect(clamped!.hardExpiresAt).toBe(new Date(lease.hardExpiresAt).toISOString());

    lease.expiresAt = created + 3_600_000;
    lease.hardExpiresAt = created + 86_400_000;
    const [unclamped] = manager.listTerminals(OWNER, WORKSPACE);
    expect(Date.parse(unclamped!.idleExpiresAt)).toBe(created + 900_000);
    expect(Date.parse(unclamped!.hardExpiresAt)).toBe(created + 28_800_000);
  });

  it('retries a failed session kill with bounded backoff', async () => {
    vi.useFakeTimers();
    const { manager, open, transport } = setup({ idleTimeoutMs: 1_000 });
    const { terminalId } = await open();
    transport.killFailures = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.listTerminals(OWNER, WORKSPACE)[0]).toMatchObject({ status: 'timed_out' });
    expect(transport.killAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_RETRY_DELAYS_MS[0]!);
    expect(transport.killAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_RETRY_DELAYS_MS[1]!);
    expect(transport.killAttempts).toBe(3);
    expect(transport.killed).toEqual([[`container-${WORKSPACE}`, terminalId]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.killAttempts).toBe(3);
  });

  it('gives up after the last retry and keeps the uncleaned record until it is cleaned or the workspace stops', async () => {
    vi.useFakeTimers();
    const { manager, open, transport } = setup({ idleTimeoutMs: 1_000, endedRetentionMs: 1_000, maxEndedPerWorkspace: 0 });
    const { terminalId } = await open();
    transport.killFailures = Infinity;
    await vi.advanceTimersByTimeAsync(1_000);
    const totalBackoff = TERMINAL_CLEANUP_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    await vi.advanceTimersByTimeAsync(totalBackoff + 60_000);
    expect(transport.killAttempts).toBe(TERMINAL_CLEANUP_RETRY_DELAYS_MS.length + 1);
    // Past its retention window and over the ended cap, yet still tracked: its session may still be running.
    expect(manager.listTerminals(OWNER, WORKSPACE).map((view) => view.terminalId)).toEqual([terminalId]);

    // An explicit close is the operator's retry; once it succeeds the record prunes normally.
    await expectHarnessError(manager.closeTerminal(OWNER, WORKSPACE, terminalId), 'UNAVAILABLE', 503);
    transport.killFailures = 0;
    await expect(manager.closeTerminal(OWNER, WORKSPACE, terminalId)).resolves.toMatchObject({ status: 'timed_out' });
    expect(manager.listTerminals(OWNER, WORKSPACE)).toEqual([]);

    const second = await open();
    transport.killFailures = Infinity;
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.stopWorkspace(WORKSPACE, OWNER);
    const attempts = transport.killAttempts;
    await vi.advanceTimersByTimeAsync(totalBackoff);
    expect(transport.killAttempts).toBe(attempts);
    await expectHarnessError(manager.readTerminal(OWNER, WORKSPACE, second.terminalId, '0', 0), 'NOT_FOUND', 404);
  });

  it('still kills the session when inspecting the ended exec fails', async () => {
    const { manager, open, transport } = setup();
    const { terminalId } = await open();
    transport.inspectError = new HarnessError('TIMEOUT', 'Docker Engine request timed out', 504, true);
    transport.connections[0]!.end();
    await vi.waitFor(() => expect(transport.killed).toEqual([[`container-${WORKSPACE}`, terminalId]]));
    expect(manager.listTerminals(OWNER, WORKSPACE)[0]).toMatchObject({ status: 'failed', endReason: 'workspace executor stopped' });
  });

  it('kills whatever a failed open may have started', async () => {
    const { manager, transport, open } = setup();
    transport.openError = new HarnessError('TIMEOUT', 'Docker Engine did not start the terminal in time', 504, true);
    await expectHarnessError(open(), 'TIMEOUT', 504);
    await vi.waitFor(() => expect(transport.killed).toHaveLength(1));
    expect(transport.killed[0]![0]).toBe(`container-${WORKSPACE}`);
    expect(manager.listTerminals(OWNER)).toEqual([]);
  });

  it('drops output that arrives after the terminal ended instead of bypassing the flushed redactor', async () => {
    const { manager, open, last } = setup();
    manager.redactorProvider = () => new SecretSnapshotRedactor({ API_TOKEN: 'tok-s3cr3t-value' });
    const { terminalId } = await open();
    // FakeConnection keeps its data listeners after close, like a socket that delivers a late chunk.
    const connection = last();
    connection.emit('before ');
    await manager.closeTerminal(OWNER, WORKSPACE, terminalId);
    connection.emit('tok-s3cr3t-value after');
    const text = decode((await manager.readTerminal(OWNER, WORKSPACE, terminalId, '0', 0)).data);
    expect(text).toBe('before ');
  });
});

describe('Docker Engine response bodies for terminals', () => {
  const response = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

  it('parses JSON and treats an empty body as undefined', async () => {
    await expect(readBody(response([Buffer.from('{"Running":true}')]))).resolves.toEqual({ Running: true });
    await expect(readBody(response([]))).resolves.toBeUndefined();
  });

  it('rejects an oversized or malformed body as a retryable UNAVAILABLE', async () => {
    await expectHarnessError(readBody(response([Buffer.alloc(40_000, 0x20), Buffer.alloc(40_000, 0x20)])), 'UNAVAILABLE', 503, true);
    await expectHarnessError(readBody(response([Buffer.from('{"Running":')])), 'UNAVAILABLE', 503, true);
  });
});
