import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HarnessError } from '@cloud-harness/contracts';
import { runDocker } from './docker-engine.js';

/**
 * Interactive PTY sessions inside a workspace executor.
 *
 * The Docker CLI refuses `exec -t` without a local TTY, so the runner speaks the Engine API directly over the
 * unix socket it already holds. Every path is unversioned: current daemons reject API versions below their
 * minimum, and the unversioned route always resolves to the daemon's own version. Request and response
 * payloads are never logged because they carry terminal keystrokes and output.
 */

export type PtyOpenRequest = {
  container: string;
  terminalId: string;
  /** Absolute path inside the executor. */
  workingDir: string;
  cols: number;
  rows: number;
};

export type PtyEnd = { error?: Error | undefined };

/** One live, hijacked exec stream. With `Tty: true` the stream is raw bytes, not the multiplexed framing. */
export interface PtyConnection {
  readonly execId: string;
  /** Bytes queued for the socket but not yet flushed, used for input backpressure. */
  readonly writableLength: number;
  write(data: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  /** Fires exactly once, when the stream ends or fails. */
  onEnd(listener: (end: PtyEnd) => void): void;
  /**
   * Detach from the stream. This does NOT end the shell: the Engine keeps the exec and its PTY alive after
   * the attach connection closes, so `PtyTransport.killSession` is what actually ends the session.
   */
  close(): void;
}

export type PtyExecState = { running: boolean; exitCode: number | null };

export interface PtyTransport {
  open(request: PtyOpenRequest): Promise<PtyConnection>;
  resize(execId: string, cols: number, rows: number): Promise<void>;
  inspect(execId: string): Promise<PtyExecState>;
  /** End every process in the terminal's session, including job-control children in other process groups. */
  killSession(container: string, terminalId: string): Promise<void>;
}

export const TERMINAL_PID_DIR = '/tmp/cloud-harness-shells';

/**
 * The login shell must be the PTY session leader with a recorded pid so `pkill -s` can end the whole session.
 * `bash -i` instead of `bash -l`: Debian's /etc/profile resets PATH and would drop the executor's tool paths.
 */
export function terminalCommand(terminalId: string): string[] {
  return [
    '/bin/bash', '-c',
    `mkdir -p ${TERMINAL_PID_DIR} /tmp/cloud-harness-home && printf '%s\\n' "$$" > ${TERMINAL_PID_DIR}/"$1".pid && exec /bin/bash -i`,
    'terminal', terminalId
  ];
}

const KILL_SESSION_SCRIPT = [
  'pid_file=$1',
  'test -r "$pid_file" || exit 0',
  'read -r sid < "$pid_file" || exit 0',
  '[[ $sid =~ ^[0-9]+$ ]] || exit 1',
  'pkill -TERM -s "$sid" 2>/dev/null',
  'for _ in {1..20}; do pgrep -s "$sid" >/dev/null || { rm -f -- "$pid_file"; exit 0; }; sleep 0.05; done',
  'pkill -KILL -s "$sid" 2>/dev/null',
  'for _ in {1..20}; do pgrep -s "$sid" >/dev/null || { rm -f -- "$pid_file"; exit 0; }; sleep 0.05; done',
  'exit 1'
].join('; ');

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

export function resolveDockerSocketPath(dockerHost: string | undefined = process.env.DOCKER_HOST): string {
  if (dockerHost === undefined || dockerHost === '') return '/var/run/docker.sock';
  if (dockerHost.startsWith('unix://')) {
    const path = dockerHost.slice('unix://'.length);
    if (path.startsWith('/')) return path;
  }
  throw new HarnessError('UNAVAILABLE', 'terminal requires a unix Docker socket', 503, false);
}

type JsonResponse = { status: number; body: unknown };

function engineError(status: number, body: unknown): HarnessError {
  // The daemon message can quote container names but never terminal bytes; keep it short regardless.
  const detail = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message.slice(0, 200)
    : `HTTP ${status}`;
  if (status === 404 || status === 409) return new HarnessError('UNAVAILABLE', `workspace executor is unavailable: ${detail}`, 503, true);
  return new HarnessError('UNAVAILABLE', `Docker Engine request failed: ${detail}`, 503, true);
}

/** An empty body is `undefined`; an oversized, unreadable, or non-JSON body is a retryable UNAVAILABLE. */
export function readBody(response: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      reject(new HarnessError('UNAVAILABLE', message, 503, true));
    };
    response.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        fail('Docker Engine response was too large');
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('error', () => fail('Docker Engine response could not be read'));
    response.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        fail('Docker Engine returned a malformed response');
      }
    });
  });
}

class SocketPtyConnection implements PtyConnection {
  private ended = false;
  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly endListeners: Array<(end: PtyEnd) => void> = [];
  private readonly pending: Buffer[] = [];

  constructor(
    readonly execId: string,
    private readonly readable: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
    private readonly socket: Duplex,
    head?: Buffer
  ) {
    if (head && head.length > 0) this.pending.push(head);
    readable.on('data', (chunk: Buffer) => this.emitData(chunk));
    readable.on('end', () => this.finish({}));
    readable.on('close', () => this.finish({}));
    readable.on('error', (error: Error) => this.finish({ error }));
    if (readable !== socket) {
      socket.on('close', () => this.finish({}));
      socket.on('error', (error: Error) => this.finish({ error }));
    }
  }

  get writableLength(): number {
    return this.socket.writableLength;
  }

  write(data: Buffer): void {
    if (this.ended || this.socket.destroyed) throw new HarnessError('CONFLICT', 'terminal is not running', 409, false);
    this.socket.write(data);
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
    if (this.pending.length > 0) {
      const buffered = Buffer.concat(this.pending.splice(0));
      listener(buffered);
    }
  }

  onEnd(listener: (end: PtyEnd) => void): void {
    this.endListeners.push(listener);
  }

  close(): void {
    try { this.socket.end(); } catch { /* already closed */ }
    // A half-closed upgrade socket can linger; force it so neither side keeps the attach connection open.
    // The exec's processes survive this; the caller ends them with `killSession`.
    setTimeout(() => { try { this.socket.destroy(); } catch { /* already closed */ } }, 250).unref();
  }

  private emitData(chunk: Buffer): void {
    if (this.dataListeners.length === 0) {
      this.pending.push(chunk);
      return;
    }
    for (const listener of this.dataListeners) listener(chunk);
  }

  private finish(end: PtyEnd): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.endListeners) listener(end);
  }
}

export class DockerPtyClient implements PtyTransport {
  constructor(private readonly dockerHost: string | undefined = process.env.DOCKER_HOST) {}

  private socketPath(): string {
    return resolveDockerSocketPath(this.dockerHost);
  }

  private async json(method: 'GET' | 'POST', path: string, body?: unknown): Promise<JsonResponse> {
    const socketPath = this.socketPath();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return await new Promise<JsonResponse>((resolve, reject) => {
      const req = request({
        socketPath,
        method,
        path,
        headers: {
          Host: 'docker',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {})
        }
      }, (response) => {
        readBody(response).then((parsed) => resolve({ status: response.statusCode ?? 0, body: parsed }), reject);
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new HarnessError('TIMEOUT', 'Docker Engine request timed out', 504, true)));
      req.on('error', (error) => {
        reject(error instanceof HarnessError ? error : new HarnessError('UNAVAILABLE', 'Docker Engine is unreachable', 503, true));
      });
      req.end(payload);
    });
  }

  async open(input: PtyOpenRequest): Promise<PtyConnection> {
    const consoleSize = [input.rows, input.cols];
    const created = await this.json('POST', `/containers/${encodeURIComponent(input.container)}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: '10001:10001',
      WorkingDir: input.workingDir,
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
      Cmd: terminalCommand(input.terminalId),
      ConsoleSize: consoleSize
    });
    if (created.status !== 201) throw engineError(created.status, created.body);
    const execId = (created.body as { Id?: unknown } | undefined)?.Id;
    if (typeof execId !== 'string' || !/^[a-f0-9]{64}$/.test(execId)) {
      throw new HarnessError('UNAVAILABLE', 'Docker Engine returned an invalid exec identifier', 503, true);
    }
    return await this.start(execId, consoleSize);
  }

  private start(execId: string, consoleSize: number[]): Promise<PtyConnection> {
    const socketPath = this.socketPath();
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: true, ConsoleSize: consoleSize }), 'utf8');
    return new Promise<PtyConnection>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const req: ClientRequest = request({
        socketPath,
        method: 'POST',
        path: `/exec/${execId}/start`,
        headers: {
          Host: 'docker',
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          Connection: 'Upgrade',
          Upgrade: 'tcp'
        }
      });
      // Bound only the handshake; the hijacked stream itself is long-lived.
      const timer = setTimeout(() => {
        settle(() => reject(new HarnessError('TIMEOUT', 'Docker Engine did not start the terminal in time', 504, true)));
        req.destroy();
      }, REQUEST_TIMEOUT_MS);
      req.on('upgrade', (_response, socket, head) => {
        socket.setNoDelay?.(true);
        settle(() => resolve(new SocketPtyConnection(execId, socket, socket, head)));
      });
      req.on('response', (response) => {
        if (response.statusCode === 200 && response.socket) {
          // A daemon that streams without the upgrade handshake still hijacks the connection.
          const socket = response.socket;
          settle(() => resolve(new SocketPtyConnection(execId, response, socket)));
          return;
        }
        readBody(response).then(
          (body) => settle(() => reject(engineError(response.statusCode ?? 0, body))),
          () => settle(() => reject(engineError(response.statusCode ?? 0, undefined)))
        );
      });
      req.on('error', (error) => {
        settle(() => reject(error instanceof HarnessError ? error : new HarnessError('UNAVAILABLE', 'Docker Engine is unreachable', 503, true)));
      });
      req.end(payload);
    });
  }

  async resize(execId: string, cols: number, rows: number): Promise<void> {
    const response = await this.json('POST', `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`);
    if (response.status !== 200 && response.status !== 201) throw engineError(response.status, response.body);
  }

  async inspect(execId: string): Promise<PtyExecState> {
    const response = await this.json('GET', `/exec/${encodeURIComponent(execId)}/json`);
    if (response.status !== 200) throw engineError(response.status, response.body);
    const body = (response.body ?? {}) as { Running?: unknown; ExitCode?: unknown };
    return {
      running: body.Running === true,
      exitCode: typeof body.ExitCode === 'number' && Number.isInteger(body.ExitCode) ? body.ExitCode : null
    };
  }

  async killSession(container: string, terminalId: string): Promise<void> {
    const result = await runDocker([
      'exec', '--user', '10001:10001', container, '/bin/bash', '-c', KILL_SESSION_SCRIPT,
      'terminal-close', `${TERMINAL_PID_DIR}/${terminalId}.pid`
    ], { timeoutMs: 10_000, maxBytes: 8_192 });
    if (result.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'terminal session could not be terminated', 503, true);
  }
}
