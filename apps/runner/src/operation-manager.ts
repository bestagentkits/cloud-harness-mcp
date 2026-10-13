import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  type ErrorCode,
  HarnessError,
  TERMINAL_MAX_READ_BYTES,
  type TerminalReadResult,
  type TerminalStatus,
  type TerminalView
} from '@cloud-harness/contracts';
import { spawnDocker, terminateContainerProcessGroup } from './docker-engine.js';
import { DockerPtyClient, type PtyConnection, type PtyEnd, type PtyTransport } from './docker-pty.js';
import type { DurableTaskStatus, StateStore } from './state-store.js';

type ManagedStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
type Managed = {
  id: string;
  workspaceId: string;
  ownerId?: string | undefined;
  output: Buffer;
  offset: number;
  status: ManagedStatus;
  createdAt: number;
  idempotencyKey: string;
  child?: ChildProcessWithoutNullStreams | undefined;
  container?: string | undefined;
  exitCode?: number | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  name?: string | undefined;
  dependsOn?: string[] | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  logPath?: string | undefined;
  outputBytes?: number | undefined;
  outputArtifactId?: string | undefined;
  settled?: boolean | undefined;
  generation?: number | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
};
export type TrackedOperation = {
  id: string;
  workspaceId?: string | undefined;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  finishedAt?: number | undefined;
  deadlineMs?: number | undefined;
  progress?: { percent?: number | undefined; stage?: string | undefined; message?: string | undefined } | undefined;
  result?: unknown;
  error?: { code: ErrorCode; message: string; retryable: boolean; retryAfterMs?: number | undefined; deadline?: string | undefined } | undefined;
  output: Buffer;
  offset: number;
  child?: ChildProcessWithoutNullStreams | undefined;
  container?: string | undefined;
  abortController?: AbortController | undefined;
};
type RedactionStream = { processChunk(chunk: Buffer): Buffer; flush(): Buffer };

export type TerminalLimits = {
  /** Live (running) terminals one workspace may hold. */
  maxPerWorkspace: number;
  /** Raw output bytes retained per terminal; older bytes fall out and are reported as `missedBytes`. */
  retainedBytes: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  /** How long an ended terminal stays readable so a client can render its final screen and status. */
  endedRetentionMs: number;
  maxEndedPerWorkspace: number;
  /** Unflushed input above this is refused so a stalled PTY cannot buffer unbounded keystrokes. */
  maxPendingInputBytes: number;
};

export const DEFAULT_TERMINAL_LIMITS: TerminalLimits = {
  maxPerWorkspace: 4,
  retainedBytes: 1_048_576,
  idleTimeoutMs: 900_000,
  maxLifetimeMs: 28_800_000,
  endedRetentionMs: 600_000,
  maxEndedPerWorkspace: 16,
  maxPendingInputBytes: 262_144
};

export type TerminalOptions = {
  transport?: PtyTransport | undefined;
  limits?: { [Key in keyof TerminalLimits]?: TerminalLimits[Key] | undefined } | undefined;
};

/** Bounded output retention addressed by absolute byte offset. */
class TerminalOutput {
  private chunks: Buffer[] = [];
  /** Absolute offset of the first retained byte. */
  start = 0;
  length = 0;

  constructor(private readonly capacity: number) {}

  get end(): number {
    return this.start + this.length;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > this.capacity) {
      const first = this.chunks[0]!;
      const excess = this.length - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.start += first.length;
        this.length -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.start += excess;
        this.length -= excess;
      }
    }
  }

  read(from: number, maxBytes: number): Buffer {
    const parts: Buffer[] = [];
    let skip = from - this.start;
    let remaining = Math.min(maxBytes, this.end - from);
    for (const chunk of this.chunks) {
      if (remaining <= 0) break;
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      const slice = chunk.subarray(skip, skip + remaining);
      skip = 0;
      remaining -= slice.length;
      parts.push(slice);
    }
    return Buffer.concat(parts);
  }
}

type TerminalRecord = {
  id: string;
  workspaceId: string;
  ownerId: string;
  container: string;
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  /** Set while the PTY handshake is in flight; the id is not yet visible to any client. */
  opening: boolean;
  createdAt: number;
  lastActivityAt: number;
  exitCode?: number | undefined;
  endedAt?: number | undefined;
  endReason?: string | undefined;
  output: TerminalOutput;
  connection?: PtyConnection | undefined;
  redaction?: RedactionStream | undefined;
  waiters: Set<() => void>;
  idleTimer?: NodeJS.Timeout | undefined;
  lifetimeTimer?: NodeJS.Timeout | undefined;
  /** The session's processes are known to be gone (or the executor is). */
  sessionCleaned: boolean;
};

export type TerminalEndEvent = { ownerId: string; view: TerminalView };

const id = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;
function utf8SafeLength(buf: Buffer, maxLen: number): number {
  if (maxLen <= 0) return 0;
  if (maxLen >= buf.length) maxLen = buf.length;
  let len = maxLen;
  while (len > 0 && len > maxLen - 4) {
    const byte = buf[len - 1]!;
    if ((byte & 0x80) === 0) return len;
    if ((byte & 0xc0) === 0xc0) {
      let expected = 2;
      if ((byte & 0xe0) === 0xc0) expected = 2;
      else if ((byte & 0xf0) === 0xe0) expected = 3;
      else if ((byte & 0xf8) === 0xf0) expected = 4;
      const actual = maxLen - (len - 1);
      if (actual >= expected) return maxLen;
      return len - 1;
    }
    len--;
  }
  return maxLen;
}


export class OperationManager {
  private readonly tasks = new Map<string, Managed>();
  private readonly shells = new Map<string, Managed>();
  private readonly sessions = new Map<string, Managed>();
  private readonly idempotency = new Map<string, string>();
  private readonly genericOperations = new Map<string, TrackedOperation>();
  private readonly retainedOutputBytes = 67_108_864;
  onTaskStart?: (workspaceId: string, timeoutMs: number) => void;
  onTaskSettle?: (workspaceId: string, taskId: string) => void;
  redactorProvider?: (workspaceId: string) => { createStream(): RedactionStream } | undefined;
  /** Called once per terminal when it stops running, for metadata-only audit. */
  onTerminalEnd?: (event: TerminalEndEvent) => void;
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly terminalLimits: TerminalLimits;
  private terminalTransport?: PtyTransport | undefined;

  constructor(
    private readonly store?: StateStore,
    private readonly bootId: string = randomBytes(16).toString('hex'),
    terminalOptions: TerminalOptions = {}
  ) {
    const limits = { ...DEFAULT_TERMINAL_LIMITS };
    for (const [key, value] of Object.entries(terminalOptions.limits ?? {}) as Array<[keyof TerminalLimits, number | undefined]>) {
      if (value !== undefined) limits[key] = value;
    }
    this.terminalLimits = limits;
    this.terminalTransport = terminalOptions.transport;
  }

  hasTaskKey(key: string, ownerId?: string, workspaceId?: string): boolean {
    if (this.idempotency.has(key)) return true;
    if (this.store && ownerId && workspaceId) {
      const rawKey = key.startsWith(`task:${workspaceId}:`) ? key.slice(`task:${workspaceId}:`.length) : key;
      return this.store.getDurableTaskByIdempotencyKey(ownerId, workspaceId, rawKey) !== undefined;
    }
    return false;
  }

  private records(workspaceId: string): Managed[] {
    return [...this.tasks.values(), ...this.shells.values(), ...this.sessions.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  private enforceOutputBudget(workspaceId: string): void {
    const records = this.records(workspaceId);
    let total = records.reduce((sum, record) => sum + record.output.length, 0);
    for (const record of [...records.filter((item) => item.status !== 'running'), ...records.filter((item) => item.status === 'running')]) {
      if (total <= this.retainedOutputBytes) break;
      const removed = Math.min(record.output.length, total - this.retainedOutputBytes);
      record.output = record.output.subarray(removed);
      record.offset += removed;
      total -= removed;
    }
  }

  private reserve(map: Map<string, Managed>, workspaceId: string, limit: number): void {
    const matching = [...map.values()].filter((record) => record.workspaceId === workspaceId);
    if (matching.length < limit) return;
    const dependencies = new Set(
      [...this.tasks.values()]
        .filter((record) => record.workspaceId === workspaceId && record.status === 'queued')
        .flatMap((record) => record.dependsOn ?? [])
    );
    const evictable = matching
      .filter((record) => record.status !== 'running' && record.status !== 'queued' && !dependencies.has(record.id))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!evictable) throw new HarnessError('LIMIT_EXCEEDED', 'too many live operation handles in this workspace', 429, true);
    map.delete(evictable.id);
    this.idempotency.delete(evictable.idempotencyKey);
  }
  private settleTask(record: Managed): void {
    if (record.settled) return;
    record.settled = true;
    this.onTaskSettle?.(record.workspaceId, record.id);
  }

  private track(record: Managed, child: ChildProcessWithoutNullStreams, maxBytes: number): void {
    record.child = child;
    const redactor = this.redactorProvider?.(record.workspaceId);
    const stdoutStream = redactor?.createStream();
    const stderrStream = redactor?.createStream();

    const append = (rawChunk: Buffer, stream?: { processChunk(chunk: Buffer): Buffer; flush(): Buffer }) => {
      const chunk = stream ? stream.processChunk(rawChunk) : rawChunk;
      if (chunk.length === 0) return;
      const currentBytes = record.outputBytes ?? 0;
      const allowedBytes = Math.max(0, maxBytes - currentBytes);
      if (allowedBytes > 0 && record.logPath) {
        const sliceToWrite = chunk.length <= allowedBytes ? chunk : chunk.subarray(0, allowedBytes);
        try {
          appendFileSync(record.logPath, sliceToWrite);
        } catch (err) {
          record.status = 'failed';
          record.errorCode = 'INTERNAL_ERROR';
          record.errorMessage = `Failed to write task output log: ${err instanceof Error ? err.message : String(err)}`;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          if (this.store && this.tasks.has(record.id)) {
            try {
              const current = this.store.getDurableTask(record.ownerId ?? '', record.workspaceId, record.id);
              const gen = current?.generation ?? record.generation ?? 1;
              this.store.updateDurableTaskStatus(record.id, gen, {
                status: 'FAILED',
                errorCode: record.errorCode,
                errorMessage: record.errorMessage,
                finishedAt: Date.now(),
                outputBytes: record.outputBytes ?? 0
              });
              record.generation = gen + 1;
            } catch { /* ignore */ }
          }
          this.reconcileQueued(record.workspaceId);
          this.settleTask(record);
          return;
        }
      }
      record.outputBytes = currentBytes + chunk.length;
      const next = Buffer.concat([record.output, chunk]);
      const removed = Math.max(0, next.length - maxBytes);
      record.offset += removed;
      record.output = next.subarray(removed);
      this.enforceOutputBudget(record.workspaceId);
    };

    child.stdout.on('data', (chunk: Buffer) => append(chunk, stdoutStream));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, stderrStream));
    child.on('close', (code) => {
      if (stdoutStream || stderrStream) {
        const flushedOut = stdoutStream?.flush() ?? Buffer.alloc(0);
        const flushedErr = stderrStream?.flush() ?? Buffer.alloc(0);
        const flushed = Buffer.concat([flushedOut, flushedErr]);
        if (flushed.length > 0) {
          const next = Buffer.concat([record.output, flushed]);
          const removed = Math.max(0, next.length - maxBytes);
          record.offset += removed;
          record.output = next.subarray(removed);
          this.enforceOutputBudget(record.workspaceId);
        }
      }
      record.exitCode = code ?? 1;
      if (record.status === 'running') record.status = code === 0 ? 'succeeded' : 'failed';
      record.finishedAt = Date.now();
      if (this.store && this.tasks.has(record.id)) {
        try {
          const statusUpper = (record.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED') as DurableTaskStatus;
          const current = this.store.getDurableTask(record.ownerId ?? '', record.workspaceId, record.id);
          const gen = current?.generation ?? record.generation ?? 1;
          this.store.updateDurableTaskStatus(record.id, gen, {
            status: statusUpper,
            exitCode: record.exitCode,
            finishedAt: record.finishedAt,
            outputBytes: record.outputBytes ?? record.output.length
          });
          record.generation = gen + 1;
        } catch { /* ignore if store is closed */ }
      }
      this.reconcileQueued(record.workspaceId);
      if (this.tasks.has(record.id)) {
        this.settleTask(record);
      }
    });
  }
  private openInteractive(
    map: Map<string, Managed>,
    prefix: 'sh' | 'sess',
    kind: 'shell' | 'session',
    workspaceId: string,
    container: string,
    cwd: string,
    key: string,
    maxBytes: number,
    name?: string
  ): Managed {
    const mapKey = `${kind}:${workspaceId}:${key}`;
    const prior = this.idempotency.get(mapKey);
    if (prior) return map.get(prior)!;
    this.reserve(map, workspaceId, 32);
    if (name && [...map.values()].some((record) => record.workspaceId === workspaceId && record.name === name && record.status === 'running')) {
      throw new HarnessError('CONFLICT', `session ${name} is already running`, 409, false);
    }
    const recordId = id(prefix);
    const record: Managed = {
      id: recordId,
      workspaceId,
      output: Buffer.alloc(0),
      offset: 0,
      status: 'running',
      container,
      createdAt: Date.now(),
      idempotencyKey: mapKey,
      ...(name ? { name } : {})
    };
    const child = spawnDocker([
      'exec', '-i', '-w', `/workspace/${cwd === '.' ? '' : cwd}`,
      container, '/usr/bin/setsid', '--wait', '/opt/harness/shell-runner.sh', recordId
    ]);
    map.set(record.id, record);
    this.idempotency.set(mapKey, record.id);
    this.track(record, child, maxBytes);
    return record;
  }

  openShell(workspaceId: string, container: string, cwd: string, key: string, maxBytes: number): Managed {
    return this.openInteractive(this.shells, 'sh', 'shell', workspaceId, container, cwd, key, maxBytes);
  }

  private interactiveIo(map: Map<string, Managed>, workspaceId: string, recordId: string, input?: string): Managed {
    const record = map.get(recordId);
    if (!record || record.workspaceId !== workspaceId) throw new HarnessError('NOT_FOUND', 'interactive session not found', 404, false);
    if (input && record.status === 'running') record.child?.stdin.write(input);
    return record;
  }

  shellIo(workspaceId: string, shellId: string, input?: string): Managed {
    return this.interactiveIo(this.shells, workspaceId, shellId, input);
  }

  private async closeInteractive(map: Map<string, Managed>, workspaceId: string, recordId: string): Promise<Managed> {
    const record = this.interactiveIo(map, workspaceId, recordId);
    if (record.status !== 'running') return record;
    await terminateContainerProcessGroup(record.container!, `/tmp/cloud-harness-shells/${record.id}.pid`);
    record.status = 'cancelled';
    record.child?.stdin.end();
    record.child?.kill();
    return record;
  }

  closeShell(workspaceId: string, shellId: string): Promise<Managed> {
    return this.closeInteractive(this.shells, workspaceId, shellId);
  }

  openSession(workspaceId: string, container: string, name: string, cwd: string, key: string, maxBytes: number): Managed {
    return this.openInteractive(this.sessions, 'sess', 'session', workspaceId, container, cwd, key, maxBytes, name);
  }

  sessionIo(workspaceId: string, sessionId: string, input?: string): Managed {
    return this.interactiveIo(this.sessions, workspaceId, sessionId, input);
  }

  closeSession(workspaceId: string, sessionId: string): Promise<Managed> {
    return this.closeInteractive(this.sessions, workspaceId, sessionId);
  }

  listSessions(workspaceId: string): Managed[] {
    return [...this.sessions.values()].filter((record) => record.workspaceId === workspaceId).sort((left, right) => left.createdAt - right.createdAt);
  }

  runTask(
    workspaceId: string,
    container: string,
    cwd: string,
    command: string,
    key: string,
    timeoutMs: number,
    maxBytes: number,
    dependsOn: string[] = [],
    ownerId?: string,
    workspacePath?: string,
    name?: string
  ): Managed & { created?: boolean } {
    const mapKey = `task:${workspaceId}:${key}`;
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command, cwd: cwd || '.', timeoutMs, maxBytes, dependsOn: [...dependsOn].sort(), name: name ?? null }))
      .digest('hex');

    if (this.store && ownerId) {
      const persisted = this.store.getDurableTaskByIdempotencyKey(ownerId, workspaceId, key);
      if (persisted) {
        if (persisted.requestFingerprint && persisted.requestFingerprint !== requestFingerprint) {
          throw new HarnessError('CONFLICT', 'Idempotency key reused with different task parameters', 409, false);
        }
        const memoryRecord = this.tasks.get(persisted.id);
        if (memoryRecord) return Object.assign(memoryRecord, { created: false });
        return {
          id: persisted.id,
          workspaceId: persisted.workspaceId,
          ownerId: persisted.ownerId,
          output: Buffer.alloc(0),
          offset: 0,
          status: persisted.status.toLowerCase() as ManagedStatus,
          createdAt: persisted.createdAt,
          idempotencyKey: mapKey,
          name: persisted.name ?? undefined,
          command: persisted.command,
          cwd: persisted.cwd,
          timeoutMs: persisted.timeoutMs,
          maxBytes: persisted.maxBytes,
          logPath: persisted.logPath,
          outputBytes: persisted.outputBytes,
          outputArtifactId: persisted.outputArtifactId ?? undefined,
          exitCode: persisted.exitCode ?? undefined,
          errorCode: persisted.errorCode ?? undefined,
          errorMessage: persisted.errorMessage ?? undefined,
          dependsOn: persisted.dependsOn,
          generation: persisted.generation,
          startedAt: persisted.startedAt ?? undefined,
          finishedAt: persisted.finishedAt ?? undefined,
          created: false
        };
      }
    } else {
      const prior = this.idempotency.get(mapKey);
      if (prior) {
        const existing = this.tasks.get(prior)!;
        return Object.assign(existing, { created: false });
      }
    }

    this.reserve(this.tasks, workspaceId, 128);
    if (new Set(dependsOn).size !== dependsOn.length) throw new HarnessError('INVALID_INPUT', 'task dependencies must be unique', 400, false);
    for (const dependencyId of dependsOn) {
      const dependency = this.tasks.get(dependencyId) ?? (this.store && ownerId ? this.store.getDurableTask(ownerId, workspaceId, dependencyId) : undefined);
      if (!dependency || dependency.workspaceId !== workspaceId) throw new HarnessError('NOT_FOUND', `task dependency ${dependencyId} not found`, 404, false);
    }

    const taskId = id('task');
    const logPath = workspacePath
      ? join(workspacePath, '.chm', 'tasks', `${taskId}.log`)
      : join(tmpdir(), `chm-task-${taskId}.log`);

    if (workspacePath) {
      try {
        mkdirSync(join(workspacePath, '.chm', 'tasks'), { recursive: true, mode: 0o700 });
      } catch { /* ignore */ }
    } else {
      try {
        mkdirSync(join(tmpdir(), 'cloud-harness-tasks'), { recursive: true, mode: 0o700 });
      } catch { /* ignore */ }
    }

    try {
      const fd = openSync(logPath, 'w', 0o600);
      closeSync(fd);
    } catch (err) {
      throw new HarnessError('INTERNAL_ERROR', `Failed to initialize task log file at ${logPath}: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }

    const record: Managed & { created?: boolean } = {
      id: taskId,
      workspaceId,
      ownerId,
      output: Buffer.alloc(0),
      offset: 0,
      status: 'queued',
      container,
      createdAt: Date.now(),
      idempotencyKey: mapKey,
      command,
      cwd,
      timeoutMs,
      maxBytes,
      logPath,
      outputBytes: 0,
      dependsOn: [...dependsOn],
      generation: 1,
      ...(name ? { name } : {}),
      created: true
    };

    if (this.store && ownerId) {
      this.store.createDurableTask({
        id: taskId,
        workspaceId,
        ownerId,
        name: name ?? null,
        command,
        cwd: cwd || '.',
        status: 'QUEUED',
        idempotencyKey: key,
        requestFingerprint,
        bootId: this.bootId,
        exitCode: null,
        errorCode: null,
        errorMessage: null,
        timeoutMs,
        maxBytes,
        logPath,
        outputBytes: 0,
        outputArtifactId: null,
        createdAt: record.createdAt,
        startedAt: null,
        finishedAt: null
      }, dependsOn);
    }

    this.tasks.set(record.id, record);
    this.idempotency.set(mapKey, record.id);
    this.reconcileQueued(workspaceId);
    return record;
  }

  private startTask(record: Managed): void {
    const timeoutSeconds = Math.max(1, Math.ceil(record.timeoutMs! / 1_000));
    const child = spawnDocker([
      'exec', '-i', '-w', `/workspace/${record.cwd === '.' ? '' : record.cwd}`, '-e', `CH_COMMAND=${record.command}`,
      record.container!, '/opt/harness/task-runner.sh', record.id, String(timeoutSeconds)
    ]);
    child.stdin.end();
    record.status = 'running';
    record.startedAt = Date.now();
    if (this.store && this.tasks.has(record.id)) {
      this.store.updateDurableTaskStatus(record.id, record.generation ?? 1, {
        status: 'RUNNING',
        startedAt: record.startedAt
      });
      record.generation = (record.generation ?? 1) + 1;
    }
    this.onTaskStart?.(record.workspaceId, record.timeoutMs ?? 60_000);
    this.track(record, child, record.maxBytes!);
  }

  private reconcileQueued(workspaceId: string): void {
    for (const record of this.tasks.values()) {
      if (record.workspaceId !== workspaceId || record.status !== 'queued') continue;
      const dependencies = (record.dependsOn ?? []).map((dependencyId) => this.tasks.get(dependencyId));
      if (dependencies.some((dependency) => !dependency || dependency.workspaceId !== workspaceId)) {
        record.status = 'blocked';
        if (this.store && this.tasks.has(record.id)) {
          this.store.updateDurableTaskStatus(record.id, record.generation ?? 1, { status: 'BLOCKED' });
          record.generation = (record.generation ?? 1) + 1;
        }
        this.settleTask(record);
        continue;
      }
      if (dependencies.some((dependency) => ['failed', 'cancelled', 'blocked'].includes(dependency!.status))) {
        record.status = 'blocked';
        if (this.store && this.tasks.has(record.id)) {
          this.store.updateDurableTaskStatus(record.id, record.generation ?? 1, { status: 'BLOCKED' });
          record.generation = (record.generation ?? 1) + 1;
        }
        this.settleTask(record);
        continue;
      }
      if (dependencies.every((dependency) => dependency!.status === 'succeeded')) this.startTask(record);
    }
  }

  task(workspaceId: string, taskId: string, ownerId?: string): Managed {
    const record = this.tasks.get(taskId);
    if (record && record.workspaceId === workspaceId) return record;
    if (this.store && ownerId) {
      const persisted = this.store.getDurableTask(ownerId, workspaceId, taskId);
      if (persisted) {
        return {
          id: persisted.id,
          workspaceId: persisted.workspaceId,
          ownerId: persisted.ownerId,
          output: Buffer.alloc(0),
          offset: 0,
          status: persisted.status.toLowerCase() as ManagedStatus,
          createdAt: persisted.createdAt,
          idempotencyKey: persisted.idempotencyKey ?? '',
          name: persisted.name ?? undefined,
          command: persisted.command,
          cwd: persisted.cwd,
          timeoutMs: persisted.timeoutMs,
          maxBytes: persisted.maxBytes,
          logPath: persisted.logPath,
          outputBytes: persisted.outputBytes,
          outputArtifactId: persisted.outputArtifactId ?? undefined,
          exitCode: persisted.exitCode ?? undefined,
          errorCode: persisted.errorCode ?? undefined,
          errorMessage: persisted.errorMessage ?? undefined,
          dependsOn: persisted.dependsOn,
          generation: persisted.generation,
          startedAt: persisted.startedAt ?? undefined,
          finishedAt: persisted.finishedAt ?? undefined
        };
      }
    }
    throw new HarnessError('NOT_FOUND', 'task not found', 404, false);
  }

  listTasks(workspaceId: string, ownerId?: string): Managed[] {
    if (this.store && ownerId) {
      const persisted = this.store.listDurableTasks(ownerId, workspaceId);
      const memoryMap = new Map([...this.tasks.values()].filter((r) => r.workspaceId === workspaceId).map((r) => [r.id, r]));
      return persisted.map((p) => {
        const mem = memoryMap.get(p.id);
        if (mem) return mem;
        return {
          id: p.id,
          workspaceId: p.workspaceId,
          ownerId: p.ownerId,
          output: Buffer.alloc(0),
          offset: 0,
          status: p.status.toLowerCase() as ManagedStatus,
          createdAt: p.createdAt,
          idempotencyKey: p.idempotencyKey ?? '',
          name: p.name ?? undefined,
          command: p.command,
          cwd: p.cwd,
          timeoutMs: p.timeoutMs,
          maxBytes: p.maxBytes,
          logPath: p.logPath,
          outputBytes: p.outputBytes,
          outputArtifactId: p.outputArtifactId ?? undefined,
          exitCode: p.exitCode ?? undefined,
          errorCode: p.errorCode ?? undefined,
          errorMessage: p.errorMessage ?? undefined,
          dependsOn: p.dependsOn,
          generation: p.generation,
          startedAt: p.startedAt ?? undefined,
          finishedAt: p.finishedAt ?? undefined
        };
      });
    }
    return [...this.tasks.values()].filter((record) => record.workspaceId === workspaceId).sort((left, right) => left.createdAt - right.createdAt);
  }
  taskGraph(workspaceId: string, ownerId?: string) {
    const tasks = this.listTasks(workspaceId, ownerId);
    return {
      nodes: tasks.map((record) => this.summary(record)),
      edges: tasks.flatMap((record) => (record.dependsOn ?? []).map((dependencyId) => ({ from: dependencyId, to: record.id })))
    };
  }

  async cancelTask(workspaceId: string, taskId: string, ownerId?: string): Promise<Managed> {
    const record = this.task(workspaceId, taskId, ownerId);
    if (record.status === 'queued') {
      record.status = 'cancelled';
      record.finishedAt = Date.now();
      if (this.store && this.tasks.has(record.id)) {
        this.store.updateDurableTaskStatus(record.id, record.generation ?? 1, {
          status: 'CANCELLED',
          finishedAt: record.finishedAt
        });
        record.generation = (record.generation ?? 1) + 1;
      }
      this.reconcileQueued(workspaceId);
      this.settleTask(record);
      return record;
    }
    if (record.status !== 'running') return record;
    if (record.container) {
      await terminateContainerProcessGroup(record.container, `/tmp/cloud-harness-tasks/${record.id}.pid`);
    }
    record.status = 'cancelled';
    record.finishedAt = Date.now();
    record.child?.kill();
    if (this.store && this.tasks.has(record.id)) {
      this.store.updateDurableTaskStatus(record.id, record.generation ?? 1, {
        status: 'CANCELLED',
        finishedAt: record.finishedAt
      });
      record.generation = (record.generation ?? 1) + 1;
    }
    this.reconcileQueued(workspaceId);
    this.settleTask(record);
    return record;
  }
  async stopWorkspace(workspaceId: string, ownerId?: string): Promise<void> {
    this.stopWorkspaceTerminals(workspaceId);
    const activeRecords = this.records(workspaceId).filter(
      (record) => record.status === 'running' || record.status === 'queued'
    );
    const exitPromises: Promise<void>[] = [];

    for (const record of activeRecords) {
      if (record.child && (record.child.exitCode === null && record.child.signalCode === null)) {
        const child = record.child;
        const exitPromise = new Promise<void>((resolve, reject) => {
          let resolved = false;
          let killTimer: NodeJS.Timeout | undefined;
          let deadlineTimer: NodeJS.Timeout | undefined;
          const done = () => {
            if (!resolved) {
              resolved = true;
              if (killTimer) clearTimeout(killTimer);
              if (deadlineTimer) clearTimeout(deadlineTimer);
              resolve();
            }
          };
          child.once('close', done);
          child.once('exit', done);

          killTimer = setTimeout(() => {
            killTimer = undefined;
            if (!resolved && (child.exitCode === null && child.signalCode === null)) {
              try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }
          }, 1_500);

          deadlineTimer = setTimeout(() => {
            deadlineTimer = undefined;
            if (!resolved && (child.exitCode === null && child.signalCode === null)) {
              resolved = true;
              if (killTimer) clearTimeout(killTimer);
              reject(new HarnessError('UNAVAILABLE', `Process for task ${record.id} failed to terminate within teardown deadline`, 503, true));
            } else {
              done();
            }
          }, 3_500);
        });
        exitPromises.push(exitPromise);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }

    if (exitPromises.length > 0) {
      await Promise.all(exitPromises);
    }
    const now = Date.now();
    for (const record of activeRecords) {
      record.status = 'cancelled';
      record.finishedAt = now;
      if (this.store && this.tasks.has(record.id)) {
        try {
          const current = this.store.getDurableTask(ownerId ?? record.ownerId ?? '', record.workspaceId, record.id);
          const gen = current?.generation ?? record.generation ?? 1;
          let outputBytes = record.outputBytes ?? record.output.length;
          if (record.logPath && existsSync(record.logPath)) {
            try { outputBytes = statSync(record.logPath).size; } catch { /* ignore */ }
          }
          this.store.updateDurableTaskStatus(record.id, gen, {
            status: 'CANCELLED',
            finishedAt: now,
            outputBytes
          });
          record.generation = gen + 1;
        } catch { /* ignore */ }
      }
    }

    for (const op of this.genericOperations.values()) {
      if (op.workspaceId === workspaceId) {
        if (op.status === 'running' || op.status === 'queued') {
          op.status = 'cancelled';
          op.finishedAt = Date.now();
          op.error = { code: 'CANCELLED', message: 'Workspace stopped or closed', retryable: false };
          if (op.abortController) {
            try { op.abortController.abort(); } catch { /* ignore */ }
          }
          if (op.child) {
            try { op.child.kill('SIGTERM'); } catch { /* ignore */ }
          }
        }
      }
    }
    for (const [recordId, record] of this.tasks) if (record.workspaceId === workspaceId) this.tasks.delete(recordId);
    for (const [recordId, record] of this.shells) if (record.workspaceId === workspaceId) this.shells.delete(recordId);
    for (const [recordId, record] of this.sessions) if (record.workspaceId === workspaceId) this.sessions.delete(recordId);
    for (const key of this.idempotency.keys()) if (key.includes(`:${workspaceId}:`)) this.idempotency.delete(key);
  }

  view(record: Managed) {
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exitCode,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
      output: record.output.toString('utf8'),
      ...(record.name ? { name: record.name } : {}),
      ...(record.dependsOn ? { dependsOn: record.dependsOn } : {})
    };
  }

  summary(record: Managed) {
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exitCode,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
      ...(record.name ? { name: record.name } : {}),
      ...(record.dependsOn ? { dependsOn: record.dependsOn } : {})
    };
  }

  viewSince(record: Managed, cursor?: string) {
    const requested = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(requested) || requested < 0) throw new HarnessError('INVALID_INPUT', 'invalid output cursor');

    if (record.logPath && existsSync(record.logPath)) {
      const stats = statSync(record.logPath);
      const totalBytes = stats.size;
      if (requested > totalBytes) throw new HarnessError('INVALID_INPUT', 'invalid output cursor');
      const pageSize = 65_536;
      const readLength = Math.min(pageSize, totalBytes - requested);
      let pageText = '';
      let consumedBytes = 0;
      if (readLength > 0) {
        const fd = openSync(record.logPath, 'r');
        const buf = Buffer.alloc(readLength);
        try {
          readSync(fd, buf, 0, readLength, requested);
          const safeLen = utf8SafeLength(buf, readLength);
          consumedBytes = safeLen > 0 ? safeLen : readLength;
          pageText = buf.subarray(0, consumedBytes).toString('utf8');
        } finally {
          closeSync(fd);
        }
      }
      const nextOffset = requested + consumedBytes;
      const truncated = nextOffset < totalBytes;
      return {
        data: { ...this.view(record), output: pageText },
        cursor: String(nextOffset),
        truncated
      };
    }

    const end = record.offset + record.output.length;
    if (requested > end) throw new HarnessError('INVALID_INPUT', 'invalid output cursor');
    const missedOutput = requested < record.offset;
    const start = Math.max(0, requested - record.offset);
    const maxSliceLen = Math.min(record.output.length - start, 65_536);
    const rawSlice = record.output.subarray(start, start + maxSliceLen);
    const safeLen = utf8SafeLength(rawSlice, rawSlice.length);
    const consumedLen = safeLen > 0 ? safeLen : rawSlice.length;
    const slice = rawSlice.subarray(0, consumedLen);
    const nextOffset = record.offset + start + consumedLen;
    return {
      data: { ...this.view(record), output: slice.toString('utf8') },
      cursor: String(nextOffset),
      truncated: missedOutput || nextOffset < end
    };
  }
  registerGenericOperation(op: {
    id: string;
    workspaceId?: string | undefined;
    kind: string;
    deadlineMs?: number | undefined;
    container?: string | undefined;
    abortController?: AbortController | undefined;
  }): TrackedOperation {
    const now = Date.now();
    // First evict expired terminal operations older than 10 minutes (600,000 ms)
    for (const [id, record] of this.genericOperations.entries()) {
      const isTerminal = record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled';
      if (isTerminal && now - (record.finishedAt ?? record.createdAt) >= 600_000) {
        this.genericOperations.delete(id);
      }
    }
    // If still at capacity, fail closed rather than evicting unexpired terminal or live operations
    if (this.genericOperations.size >= 500) {
      throw new HarnessError('LIMIT_EXCEEDED', 'too many live or retained operation handles (maximum 500)', 429, true);
    }
    const tracked: TrackedOperation = {
      id: op.id,
      workspaceId: op.workspaceId,
      kind: op.kind,
      status: 'running',
      createdAt: now,
      deadlineMs: op.deadlineMs,
      output: Buffer.alloc(0),
      offset: 0,
      container: op.container,
      abortController: op.abortController
    };
    this.genericOperations.set(op.id, tracked);
    return tracked;
  }

  updateGenericOperation(id: string, patch: Partial<TrackedOperation>): TrackedOperation | undefined {
    const current = this.genericOperations.get(id);
    if (!current) return undefined;
    if (patch.status && patch.status !== 'running' && patch.status !== 'queued' && !current.finishedAt) {
      current.finishedAt = Date.now();
    }
    Object.assign(current, patch);
    return current;
  }

  getGenericOperation(id: string): TrackedOperation | undefined {
    const gen = this.genericOperations.get(id);
    if (gen) {
      const isTerminal = gen.status === 'completed' || gen.status === 'failed' || gen.status === 'cancelled';
      if (isTerminal && Date.now() - (gen.finishedAt ?? gen.createdAt) >= 600_000) {
        this.genericOperations.delete(id);
        return undefined;
      }
      return gen;
    }
    const task = this.tasks.get(id);
    if (task) {
      return {
        id: task.id,
        workspaceId: task.workspaceId,
        kind: 'task',
        status: task.status === 'succeeded' ? 'completed' : task.status === 'blocked' ? 'failed' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'running',
        createdAt: task.createdAt,
        output: task.output,
        offset: task.offset,
        child: task.child,
        container: task.container,
        error: task.status === 'blocked' ? { code: 'CONFLICT', message: 'Task blocked by dependency failure', retryable: false } : undefined
      };
    }
    return undefined;
  }

  async cancelGenericOperation(id: string): Promise<TrackedOperation> {
    const op = this.genericOperations.get(id);
    if (op) {
      if (op.status === 'running' || op.status === 'queued') {
        op.status = 'cancelled';
        op.finishedAt = Date.now();
        if (op.abortController) {
          try { op.abortController.abort(); } catch { /* ignore */ }
        }
        if (op.child) {
          try { op.child.kill('SIGTERM'); } catch { /* process already exited */ }
        }
        if (op.container) {
          try {
            await terminateContainerProcessGroup(op.container, `/tmp/cloud-harness-operations/${id}.pid`);
          } catch { /* container already stopped */ }
        }
      }
      return op;
    }
    const task = this.tasks.get(id);
    if (task) {
      await this.cancelTask(task.workspaceId, id);
      return {
        id: task.id,
        workspaceId: task.workspaceId,
        kind: 'task',
        status: 'cancelled',
        createdAt: task.createdAt,
        output: task.output,
        offset: task.offset
      };
    }
    throw new HarnessError('NOT_FOUND', `operation ${id} not found`, 404, false);
  }

  hasRunningOperations(workspaceId: string): boolean {
    const hasRunningTasks = [...this.tasks.values()].some((t) => t.workspaceId === workspaceId && t.status === 'running');
    const hasRunningGeneric = [...this.genericOperations.values()].some((o) => o.workspaceId === workspaceId && o.status === 'running');
    return hasRunningTasks || hasRunningGeneric;
  }

  private ptyTransport(): PtyTransport {
    this.terminalTransport ??= new DockerPtyClient();
    return this.terminalTransport;
  }

  /** Forget ended terminals past their read window, then cap how many ended ones a workspace keeps. */
  private pruneTerminals(now = Date.now()): void {
    const endedByWorkspace = new Map<string, TerminalRecord[]>();
    for (const record of this.terminals.values()) {
      if (record.status === 'running' || record.endedAt === undefined) continue;
      if (now - record.endedAt >= this.terminalLimits.endedRetentionMs) {
        this.terminals.delete(record.id);
        continue;
      }
      const list = endedByWorkspace.get(record.workspaceId) ?? [];
      list.push(record);
      endedByWorkspace.set(record.workspaceId, list);
    }
    for (const list of endedByWorkspace.values()) {
      list.sort((left, right) => left.endedAt! - right.endedAt!);
      for (const record of list.slice(0, Math.max(0, list.length - this.terminalLimits.maxEndedPerWorkspace))) {
        this.terminals.delete(record.id);
      }
    }
  }

  private requireTerminal(ownerId: string, workspaceId: string, terminalId: string): TerminalRecord {
    this.pruneTerminals();
    const record = this.terminals.get(terminalId);
    if (!record || record.opening || record.workspaceId !== workspaceId || record.ownerId !== ownerId) {
      throw new HarnessError('NOT_FOUND', 'terminal not found', 404, false);
    }
    return record;
  }

  private wakeTerminal(record: TerminalRecord): void {
    const waiters = [...record.waiters];
    record.waiters.clear();
    for (const wake of waiters) wake();
  }

  private armIdleTimer(record: TerminalRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      this.endTerminal(record, 'timed_out', 'idle timeout');
      void this.cleanTerminalSession(record).catch(() => undefined);
    }, this.terminalLimits.idleTimeoutMs);
    record.idleTimer.unref?.();
  }

  private touchTerminal(record: TerminalRecord): void {
    if (record.status !== 'running') return;
    record.lastActivityAt = Date.now();
    this.armIdleTimer(record);
  }

  private appendTerminalOutput(record: TerminalRecord, raw: Buffer): void {
    const chunk = record.redaction ? record.redaction.processChunk(raw) : raw;
    if (chunk.length === 0) return;
    record.output.append(chunk);
    this.wakeTerminal(record);
  }

  /**
   * Move a running terminal to its final state exactly once: stop the timers, flush the redaction holdback,
   * hang up the PTY, and wake every parked reader so it observes the status change.
   */
  private endTerminal(record: TerminalRecord, status: Exclude<TerminalStatus, 'running'>, reason: string, exitCode?: number): boolean {
    if (record.status !== 'running') return false;
    record.status = status;
    record.endedAt = Date.now();
    record.endReason = reason.slice(0, 200);
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (record.idleTimer) clearTimeout(record.idleTimer);
    if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);
    record.idleTimer = undefined;
    record.lifetimeTimer = undefined;
    if (record.redaction) {
      const flushed = record.redaction.flush();
      if (flushed.length > 0) record.output.append(flushed);
    }
    try { record.connection?.close(); } catch { /* already closed */ }
    this.wakeTerminal(record);
    try {
      this.onTerminalEnd?.({ ownerId: record.ownerId, view: this.terminalView(record) });
    } catch { /* audit is best-effort and must not break teardown */ }
    return true;
  }

  /** End every process left in the terminal's session (job-control children in other process groups too). */
  private async cleanTerminalSession(record: TerminalRecord): Promise<void> {
    if (record.sessionCleaned) return;
    await this.ptyTransport().killSession(record.container, record.id);
    record.sessionCleaned = true;
  }

  private async settleTerminalStream(record: TerminalRecord, end: PtyEnd): Promise<void> {
    if (record.status !== 'running') return;
    if (end.error) {
      this.endTerminal(record, 'failed', 'terminal stream failed');
      void this.cleanTerminalSession(record).catch(() => undefined);
      return;
    }
    // The attach stream can close a moment before the daemon records the exit code.
    let exitCode: number | null = null;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await this.ptyTransport().inspect(record.connection!.execId);
        if (!state.running) {
          exitCode = state.exitCode;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    } catch {
      this.endTerminal(record, 'failed', 'workspace executor stopped');
      record.sessionCleaned = true;
      return;
    }
    if (exitCode === null) this.endTerminal(record, 'failed', 'terminal stream ended without an exit status');
    else this.endTerminal(record, 'exited', `shell exited with code ${exitCode}`, exitCode);
    void this.cleanTerminalSession(record).catch(() => undefined);
  }

  async openTerminal(input: {
    ownerId: string;
    workspaceId: string;
    container: string;
    cwd: string;
    cols: number;
    rows: number;
  }): Promise<TerminalView> {
    this.pruneTerminals();
    const live = [...this.terminals.values()].filter((record) => record.workspaceId === input.workspaceId && record.status === 'running');
    if (live.length >= this.terminalLimits.maxPerWorkspace) {
      throw new HarnessError('LIMIT_EXCEEDED', `too many open terminals in this workspace (maximum ${this.terminalLimits.maxPerWorkspace})`, 429, false);
    }
    const now = Date.now();
    const record: TerminalRecord = {
      id: id('term'),
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      container: input.container,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      status: 'running',
      opening: true,
      createdAt: now,
      lastActivityAt: now,
      output: new TerminalOutput(this.terminalLimits.retainedBytes),
      redaction: this.redactorProvider?.(input.workspaceId)?.createStream(),
      waiters: new Set(),
      sessionCleaned: false
    };
    // Reserve the slot before the handshake so concurrent opens cannot exceed the limit.
    this.terminals.set(record.id, record);
    let connection: PtyConnection;
    try {
      connection = await this.ptyTransport().open({
        container: input.container,
        terminalId: record.id,
        workingDir: `/workspace/${input.cwd === '.' ? '' : input.cwd}`,
        cols: input.cols,
        rows: input.rows
      });
    } catch (error) {
      this.terminals.delete(record.id);
      throw error;
    }
    if (!this.terminals.has(record.id)) {
      // The workspace stopped while the handshake was in flight.
      connection.close();
      throw new HarnessError('NOT_FOUND', 'workspace not found', 404, false);
    }
    record.connection = connection;
    record.opening = false;
    connection.onData((chunk) => this.appendTerminalOutput(record, chunk));
    connection.onEnd((end) => { void this.settleTerminalStream(record, end); });
    this.armIdleTimer(record);
    record.lifetimeTimer = setTimeout(() => {
      record.lifetimeTimer = undefined;
      this.endTerminal(record, 'timed_out', 'lifetime limit');
      void this.cleanTerminalSession(record).catch(() => undefined);
    }, this.terminalLimits.maxLifetimeMs);
    record.lifetimeTimer.unref?.();
    return this.terminalView(record);
  }

  async readTerminal(ownerId: string, workspaceId: string, terminalId: string, cursor: string, waitMs: number): Promise<TerminalReadResult> {
    const record = this.requireTerminal(ownerId, workspaceId, terminalId);
    const requested = Number(cursor);
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > record.output.end) {
      throw new HarnessError('INVALID_INPUT', 'invalid terminal cursor', 400, false);
    }
    this.touchTerminal(record);
    if (waitMs > 0 && requested === record.output.end && record.status === 'running') {
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(() => {
          record.waiters.delete(wake);
          resolveWait();
        }, waitMs);
        const wake = () => {
          clearTimeout(timer);
          resolveWait();
        };
        record.waiters.add(wake);
      });
    }
    const from = Math.max(requested, record.output.start);
    const missedBytes = from - requested;
    const page = record.output.read(from, TERMINAL_MAX_READ_BYTES);
    const nextCursor = from + page.length;
    return {
      terminal: this.terminalView(record),
      data: page.toString('base64'),
      cursor: String(requested),
      nextCursor: String(nextCursor),
      missedBytes,
      more: nextCursor < record.output.end
    };
  }

  writeTerminal(ownerId: string, workspaceId: string, terminalId: string, data: Buffer): TerminalView {
    const record = this.requireTerminal(ownerId, workspaceId, terminalId);
    if (record.status !== 'running' || !record.connection) throw new HarnessError('CONFLICT', 'terminal is not running', 409, false);
    if (record.connection.writableLength > this.terminalLimits.maxPendingInputBytes) {
      throw new HarnessError('LIMIT_EXCEEDED', 'terminal input is backed up; retry shortly', 429, true);
    }
    if (data.length > 0) record.connection.write(data);
    this.touchTerminal(record);
    return this.terminalView(record);
  }

  async resizeTerminal(ownerId: string, workspaceId: string, terminalId: string, cols: number, rows: number): Promise<TerminalView> {
    const record = this.requireTerminal(ownerId, workspaceId, terminalId);
    if (record.status !== 'running' || !record.connection) throw new HarnessError('CONFLICT', 'terminal is not running', 409, false);
    await this.ptyTransport().resize(record.connection.execId, cols, rows);
    record.cols = cols;
    record.rows = rows;
    this.touchTerminal(record);
    return this.terminalView(record);
  }

  /** Idempotent: closing an ended terminal only retries a session cleanup that has not succeeded yet. */
  async closeTerminal(ownerId: string, workspaceId: string, terminalId: string): Promise<TerminalView> {
    const record = this.requireTerminal(ownerId, workspaceId, terminalId);
    this.endTerminal(record, 'closed', 'closed by user');
    await this.cleanTerminalSession(record);
    return this.terminalView(record);
  }

  /** Every terminal the owner can still read, optionally scoped to one workspace, oldest first. */
  listTerminals(ownerId: string, workspaceId?: string): TerminalView[] {
    this.pruneTerminals();
    return [...this.terminals.values()]
      .filter((record) => !record.opening && record.ownerId === ownerId && (workspaceId === undefined || record.workspaceId === workspaceId))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.terminalView(record));
  }

  terminalView(record: TerminalRecord): TerminalView {
    const iso = (value: number) => new Date(value).toISOString();
    return {
      terminalId: record.id as TerminalView['terminalId'],
      workspaceId: record.workspaceId as TerminalView['workspaceId'],
      status: record.status,
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      createdAt: iso(record.createdAt),
      lastActivityAt: iso(record.lastActivityAt),
      idleExpiresAt: iso(record.lastActivityAt + this.terminalLimits.idleTimeoutMs),
      hardExpiresAt: iso(record.createdAt + this.terminalLimits.maxLifetimeMs),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.endedAt !== undefined ? { endedAt: iso(record.endedAt) } : {}),
      ...(record.endReason !== undefined ? { endReason: record.endReason } : {})
    };
  }

  /** Hang up every terminal of a stopping workspace and forget them; the executor is about to be removed. */
  private stopWorkspaceTerminals(workspaceId: string): void {
    for (const [terminalId, record] of this.terminals) {
      if (record.workspaceId !== workspaceId) continue;
      if (record.opening) {
        this.terminals.delete(terminalId);
        continue;
      }
      this.endTerminal(record, 'failed', 'workspace stopped');
      record.sessionCleaned = true;
      this.terminals.delete(terminalId);
    }
  }
}
