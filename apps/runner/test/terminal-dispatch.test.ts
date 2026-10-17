import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HarnessError,
  TerminalReadResultSchema,
  TerminalViewSchema,
  type RunnerConfig,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { MetadataStore } from '../src/metadata-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const pty = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class FakeConnection {
    writableLength = 0;
    readonly written: Buffer[] = [];
    closed = false;
    readonly data: Array<Listener<Buffer>> = [];
    readonly ends: Array<Listener<{ error?: Error }>> = [];
    constructor(readonly execId: string, readonly container: string) {}
    write(chunk: Buffer) { this.written.push(Buffer.from(chunk)); }
    onData(listener: Listener<Buffer>) { this.data.push(listener); }
    onEnd(listener: Listener<{ error?: Error }>) { this.ends.push(listener); }
    close() {
      this.closed = true;
      for (const listener of this.ends.splice(0)) listener({});
    }
    emit(text: string) { for (const listener of this.data) listener(Buffer.from(text, 'utf8')); }
  }
  const state = { connections: [] as FakeConnection[], killed: [] as string[] };
  class DockerPtyClient {
    async open(request: { container: string }) {
      const connection = new FakeConnection(`exec-${state.connections.length}`, request.container);
      state.connections.push(connection);
      return connection;
    }
    async resize() { /* geometry is asserted by the manager tests */ }
    async inspect() { return { running: false, exitCode: 0 }; }
    async killSession(_container: string, terminalId: string) { state.killed.push(terminalId); }
  }
  return { state, DockerPtyClient };
});

vi.mock('../src/docker-pty.js', () => ({ DockerPtyClient: pty.DockerPtyClient }));

vi.mock('../src/docker-engine.js', () => ({
  runDocker: vi.fn(async (args: string[]) => {
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

import { WorkspaceService } from '../src/workspace-service.js';

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  pty.state.connections.length = 0;
  pty.state.killed.length = 0;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const principalA: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://access.example.com', subject: 'owner-a' };
const principalB: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://access.example.com', subject: 'owner-b' };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-terminal-dispatch-'));
  directories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  const config = {
    jobsRoot, stateDb: join(directory, 'state.db'), executorImage: 'executor',
    maxOutputBytes: 262_144, maxWorkspaceBytes: 536_870_912, minFreeBytes: 0,
    wallTtlSeconds: 300, idleTtlSeconds: 180
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  const ownerA = store.resolvePrincipal(principalA);
  const ownerB = store.resolvePrincipal(principalB);
  const now = Date.now();
  const workspace = (character: string, ownerId: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord => {
    const id = `ws_${character.repeat(24)}`;
    const workspacePath = join(jobsRoot, id);
    mkdirSync(join(workspacePath, 'repo'), { recursive: true });
    const record: WorkspaceRecord = {
      id, ownerId, idempotencyKey: `terminal-${character}`,
      repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
      containerName: `executor-${character}`, workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
      // The hard deadline is the wall TTL snapshotted at open, as workspace_open records it.
      createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, hardExpiresAt: now + 300_000, generation: 1, error: null,
      ...overrides
    };
    store.create(record);
    return record;
  };
  const metadata = new MetadataStore(config.stateDb);
  const service = new WorkspaceService(config, store, metadata);
  return { service, store, metadata, ownerA, ownerB, workspace };
}

async function expectCode(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HarnessError);
  expect((error as HarnessError).code).toBe(code);
  expect((error as HarnessError).status).toBe(status);
}

describe('internal terminal dispatch', () => {
  it('runs the terminal lifecycle for the owner with metadata-only audit rows', async () => {
    const { service, metadata, ownerA, workspace } = fixture();
    const ws = workspace('a', ownerA);
    const opened = await service.executeInternal(principalA, 'terminal_open', { workspaceId: ws.id, cwd: 'src', cols: 100, rows: 30 });
    expect(opened).toMatchObject({ ok: true, truncated: false });
    const view = TerminalViewSchema.parse(opened.data);
    expect(view).toMatchObject({ workspaceId: ws.id, cwd: 'src', cols: 100, rows: 30, status: 'running' });
    expect(pty.state.connections[0]!.container).toBe('executor-a');

    const keystrokes = Buffer.from('echo hidden-input\r\x03', 'utf8');
    const input = await service.executeInternal(principalA, 'terminal_input', {
      workspaceId: ws.id, terminalId: view.terminalId, data: keystrokes.toString('base64')
    });
    expect(TerminalViewSchema.parse(input.data).status).toBe('running');
    expect(Buffer.concat(pty.state.connections[0]!.written)).toEqual(keystrokes);

    pty.state.connections[0]!.emit('hidden-output\r\n');
    const read = await service.executeInternal(principalA, 'terminal_read', { workspaceId: ws.id, terminalId: view.terminalId });
    const page = TerminalReadResultSchema.parse(read.data);
    expect(Buffer.from(page.data, 'base64').toString('utf8')).toBe('hidden-output\r\n');

    const resized = await service.executeInternal(principalA, 'terminal_resize', { workspaceId: ws.id, terminalId: view.terminalId, cols: 90, rows: 20 });
    expect(TerminalViewSchema.parse(resized.data)).toMatchObject({ cols: 90, rows: 20 });

    const listed = await service.executeInternal(principalA, 'terminal_list', { workspaceId: ws.id });
    expect(z.object({ terminals: z.array(TerminalViewSchema) }).strict().parse(listed.data).terminals).toHaveLength(1);
    const listedAll = await service.executeInternal(principalA, 'terminal_list', {});
    expect((listedAll.data as { terminals: unknown[] }).terminals).toHaveLength(1);

    const closed = await service.executeInternal(principalA, 'terminal_close', { workspaceId: ws.id, terminalId: view.terminalId });
    expect(TerminalViewSchema.parse(closed.data)).toMatchObject({ status: 'closed', endReason: 'closed by user' });
    expect(pty.state.killed).toEqual([view.terminalId]);

    const audit = metadata.listAudit(ownerA, 100).filter((event) => event.action.startsWith('terminal.'));
    expect(audit.map((event) => event.action).sort()).toEqual(['terminal.closed', 'terminal.opened']);
    expect(audit.find((event) => event.action === 'terminal.opened')!.details).toEqual({
      terminalId: view.terminalId, workspaceId: ws.id, cwd: 'src', cols: 100, rows: 30
    });
    expect(audit.find((event) => event.action === 'terminal.closed')!.details).toMatchObject({
      terminalId: view.terminalId, status: 'closed', reason: 'closed by user'
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('hidden-input');
    expect(serialized).not.toContain('hidden-output');
  });

  it('answers NOT_FOUND to a foreign owner and never leaks a terminal across workspaces', async () => {
    const { service, ownerA, ownerB, workspace } = fixture();
    const wsA = workspace('a', ownerA);
    const wsA2 = workspace('c', ownerA);
    workspace('b', ownerB);
    const view = TerminalViewSchema.parse((await service.executeInternal(principalA, 'terminal_open', { workspaceId: wsA.id })).data);

    await expectCode(service.executeInternal(principalB, 'terminal_open', { workspaceId: wsA.id }), 'NOT_FOUND', 404);
    await expectCode(service.executeInternal(principalB, 'terminal_read', { workspaceId: wsA.id, terminalId: view.terminalId }), 'NOT_FOUND', 404);
    await expectCode(service.executeInternal(principalB, 'terminal_input', { workspaceId: wsA.id, terminalId: view.terminalId, data: 'YQ==' }), 'NOT_FOUND', 404);
    await expectCode(service.executeInternal(principalB, 'terminal_close', { workspaceId: wsA.id, terminalId: view.terminalId }), 'NOT_FOUND', 404);
    await expectCode(service.executeInternal(principalB, 'terminal_list', { workspaceId: wsA.id }), 'NOT_FOUND', 404);
    expect((await service.executeInternal(principalB, 'terminal_list', {})).data).toEqual({ terminals: [] });

    await expectCode(service.executeInternal(principalA, 'terminal_read', { workspaceId: wsA2.id, terminalId: view.terminalId }), 'NOT_FOUND', 404);
    await expectCode(service.executeInternal(principalA, 'terminal_close', { workspaceId: wsA2.id, terminalId: view.terminalId }), 'NOT_FOUND', 404);
    await expectCode(service.executeInternal(principalA, 'terminal_read', { workspaceId: `ws_${'z'.repeat(24)}`, terminalId: view.terminalId }), 'NOT_FOUND', 404);
    expect(pty.state.connections).toHaveLength(1);
    expect(pty.state.connections[0]!.written).toEqual([]);
    expect(pty.state.killed).toEqual([]);
  });

  it('refuses terminals in inactive, expired, or executor-less workspaces', async () => {
    const { service, ownerA, workspace } = fixture();
    const now = Date.now();
    const recoverable = workspace('d', ownerA, { status: 'EXPIRED_RECOVERABLE', containerName: null });
    const closed = workspace('e', ownerA, { status: 'CLOSED', containerName: null });
    const expired = workspace('f', ownerA, { expiresAt: now - 1 });
    const noExecutor = workspace('g', ownerA, { containerName: null });

    await expectCode(service.executeInternal(principalA, 'terminal_open', { workspaceId: recoverable.id }), 'EXPIRED', 410);
    await expectCode(service.executeInternal(principalA, 'terminal_open', { workspaceId: closed.id }), 'EXPIRED', 409);
    await expectCode(service.executeInternal(principalA, 'terminal_open', { workspaceId: expired.id }), 'EXPIRED', 410);
    await expectCode(service.executeInternal(principalA, 'terminal_open', { workspaceId: noExecutor.id }), 'UNAVAILABLE', 503);
    await expectCode(service.executeInternal(principalA, 'terminal_list', { workspaceId: recoverable.id }), 'EXPIRED', 410);
    expect(pty.state.connections).toHaveLength(0);
  });

  it('ends terminals when the workspace is closed', async () => {
    const { service, store, ownerA, workspace } = fixture();
    const ws = workspace('a', ownerA);
    const view = TerminalViewSchema.parse((await service.executeInternal(principalA, 'terminal_open', { workspaceId: ws.id })).data);
    await service.executeInternal(principalA, 'workspace_close_fenced', { workspaceId: ws.id, expectedGeneration: store.byId(ws.id)!.generation });
    expect(pty.state.connections[0]!.closed).toBe(true);
    expect((await service.executeInternal(principalA, 'terminal_list', {})).data).toEqual({ terminals: [] });
    await expectCode(service.executeInternal(principalA, 'terminal_read', { workspaceId: ws.id, terminalId: view.terminalId }), 'EXPIRED', 409);
  });

  it('keeps the workspace alive while a running terminal is only read, with throttled lease writes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, store, ownerA, workspace } = fixture();
    const ws = workspace('a', ownerA);
    const view = TerminalViewSchema.parse((await service.executeInternal(principalA, 'terminal_open', { workspaceId: ws.id })).data);
    const read = async () => TerminalReadResultSchema.parse((await service.executeInternal(principalA, 'terminal_read', { workspaceId: ws.id, terminalId: view.terminalId })).data);
    const openedExpiry = store.byId(ws.id)!.expiresAt;

    vi.setSystemTime(Date.now() + 10_000);
    await read();
    expect(store.byId(ws.id)!.expiresAt).toBe(openedExpiry);

    // Past the idle lease (180 s here) the workspace survives because reads refreshed it every 30 s.
    for (let step = 0; step < 8; step += 1) {
      vi.setSystemTime(Date.now() + 30_000);
      await read();
    }
    const refreshed = store.byId(ws.id)!;
    expect(refreshed.status).toBe('ACTIVE');
    expect(refreshed.expiresAt).toBeGreaterThan(openedExpiry);
    expect(refreshed.expiresAt).toBe(Math.min(ws.createdAt + 300_000, Date.now() + 180_000));

    vi.setSystemTime(Date.now() + 5_000);
    await read();
    expect(store.byId(ws.id)!.expiresAt).toBe(refreshed.expiresAt);

    // The view reports the workspace's own, earlier deadlines instead of the 15 min / 8 h terminal limits.
    const page = await read();
    expect(page.terminal.idleExpiresAt).toBe(new Date(refreshed.expiresAt).toISOString());
    expect(page.terminal.hardExpiresAt).toBe(new Date(refreshed.hardExpiresAt).toISOString());
  });

  it('never extends a workspace past its wall-clock cap through terminal reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, store, ownerA, workspace } = fixture();
    const ws = workspace('a', ownerA);
    const view = TerminalViewSchema.parse((await service.executeInternal(principalA, 'terminal_open', { workspaceId: ws.id })).data);
    for (let step = 0; step < 9; step += 1) {
      vi.setSystemTime(Date.now() + 30_000);
      await service.executeInternal(principalA, 'terminal_read', { workspaceId: ws.id, terminalId: view.terminalId });
    }
    // 270 s in, with a 300 s wall clock: the lease stops at createdAt + wall, not at now + idle.
    expect(store.byId(ws.id)!.expiresAt).toBe(ws.createdAt + 300_000);
    vi.setSystemTime(ws.createdAt + 300_000);
    await expectCode(service.executeInternal(principalA, 'terminal_read', { workspaceId: ws.id, terminalId: view.terminalId }), 'EXPIRED', 410);
  });

  it('ends and forgets the terminals of a workspace that expires', async () => {
    const { service, store, ownerA, workspace } = fixture();
    const ws = workspace('a', ownerA);
    const view = TerminalViewSchema.parse((await service.executeInternal(principalA, 'terminal_open', { workspaceId: ws.id })).data);
    await service.executeInternal(principalA, 'terminal_close', { workspaceId: ws.id, terminalId: view.terminalId });
    const running = TerminalViewSchema.parse((await service.executeInternal(principalA, 'terminal_open', { workspaceId: ws.id })).data);
    store.update(ws.id, { expiresAt: Date.now() - 1 });
    await expectCode(service.executeInternal(principalA, 'terminal_read', { workspaceId: ws.id, terminalId: running.terminalId }), 'EXPIRED', 410);
    expect(pty.state.connections[1]!.closed).toBe(true);
    expect((await service.executeInternal(principalA, 'terminal_list', {})).data).toEqual({ terminals: [] });
  });
});
