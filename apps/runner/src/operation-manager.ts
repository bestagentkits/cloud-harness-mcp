import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { type ErrorCode, HarnessError } from '@cloud-harness/contracts';
import { spawnDocker, terminateContainerProcessGroup } from './docker-engine.js';

type ManagedStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
type Managed = {
  id: string;
  workspaceId: string;
  output: Buffer;
  offset: number;
  status: ManagedStatus;
  createdAt: number;
  idempotencyKey: string;
  child?: ChildProcessWithoutNullStreams;
  container?: string;
  exitCode?: number;
  name?: string;
  dependsOn?: string[];
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  settled?: boolean;
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
const id = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

export class OperationManager {
  private readonly tasks = new Map<string, Managed>();
  private readonly shells = new Map<string, Managed>();
  private readonly sessions = new Map<string, Managed>();
  private readonly idempotency = new Map<string, string>();
  private readonly genericOperations = new Map<string, TrackedOperation>();
  private readonly retainedOutputBytes = 67_108_864;
  onTaskStart?: (workspaceId: string, timeoutMs: number) => void;
  onTaskSettle?: (workspaceId: string, taskId: string) => void;

  hasTaskKey(key: string): boolean {
    return this.idempotency.has(key);
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
    const append = (chunk: Buffer) => {
      const next = Buffer.concat([record.output, chunk]);
      const removed = Math.max(0, next.length - maxBytes);
      record.offset += removed;
      record.output = next.subarray(removed);
      this.enforceOutputBudget(record.workspaceId);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      record.exitCode = code ?? 1;
      if (record.status === 'running') record.status = code === 0 ? 'succeeded' : 'failed';
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
    dependsOn: string[] = []
  ): Managed & { created?: boolean } {
    const mapKey = `task:${workspaceId}:${key}`;
    const prior = this.idempotency.get(mapKey);
    if (prior) {
      const existing = this.tasks.get(prior)!;
      return Object.assign(existing, { created: false });
    }
    this.reserve(this.tasks, workspaceId, 128);
    if (new Set(dependsOn).size !== dependsOn.length) throw new HarnessError('INVALID_INPUT', 'task dependencies must be unique', 400, false);
    for (const dependencyId of dependsOn) {
      const dependency = this.tasks.get(dependencyId);
      if (!dependency || dependency.workspaceId !== workspaceId) throw new HarnessError('NOT_FOUND', `task dependency ${dependencyId} not found`, 404, false);
    }
    const record: Managed & { created?: boolean } = {
      id: id('task'),
      workspaceId,
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
      dependsOn: [...dependsOn],
      created: true
    };
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
    this.onTaskStart?.(record.workspaceId, record.timeoutMs ?? 60_000);
    this.track(record, child, record.maxBytes!);
  }

  private reconcileQueued(workspaceId: string): void {
    for (const record of this.tasks.values()) {
      if (record.workspaceId !== workspaceId || record.status !== 'queued') continue;
      const dependencies = (record.dependsOn ?? []).map((dependencyId) => this.tasks.get(dependencyId));
      if (dependencies.some((dependency) => !dependency || dependency.workspaceId !== workspaceId)) {
        record.status = 'blocked';
        this.settleTask(record);
        continue;
      }
      if (dependencies.some((dependency) => ['failed', 'cancelled', 'blocked'].includes(dependency!.status))) {
        record.status = 'blocked';
        this.settleTask(record);
        continue;
      }
      if (dependencies.every((dependency) => dependency!.status === 'succeeded')) this.startTask(record);
    }
  }

  task(workspaceId: string, taskId: string): Managed {
    const record = this.tasks.get(taskId);
    if (!record || record.workspaceId !== workspaceId) throw new HarnessError('NOT_FOUND', 'task not found', 404, false);
    return record;
  }

  listTasks(workspaceId: string): Managed[] {
    return [...this.tasks.values()].filter((record) => record.workspaceId === workspaceId).sort((left, right) => left.createdAt - right.createdAt);
  }

  taskGraph(workspaceId: string) {
    const tasks = this.listTasks(workspaceId);
    return {
      nodes: tasks.map((record) => this.summary(record)),
      edges: tasks.flatMap((record) => (record.dependsOn ?? []).map((dependencyId) => ({ from: dependencyId, to: record.id })))
    };
  }

  async cancelTask(workspaceId: string, taskId: string): Promise<Managed> {
    const record = this.task(workspaceId, taskId);
    if (record.status === 'queued') {
      record.status = 'cancelled';
      this.reconcileQueued(workspaceId);
      this.settleTask(record);
      return record;
    }
    if (record.status !== 'running') return record;
    await terminateContainerProcessGroup(record.container!, `/tmp/cloud-harness-tasks/${record.id}.pid`);
    record.status = 'cancelled';
    record.child?.kill();
    this.reconcileQueued(workspaceId);
    this.settleTask(record);
    return record;
  }
  stopWorkspace(workspaceId: string): void {
    for (const record of this.records(workspaceId)) {
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'cancelled';
        record.child?.kill();
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
      ...(record.name ? { name: record.name } : {}),
      ...(record.dependsOn ? { dependsOn: record.dependsOn } : {})
    };
  }

  viewSince(record: Managed, cursor?: string) {
    const requested = cursor === undefined ? 0 : Number(cursor);
    const end = record.offset + record.output.length;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > end) throw new HarnessError('INVALID_INPUT', 'invalid output cursor');
    const missedOutput = requested < record.offset;
    const start = Math.max(0, requested - record.offset);
    const page = record.output.subarray(start, Math.min(record.output.length, start + 65_536));
    const nextCursor = record.offset + start + page.length;
    return {
      data: { ...this.view(record), output: page.toString('utf8') },
      cursor: String(nextCursor),
      truncated: missedOutput || nextCursor < end
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
}
