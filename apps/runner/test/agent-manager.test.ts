import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { RunnerAgentsConfigSchema, type RunnerOperation } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../src/agent-manager.js';
import type { AgentGatewayControl, AgentLeaseGrant } from '../src/agent-gateway-control.js';
import type { AgentLaunchSpec, AgentLauncher, AgentRuntimeProcess } from '../src/agent-launcher.js';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const directories: string[] = [];
const openStores: StateStore[] = [];
afterEach(() => {
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const agentsConfig = RunnerAgentsConfigSchema.parse({
  image: 'cloud-harness-agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  profiles: [{
    id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
    maxProxyOperations: ['files_read', 'files_write']
  }],
  limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600 }
});

function workspace(networkProfile: WorkspaceRecord['networkProfile'] = 'network-none', ownerId = 'owner'): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile,
    createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
    gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
  };
}

function setup(
  networkProfile: WorkspaceRecord['networkProfile'] = 'network-none',
  config = agentsConfig,
  now?: () => number
) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-manager-'));
  directories.push(directory);
  const store = new StateStore(join(directory, 'state.db'));
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const record = workspace(networkProfile, ownerId);
  store.create(record);
  const repository = new AgentStateRepository(store.database, config.limits);
  const launcher = new FakeLauncher();
  const gateway = new FakeGateway();
  const toolExecutor = vi.fn(async () => ({ ok: true as const, message: 'read', data: { content: 'ok' }, truncated: false }));
  const manager = new AgentManager(config, store, { repository, launcher, gateway, toolExecutor, ...(now ? { now } : {}) });
  return { store, record, repository, launcher, gateway, toolExecutor, manager };
}

function spawnInput(record: WorkspaceRecord, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: record.id,
    prompt: 'inspect the repository', idempotencyKey: 'spawn-key', profileId: 'default',
    proxyOperations: ['files_read'], ttlSeconds: 30, maxOutputBytes: 262_144,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
    ...overrides
  };
}

function reservationForManager(record: WorkspaceRecord, suffix: string, now: number) {
  const key = suffix.padEnd(24, 'x').slice(0, 24);
  return {
    id: `agent_${key}`,
    ownerId: record.ownerId,
    workspaceId: record.id,
    workspaceGeneration: record.generation,
    idempotencyKey: `spawn-${suffix}`,
    payloadHash: key.padEnd(64, 'x'),
    promptHash: key.padEnd(64, 'p'),
    profileId: 'default',
    proxyOperations: ['files_read' as const],
    budget: {
      ttlSeconds: 30,
      maxOutputBytes: 262_144,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostMicros: 1_000_000
    },
    containerName: `agent-${suffix}`,
    networkName: `agent-net-${suffix}`,
    gatewayLeaseId: `lease-${suffix}`,
    now,
    expiresAt: now + 30_000
  };
}

class FakeGateway implements AgentGatewayControl {
  readonly issued: AgentLeaseGrant[] = [];
  readonly revoked: string[] = [];

  failIssue = false;
  failRevoke = false;
  revokeGate?: Promise<void>;
  async issue(input: Omit<AgentLeaseGrant, 'lease'>): Promise<AgentLeaseGrant> {
    if (this.failIssue) throw new Error('injected lease issue failure');
    const grant = { ...input, lease: `bearer_${'x'.repeat(48)}` };
    this.issued.push(grant);
    return grant;
  }
  async revokeAndDrain(leaseId: string): Promise<void> {
    this.revoked.push(leaseId);
    await this.revokeGate;
    if (this.failRevoke) throw new Error('injected lease revoke failure');
  }
  async cancelAndDrain(): Promise<void> {}
}

class FakeLauncher implements AgentLauncher {
  readonly launches: AgentLaunchSpec[] = [];
  readonly cleanups: Array<Pick<AgentLaunchSpec, 'containerName' | 'networkName'>> = [];
  readonly inputs: PassThrough[] = [];
  readonly outputs: PassThrough[] = [];
  failCleanup = false;
  reconciled = false;

  async reconcile(): Promise<void> { this.reconciled = true; }
  async launch(spec: AgentLaunchSpec): Promise<AgentRuntimeProcess> {
    this.launches.push(spec);
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    this.inputs.push(input);
    this.outputs.push(output);
    const process = { stdin: input, stdout: output, stderr } as unknown as ChildProcessWithoutNullStreams;
    return { process, exited: Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>().promise };
  }
  async cleanup(spec: Pick<AgentLaunchSpec, 'containerName' | 'networkName'>): Promise<void> {
    this.cleanups.push(spec);
    if (this.failCleanup) throw new Error('injected cleanup failure');
  }
  async inspect(): Promise<{ container: boolean; network: boolean }> {
    return { container: false, network: false };
  }
}

async function waitForRunning(manager: AgentManager, record: WorkspaceRecord): Promise<string> {
  await vi.waitFor(() => expect(manager.dispatch(record.ownerId, record, 'agent_status', {
    workspaceId: record.id, idempotencyKey: 'spawn-key'
  })).resolves.toMatchObject({ data: { status: 'RUNNING' } }));
  const response = await manager.dispatch(record.ownerId, record, 'agent_status', {
    workspaceId: record.id, idempotencyKey: 'spawn-key'
  });
  return (response.data as { agentId: string }).agentId;
}

describe('AgentManager', () => {
  it('owns exactly the six public operations and excludes generic fallback operations', () => {
    const agentOperations: RunnerOperation[] = ['agent_spawn', 'agent_status', 'agent_logs', 'agent_message', 'agent_cancel', 'agent_list'];
    for (const operation of agentOperations) expect(AgentManager.isPublicOperation(operation)).toBe(true);
    expect(AgentManager.isPublicOperation('files_read')).toBe(false);
    expect(AgentManager.isPublicOperation('git_push')).toBe(false);
    expect(AgentManager.isPublicOperation('deployments_run')).toBe(false);
  });

  it('atomically replays concurrent spawn admission with one runtime launch (32-way fan-out)', async () => {
    const { manager, record, launcher, gateway, store } = setup();
    const concurrentCount = 32;
    const requests = Array.from({ length: concurrentCount }, () =>
      manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record))
    );
    const results = await Promise.all(requests);
    const firstAgentId = (results[0]!.data as { agentId: string }).agentId;
    for (const res of results) {
      expect((res.data as { agentId: string }).agentId).toBe(firstAgentId);
    }
    const nonReplayed = results.filter((res) => (res.data as { replayed: boolean }).replayed === false);
    const replayed = results.filter((res) => (res.data as { replayed: boolean }).replayed === true);
    expect(nonReplayed).toHaveLength(1);
    expect(replayed).toHaveLength(concurrentCount - 1);
    expect(launcher.launches).toHaveLength(1);
    expect(gateway.issued).toHaveLength(1);
    store.close();
  });

  it('rejects network-enabled workspaces before launcher or gateway effects', async () => {
    const { manager, record, launcher, gateway, store } = setup('dependency-access');
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(launcher.launches).toHaveLength(0);
    expect(gateway.issued).toHaveLength(0);
    store.close();
  });

  it('makes foreign ownership indistinguishable from a missing workspace', async () => {
    const { manager, record, store } = setup();
    const foreignOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'foreign' });
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    await expect(manager.dispatch(foreignOwner, record, 'agent_status', {
      workspaceId: record.id, idempotencyKey: 'spawn-key'
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    store.close();
  });

  it('persists message delivery and replays without writing a second protocol record (32-way fan-out)', async () => {
    const { manager, record, launcher, store } = setup();
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    const chunks: Buffer[] = [];
    launcher.inputs[0]!.on('data', (chunk: Buffer) => chunks.push(chunk));
    const input = { workspaceId: record.id, agentId, idempotencyKey: 'message-key', mode: 'steer' as const, message: 'focus on tests' };
    const concurrentCount = 32;
    const messageRequests = Array.from({ length: concurrentCount }, () =>
      manager.dispatch(record.ownerId, record, 'agent_message', input)
    );
    const messageResults = await Promise.all(messageRequests);
    const nonReplayed = messageResults.filter((res) => (res.data as { replayed: boolean }).replayed === false);
    const replayed = messageResults.filter((res) => (res.data as { replayed: boolean }).replayed === true);
    expect(nonReplayed).toHaveLength(1);
    expect(replayed.length).toBe(concurrentCount - 1);
    await vi.waitFor(() => {
      expect(Buffer.concat(chunks).toString('utf8').split('\n').filter((line) => line.includes('"type":"message"'))).toHaveLength(1);
    });
    const followUpReplay = await manager.dispatch(record.ownerId, record, 'agent_message', input);
    expect(followUpReplay.data).toMatchObject({ state: 'SENT', replayed: true });
    store.close();
  });

  it('executes only granted proxy tools and appends bounded protocol events', async () => {
    const { manager, record, launcher, toolExecutor, store } = setup();
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    launcher.outputs[0]!.write(`${JSON.stringify({ type: 'event', sequence: 1, event: { kind: 'notice', message: 'hello' } })}\n`);
    launcher.outputs[0]!.write(`${JSON.stringify({
      type: 'tool_request', requestId: 'request-1', toolCallId: 'call-1', operation: 'files_read', input: { path: 'README.md' }
    })}\n`);
    await vi.waitFor(() => expect(toolExecutor).toHaveBeenCalledTimes(1));
    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: record.ownerId, workspaceId: record.id, agentId, operation: 'files_read',
      toolInput: expect.objectContaining({ workspaceId: record.id, path: 'README.md' })
    }));
    const logs = await manager.dispatch(record.ownerId, record, 'agent_logs', {
      workspaceId: record.id, agentId, cursor: '0', limitBytes: 65_536
    });
    expect(logs.data).toMatchObject({ events: [expect.objectContaining({ type: 'event' })] });
    store.close();
  });

  it('returns a maximum files_read payload without protocol truncation', async () => {
    const { manager, record, launcher, toolExecutor, store } = setup();
    const content = '\0'.repeat(262_144);
    toolExecutor.mockResolvedValueOnce({ ok: true, message: 'read', data: { content }, truncated: false });
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    await waitForRunning(manager, record);
    const chunks: Buffer[] = [];
    launcher.inputs[0]!.on('data', (chunk: Buffer) => chunks.push(chunk));
    launcher.outputs[0]!.write(`${JSON.stringify({
      type: 'tool_request', requestId: 'request-large-read', toolCallId: 'call-large-read',
      operation: 'files_read', input: { path: 'README.md', limit: 262_144 }
    })}\n`);
    await vi.waitFor(() => {
      const records = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.some((item) => item.type === 'tool_result')).toBe(true);
    });
    const records = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      type: string;
      content?: Array<{ text: string }>;
    });
    const result = records.find((item) => item.type === 'tool_result');
    expect(JSON.parse(result?.content?.[0]?.text ?? '{}')).toMatchObject({ data: { content } });
    store.close();
  });

  it('fences a settled parent and cancels descendants post-order before terminal persistence', async () => {
    const { manager, record, launcher, repository, store } = setup();
    const parentSpawn = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const parentId = (parentSpawn.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, parentId)?.status).toBe('RUNNING'));
    const childSpawn = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'child-key',
      parentAgentId: parentId
    }));
    const childId = (childSpawn.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, parentId)?.status).toBe('RUNNING'));
    launcher.outputs[0]!.write(`${JSON.stringify({
      type: 'terminal',
      state: 'SUCCEEDED',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 }
    })}\n`);
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, parentId)?.status).toBe('SUCCEEDED'));
    expect(repository.findAgent(record.ownerId, record.id, childId)?.status).toBe('CANCELLED');
    expect(launcher.cleanups.map((cleanup) => cleanup.containerName)).toEqual([
      repository.findAgent(record.ownerId, record.id, childId)?.containerName,
      repository.findAgent(record.ownerId, record.id, parentId)?.containerName
    ]);
    store.close();
  });

  it('keeps cleanup failures nonterminal with durable retry metadata', async () => {
    const { manager, record, launcher, repository, store } = setup();
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    launcher.failCleanup = true;
    await expect(manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId })).rejects.toThrow('injected cleanup failure');
    expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('CANCELLING');
    expect(repository.cleanupRetry(record.ownerId, record.id, agentId, 1)).toMatchObject({ attempts: 1 });
    store.close();
  });

  it('removes launched resources when lease issue fails', async () => {
    const { manager, record, launcher, gateway, repository, store } = setup();
    gateway.failIssue = true;
    const spawned = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('FAILED'));
    expect(launcher.launches).toHaveLength(0);
    expect(launcher.cleanups).toHaveLength(1);
    store.close();
  });

  it('attempts local resource removal when gateway drain fails', async () => {
    const { manager, record, launcher, gateway, repository, store } = setup();
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    gateway.failRevoke = true;
    await expect(manager.dispatch(record.ownerId, record, 'agent_cancel', {
      workspaceId: record.id,
      agentId
    })).rejects.toThrow('injected lease revoke failure');
    expect(launcher.cleanups).toHaveLength(1);
    expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('CANCELLING');
    expect(repository.cleanupRetry(record.ownerId, record.id, agentId, 1)).toBeDefined();
    store.close();
  });

  it('reconciles durable nonterminal rows only after resource and lease drain', async () => {
    const { manager, record, repository, launcher, gateway, store } = setup();
    const now = Date.now();
    const reserved = repository.reserveSpawn({
      id: `agent_${'a'.repeat(24)}`, ownerId: record.ownerId, workspaceId: record.id, workspaceGeneration: 1,
      idempotencyKey: 'restart-key', payloadHash: 'a'.repeat(64), promptHash: 'b'.repeat(64), profileId: 'default',
      proxyOperations: ['files_read'], budget: { ttlSeconds: 30, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
      containerName: 'agent-restart', networkName: 'agent-net-restart', gatewayLeaseId: 'lease-restart', now, expiresAt: now + 30_000
    }).record;
    const drain = Promise.withResolvers<void>();
    gateway.revokeGate = drain.promise;
    const starting = manager.start();
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, reserved.id)).toMatchObject({
      status: 'CANCELLING',
      outcomeUnknown: false
    }));
    expect(launcher.cleanups).toHaveLength(0);
    drain.resolve();
    await starting;
    expect(launcher.reconciled).toBe(true);
    expect(gateway.revoked).toContain(reserved.gatewayLeaseId);
    expect(repository.findAgent(record.ownerId, record.id, reserved.id)).toMatchObject({ status: 'INTERRUPTED', outcomeUnknown: true });
    await manager.stop();
    store.close();
  });

  it('runs closed-workspace retention maintenance and restores retained capacity', async () => {
    let now = Date.now();
    const config = RunnerAgentsConfigSchema.parse({
      ...agentsConfig,
      limits: {
        ...agentsConfig.limits,
        retentionSeconds: 1,
        lookupHorizonSeconds: 2,
        globalRetainedRows: 1,
        principalRetainedRows: 1,
        workspaceRetainedRows: 1
      }
    });
    const { manager, record, repository, store } = setup('network-none', config, () => now);
    const terminal = repository.reserveSpawn(reservationForManager(record, 'retained', now)).record;
    repository.transitionStatus({
      ownerId: record.ownerId,
      workspaceId: record.id,
      agentId: terminal.id,
      generation: terminal.generation,
      expectedStatuses: ['SPAWNING'],
      status: 'FAILED',
      now,
      terminalReason: 'test terminal'
    });
    store.updateFenced(record.id, record.generation, ['ACTIVE'], { status: 'CLOSED' });
    const replacement = { ...workspace('network-none', record.ownerId), id: `ws_${'r'.repeat(24)}`, idempotencyKey: 'replacement-workspace' };
    store.create(replacement);
    expect(() => repository.reserveSpawn(reservationForManager(replacement, 'blocked', now)))
      .toThrow('retained record capacity');

    now += 1_000;
    await manager.start();
    expect(repository.findAgent(record.ownerId, record.id, terminal.id)).toBeUndefined();
    expect(repository.findTombstone(record.ownerId, record.id, terminal.id)).toBeDefined();
    await expect(manager.dispatch(record.ownerId, record, 'agent_status', {
      workspaceId: record.id,
      agentId: terminal.id
    })).resolves.toMatchObject({
      data: {
        agentId: terminal.id,
        workspaceId: record.id,
        status: 'FAILED',
        generation: terminal.generation,
        compacted: true
      }
    });
    await expect(manager.dispatch(record.ownerId, record, 'agent_status', {
      workspaceId: record.id,
      idempotencyKey: terminal.idempotencyKey
    })).resolves.toMatchObject({ data: { agentId: terminal.id, compacted: true } });
    await manager.stop();

    now += 1_000;
    const restarted = new AgentManager(config, store, {
      repository,
      launcher: new FakeLauncher(),
      gateway: new FakeGateway(),
      toolExecutor: async () => ({ ok: true, message: 'read', data: { content: 'ok' }, truncated: false }),
      now: () => now
    });
    await restarted.start();
    expect(repository.findTombstone(record.ownerId, record.id, terminal.id)).toBeUndefined();
    expect(repository.reserveSpawn(reservationForManager(replacement, 'admitted', now)).record.status).toBe('SPAWNING');
    await restarted.stop();
    store.close();
  });

  it('fences stale manager from transitioning or executing after epoch bump on restart', async () => {
    const { manager, record, repository, launcher, gateway, store } = setup();
    await manager.start();
    const spawnRes = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = (spawnRes.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING'));

    const secondLauncher = new FakeLauncher();
    const secondGateway = new FakeGateway();
    // Create a new restarted manager on the same store which bumps epoch
    const secondManager = new AgentManager(agentsConfig, store, {
      repository,
      launcher: secondLauncher,
      gateway: secondGateway,
      toolExecutor: vi.fn(async () => ({ ok: true as const, message: 'ok', data: {}, truncated: false }))
    });
    await secondManager.start();

    // The old agent was reconciled to INTERRUPTED by restart
    expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('INTERRUPTED');

    const initialLaunches = launcher.launches.length;
    const initialGatewayIssued = gateway.issued.length;

    // The old manager instance attempts to spawn a fresh key with old epoch -> rejected
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'fresh-key-after-bump'
    }))).rejects.toThrow();

    // The old manager instance attempts to message with old epoch -> rejected
    await expect(manager.dispatch(record.ownerId, record, 'agent_message', {
      workspaceId: record.id, agentId, idempotencyKey: 'old-epoch-msg', mode: 'steer', message: 'stale'
    })).rejects.toThrow();

    // Assert zero side effects occurred on the stale manager's launcher/gateway
    expect(launcher.launches.length).toBe(initialLaunches);
    expect(gateway.issued.length).toBe(initialGatewayIssued);

    await secondManager.stop();
    await manager.stop();
    store.close();
  });
});
