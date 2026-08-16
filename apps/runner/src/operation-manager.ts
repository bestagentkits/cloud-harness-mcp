import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HarnessError } from '@cloud-harness/contracts';
import { spawnDocker, terminateContainerProcessGroup } from './docker-engine.js';

type Managed = {
  id: string; workspaceId: string; child: ChildProcessWithoutNullStreams; output: Buffer; offset: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'; exitCode?: number; container?: string;
  createdAt: number; idempotencyKey: string;
};

const id = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

export class OperationManager {
  private readonly tasks = new Map<string, Managed>();
  private readonly shells = new Map<string, Managed>();
  private readonly idempotency = new Map<string, string>();
  private readonly retainedOutputBytes = 67_108_864;

  private records(workspaceId: string): Managed[] {
    return [...this.tasks.values(), ...this.shells.values()]
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
    const evictable = matching
      .filter((record) => record.status !== 'running')
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!evictable) throw new HarnessError('LIMIT_EXCEEDED', 'too many live operation handles in this workspace', 429, true);
    map.delete(evictable.id);
    this.idempotency.delete(evictable.idempotencyKey);
  }

  private track(record: Managed, maxBytes: number): void {
    const append = (chunk: Buffer) => {
      const next = Buffer.concat([record.output, chunk]);
      const removed = Math.max(0, next.length - maxBytes);
      record.offset += removed;
      record.output = next.subarray(removed);
      this.enforceOutputBudget(record.workspaceId);
    };
    record.child.stdout.on('data', append);
    record.child.stderr.on('data', append);
    record.child.on('close', (code) => {
      record.exitCode = code ?? 1;
      if (record.status === 'running') record.status = code === 0 ? 'succeeded' : 'failed';
    });
  }

  openShell(workspaceId: string, container: string, cwd: string, key: string, maxBytes: number): Managed {
    const mapKey = `shell:${workspaceId}:${key}`;
    const prior = this.idempotency.get(mapKey);
    if (prior) return this.shells.get(prior)!;
    this.reserve(this.shells, workspaceId, 32);
    const shellId = id('sh');
    const record: Managed = {
      id: shellId,
      workspaceId,
      child: spawnDocker(['exec', '-i', '-w', `/workspace/${cwd === '.' ? '' : cwd}`, container, '/usr/bin/setsid', '/opt/harness/shell-runner.sh', shellId]),
      output: Buffer.alloc(0), offset: 0, status: 'running', container, createdAt: Date.now(), idempotencyKey: mapKey
    };
    this.shells.set(record.id, record);
    this.idempotency.set(mapKey, record.id);
    this.track(record, maxBytes);
    return record;
  }

  shellIo(workspaceId: string, shellId: string, input?: string): Managed {
    const record = this.shells.get(shellId);
    if (!record || record.workspaceId !== workspaceId) throw new Error('shell not found');
    if (input && record.status === 'running') record.child.stdin.write(input);
    return record;
  }

  async closeShell(workspaceId: string, shellId: string): Promise<Managed> {
    const record = this.shellIo(workspaceId, shellId);
    if (record.status !== 'running') return record;
    await terminateContainerProcessGroup(record.container!, `/tmp/cloud-harness-shells/${record.id}.pid`);
    record.status = 'cancelled';
    record.child.stdin.end();
    record.child.kill();
    return record;
  }

  runTask(workspaceId: string, container: string, cwd: string, command: string, key: string, timeoutMs: number, maxBytes: number): Managed {
    const mapKey = `task:${workspaceId}:${key}`;
    const prior = this.idempotency.get(mapKey);
    if (prior) return this.tasks.get(prior)!;
    this.reserve(this.tasks, workspaceId, 128);
    const taskId = id('task');
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    const child = spawnDocker([
      'exec', '-i', '-w', `/workspace/${cwd === '.' ? '' : cwd}`, '-e', `CH_COMMAND=${command}`,
      container, '/opt/harness/task-runner.sh', taskId, String(timeoutSeconds)
    ]);
    child.stdin.end();
    const record: Managed = {
      id: taskId, workspaceId, child, output: Buffer.alloc(0), offset: 0, status: 'running', container,
      createdAt: Date.now(), idempotencyKey: mapKey
    };
    this.tasks.set(record.id, record);
    this.idempotency.set(mapKey, record.id);
    this.track(record, maxBytes);
    return record;
  }

  task(workspaceId: string, taskId: string): Managed {
    const record = this.tasks.get(taskId);
    if (!record || record.workspaceId !== workspaceId) throw new Error('task not found');
    return record;
  }

  listTasks(workspaceId: string): Managed[] {
    return [...this.tasks.values()].filter((record) => record.workspaceId === workspaceId);
  }

  async cancelTask(workspaceId: string, taskId: string): Promise<Managed> {
    const record = this.task(workspaceId, taskId);
    if (record.status !== 'running') return record;
    if (record.container) {
      await terminateContainerProcessGroup(record.container, `/tmp/cloud-harness-tasks/${record.id}.pid`);
    }
    record.status = 'cancelled';
    record.child.kill();
    return record;
  }

  stopWorkspace(workspaceId: string): void {
    for (const record of [...this.tasks.values(), ...this.shells.values()]) {
      if (record.workspaceId === workspaceId && record.status === 'running') {
        record.status = 'cancelled';
        record.child.kill();
      }
    }
    for (const [recordId, record] of this.tasks) if (record.workspaceId === workspaceId) this.tasks.delete(recordId);
    for (const [recordId, record] of this.shells) if (record.workspaceId === workspaceId) this.shells.delete(recordId);
    for (const key of this.idempotency.keys()) if (key.includes(`:${workspaceId}:`)) this.idempotency.delete(key);
  }

  view(record: Managed) {
    return { id: record.id, status: record.status, exitCode: record.exitCode, output: record.output.toString('utf8') };
  }

  summary(record: Managed) {
    return { id: record.id, status: record.status, exitCode: record.exitCode };
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
      data: { id: record.id, status: record.status, exitCode: record.exitCode, output: page.toString('utf8') },
      cursor: String(nextCursor),
      truncated: missedOutput || nextCursor < end
    };
  }
}
