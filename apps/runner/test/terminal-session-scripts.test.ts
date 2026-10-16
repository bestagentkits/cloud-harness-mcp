import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KILL_SESSION_SCRIPT, TERMINAL_PID_DIR, terminalCommand } from '../src/docker-pty.js';

/**
 * Runs the real shell launcher and session-kill scripts on the host, with the executor's fixed paths moved into
 * a private temporary directory. Each launched shell is spawned detached, so it leads its own session exactly as
 * the PTY's login shell does inside the executor and the session kill can only reach this test's processes.
 */
const EXECUTOR_HOME = '/tmp/cloud-harness-home';

let root: string;
let pidDir: string;
let home: string;
const children: ChildProcess[] = [];

function launcherScript(terminalId: string): string {
  const command = terminalCommand(terminalId);
  const script = command[2]!;
  expect(script).toContain(TERMINAL_PID_DIR);
  expect(script).toContain(EXECUTOR_HOME);
  return script.replaceAll(TERMINAL_PID_DIR, pidDir).replaceAll(EXECUTOR_HOME, home);
}

function startShell(terminalId: string): { child: ChildProcess; exited: Promise<number | null> } {
  const command = terminalCommand(terminalId);
  const child = spawn(command[0]!, [command[1]!, launcherScript(terminalId), ...command.slice(3)], {
    detached: true,
    // An open stdin pipe keeps the interactive shell alive until its session is killed.
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, HOME: home }
  });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited };
}

/** Asynchronous so this process can reap the killed shell while the script waits, as the executor's init does. */
function killSession(terminalId: string): Promise<number | null> {
  const child = spawn('/bin/bash', ['-c', KILL_SESSION_SCRIPT, 'terminal-close', join(pidDir, `${terminalId}.pid`)], {
    stdio: 'ignore',
    timeout: 10_000
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} was not created`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform === 'win32')('terminal session scripts', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cloud-harness-terminal-session-'));
    pidDir = join(root, 'shells');
    home = join(root, 'home');
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('ends the whole session of a shell that recorded its pid and forgets the pid file', async () => {
    const shell = startShell('term_recorded');
    const pidFile = join(pidDir, 'term_recorded.pid');
    await waitForFile(pidFile);
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(shell.child.pid));

    expect(await killSession('term_recorded')).toBe(0);
    expect(await settlesWithin(shell.exited, 5_000)).not.toBe('pending');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('keeps a shell that starts after its terminal was closed from ever running', async () => {
    // The close lands before the launcher has recorded a pid, as when a terminal is closed right after opening.
    expect(await killSession('term_raced')).toBe(0);

    const shell = startShell('term_raced');
    const code = await settlesWithin(shell.exited, 3_000);
    expect(code).not.toBe('pending');
    expect(code).not.toBe(0);

    // A retried cleanup stays successful and still blocks the shell.
    expect(await killSession('term_raced')).toBe(0);
    const retry = startShell('term_raced');
    expect(await settlesWithin(retry.exited, 3_000)).not.toBe('pending');
  });

  it('does not let a stale close of one terminal block another', async () => {
    expect(await killSession('term_other')).toBe(0);
    const shell = startShell('term_live');
    await waitForFile(join(pidDir, 'term_live.pid'));
    expect(await settlesWithin(shell.exited, 200)).toBe('pending');
    expect(await killSession('term_live')).toBe(0);
    expect(await settlesWithin(shell.exited, 5_000)).not.toBe('pending');
  });
});
