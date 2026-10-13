import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TerminalReadResultSchema, type TerminalView } from '@cloud-harness/contracts';
import { removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { DockerPtyClient } from '../../apps/runner/src/docker-pty.js';
import { OperationManager } from '../../apps/runner/src/operation-manager.js';

/**
 * Real PTYs against a real, hardened executor container. The container is started with the same
 * restrictions `WorkspaceService.createExecutor` applies, so these prove the Engine API transport, the
 * session-leader pid capture, and whole-session teardown under the production sandbox.
 */
const image = process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local';
const container = `chm-terminal-pty-test-${randomBytes(6).toString('hex')}`;
const owner = 'terminal-owner';
const workspaceId = `ws_${'t'.repeat(24)}`;
let directory: string;
let manager: OperationManager;

type Session = { view: TerminalView; cursor: string; text: string };

async function open(cols = 80, rows = 24): Promise<Session> {
  const view = await manager.openTerminal({ ownerId: owner, workspaceId, container, cwd: '.', cols, rows });
  return { view, cursor: '0', text: '' };
}

function send(session: Session, input: string): void {
  manager.writeTerminal(owner, workspaceId, session.view.terminalId, Buffer.from(input, 'utf8'));
}

async function pump(session: Session, waitMs: number): Promise<TerminalView> {
  const page = TerminalReadResultSchema.parse(await manager.readTerminal(owner, workspaceId, session.view.terminalId, session.cursor, waitMs));
  session.text += Buffer.from(page.data, 'base64').toString('utf8');
  session.cursor = page.nextCursor;
  session.view = page.terminal;
  return page.terminal;
}

type Pattern = RegExp | string | ((text: string) => boolean);

async function waitFor(session: Session, pattern: Pattern, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  const search = () => typeof pattern === 'function'
    ? (pattern(session.text) ? true : null)
    : typeof pattern === 'string' ? (session.text.includes(pattern) ? pattern : null) : session.text.match(pattern);
  for (;;) {
    const found = search();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`terminal output did not match ${String(pattern)}; tail: ${JSON.stringify(session.text.slice(-400))}`);
    const status = await pump(session, 1_000);
    if (status.status !== 'running' && !search()) {
      throw new Error(`terminal ended (${status.status}) before matching ${String(pattern)}`);
    }
  }
}

async function waitForStatus(session: Session, timeoutMs = 20_000): Promise<TerminalView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await pump(session, 1_000);
    if (view.status !== 'running') return view;
  }
  throw new Error('terminal did not end');
}

async function exec(...args: string[]) {
  return await runDocker(['exec', container, ...args], { timeoutMs: 15_000 });
}

async function sessionPid(terminalId: string): Promise<string> {
  const result = await exec('cat', `/tmp/cloud-harness-shells/${terminalId}.pid`);
  expect(result.exitCode).toBe(0);
  const pid = result.stdout.trim();
  expect(pid).toMatch(/^[0-9]+$/);
  return pid;
}

async function sessionProcesses(sid: string): Promise<string> {
  const result = await exec('ps', '-o', 'pid=,pgid=,comm=', '--sid', sid);
  return result.stdout.trim();
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-terminal-pty-'));
  chmodSync(directory, 0o777);
  const created = await runDocker([
    'run', '--detach', '--name', container,
    '--label', 'cloud-harness.test=terminal-pty',
    '--user', '10001:10001', '--workdir', '/workspace', '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024',
    '--network', 'none',
    '--volume', `${directory}:/workspace:rw`,
    '--env', 'HOME=/tmp/cloud-harness-home',
    '--env', 'PATH=/workspace/node_modules/.bin:/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    image
  ], { timeoutMs: 60_000 });
  if (created.exitCode !== 0) throw new Error(`executor test container failed to start: ${created.stderr}`);
  manager = new OperationManager(undefined, 'terminal-pty-test');
}, 90_000);

afterEach(async () => {
  // A failed assertion must not leak a live PTY into the next test's per-workspace limit.
  for (const view of manager.listTerminals(owner, workspaceId)) {
    if (view.status === 'running') await manager.closeTerminal(owner, workspaceId, view.terminalId).catch(() => undefined);
  }
}, 30_000);

afterAll(async () => {
  if (manager) await manager.stopWorkspace(workspaceId).catch(() => undefined);
  await removeContainer(container).catch(() => undefined);
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 60_000);

describe('real PTY terminals in a hardened executor', () => {
  it('allocates a PTY of the requested size, follows resizes, and keeps the sandbox identity', async () => {
    const session = await open(100, 30);
    await waitFor(session, /\$ $/m);
    send(session, 'echo "M1:$(tty)"; echo "M2:$(stty size)"; echo "M3:$(id -u):$(id -g)"; echo "M4:$(test -e /var/run/docker.sock && echo present || echo absent)"; echo "M5:$PWD:$TERM"; echo "M6:$PATH"\r');
    await waitFor(session, /M1:\/dev\/pts\/[0-9]+/);
    await waitFor(session, 'M2:30 100');
    await waitFor(session, 'M3:10001:10001');
    await waitFor(session, 'M4:absent');
    await waitFor(session, 'M5:/workspace:xterm-256color');
    await waitFor(session, /M6:[^\r\n]*\/opt\/user-tools\/bin/);

    const pid = await sessionPid(session.view.terminalId);
    const leader = await exec('ps', '-o', 'sid=', '-p', pid);
    expect(leader.stdout.trim()).toBe(pid);

    await manager.resizeTerminal(owner, workspaceId, session.view.terminalId, 120, 40);
    send(session, 'echo "M7:$(stty size)"\r');
    await waitFor(session, 'M7:40 120');

    send(session, "printf 'R:%s:\\x41:%s\\n' \"$((6*7))\" 'h\u00e9llo \u2713'\r");
    await waitFor(session, 'R:42:A:h\u00e9llo \u2713');
    await manager.closeTerminal(owner, workspaceId, session.view.terminalId);
  });

  it('interrupts a foreground job with Ctrl-C', async () => {
    const session = await open();
    await waitFor(session, /\$ $/m);
    send(session, 'sleep 100\r');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const started = Date.now();
    send(session, '\x03');
    // An interrupt flushes the tty input queue, so type the probe only once the prompt is back.
    await waitFor(session, /\^C[\s\S]*\$ $/m);
    send(session, 'echo "AFTER:$?"\r');
    await waitFor(session, 'AFTER:130');
    expect(Date.now() - started).toBeLessThan(10_000);
    await manager.closeTerminal(owner, workspaceId, session.view.terminalId);
  });

  it('runs full-screen programs: vim on the alternate screen and top redrawn in place', async () => {
    const session = await open();
    await waitFor(session, /\$ $/m);
    send(session, 'vim -u NONE /tmp/vim-probe.txt\r');
    await waitFor(session, '\x1b[?1049h');
    send(session, '\x1b:q!\r');
    await waitFor(session, '\x1b[?1049l');
    send(session, 'echo "VIM_DONE:$?"\r');
    await waitFor(session, 'VIM_DONE:0');

    // procps top does not switch to the alternate screen: it enables keypad-transmit mode, clears the
    // screen, and redraws in place, then restores keypad mode on quit.
    const beforeTop = session.text.length;
    send(session, 'top\r');
    const fullScreenAt = () => session.text.indexOf('\x1b[?1h\x1b=', beforeTop);
    await waitFor(session, (text) => fullScreenAt() >= 0 && text.indexOf('avail Mem', fullScreenAt()) >= 0);
    expect(session.text.indexOf('\x1b[H\x1b[2J', fullScreenAt())).toBeGreaterThan(0);
    send(session, 'q');
    await waitFor(session, (text) => text.indexOf('\x1b[?1l\x1b>', fullScreenAt()) >= 0);
    send(session, 'echo "TOP_DONE:$?"\r');
    await waitFor(session, 'TOP_DONE:0');
    expect((await exec('pgrep', '-x', 'top')).stdout.trim()).toBe('');
    await manager.closeTerminal(owner, workspaceId, session.view.terminalId);
  });

  it('closing ends the whole session, including background jobs and a running vim', async () => {
    const session = await open();
    await waitFor(session, /\$ $/m);
    send(session, 'sleep 300 &\r');
    await waitFor(session, /\[1\] [0-9]+/);
    send(session, 'vim -u NONE /tmp/close-probe.txt\r');
    await waitFor(session, '\x1b[?1049h');

    const sid = await sessionPid(session.view.terminalId);
    const before = await sessionProcesses(sid);
    expect(before).toMatch(/\bvim\b/);
    expect(before).toMatch(/\bsleep\b/);
    // Job control puts vim and the background sleep in their own process groups.
    expect(new Set(before.split('\n').map((line) => line.trim().split(/\s+/)[1])).size).toBeGreaterThanOrEqual(3);

    const closed = await manager.closeTerminal(owner, workspaceId, session.view.terminalId);
    expect(closed).toMatchObject({ status: 'closed', endReason: 'closed by user' });
    expect(await sessionProcesses(sid)).toBe('');
    const leftovers = await exec('pgrep', '-a', '-f', 'close-probe|sleep 300');
    expect(leftovers.stdout.trim()).toBe('');
    await expect(exec('test', '-e', `/tmp/cloud-harness-shells/${session.view.terminalId}.pid`)).resolves.toMatchObject({ exitCode: 1 });
  });

  it('keeps the session alive when only the attach stream is destroyed, so the session kill is mandatory', async () => {
    // Drive the transport directly: the manager always kills after hanging up, which would hide the point.
    const transport = new DockerPtyClient();
    const terminalId = `term_detach_${randomBytes(6).toString('hex')}`;
    const connection = await transport.open({ container, terminalId, workingDir: '/workspace/', cols: 80, rows: 24 });
    let text = '';
    connection.onData((chunk) => { text += chunk.toString('utf8'); });
    const ended = new Promise<void>((resolveEnd) => connection.onEnd(() => resolveEnd()));
    const until = async (pattern: RegExp) => {
      const deadline = Date.now() + 20_000;
      while (!pattern.test(text)) {
        if (Date.now() > deadline) throw new Error(`output did not match ${String(pattern)}; tail: ${JSON.stringify(text.slice(-200))}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    };
    await until(/\$ $/m);
    connection.write(Buffer.from('sleep 300 &\r'));
    await until(/\[1\] [0-9]+/);
    const sid = await sessionPid(terminalId);

    connection.close();
    await ended;
    // Give the daemon well past the 250 ms forced destroy to react to the closed connection.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    const survivors = await sessionProcesses(sid);
    expect(survivors).toMatch(/\bbash\b/);
    expect(survivors).toMatch(/\bsleep\b/);

    await transport.killSession(container, terminalId);
    expect(await sessionProcesses(sid)).toBe('');
    await expect(exec('test', '-e', `/tmp/cloud-harness-shells/${terminalId}.pid`)).resolves.toMatchObject({ exitCode: 1 });
  }, 40_000);

  it('reports the shell exit code when the shell exits', async () => {
    const session = await open();
    await waitFor(session, /\$ $/m);
    send(session, 'exit 7\r');
    const ended = await waitForStatus(session);
    expect(ended).toMatchObject({ status: 'exited', exitCode: 7 });
    expect(() => send(session, 'echo late\r')).toThrow(/not running/);
  });

  it('ends visibly instead of hanging when the working directory does not exist', async () => {
    const view = await manager.openTerminal({ ownerId: owner, workspaceId, container, cwd: 'missing-directory', cols: 80, rows: 24 });
    const session: Session = { view, cursor: '0', text: '' };
    const ended = await waitForStatus(session);
    expect(['exited', 'failed']).toContain(ended.status);
    expect(ended.status === 'exited' ? ended.exitCode : 0).not.toBe(0);
  });

  it('refuses a fifth live terminal and frees the slot on close', async () => {
    const sessions = [];
    for (let index = 0; index < 4; index += 1) sessions.push(await open());
    await expect(open()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', status: 429, retryable: false });
    for (const session of sessions) await manager.closeTerminal(owner, workspaceId, session.view.terminalId);
    const leftovers = await exec('pgrep', '-c', '-x', 'bash');
    expect(leftovers.stdout.trim()).toBe('0');
  });
});
