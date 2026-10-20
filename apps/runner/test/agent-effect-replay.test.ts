import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentProxyOperationSchema, RunnerAgentsConfigSchema, type RunnerResponse } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectPayloadHash } from '../src/agent-effect-reconciler.js';
import { AgentManager, type AgentToolExecutor } from '../src/agent-manager.js';
import type { AgentGatewayControl, AgentLeaseGrant, AgentLeaseRevocation } from '../src/agent-gateway-control.js';
import type { AgentLaunchSpec, AgentLauncher, AgentRuntimeProcess } from '../src/agent-launcher.js';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { ModelSpendLedger } from '../src/model-spend-ledger.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const ALL_OPERATIONS = AgentProxyOperationSchema.options;
const config = RunnerAgentsConfigSchema.parse({
  image: 'cloud-harness-agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  sessionPersistenceEnabled: true,
  profiles: [{
    id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
    maxProxyOperations: ALL_OPERATIONS
  }],
  limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600 }
});
const LEASE = `bearer_${'x'.repeat(48)}`;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

class FakeGateway implements AgentGatewayControl {
  readonly revoked: string[] = [];
  async issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant> {
    return { ...input, lease: LEASE };
  }
  async revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation | void> {
    this.revoked.push(leaseId);
  }
  async cancelAndDrain(): Promise<void> {}
}

class FakeLauncher implements AgentLauncher {
  readonly launches: AgentLaunchSpec[] = [];
  readonly cleanups: string[] = [];
  readonly outputs: PassThrough[] = [];
  readonly #records: Array<Array<Record<string, unknown>>> = [];

  async reconcile(): Promise<void> {}
  async launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess> {
    this.launches.push(spec);
    const input = new PassThrough();
    const output = new PassThrough();
    const records: Array<Record<string, unknown>> = [];
    let buffered = '';
    input.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line) records.push(JSON.parse(line) as Record<string, unknown>);
    });
    this.#records.push(records);
    this.outputs.push(output);
    const process = { stdin: input, stdout: output, stderr: new PassThrough() } as unknown as ChildProcessWithoutNullStreams;
    return { process, exited: Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>().promise };
  }
  async cleanup(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>): Promise<void> {
    this.cleanups.push(spec.containerName);
  }
  async inspect(): Promise<{ container: boolean; network: boolean }> {
    return { container: false, network: false };
  }
  /** Everything the runner wrote to one runtime, parsed. */
  received(index: number): Array<Record<string, unknown>> {
    return this.#records[index] ?? [];
  }
  emit(index: number, record: Record<string, unknown>): void {
    this.outputs[index]!.write(`${JSON.stringify(record)}\n`);
  }
}

type Interruption = { operation: string; when: 'before' | 'after'; gate: PromiseWithResolvers<void> };

/**
 * An in-memory workspace behind the agent tool executor. It answers like the executor worker,
 * counts the mutations it applies, and can stall one call before or after its effect to model a
 * runner that dies at that point.
 */
class FakeWorkspace {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  readonly applied: string[] = [];
  interruption?: Interruption;

  readonly executor: AgentToolExecutor = async ({ operation, toolInput, signal }) => {
    this.calls.push({ operation, input: toolInput });
    const interruption = this.interruption?.operation === operation ? this.interruption : undefined;
    if (interruption) this.interruption = undefined;
    const stall = async () => {
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('tool call aborted'));
        signal.addEventListener('abort', () => reject(new Error('tool call aborted')), { once: true });
      });
      await Promise.race([interruption!.gate.promise, aborted]);
    };
    if (interruption?.when === 'before') await stall();
    const result = this.apply(operation, toolInput);
    if (interruption?.when === 'after') await stall();
    return result;
  };

  interrupt(operation: string, when: 'before' | 'after'): PromiseWithResolvers<void> {
    const gate = Promise.withResolvers<void>();
    this.interruption = { operation, when, gate };
    return gate;
  }

  executions(operation: string): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  private apply(operation: string, input: Record<string, unknown>): RunnerResponse {
    const ok = (message: string, data: unknown): RunnerResponse => ({ ok: true, message, data, truncated: false });
    const fail = (code: 'INVALID_INPUT' | 'CONFLICT', message: string): RunnerResponse =>
      ({ ok: false, message, error: { code, message, retryable: false }, truncated: false });
    const missing = (path: string) => fail('INVALID_INPUT', `ENOENT: no such file or directory, realpath '/workspace/${path}'`);
    const path = input.path as string;
    switch (operation) {
      case 'files_read': {
        if (this.directories.has(path)) return fail('INVALID_INPUT', 'EISDIR: illegal operation on a directory, read');
        const content = this.files.get(path);
        if (content === undefined) return missing(path);
        const offset = (input.offset as number | undefined) ?? 0;
        const limit = input.readAll ? 1_048_576 : (input.limit as number | undefined) ?? 65_536;
        const slice = content.slice(offset, offset + limit);
        return ok(`Read ${slice.length} bytes`, {
          path, content: slice, sha256: sha256(content), bytesReturned: slice.length, totalBytes: content.length, eof: offset + limit >= content.length
        });
      }
      case 'files_write': {
        const current = this.files.get(path);
        if (input.expectedSha256 && (current === undefined || sha256(current) !== input.expectedSha256)) return fail('CONFLICT', 'file changed since it was read');
        this.files.set(path, input.content as string);
        this.applied.push(operation);
        return ok('File written', { path, sha256: sha256(input.content as string) });
      }
      case 'files_apply_patch': {
        const current = this.files.get(path);
        if (current === undefined) return missing(path);
        const oldText = input.oldText as string;
        const first = current.indexOf(oldText);
        if (first < 0) return fail('CONFLICT', 'oldText was not found');
        if (current.indexOf(oldText, first + Math.max(1, oldText.length)) >= 0) return fail('CONFLICT', 'oldText is not unique');
        const next = current.slice(0, first) + (input.newText as string) + current.slice(first + oldText.length);
        this.files.set(path, next);
        this.applied.push(operation);
        return ok('Patch applied', { path, sha256: sha256(next) });
      }
      case 'files_delete': {
        if (!this.files.delete(path) && !this.directories.delete(path)) return missing(path);
        this.applied.push(operation);
        return ok('Path deleted', { path, type: 'file' });
      }
      case 'files_move': {
        const source = input.source as string;
        const destination = input.destination as string;
        const content = this.files.get(source);
        if (content === undefined) return missing(source);
        if (this.files.has(destination) && !input.overwrite) return fail('CONFLICT', 'destination already exists');
        this.files.delete(source);
        this.files.set(destination, content);
        this.applied.push(operation);
        return ok('Path moved', { source, destination });
      }
      case 'files_mkdir': {
        this.directories.add(path);
        this.applied.push(operation);
        return ok('Directory created', { path });
      }
      default:
        return ok('listed', { entries: [...this.files.keys()].sort().map((name) => ({ name, type: 'file' })) });
    }
  }
}

function workspaceRecord(ownerId: string): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
    gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
}

type Runner = { manager: AgentManager; launcher: FakeLauncher; repository: AgentStateRepository };

function setup(now?: () => number, agentsConfig = config) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-effect-replay-'));
  directories.push(directory);
  const store = new StateStore(join(directory, 'state.db'));
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const record = workspaceRecord(ownerId);
  store.create(record);
  const fs = new FakeWorkspace();
  const runners: Runner[] = [];
  /** Starts a runner process on the shared state database, as a restart would. */
  const runner = (started: boolean): Runner => {
    const repository = new AgentStateRepository(store.database, agentsConfig.limits, store.instanceId());
    const launcher = new FakeLauncher();
    const manager = new AgentManager(agentsConfig, store, {
      repository, launcher, gateway: new FakeGateway(), toolExecutor: fs.executor,
      spendLedger: new ModelSpendLedger(store.database, { log: vi.fn() }), ...(now ? { now } : {})
    });
    const created = { manager, launcher, repository };
    runners.push(created);
    if (started) cleanups.push(async () => await manager.stop());
    return created;
  };
  cleanups.push(async () => { store.close(); });
  return { store, record, fs, runner, runners, first: runner(false) };
}

type Context = ReturnType<typeof setup>;

async function spawnRunning(context: Context, runner: Runner, idempotencyKey: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { record } = context;
  const response = await runner.manager.dispatch(record.ownerId, record, 'agent_spawn', {
    workspaceId: record.id, prompt: 'edit the repository', idempotencyKey, profileId: 'default',
    proxyOperations: ALL_OPERATIONS, ttlSeconds: 30, maxOutputBytes: 262_144,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, ...overrides
  });
  const agentId = (response.data as { agentId: string }).agentId;
  await vi.waitFor(() => expect(runner.repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING'));
  return agentId;
}

function toolResults(launcher: FakeLauncher, index: number, requestId: string): Array<{ isError: boolean; text: string }> {
  return launcher.received(index)
    .filter((item) => item.type === 'tool_result' && item.requestId === requestId)
    .map((item) => ({ isError: item.isError as boolean, text: (item.content as Array<{ text: string }>)[0]!.text }));
}

async function request(
  launcher: FakeLauncher,
  index: number,
  requestId: string,
  operation: string,
  input: Record<string, unknown>
): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const before = toolResults(launcher, index, requestId).length;
  launcher.emit(index, { type: 'tool_request', requestId, toolCallId: requestId, operation, input });
  await vi.waitFor(() => expect(toolResults(launcher, index, requestId).length).toBe(before + 1));
  const result = toolResults(launcher, index, requestId)[before]!;
  return { ...result, body: JSON.parse(result.text) as Record<string, unknown> };
}

/** Records a user turn and an unanswered tool call so the session is continuable after a crash. */
async function recordToolCall(
  context: Context,
  runner: Runner,
  index: number,
  agentId: string,
  requestId: string,
  calls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }> = [{ name: 'files_write', arguments: {} }]
): Promise<void> {
  runner.launcher.emit(index, { type: 'session_message', seq: 0, message: { role: 'user', content: [{ type: 'text', text: 'edit' }], timestamp: 1 } });
  runner.launcher.emit(index, {
    type: 'session_message', seq: 1,
    message: {
      role: 'assistant', stopReason: 'toolUse', timestamp: 2,
      content: calls.map((call) => ({ type: 'toolCall', id: call.id ?? requestId, name: call.name, arguments: call.arguments }))
    }
  });
  await vi.waitFor(() => expect(runner.repository.findSession(agentId)?.messageCount).toBe(2));
}

type ToolOutcome = { toolCallId: string; outcome: string; isError: boolean; text: string };

/** The tool outcomes the runner put in a runtime's start record, if any. */
async function startOutcomes(launcher: FakeLauncher, index: number): Promise<ToolOutcome[] | undefined> {
  const find = () => launcher.received(index).find((item) => item.type === 'start') as { session?: { toolOutcomes?: ToolOutcome[] } } | undefined;
  await vi.waitFor(() => expect(find()?.session).toBeDefined());
  return find()!.session!.toolOutcomes;
}

/** Kills the first runner at its current point and starts a second one, which reconciles every agent. */
async function crashAndRestart(context: Context, agentId: string): Promise<Runner> {
  const next = context.runner(true);
  await next.manager.start();
  expect(next.repository.findAgent(context.record.ownerId, context.record.id, agentId)).toMatchObject({ status: 'INTERRUPTED', outcomeUnknown: true });
  return next;
}

async function continueAgent(context: Context, runner: Runner, predecessorId: string, idempotencyKey: string): Promise<string> {
  return await spawnRunning(context, runner, idempotencyKey, { continueFrom: predecessorId });
}

describe('agent effect receipts and replay', () => {
  it('returns the stored result bytes of a completed read when the request is delivered again after a crash', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('README.md', '# readme\n');
    const agentId = await spawnRunning(context, first, 'read-key');
    await recordToolCall(context, first, 0, agentId, 'toolu_read');
    const original = await request(first.launcher, 0, 'toolu_read', 'files_read', { path: 'README.md' });
    expect(original.body).toMatchObject({ ok: true, data: { content: '# readme\n' } });
    expect(original.body).not.toHaveProperty('replayed');
    // The runner dies after the result reached the runtime but before the session recorded it.
    fs.files.set('README.md', '# changed since\n');
    const second = await crashAndRestart(context, agentId);
    const successorId = await continueAgent(context, second, agentId, 'read-continue');
    const replay = await request(second.launcher, 0, 'toolu_read', 'files_read', { path: 'README.md' });
    expect(replay.text).toBe(original.text);
    expect(replay.isError).toBe(false);
    expect(fs.executions('files_read')).toBe(1);
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_read', kind: 'files_read' })).toMatchObject({ state: 'APPLIED', agentId });
    expect(successorId).not.toBe(agentId);
  });

  it('reconciles a whole-file write that applied before the runner died instead of writing again', async () => {
    const context = setup();
    const { first, fs, record } = context;
    const agentId = await spawnRunning(context, first, 'write-key');
    await recordToolCall(context, first, 0, agentId, 'toolu_write');
    const stalled = fs.interrupt('files_write', 'after');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_write', toolCallId: 'toolu_write', operation: 'files_write', input: { path: 'out.txt', content: 'new content' } });
    await vi.waitFor(() => expect(fs.files.get('out.txt')).toBe('new content'));
    const key = { rootAgentId: agentId, requestId: 'toolu_write', kind: 'files_write' };
    expect(first.repository.findEffect(key)).toMatchObject({ state: 'DISPATCHED', intendedSha256: sha256('new content') });

    const second = await crashAndRestart(context, agentId);
    expect(second.repository.findEffect(key)).toMatchObject({ state: 'UNKNOWN', resultJson: null });
    // The dead runner's late completion cannot record an outcome or usage, or reach the session.
    const usageBefore = second.repository.usage(record.ownerId, record.id, agentId, 1);
    stalled.resolve();
    await vi.waitFor(() => expect(toolResults(first.launcher, 0, 'toolu_write')).toHaveLength(1));
    expect(JSON.parse(toolResults(first.launcher, 0, 'toolu_write')[0]!.text)).toMatchObject({ ok: false, message: 'agent tool execution lost its lifecycle fence' });
    expect(second.repository.findEffect(key)).toMatchObject({ state: 'UNKNOWN', resultJson: null });
    expect(second.repository.usage(record.ownerId, record.id, agentId, 1)).toEqual(usageBefore);

    await continueAgent(context, second, agentId, 'write-continue');
    const reconciled = await request(second.launcher, 0, 'toolu_write', 'files_write', { path: 'out.txt', content: 'new content' });
    expect(reconciled.isError).toBe(false);
    expect(reconciled.body).toMatchObject({ ok: true, reconciled: true, data: { path: 'out.txt', sha256: sha256('new content') } });
    expect(fs.applied).toEqual(['files_write']);
    expect(second.repository.findEffect(key)).toMatchObject({ state: 'APPLIED', reconciled: true, resultJson: reconciled.text });
    // Once settled, a further delivery returns the same bytes.
    expect((await request(second.launcher, 0, 'toolu_write', 'files_write', { path: 'out.txt', content: 'new content' })).text).toBe(reconciled.text);
    expect(fs.applied).toEqual(['files_write']);
  });

  it('reconciles a patch against the post-image computed at dispatch and never patches twice', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('src/a.ts', 'const a = 1;\n');
    const agentId = await spawnRunning(context, first, 'patch-key');
    await recordToolCall(context, first, 0, agentId, 'toolu_patch');
    fs.interrupt('files_apply_patch', 'after');
    const input = { path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 2' };
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_patch', toolCallId: 'toolu_patch', operation: 'files_apply_patch', input });
    await vi.waitFor(() => expect(fs.files.get('src/a.ts')).toBe('const a = 2;\n'));
    const key = { rootAgentId: agentId, requestId: 'toolu_patch', kind: 'files_apply_patch' };
    expect(first.repository.findEffect(key)).toMatchObject({
      state: 'DISPATCHED', preImageSha256: sha256('const a = 1;\n'), intendedSha256: sha256('const a = 2;\n')
    });
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'patch-continue');
    const reconciled = await request(second.launcher, 0, 'toolu_patch', 'files_apply_patch', input);
    expect(reconciled.body).toMatchObject({ ok: true, reconciled: true });
    expect(fs.applied).toEqual(['files_apply_patch']);
    expect(fs.files.get('src/a.ts')).toBe('const a = 2;\n');
  });

  it('reports a patch that never reached the file as not applied, and a changed file as unknown', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('a.txt', 'alpha\n');
    fs.files.set('b.txt', 'beta\n');
    const agentId = await spawnRunning(context, first, 'patch-lost-key');
    await recordToolCall(context, first, 0, agentId, 'toolu_a');
    fs.interrupt('files_apply_patch', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_a', toolCallId: 'toolu_a', operation: 'files_apply_patch', input: { path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' } });
    await vi.waitFor(() => expect(fs.executions('files_apply_patch')).toBe(1));
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'patch-lost-continue');

    const notApplied = await request(second.launcher, 0, 'toolu_a', 'files_apply_patch', { path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' });
    expect(notApplied.isError).toBe(true);
    expect(notApplied.body).toMatchObject({ ok: false, error: { code: 'EFFECT_NOT_APPLIED', retryable: true } });
    expect(fs.files.get('a.txt')).toBe('alpha\n');
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_a', kind: 'files_apply_patch' })).toMatchObject({ state: 'REJECTED', resultJson: notApplied.text });
    expect(fs.applied).toEqual([]);

    // An effect of unknown outcome whose target someone else changed stays unknown.
    second.repository.reserveEffect({
      ownerId: context.record.ownerId, workspaceId: context.record.id, agentId, agentGeneration: 1, runnerEpoch: 1,
      requestId: 'toolu_b', kind: 'files_apply_patch',
      payloadHash: effectPayloadHash('files_apply_patch', { path: 'b.txt', oldText: 'beta', newText: 'BETA' }),
      preImageSha256: sha256('beta\n'), intendedSha256: sha256('BETA\n'), now: Date.now()
    });
    context.store.database.prepare("UPDATE agent_effects SET state='UNKNOWN' WHERE request_id='toolu_b'").run();
    fs.files.set('b.txt', 'edited by hand\n');
    const unknown = await request(second.launcher, 0, 'toolu_b', 'files_apply_patch', { path: 'b.txt', oldText: 'beta', newText: 'BETA' });
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'EFFECT_UNKNOWN', retryable: false } });
    expect(String(unknown.body.message)).toContain('ask the owner');
    expect(fs.files.get('b.txt')).toBe('edited by hand\n');
    expect(fs.applied).toEqual([]);
  });

  it('reconciles a delete whose path is gone and a move whose source left for its destination', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('old.txt', 'old');
    fs.files.set('from.txt', 'moving');
    const agentId = await spawnRunning(context, first, 'destructive-key');
    await recordToolCall(context, first, 0, agentId, 'toolu_delete');
    fs.interrupt('files_delete', 'after');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_delete', toolCallId: 'toolu_delete', operation: 'files_delete', input: { path: 'old.txt' } });
    await vi.waitFor(() => expect(fs.files.has('old.txt')).toBe(false));
    const second = await crashAndRestart(context, agentId);
    const successorId = await continueAgent(context, second, agentId, 'destructive-continue');
    const deleted = await request(second.launcher, 0, 'toolu_delete', 'files_delete', { path: 'old.txt' });
    expect(deleted.body).toMatchObject({ ok: true, reconciled: true, data: { path: 'old.txt' } });

    second.launcher.emit(0, { type: 'session_message', seq: 2, message: { role: 'user', content: [{ type: 'text', text: 'move' }], timestamp: 3 } });
    fs.interrupt('files_move', 'after');
    second.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_move', toolCallId: 'toolu_move', operation: 'files_move', input: { source: 'from.txt', destination: 'to.txt' } });
    await vi.waitFor(() => expect(fs.files.get('to.txt')).toBe('moving'));
    await vi.waitFor(() => expect(second.repository.findSession(successorId)?.messageCount).toBe(3));
    const third = await crashAndRestart(context, successorId);
    await continueAgent(context, third, successorId, 'destructive-continue-2');
    const moved = await request(third.launcher, 0, 'toolu_move', 'files_move', { source: 'from.txt', destination: 'to.txt' });
    expect(moved.body).toMatchObject({ ok: true, reconciled: true, data: { source: 'from.txt', destination: 'to.txt' } });
    expect(fs.applied).toEqual(['files_delete', 'files_move']);
    // The whole lineage shares one root, so the third agent found the second agent's effect.
    expect(third.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_move', kind: 'files_move' })).toMatchObject({ agentId: successorId, state: 'APPLIED' });
  });

  it('never issues a destructive operation again when its outcome cannot be observed', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('keep.txt', 'keep');
    const agentId = await spawnRunning(context, first, 'move-lost-key');
    await recordToolCall(context, first, 0, agentId, 'toolu_move');
    fs.interrupt('files_move', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_move', toolCallId: 'toolu_move', operation: 'files_move', input: { source: 'keep.txt', destination: 'moved.txt' } });
    await vi.waitFor(() => expect(fs.executions('files_move')).toBe(1));
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'move-lost-continue');
    const unknown = await request(second.launcher, 0, 'toolu_move', 'files_move', { source: 'keep.txt', destination: 'moved.txt' });
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'EFFECT_UNKNOWN' } });
    expect(fs.executions('files_move')).toBe(1);
    expect(fs.files.get('keep.txt')).toBe('keep');
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_move', kind: 'files_move' })).toMatchObject({ state: 'UNKNOWN', resultJson: null });
  });

  it('runs a redelivered request exactly once and answers every delivery with the same bytes', async () => {
    const context = setup();
    const { first, fs } = context;
    const agentId = await spawnRunning(context, first, 'dedupe-key');
    const input = { path: 'once.txt', content: 'once' };
    for (let index = 0; index < 4; index += 1) {
      first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_once', toolCallId: 'toolu_once', operation: 'files_write', input });
    }
    await vi.waitFor(() => expect(toolResults(first.launcher, 0, 'toolu_once')).toHaveLength(4));
    const results = toolResults(first.launcher, 0, 'toolu_once');
    expect(new Set(results.map((result) => result.text)).size).toBe(1);
    expect(JSON.parse(results[0]!.text)).toMatchObject({ ok: true, message: 'File written' });
    expect(fs.applied).toEqual(['files_write']);
    // The same request ID with a different payload is refused without running.
    const conflict = await request(first.launcher, 0, 'toolu_once', 'files_write', { path: 'once.txt', content: 'twice' });
    expect(conflict.body).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(fs.applied).toEqual(['files_write']);
    expect(first.repository.findAgent(context.record.ownerId, context.record.id, agentId)?.status).toBe('RUNNING');
  });

  it('re-executes only a read whose receipt expired, and refuses a write whose receipt expired', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('r.txt', 'read me');
    await spawnRunning(context, first, 'expired-key');
    const read = await request(first.launcher, 0, 'toolu_r', 'files_read', { path: 'r.txt' });
    await request(first.launcher, 0, 'toolu_w', 'files_write', { path: 'w.txt', content: 'w' });
    expect(first.repository.purgeExpiredReceipts(Date.now() + config.limits.sessionRetentionMs + 1)).toBe(2);
    // Purged text no longer counts toward the lineage's receipt byte cap.
    expect(context.store.database.prepare('SELECT COUNT(*) AS count FROM agent_effects WHERE result_bytes IS NOT NULL').get()).toEqual({ count: 0 });

    const reread = await request(first.launcher, 0, 'toolu_r', 'files_read', { path: 'r.txt' });
    expect(reread.body).toEqual({ ...read.body, replayed: 're-executed' });
    expect(fs.executions('files_read')).toBe(2);
    const rewrite = await request(first.launcher, 0, 'toolu_w', 'files_write', { path: 'w.txt', content: 'w' });
    expect(rewrite.body).toMatchObject({ ok: false, error: { code: 'EFFECT_RECEIPT_UNAVAILABLE', retryable: false } });
    expect(fs.applied).toEqual(['files_write']);
  });

  it('keeps the first result model-visible as before while redacting the gateway lease from the stored receipt', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('leak.txt', `token=${LEASE}`);
    const agentId = await spawnRunning(context, first, 'lease-key');
    const result = await request(first.launcher, 0, 'toolu_leak', 'files_read', { path: 'leak.txt' });
    expect(result.text).toBe(JSON.stringify({
      ok: true, message: `Read ${`token=${LEASE}`.length} bytes`,
      data: { path: 'leak.txt', content: `token=${LEASE}`, sha256: sha256(`token=${LEASE}`), bytesReturned: `token=${LEASE}`.length, totalBytes: `token=${LEASE}`.length, eof: true },
      truncated: false
    }));
    const receipt = first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_leak', kind: 'files_read' })!;
    expect(receipt.resultJson).not.toContain(LEASE);
    expect(receipt.resultJson).toContain('token=[REDACTED]');
  });

  it('records an effect cancelled mid-dispatch as unknown and executes nothing after the cancel', async () => {
    const context = setup();
    const { first, fs, record } = context;
    fs.files.set('slow.txt', 'x');
    const agentId = await spawnRunning(context, first, 'cancel-key');
    fs.interrupt('files_write', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_slow', toolCallId: 'toolu_slow', operation: 'files_write', input: { path: 'slow.txt', content: 'y' } });
    await vi.waitFor(() => expect(fs.executions('files_write')).toBe(1));
    await first.manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
    expect(first.repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('CANCELLED');
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_slow', kind: 'files_write' })).toMatchObject({ state: 'UNKNOWN' });
    expect(fs.files.get('slow.txt')).toBe('x');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_after', toolCallId: 'toolu_after', operation: 'files_read', input: { path: 'slow.txt' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.executions('files_read')).toBe(0);
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_after', kind: 'files_read' })).toBeUndefined();
  });

  it('executes nothing for an agent past its TTL or in a closed workspace, and refuses to continue into a closed workspace', async () => {
    let now = Date.now();
    const context = setup(() => now);
    const { first, fs, record } = context;
    fs.files.set('a.txt', 'a');
    const agentId = await spawnRunning(context, first, 'ttl-expiry-key');
    now += 31_000;
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_late', toolCallId: 'toolu_late', operation: 'files_read', input: { path: 'a.txt' } });
    await vi.waitFor(() => expect(first.repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('INTERRUPTED'));
    expect(fs.calls).toHaveLength(0);
    now = Date.now();

    const second = setup();
    second.fs.files.set('a.txt', 'a');
    const runningId = await spawnRunning(second, second.first, 'closed-key');
    second.store.updateFenced(second.record.id, second.record.generation, ['ACTIVE'], { status: 'CLOSED' });
    second.first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_closed', toolCallId: 'toolu_closed', operation: 'files_read', input: { path: 'a.txt' } });
    await vi.waitFor(() => expect(second.first.repository.findAgent(second.record.ownerId, second.record.id, runningId)?.status).not.toBe('RUNNING'));
    expect(second.fs.calls).toHaveLength(0);
    const closed = { ...second.record, status: 'CLOSED' as const };
    await expect(second.first.manager.dispatch(second.record.ownerId, closed, 'agent_spawn', {
      workspaceId: second.record.id, prompt: 'again', idempotencyKey: 'closed-continue', profileId: 'default', proxyOperations: ['files_read'],
      ttlSeconds: 30, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, continueFrom: runningId
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancels a child with its parent without orphans or resurrection, and continues the child only on owner request', async () => {
    const context = setup();
    const { first, fs, record } = context;
    fs.files.set('a.txt', 'a');
    const parentId = await spawnRunning(context, first, 'parent-key');
    const childId = await spawnRunning(context, first, 'child-key', { parentAgentId: parentId });
    await first.manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId: parentId });
    expect(first.repository.findAgent(record.ownerId, record.id, parentId)?.status).toBe('CANCELLED');
    expect(first.repository.findAgent(record.ownerId, record.id, childId)?.status).toBe('CANCELLED');
    expect([...first.launcher.cleanups].sort()).toEqual(first.launcher.launches.map((launch) => launch.containerName).sort());

    // A late request from the cancelled child neither executes nor revives it.
    first.launcher.emit(1, { type: 'tool_request', requestId: 'toolu_child', toolCallId: 'toolu_child', operation: 'files_read', input: { path: 'a.txt' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.calls).toHaveLength(0);
    expect(first.repository.findAgent(record.ownerId, record.id, childId)?.status).toBe('CANCELLED');

    // Only the owner can continue it, once, and the continuation joins the child's lineage.
    const successorId = await continueAgent(context, first, childId, 'child-continue');
    expect(first.repository.lineageRoot(successorId)).toBe(childId);
    await expect(continueAgent(context, first, childId, 'child-continue-again')).rejects.toMatchObject({ code: 'CONFLICT' });
    const result = await request(first.launcher, 2, 'toolu_child', 'files_read', { path: 'a.txt' });
    expect(result.body).toMatchObject({ ok: true, data: { content: 'a' } });
    expect(fs.executions('files_read')).toBe(1);
  });
});

describe('outcomes of unanswered tool calls in a continued transcript', () => {
  it('closes an unguarded write that applied before the crash with its original result, so it is written exactly once', async () => {
    const context = setup();
    const { first, fs } = context;
    const input = { path: 'out.txt', content: 'v1' };
    const agentId = await spawnRunning(context, first, 'outcome-applied');
    await recordToolCall(context, first, 0, agentId, 'toolu_w', [{ name: 'files_write', arguments: input }]);
    const original = await request(first.launcher, 0, 'toolu_w', 'files_write', input);
    expect(original.body).toMatchObject({ ok: true, message: 'File written' });
    // The runner dies after the receipt was stored but before the session recorded the result.
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-applied-continue');
    expect(await startOutcomes(second.launcher, 0)).toEqual([{ toolCallId: 'toolu_w', outcome: 'APPLIED', isError: false, text: original.text }]);
    expect(fs.executions('files_write')).toBe(1);
    expect(fs.applied).toEqual(['files_write']);
  });

  it('reconciles a write whose result was lost before the continuation starts and closes the call as applied', async () => {
    const context = setup();
    const { first, fs } = context;
    const input = { path: 'out.txt', content: 'v1' };
    const agentId = await spawnRunning(context, first, 'outcome-reconciled');
    await recordToolCall(context, first, 0, agentId, 'toolu_w', [{ name: 'files_write', arguments: input }]);
    fs.interrupt('files_write', 'after');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_w', toolCallId: 'toolu_w', operation: 'files_write', input });
    await vi.waitFor(() => expect(fs.files.get('out.txt')).toBe('v1'));
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-reconciled-continue');
    const outcomes = await startOutcomes(second.launcher, 0);
    expect(outcomes).toEqual([{ toolCallId: 'toolu_w', outcome: 'APPLIED', isError: false, text: expect.any(String) }]);
    expect(JSON.parse(outcomes![0]!.text)).toMatchObject({ ok: true, reconciled: true, data: { path: 'out.txt', sha256: sha256('v1') } });
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_w', kind: 'files_write' }))
      .toMatchObject({ state: 'APPLIED', reconciled: true, resultJson: outcomes![0]!.text });
    expect(fs.executions('files_write')).toBe(1);
  });

  it('tells the model to read the target first when a lost mutation cannot be proven either way', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('keep.txt', 'keep');
    const input = { source: 'keep.txt', destination: 'moved.txt' };
    const agentId = await spawnRunning(context, first, 'outcome-unknown');
    await recordToolCall(context, first, 0, agentId, 'toolu_m', [{ name: 'files_move', arguments: input }]);
    fs.interrupt('files_move', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_m', toolCallId: 'toolu_m', operation: 'files_move', input });
    await vi.waitFor(() => expect(fs.executions('files_move')).toBe(1));
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-unknown-continue');
    const outcomes = await startOutcomes(second.launcher, 0);
    expect(outcomes).toEqual([{ toolCallId: 'toolu_m', outcome: 'UNKNOWN', isError: true, text: expect.any(String) }]);
    const body = JSON.parse(outcomes![0]!.text) as { message: string; error: { code: string } };
    expect(body.error.code).toBe('EFFECT_UNKNOWN');
    expect(body.message).toContain('may have taken effect');
    expect(body.message).toContain('Inspect the target with a read before any retry');
    expect(fs.executions('files_move')).toBe(1);
    expect(fs.files.get('keep.txt')).toBe('keep');
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_m', kind: 'files_move' })).toMatchObject({ state: 'UNKNOWN', resultJson: null });
  });

  it('closes a patch that never reached its file as not applied and records that outcome', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('a.txt', 'alpha\n');
    const input = { path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' };
    const agentId = await spawnRunning(context, first, 'outcome-not-applied');
    await recordToolCall(context, first, 0, agentId, 'toolu_p', [{ name: 'files_apply_patch', arguments: input }]);
    fs.interrupt('files_apply_patch', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_p', toolCallId: 'toolu_p', operation: 'files_apply_patch', input });
    await vi.waitFor(() => expect(fs.executions('files_apply_patch')).toBe(1));
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-not-applied-continue');
    const outcomes = await startOutcomes(second.launcher, 0);
    expect(outcomes).toEqual([{ toolCallId: 'toolu_p', outcome: 'NOT_APPLIED', isError: true, text: expect.any(String) }]);
    expect(JSON.parse(outcomes![0]!.text)).toMatchObject({ ok: false, error: { code: 'EFFECT_NOT_APPLIED', retryable: true } });
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_p', kind: 'files_apply_patch' }))
      .toMatchObject({ state: 'REJECTED', resultJson: outcomes![0]!.text });
    expect(fs.files.get('a.txt')).toBe('alpha\n');
    expect(fs.applied).toEqual([]);
  });

  it('leaves a never-dispatched call and a repeatable read unsettled, and never settles a call that does not match its effect', async () => {
    const context = setup();
    const { first, fs, record } = context;
    const agentId = await spawnRunning(context, first, 'outcome-none');
    await recordToolCall(context, first, 0, agentId, 'toolu_new', [
      { name: 'files_write', arguments: { path: 'new.txt', content: 'never sent' } },
      { id: 'toolu_read', name: 'files_read', arguments: { path: 'r.txt' } },
      { id: 'toolu_other', name: 'files_write', arguments: { path: 'm.txt', content: 'not what was sent' } }
    ]);
    first.repository.reserveEffect({
      ownerId: record.ownerId, workspaceId: record.id, agentId, agentGeneration: 1, runnerEpoch: 1,
      requestId: 'toolu_read', kind: 'files_read', payloadHash: effectPayloadHash('files_read', { path: 'r.txt' }), now: Date.now()
    });
    fs.interrupt('files_write', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_other', toolCallId: 'toolu_other', operation: 'files_write', input: { path: 'm.txt', content: 'sent' } });
    await vi.waitFor(() => expect(fs.executions('files_write')).toBe(1));
    context.store.database.prepare("UPDATE agent_effects SET state='DISPATCHED' WHERE request_id='toolu_read'").run();
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-none-continue');
    const outcomes = await startOutcomes(second.launcher, 0);
    expect(outcomes).toEqual([{ toolCallId: 'toolu_other', outcome: 'UNKNOWN', isError: true, text: expect.any(String) }]);
    // The dispatched call may have run, so the mismatch is reported as unknown, never as not run.
    expect(JSON.parse(outcomes![0]!.text)).toMatchObject({ ok: false, error: { code: 'EFFECT_UNKNOWN', retryable: false } });
    expect(outcomes![0]!.text).not.toContain('was not run');
    // A transcript that does not match the dispatched payload is never used to observe or settle it.
    expect(fs.executions('files_read')).toBe(0);
    expect(second.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_other', kind: 'files_write' })).toMatchObject({ state: 'UNKNOWN' });
    expect(fs.executions('files_write')).toBe(1);
  });

  it('bounds the settled outcomes in count and size and redacts the gateway lease from them', async () => {
    const context = setup();
    const { first, record } = context;
    const agentId = await spawnRunning(context, first, 'outcome-bounds');
    const calls = Array.from({ length: 70 }, (_, index) => ({ id: `toolu_${index}`, name: 'files_mkdir', arguments: { path: `d${index}` } }));
    await recordToolCall(context, first, 0, agentId, 'toolu_0', calls);
    for (const call of calls) {
      first.repository.reserveEffect({
        ownerId: record.ownerId, workspaceId: record.id, agentId, agentGeneration: 1, runnerEpoch: 1,
        requestId: call.id, kind: 'files_mkdir', payloadHash: effectPayloadHash('files_mkdir', call.arguments), now: Date.now()
      });
    }
    const receipt = (text: string) => JSON.stringify({ ok: true, message: text, data: {}, truncated: false });
    const update = context.store.database.prepare("UPDATE agent_effects SET state='APPLIED', result_json=? WHERE request_id=?");
    for (const call of calls) update.run(receipt(`made ${call.arguments.path}`), call.id);
    update.run(receipt('x'.repeat(100 * 1024)), 'toolu_0');
    update.run(receipt(`leaked ${LEASE}`), 'toolu_1');
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-bounds-continue');
    const outcomes = (await startOutcomes(second.launcher, 0))!;
    expect(outcomes.map((outcome) => outcome.toolCallId)).toEqual(calls.slice(0, 64).map((call) => call.id));
    expect(Buffer.byteLength(outcomes[0]!.text)).toBeLessThan(1_024);
    expect(JSON.parse(outcomes[0]!.text)).toMatchObject({ ok: true, truncated: true });
    expect(outcomes[0]!.text).toContain('Inspect the target with a read');
    expect(outcomes[1]!.text).toBe(receipt('leaked [REDACTED]'));
    expect(outcomes[2]!.text).toBe(receipt('made d2'));
  });

  it('never closes a call with the receipt of another call that reused its provider tool call ID', async () => {
    const context = setup();
    const { first, fs } = context;
    const applied = { path: 'a.txt', content: 'first' };
    const agentId = await spawnRunning(context, first, 'outcome-reused-id');
    // The ledger holds an applied write under the request ID that the unanswered call maps to,
    // but with the payload of a different call.
    const original = await request(first.launcher, 0, 'toolu_dup', 'files_write', applied);
    expect(original.body).toMatchObject({ ok: true });
    await recordToolCall(context, first, 0, agentId, 'toolu_dup', [{ name: 'files_write', arguments: { path: 'a.txt', content: 'second' } }]);
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-reused-id-continue');
    const outcomes = (await startOutcomes(second.launcher, 0))!;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.text).not.toBe(original.text);
    expect(JSON.parse(outcomes[0]!.text)).toMatchObject({ ok: false, error: { code: 'EFFECT_UNKNOWN' } });
    expect(fs.files.get('a.txt')).toBe('first');
    expect(fs.applied).toEqual(['files_write']);
  });

  it('settles a call whose transcript arguments the runtime coerced before dispatch with its real outcome', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.files.set('r.txt', 'readable content');
    fs.files.set('gone.txt', 'to delete');
    const agentId = await spawnRunning(context, first, 'outcome-coerced');
    // The model's raw arguments, as the transcript keeps them: an optional null and string-typed
    // numbers and booleans, which the runtime drops or coerces before it proxies the call.
    await recordToolCall(context, first, 0, agentId, 'toolu_r', [
      { id: 'toolu_r', name: 'files_read', arguments: { path: 'r.txt', limit: '10' } },
      { id: 'toolu_d', name: 'files_delete', arguments: { path: 'gone.txt', recursive: null } },
      { id: 'toolu_mk', name: 'files_mkdir', arguments: { path: 'made', recursive: 'true' } }
    ]);
    const read = await request(first.launcher, 0, 'toolu_r', 'files_read', { path: 'r.txt', limit: 10 });
    expect(read.body).toMatchObject({ ok: true, data: { content: 'readable c' } });
    fs.interrupt('files_delete', 'after');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_d', toolCallId: 'toolu_d', operation: 'files_delete', input: { path: 'gone.txt' } });
    await vi.waitFor(() => expect(fs.files.has('gone.txt')).toBe(false));
    // Tool calls run one at a time, so the mkdir's lost dispatch is recorded directly, as the runner
    // records it for the coerced arguments; the directory then landed.
    const fence = { ownerId: context.record.ownerId, workspaceId: context.record.id, agentId, agentGeneration: 1, runnerEpoch: 1 };
    first.repository.reserveEffect({
      ...fence, requestId: 'toolu_mk', kind: 'files_mkdir', now: Date.now(),
      payloadHash: effectPayloadHash('files_mkdir', { path: 'made', recursive: true })
    });
    expect(first.repository.dispatchEffect({
      rootAgentId: agentId, requestId: 'toolu_mk', kind: 'files_mkdir', fence, expectedStates: ['INTENT'], preEntry: 'absent', now: Date.now()
    })).toBe(true);
    fs.directories.add('made');
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-coerced-continue');
    const outcomes = (await startOutcomes(second.launcher, 0))!;
    expect(outcomes.map((outcome) => [outcome.toolCallId, outcome.outcome, outcome.isError]))
      .toEqual([['toolu_r', 'APPLIED', false], ['toolu_d', 'APPLIED', false], ['toolu_mk', 'APPLIED', false]]);
    expect(outcomes[0]!.text).toBe(read.text);
    expect(JSON.parse(outcomes[1]!.text)).toMatchObject({ ok: true, reconciled: true });
    expect(JSON.parse(outcomes[2]!.text)).toMatchObject({ ok: true, reconciled: true });
    expect(fs.executions('files_delete')).toBe(1);
    expect(fs.executions('files_mkdir')).toBe(0);
  });

  it('reports a delete of a path that never existed and an mkdir of an existing directory as unknown, not applied', async () => {
    const context = setup();
    const { first, fs } = context;
    fs.directories.add('existing');
    const agentId = await spawnRunning(context, first, 'outcome-unchanged');
    await recordToolCall(context, first, 0, agentId, 'toolu_del', [
      { id: 'toolu_del', name: 'files_delete', arguments: { path: 'never.txt' } },
      { id: 'toolu_mk', name: 'files_mkdir', arguments: { path: 'existing' } }
    ]);
    fs.interrupt('files_delete', 'before');
    first.launcher.emit(0, { type: 'tool_request', requestId: 'toolu_del', toolCallId: 'toolu_del', operation: 'files_delete', input: { path: 'never.txt' } });
    await vi.waitFor(() => expect(fs.executions('files_delete')).toBe(1));
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_del', kind: 'files_delete' })).toMatchObject({ state: 'DISPATCHED', preEntry: 'absent' });
    // Tool calls run one at a time, so the mkdir's lost dispatch is recorded directly, as the runner
    // records it: the directory already existed when it was dispatched.
    const fence = { ownerId: context.record.ownerId, workspaceId: context.record.id, agentId, agentGeneration: 1, runnerEpoch: 1 };
    first.repository.reserveEffect({
      ...fence, requestId: 'toolu_mk', kind: 'files_mkdir', now: Date.now(),
      payloadHash: effectPayloadHash('files_mkdir', { path: 'existing' })
    });
    expect(first.repository.dispatchEffect({
      rootAgentId: agentId, requestId: 'toolu_mk', kind: 'files_mkdir', fence, expectedStates: ['INTENT'], preEntry: 'directory', now: Date.now()
    })).toBe(true);
    const second = await crashAndRestart(context, agentId);
    await continueAgent(context, second, agentId, 'outcome-unchanged-continue');
    const outcomes = (await startOutcomes(second.launcher, 0))!;
    expect(outcomes.map((outcome) => [outcome.toolCallId, outcome.outcome])).toEqual([['toolu_del', 'UNKNOWN'], ['toolu_mk', 'UNKNOWN']]);
    for (const outcome of outcomes) expect(JSON.parse(outcome.text)).toMatchObject({ error: { code: 'EFFECT_UNKNOWN' } });
    expect(fs.applied).toEqual([]);
  });
});

describe('stored receipt results', () => {
  const storedResults = (context: Context) => (context.store.database
    .prepare('SELECT COUNT(*) AS stored FROM agent_effects WHERE result_json IS NOT NULL')
    .get() as { stored: number }).stored;

  it('keeps only payload and result hashes for an agent spawned without session persistence', async () => {
    const context = setup(undefined, RunnerAgentsConfigSchema.parse({ ...config, sessionPersistenceEnabled: false }));
    const { first, fs, record } = context;
    fs.files.set('.env', 'SECRET=value');
    const agentId = await spawnRunning(context, first, 'flags-off-key');
    const read = await request(first.launcher, 0, 'toolu_env', 'files_read', { path: '.env' });
    expect(read.body).toMatchObject({ ok: true, data: { content: 'SECRET=value' } });
    const written = await request(first.launcher, 0, 'toolu_w', 'files_write', { path: 'w.txt', content: 'w' });
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_env', kind: 'files_read' })).toMatchObject({
      state: 'APPLIED', resultJson: null, resultSha256: sha256(read.text), retainUntil: null
    });
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_w', kind: 'files_write' })).toMatchObject({
      state: 'APPLIED', resultJson: null, resultSha256: sha256(written.text)
    });
    expect(storedResults(context)).toBe(0);
    expect(JSON.stringify(context.store.database.prepare('SELECT * FROM agent_effects').all())).not.toContain('SECRET=value');
    // A redelivered write is still never issued twice.
    const again = await request(first.launcher, 0, 'toolu_w', 'files_write', { path: 'w.txt', content: 'w' });
    expect(again.body).toMatchObject({ ok: false, error: { code: 'EFFECT_RECEIPT_UNAVAILABLE' } });
    expect(fs.applied).toEqual(['files_write']);
    expect(first.repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING');
  });

  it('dispatches a delete, mkdir, or move of an agent that records no session without observing its target first', async () => {
    const context = setup(undefined, RunnerAgentsConfigSchema.parse({ ...config, sessionPersistenceEnabled: false }));
    const { first, fs } = context;
    fs.files.set('old.txt', 'old');
    fs.files.set('from.txt', 'moving');
    const agentId = await spawnRunning(context, first, 'flags-off-observe');
    await request(first.launcher, 0, 'toolu_del', 'files_delete', { path: 'old.txt' });
    await request(first.launcher, 0, 'toolu_mk', 'files_mkdir', { path: 'dir' });
    await request(first.launcher, 0, 'toolu_mv', 'files_move', { source: 'from.txt', destination: 'to.txt' });
    // One executor call per tool call, as before the ledger recorded pre-dispatch state.
    expect(fs.calls.map((call) => call.operation)).toEqual(['files_delete', 'files_mkdir', 'files_move']);
    for (const [requestId, kind] of [['toolu_del', 'files_delete'], ['toolu_mk', 'files_mkdir'], ['toolu_mv', 'files_move']] as const) {
      expect(first.repository.findEffect({ rootAgentId: agentId, requestId, kind })).toMatchObject({ state: 'APPLIED', preEntry: null });
    }
  });

  it('stops storing result text once a lineage reaches its receipt byte cap', async () => {
    const capped = RunnerAgentsConfigSchema.parse({ ...config, limits: { ...config.limits, maxReceiptBytesPerLineage: 1_000 } });
    const context = setup(undefined, capped);
    const { first, fs } = context;
    fs.files.set('a.txt', 'a'.repeat(400));
    fs.files.set('b.txt', 'b'.repeat(400));
    const agentId = await spawnRunning(context, first, 'capped-key');
    const a = await request(first.launcher, 0, 'toolu_a', 'files_read', { path: 'a.txt' });
    const b = await request(first.launcher, 0, 'toolu_b', 'files_read', { path: 'b.txt' });
    expect(Buffer.byteLength(a.text) + Buffer.byteLength(b.text)).toBeGreaterThan(1_000);
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_a', kind: 'files_read' })).toMatchObject({ resultJson: a.text });
    expect(first.repository.findEffect({ rootAgentId: agentId, requestId: 'toolu_b', kind: 'files_read' })).toMatchObject({
      resultJson: null, resultSha256: sha256(b.text)
    });
    const held = context.store.database.prepare(`SELECT SUM(length(CAST(result_json AS BLOB))) AS bytes, SUM(result_bytes) AS recorded
      FROM agent_effects WHERE root_agent_id=?`).get(agentId) as { bytes: number; recorded: number };
    expect(held.bytes).toBeLessThanOrEqual(1_000);
    // The cap is summed from the recorded sizes, which match the stored text exactly.
    expect(held.recorded).toBe(Buffer.byteLength(a.text));
    expect(held.recorded).toBe(held.bytes);
    // Past the cap a repeat behaves as after retention: the read runs again, the stored one replays.
    expect((await request(first.launcher, 0, 'toolu_b', 'files_read', { path: 'b.txt' })).body).toMatchObject({ replayed: 're-executed' });
    expect((await request(first.launcher, 0, 'toolu_a', 'files_read', { path: 'a.txt' })).text).toBe(a.text);
    expect(fs.executions('files_read')).toBe(3);
  });
});
