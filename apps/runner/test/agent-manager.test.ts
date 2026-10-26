import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ModelProfileIdSchema, RunnerAgentsConfigSchema, buildRepositoryGuidanceSnapshot, type RunnerOperation } from '@cloud-harness/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../src/agent-manager.js';
import { DockerAgentGatewayControl, type AgentGatewayControl, type AgentLeaseGrant, type AgentLeaseRevocation, type AgentLeaseSettlement } from '../src/agent-gateway-control.js';
import * as dockerEngine from '../src/docker-engine.js';
import type { AgentLaunchSpec, AgentLauncher, AgentRuntimeProcess } from '../src/agent-launcher.js';
import { AGENT_SESSION_GENESIS_SHA256, AgentStateRepository, chainAgentSessionHead } from '../src/agent-state-repository.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { ModelSpendLedger, staticProfileSpendKey } from '../src/model-spend-ledger.js';
import { SecretKeyring } from '../src/secret-keyring.js';
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
  const spendLog = vi.fn();
  const spendLedger = new ModelSpendLedger(store.database, { log: spendLog });
  const manager = new AgentManager(config, store, { repository, launcher, gateway, toolExecutor, spendLedger, ...(now ? { now } : {}) });
  return { store, record, repository, launcher, gateway, toolExecutor, manager, spendLedger, spendLog };
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
  /** Settlements the gateway returns on revoke, by lease id; a lease without one revokes as unknown. */
  readonly settlements = new Map<string, Partial<AgentLeaseSettlement>>();

  failIssue = false;
  failRevoke = false;
  revokeGate?: Promise<void>;
  /** Unset models an older gateway, which reports neither a boot id nor a settlement. */
  bootId?: string;
  async issue(input: Omit<AgentLeaseGrant, 'lease' | 'gatewayBootId'>): Promise<AgentLeaseGrant> {
    if (this.failIssue) throw new Error('injected lease issue failure');
    const grant = { ...input, lease: `bearer_${'x'.repeat(48)}`, ...(this.bootId ? { gatewayBootId: this.bootId } : {}) };
    this.issued.push(grant);
    return grant;
  }
  async revokeAndDrain(leaseId: string): Promise<AgentLeaseRevocation | void> {
    this.revoked.push(leaseId);
    await this.revokeGate;
    if (this.failRevoke) throw new Error('injected lease revoke failure');
    if (this.bootId === undefined) return;
    const settlement = this.settlements.get(leaseId);
    if (!settlement) return { revoked: false, gatewayBootId: this.bootId };
    return {
      revoked: true,
      gatewayBootId: this.bootId,
      settlement: {
        leaseId, reason: 'revoked', settledAt: 1, initialInputTokens: 10_000, initialOutputTokens: 2_000, initialCostMicros: 1_000_000,
        costMicros: 0, overrunCostMicros: 0, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
        reasoningTokens: 0, requests: 0, requestsWithoutUsage: 0, ...settlement
      }
    };
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

/** Saves the profile `cached` for the store's owner, priced like an OpenAI model. */
function createCachedProfile(store: StateStore, ownerId: string): ModelProfileStateRepository {
  const modelProfiles = new ModelProfileStateRepository(store.database, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
  const credential = modelProfiles.createCredential(ownerId, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-test' });
  modelProfiles.createProfile(ownerId, {
    profileId: ModelProfileIdSchema.parse('cached'),
    displayName: 'Cached',
    credentialId: credential.id,
    model: 'openai/gpt-5',
    apiMode: 'chat-completions',
    pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000 },
    limits: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
    maxProxyOperations: ['files_read']
  });
  return modelProfiles;
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

  it('stops counting an agent as running once its TTL has passed', async () => {
    let now = Date.now();
    const { manager, record, repository } = setup('network-none', agentsConfig, () => now);
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    // Wait for the launch to arm its TTL timer against the real clock before moving the clock past it.
    await vi.waitFor(() => expect(repository.listActiveAgents(record.ownerId, record.id)[0]?.status).toBe('RUNNING'));
    expect(manager.hasActiveAgents(record.ownerId, record.id)).toBe(true);
    now += 31_000;
    expect(manager.hasActiveAgents(record.ownerId, record.id)).toBe(false);
    await manager.stop();
  });

  it('rejects network-enabled workspaces before launcher or gateway effects', async () => {
    const { manager, record, launcher, gateway, store } = setup('dependency-access');
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(launcher.launches).toHaveLength(0);
    expect(gateway.issued).toHaveLength(0);
    store.close();
  });

  it('skips agent admission for an ACTIVE dependency-access workspace instead of aborting startup', async () => {
    // Regression: openWorkspaceAdmission throws for a workspace whose profile is not
    // network-none, and the startup loop called it unconditionally. A single ACTIVE
    // dependency-access workspace therefore killed the runner on every restart, and the unhealthy
    // runner took the entire compose stack down with it.
    const { manager, record, store } = setup('dependency-access');
    await expect(manager.start()).resolves.toBeUndefined();
    const admission = store.database.prepare('SELECT COUNT(*) AS count FROM agent_workspace_admission').get() as { count: number };
    expect(admission.count).toBe(0);
    // The eligibility rule itself is unchanged: spawning there is still refused.
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record))).rejects.toMatchObject({ code: 'CONFLICT' });
    await manager.stop();
    store.close();
  });

  it('reports a found-but-ineligible workspace as CONFLICT, not NOT_FOUND, when opening admission', () => {
    const { repository, record, store } = setup('dependency-access');
    expect(() => repository.openWorkspaceAdmission(record.ownerId, record.id, record.generation, Date.now()))
      .toThrow(expect.objectContaining({ code: 'CONFLICT', message: expect.stringContaining('not eligible for agent admission') }));
    // A missing workspace, a stale generation, and a foreign owner still read as NOT_FOUND.
    expect(() => repository.openWorkspaceAdmission(record.ownerId, 'ws_missing', record.generation, Date.now()))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => repository.openWorkspaceAdmission(record.ownerId, record.id, record.generation + 1, Date.now()))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const foreignOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'foreign' });
    expect(() => repository.openWorkspaceAdmission(foreignOwner, record.id, record.generation, Date.now()))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    store.close();
  });

  it('reports a non-ACTIVE network-none workspace as CONFLICT to its owner and NOT_FOUND to others', () => {
    const { repository, record, store } = setup();
    store.update(record.id, { status: 'CLOSED' });
    expect(() => repository.openWorkspaceAdmission(record.ownerId, record.id, record.generation, Date.now()))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    const foreignOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'foreign' });
    expect(() => repository.openWorkspaceAdmission(foreignOwner, record.id, record.generation, Date.now()))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
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

describe('agent spend ledger enforcement', () => {
  function ledgerRows(store: StateStore): number {
    return (store.database.prepare('SELECT COUNT(*) AS count FROM model_spend_ledger').get() as { count: number }).count;
  }

  function leaseOf(repository: AgentStateRepository, record: WorkspaceRecord, agentId: string): string {
    return repository.findAgent(record.ownerId, record.id, agentId)!.gatewayLeaseId;
  }

  it('admits exactly one of two concurrent spawns when the policy fits one cap, without clamping the cap', async () => {
    const { manager, record, store, spendLedger, gateway } = setup();
    spendLedger.setPolicy(record.ownerId, { period: 'day', limitMicros: 1_500_000 }, Date.now());
    const results = await Promise.allSettled([
      manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey: 'first-spawn' })),
      manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey: 'second-spawn' }))
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.reason).toMatchObject({ code: 'LIMIT_EXCEEDED', status: 429, retryable: false });
    expect(String((refused?.reason as Error).message)).toContain('model spend policy (principal, day) would be exceeded');
    expect(ledgerRows(store)).toBe(1);
    await vi.waitFor(() => expect(gateway.issued).toHaveLength(1));
    expect(gateway.issued[0]!.maxCostMicros).toBe(1_000_000);
    await manager.stop();
  });

  it('never reserves twice for an idempotent replay', async () => {
    const { manager, record, store, spendLedger } = setup();
    spendLedger.setPolicy(record.ownerId, { period: 'month', limitMicros: 1_000_000 }, Date.now());
    const first = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const replay = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    expect(replay.data).toMatchObject({ agentId: (first.data as { agentId: string }).agentId, replayed: true });
    expect(ledgerRows(store)).toBe(1);
    await manager.stop();
  });

  it('creates no agent, lease, or container for a spawn the policy refuses', async () => {
    const { store, record, repository, spendLedger, launcher, gateway, toolExecutor } = setup();
    const manager = new AgentManager(agentsConfig, store, {
      repository, launcher, gateway, toolExecutor, spendLedger, modelProfiles: createCachedProfile(store, record.ownerId)
    });
    spendLedger.setPolicy(record.ownerId, { profileId: 'cached', period: 'day', limitMicros: 999_999 }, Date.now());
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { profileId: 'cached' })))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', message: expect.stringContaining('(profile cached, day)') });
    expect(repository.findByIdempotency(record.ownerId, record.id, 'spawn-key')).toBeUndefined();
    expect(ledgerRows(store)).toBe(0);
    expect(gateway.issued).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
    await manager.stop();
  });

  it('does not apply a saved-profile policy to a static profile that shares its id', async () => {
    const { manager, record, store, spendLedger } = setup();
    spendLedger.setPolicy(record.ownerId, { profileId: 'default', period: 'day', limitMicros: 999_999 }, Date.now());
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record))).resolves.toBeDefined();
    expect(ledgerRows(store)).toBe(1);
    await manager.stop();
  });

  it('keeps the per-run cost cap validation whatever the policy allows', async () => {
    const { manager, record, store, spendLedger } = setup();
    spendLedger.setPolicy(record.ownerId, { period: 'month', limitMicros: 1_000_000_000_000 }, Date.now());
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { maxCostMicros: 1_000_001 })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'requested budget exceeds the selected profile' });
    expect(ledgerRows(store)).toBe(0);
    await manager.stop();
  });

  it('settles a cancelled run at the gateway cost, including an overrun', async () => {
    const { manager, record, repository, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    const leaseId = leaseOf(repository, record, agentId);
    expect(spendLedger.find(leaseId)).toMatchObject({ state: 'issuing', gatewayBootId: 'boot-1', reservedMicros: 1_000_000 });
    gateway.settlements.set(leaseId, { costMicros: 1_200_000, overrunCostMicros: 200_000, requests: 2 });
    await manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
    expect(spendLedger.find(leaseId)).toMatchObject({ state: 'settled', chargedMicros: 1_200_000 });
    await manager.stop();
  });

  it('charges the reservation when a request reported no usage', async () => {
    const { manager, record, repository, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    const leaseId = leaseOf(repository, record, agentId);
    gateway.settlements.set(leaseId, { costMicros: 10, requests: 3, requestsWithoutUsage: 1 });
    await manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
    expect(spendLedger.find(leaseId)).toMatchObject({ state: 'settled', chargedMicros: 1_000_000 });
    await manager.stop();
  });

  it('leaves a lease lost to a gateway restart unreconciled at its cap', async () => {
    const { manager, record, repository, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    const leaseId = leaseOf(repository, record, agentId);
    gateway.bootId = 'boot-2';
    await manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
    expect(spendLedger.find(leaseId)).toMatchObject({ state: 'unreconciled', chargedMicros: 1_000_000 });
    await manager.stop();
  });

  it('counts a run against an older gateway that returns no settlement at its cap', async () => {
    const { manager, record, repository, spendLedger } = setup();
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    const leaseId = leaseOf(repository, record, agentId);
    expect(spendLedger.find(leaseId)).toMatchObject({ state: 'issuing', gatewayBootId: null });
    await manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
    expect(spendLedger.find(leaseId)).toMatchObject({ state: 'unreconciled', chargedMicros: 1_000_000 });
    await manager.stop();
  });

  it('releases the reservation when the launch fails before the lease is issued', async () => {
    const { store, record, repository, launcher, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    const manager = new AgentManager(agentsConfig, store, {
      repository, launcher, gateway, spendLedger,
      toolExecutor: vi.fn(async () => ({ ok: true as const, message: 'read', data: {}, truncated: false })),
      repositoryGuidance: async () => { throw new Error('scan exceeded its deadline'); }
    });
    const spawned = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('FAILED'));
    expect(gateway.issued).toHaveLength(0);
    expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'released', chargedMicros: 0 });
    await manager.stop();
  });

  it('keeps the row open for retry when the revoke fails', async () => {
    const { manager, record, repository, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = await waitForRunning(manager, record);
    gateway.failRevoke = true;
    await expect(manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId })).rejects.toThrow('injected lease revoke failure');
    expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'issuing', chargedMicros: null });
    await manager.stop();
  });

  type ControlAnswer = { exitCode: number; stdout: string };
  const issuedAnswer: ControlAnswer = { exitCode: 0, stdout: JSON.stringify({ ok: true, lease: 'L'.repeat(64), gatewayBootId: 'boot-1' }) };

  /**
   * A manager on the real control client, whose gateway answers `issue` with `issueAnswer`
   * and `revoke` with `revokeAnswer(leaseId)`.
   */
  function controlClientSetup(
    issueAnswer: ControlAnswer,
    revokeAnswer: (leaseId: string) => unknown = () => ({ ok: true, revoked: false, gatewayBootId: 'boot-1' })
  ) {
    const base = setup();
    const runDocker = vi.spyOn(dockerEngine, 'runDocker').mockImplementation(async (_args, options) => {
      const command = JSON.parse(options?.stdin ?? '{}') as { operation?: string; leaseId?: string };
      if (command.operation === 'issue') return { ...issueAnswer, stderr: '' };
      if (command.operation === 'revoke') return { exitCode: 0, stdout: JSON.stringify(revokeAnswer(command.leaseId ?? '')), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, revoked: false, gatewayBootId: 'boot-1' }), stderr: '' };
    });
    const manager = new AgentManager(agentsConfig, base.store, {
      repository: base.repository, launcher: base.launcher, spendLedger: base.spendLedger, toolExecutor: base.toolExecutor,
      gateway: new DockerAgentGatewayControl('mock-gateway-container')
    });
    return { ...base, manager, runDocker };
  }

  async function spawnUntilFailed(manager: AgentManager, record: WorkspaceRecord, repository: AgentStateRepository, idempotencyKey: string): Promise<string> {
    const spawned = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey }));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('FAILED'));
    return agentId;
  }

  it('releases the reservation when the gateway explicitly refuses the lease', async () => {
    const { manager, record, repository, spendLedger, launcher, runDocker } = controlClientSetup({
      exitCode: 0, stdout: JSON.stringify({ ok: false, error: 'unknown profile' })
    });
    try {
      const agentId = await spawnUntilFailed(manager, record, repository, 'refused-spawn');
      expect(launcher.launches).toHaveLength(0);
      expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'released', chargedMicros: 0 });
      expect(spendLedger.windowTotals(record.ownerId, null, 'day', Date.now()).committedMicros).toBe(0);
    } finally {
      runDocker.mockRestore();
      await manager.stop();
    }
  });

  it('does not let repeated refused issues use up a tight daily policy', async () => {
    const { manager, record, repository, spendLedger, runDocker } = controlClientSetup({
      exitCode: 0, stdout: JSON.stringify({ ok: false, error: 'unknown profile' })
    });
    try {
      spendLedger.setPolicy(record.ownerId, { period: 'day', limitMicros: 1_000_000 }, Date.now());
      for (const key of ['refused-one', 'refused-two', 'refused-three']) await spawnUntilFailed(manager, record, repository, key);
      expect(spendLedger.windowTotals(record.ownerId, null, 'day', Date.now()).committedMicros).toBe(0);
    } finally {
      runDocker.mockRestore();
      await manager.stop();
    }
  });

  it('charges the cap as unreconciled when the issue fails in transport, because the lease may exist', async () => {
    const { manager, record, repository, spendLedger, runDocker } = controlClientSetup({ exitCode: 1, stdout: '' });
    try {
      const agentId = await spawnUntilFailed(manager, record, repository, 'transport-failure');
      expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'unreconciled', chargedMicros: 1_000_000 });
    } finally {
      runDocker.mockRestore();
      await manager.stop();
    }
  });

  it('treats an already-registered refusal as ambiguous, because the lease exists', async () => {
    const { manager, record, repository, spendLedger, runDocker } = controlClientSetup({
      exitCode: 0, stdout: JSON.stringify({ ok: false, error: 'leaseId already registered' })
    });
    try {
      const agentId = await spawnUntilFailed(manager, record, repository, 'already-registered');
      expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'unreconciled', chargedMicros: 1_000_000 });
    } finally {
      runDocker.mockRestore();
      await manager.stop();
    }
  });

  function gatewaySettlement(leaseId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      leaseId, reason: 'revoked', settledAt: 1, initialInputTokens: 10_000, initialOutputTokens: 2_000, initialCostMicros: 1_000_000,
      costMicros: 300_000, overrunCostMicros: 0, promptTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5,
      reasoningTokens: 0, requests: 1, requestsWithoutUsage: 0, ...overrides
    };
  }

  it('ends the agent and charges the cap as unreconciled when the gateway returns an invalid settlement', async () => {
    const { manager, record, repository, spendLedger, runDocker } = controlClientSetup(issuedAnswer, (leaseId) => ({
      ok: true, revoked: true, gatewayBootId: 'boot-1', settlement: gatewaySettlement(leaseId, { costMicros: -1 })
    }));
    try {
      await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
      const agentId = await waitForRunning(manager, record);
      await manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
      expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('CANCELLED');
      expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'unreconciled', chargedMicros: 1_000_000 });
    } finally {
      runDocker.mockRestore();
      await manager.stop();
    }
  });

  it('settles normally when a newer gateway adds an unknown settlement field', async () => {
    const { manager, record, repository, spendLedger, runDocker } = controlClientSetup(issuedAnswer, (leaseId) => ({
      ok: true, revoked: true, gatewayBootId: 'boot-1', settlement: gatewaySettlement(leaseId, { futureField: 'value' })
    }));
    try {
      await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
      const agentId = await waitForRunning(manager, record);
      await manager.dispatch(record.ownerId, record, 'agent_cancel', { workspaceId: record.id, agentId });
      expect(spendLedger.find(leaseOf(repository, record, agentId))).toMatchObject({ state: 'settled', chargedMicros: 300_000 });
    } finally {
      runDocker.mockRestore();
      await manager.stop();
    }
  });

  it('starts accepting spawns even when the startup spend sweep fails', async () => {
    const { manager, record, spendLedger } = setup();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listOpen = vi.spyOn(spendLedger, 'listOpen').mockImplementation(() => { throw new Error('database is locked'); });
    try {
      await expect(manager.start()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(listOpen).toHaveBeenCalled());
      await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('model spend sweep failed')));
      await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record))).resolves.toBeDefined();
    } finally {
      listOpen.mockRestore();
      await manager.stop();
      stderr.mockRestore();
    }
  });

  it('keeps sweeping the remaining rows when one settle or the prune throws', async () => {
    const { manager, record, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    const now = Date.now();
    for (const leaseId of ['lease-broken', 'lease-fine']) {
      spendLedger.admit({
        leaseId, principalId: record.ownerId, profileKey: staticProfileSpendKey('default'), revisionId: null,
        agentId: `agent_${leaseId.slice(-4).padEnd(24, 'z')}`, workspaceId: record.id, reservedMicros: 500_000, now
      });
      spendLedger.markIssuing(leaseId);
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const settle = spendLedger.settle.bind(spendLedger);
    vi.spyOn(spendLedger, 'settle').mockImplementation((leaseId, ...rest) => {
      if (leaseId === 'lease-broken') throw new Error('disk I/O error');
      return settle(leaseId, ...rest);
    });
    vi.spyOn(spendLedger, 'prune').mockImplementation(() => { throw new Error('disk I/O error'); });
    try {
      await expect(manager.start()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(spendLedger.find('lease-fine')).toMatchObject({ state: 'unreconciled' }));
      expect(spendLedger.find('lease-broken')).toMatchObject({ state: 'issuing' });
      await vi.waitFor(() => expect(stderr.mock.calls.filter(([line]) => String(line).includes('model spend sweep failed'))).toHaveLength(2));
    } finally {
      vi.restoreAllMocks();
      await manager.stop();
    }
  });

  it('settles orphaned rows on runner restart', async () => {
    const { manager, record, repository, gateway, spendLedger } = setup();
    gateway.bootId = 'boot-1';
    const now = Date.now();
    // A run whose agent reached a terminal state before its lease was settled, as after a crash.
    const reservation = reservationForManager(record, 'orphan', now);
    repository.reserveSpawn({
      ...reservation,
      admit: () => {
        spendLedger.admit({
          leaseId: reservation.gatewayLeaseId, principalId: record.ownerId, profileKey: staticProfileSpendKey('default'), revisionId: null,
          agentId: reservation.id, workspaceId: record.id, reservedMicros: 1_000_000, now
        });
      }
    });
    spendLedger.markIssuing(reservation.gatewayLeaseId);
    spendLedger.recordGatewayBoot(reservation.gatewayLeaseId, 'boot-1');
    repository.transitionStatus({
      ownerId: record.ownerId, workspaceId: record.id, agentId: reservation.id, generation: 1,
      expectedStatuses: ['SPAWNING'], status: 'FAILED', now, terminalReason: 'runner crashed'
    });
    gateway.settlements.set(reservation.gatewayLeaseId, { costMicros: 250_000 });
    // A row whose agent record is gone and whose lease the gateway no longer knows.
    spendLedger.admit({
      leaseId: 'lease-gone', principalId: record.ownerId, profileKey: staticProfileSpendKey('default'), revisionId: null,
      agentId: `agent_${'g'.repeat(24)}`, workspaceId: record.id, reservedMicros: 500_000, now
    });
    spendLedger.markIssuing('lease-gone');
    await manager.start();
    // The startup sweep runs in the background, after admission opens.
    await vi.waitFor(() => {
      expect(spendLedger.find('lease-gone')?.state).not.toBe('issuing');
      expect(spendLedger.find(reservation.gatewayLeaseId)?.state).not.toBe('issuing');
    });
    expect(gateway.revoked).toEqual(expect.arrayContaining([reservation.gatewayLeaseId, 'lease-gone']));
    expect(spendLedger.find(reservation.gatewayLeaseId)).toMatchObject({ state: 'settled', chargedMicros: 250_000 });
    expect(spendLedger.find('lease-gone')).toMatchObject({ state: 'unreconciled', chargedMicros: 500_000 });
    await manager.stop();
  });

  it('starts no spend sweep from a reap that finishes after stop', async () => {
    const { manager, spendLedger } = setup();
    await manager.start();
    await manager.stop();
    const listOpen = vi.spyOn(spendLedger, 'listOpen');
    try {
      // The tail of a reap that was already running when stop() was called, with a sweep due.
      const internals = manager as unknown as { lastSpendSweepAt: number; reap(): Promise<void> };
      internals.lastSpendSweepAt = 0;
      await internals.reap();
      expect(listOpen).not.toHaveBeenCalled();
    } finally {
      listOpen.mockRestore();
    }
  });

  it('logs the first admission that reaches a policy warning threshold', async () => {
    const { manager, record, spendLedger, spendLog } = setup();
    spendLedger.setPolicy(record.ownerId, { period: 'month', limitMicros: 2_000_000, warnPercent: 50 }, Date.now());
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    expect(spendLog).toHaveBeenCalledTimes(1);
    expect(spendLog).toHaveBeenCalledWith(expect.objectContaining({ msg: 'model spend threshold reached', principalId: record.ownerId, period: 'month' }));
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    expect(spendLog).toHaveBeenCalledTimes(1);
    await manager.stop();
  });
});

describe('agent repository guidance bootstrap', () => {
  function guidedSetup(repositoryGuidance: ConstructorParameters<typeof AgentManager>[2]['repositoryGuidance'], config = agentsConfig) {
    const directory = mkdtempSync(join(tmpdir(), 'agent-manager-guidance-'));
    directories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const record = workspace('network-none', ownerId);
    store.create(record);
    const repository = new AgentStateRepository(store.database, config.limits);
    const launcher = new FakeLauncher();
    const gateway = new FakeGateway();
    const toolExecutor = vi.fn(async () => ({ ok: true as const, message: 'read', data: {}, truncated: false }));
    const manager = new AgentManager(config, store, { repository, launcher, gateway, toolExecutor, repositoryGuidance });
    return { store, record, repository, launcher, gateway, manager };
  }

  it('fails closed before any lease or container exists when the guidance scan fails', async () => {
    const { manager, record, repository, launcher, gateway } = guidedSetup(async () => { throw new Error('scan exceeded its deadline'); });
    const spawned = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('FAILED'));
    expect(gateway.issued).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
    const agent = repository.findAgent(record.ownerId, record.id, agentId)!;
    expect(`${agent.cleanupReason ?? ''} ${agent.terminalReason ?? ''}`).toContain('repositoryContext "none"');
    await manager.stop();
  });

  it('keeps a small output budget for the agent instead of ending it on the guidance report', async () => {
    const items = Array.from({ length: 8 }, (_, index) => {
      const content = `rule ${index}`;
      return {
        kind: 'instruction', path: `.claude/rules/rule-${index}.md`, format: 'claude', clients: ['claude'],
        contentSha256: createHash('sha256').update(content).digest('hex'), byteCount: content.length, content
      };
    });
    const snapshot = buildRepositoryGuidanceSnapshot({ items, warnings: [], truncated: false });
    const { manager, record, repository, launcher } = guidedSetup(async () => ({ snapshot, reused: false }));
    const spawned = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { repositoryContext: 'claude', maxOutputBytes: 1_024 }));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(launcher.inputs).toHaveLength(1));
    const agent = repository.findAgent(record.ownerId, record.id, agentId)!;
    expect(agent.status).toBe('RUNNING');
    expect(repository.readLogs(record.ownerId, record.id, agentId, agent.generation, '0', 1_024).events
      .every((event) => Buffer.byteLength(event.content) <= 256)).toBe(true);
    await manager.stop();
  });

  it('records only counts when the injected-document report would exceed the log event bound', async () => {
    const items = Array.from({ length: 60 }, (_, index) => {
      const content = `rule ${index}`;
      return {
        kind: 'instruction', path: `.claude/rules/${'r'.repeat(200)}-${index}.md`, format: 'claude', clients: ['claude'],
        contentSha256: createHash('sha256').update(content).digest('hex'), byteCount: content.length, content
      };
    });
    const snapshot = buildRepositoryGuidanceSnapshot({ items, warnings: [], truncated: false });
    const config = RunnerAgentsConfigSchema.parse({ ...agentsConfig, limits: { ...agentsConfig.limits, maxLogEventBytes: 4_096 } });
    const { manager, record, repository, launcher } = guidedSetup(async () => ({ snapshot, reused: true }), config);
    const spawned = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { repositoryContext: 'claude' }));
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(launcher.inputs).toHaveLength(1));
    const agent = repository.findAgent(record.ownerId, record.id, agentId)!;
    const page = repository.readLogs(record.ownerId, record.id, agentId, agent.generation, '0', 262_144);
    const report = JSON.parse(page.events.find((event) => event.type === 'repository_context')!.content) as Record<string, unknown>;
    expect(report).toMatchObject({ profile: 'claude', listsOmitted: true, snapshotReused: true, snapshotDigest: snapshot.digest, truncated: true });
    // The profile's input budget bounds the injected guidance, so the remainder is reported as skipped.
    expect((report.injected as number) + (report.skipped as number)).toBe(60);
    // The gateway charges one input token per body byte on every turn, so guidance and task stay
    // within a quarter of the input budget.
    expect((report.injectedBytes as number) + Buffer.byteLength('inspect the repository')).toBeLessThanOrEqual(2_500);
    expect(report.skipped as number).toBeGreaterThan(0);
    await manager.stop();
  });
  describe('start record pricing', () => {
    // The start record is the first protocol line the runner writes to the agent.
    async function startRecordCost(launcher: FakeLauncher): Promise<Record<string, number>> {
      await vi.waitFor(() => expect(launcher.inputs).toHaveLength(1));
      let line: string | undefined;
      await vi.waitFor(() => {
        const buffered = launcher.inputs[0]!.read() as Buffer | null;
        line = buffered?.toString('utf8').split('\n').find((candidate) => candidate.includes('"type":"start"'));
        expect(line).toBeDefined();
      });
      return (JSON.parse(line!) as { model: { cost: Record<string, number> } }).model.cost;
    }

    it('reports a static profile\'s unknown cache prices at its input price, as the gateway charges them', async () => {
      const { manager, record, launcher } = setup();
      await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
      expect(await startRecordCost(launcher)).toEqual({ input: 0.000001, output: 0.000001, cacheRead: 0.000001, cacheWrite: 0.000001 });
      await manager.stop();
    });

    it('reports the configured cache prices of a static profile', async () => {
      const config = RunnerAgentsConfigSchema.parse({
        ...agentsConfig,
        profiles: [{ ...agentsConfig.profiles[0]!, provider: 'openai', inputMicrosPerMillionTokens: 2_000_000, cacheReadMicrosPerMillionTokens: 500_000 }]
      });
      const { manager, record, launcher } = setup('network-none', config);
      await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
      expect(await startRecordCost(launcher)).toEqual({ input: 2, output: 0.000001, cacheRead: 0.5, cacheWrite: 2 });
      await manager.stop();
    });

    it('reports a saved profile revision\'s effective cache prices instead of zero', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agent-manager-pricing-'));
      directories.push(directory);
      const store = new StateStore(join(directory, 'state.db'));
      openStores.push(store);
      const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
      const record = workspace('network-none', ownerId);
      store.create(record);
      const modelProfiles = createCachedProfile(store, ownerId);
      const launcher = new FakeLauncher();
      const manager = new AgentManager(agentsConfig, store, {
        repository: new AgentStateRepository(store.database, agentsConfig.limits),
        launcher,
        gateway: new FakeGateway(),
        toolExecutor: vi.fn(async () => ({ ok: true as const, message: 'read', data: {}, truncated: false })),
        modelProfiles
      });
      await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { profileId: 'cached' }));
      // OpenAI bills no cache-write premium, so the unknown write costs the input price. A lookup
      // that missed the credential would resolve as custom and report twice that.
      expect(await startRecordCost(launcher)).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
      await manager.stop();
    });
  });
});

describe('AgentManager persisted sessions', () => {
  const persistingConfig = RunnerAgentsConfigSchema.parse({ ...agentsConfig, sessionPersistenceEnabled: true });
  const twoProfileConfig = RunnerAgentsConfigSchema.parse({
    ...persistingConfig,
    profiles: [...persistingConfig.profiles, { ...persistingConfig.profiles[0]!, id: 'other', displayName: 'Other' }]
  });
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 };
  const userMessage = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
  const assistantCall = { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'files_read', arguments: { path: 'README.md' } }], stopReason: 'toolUse', timestamp: 2 };
  const toolResult = { role: 'toolResult', toolCallId: 'call-1', toolName: 'files_read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 };

  function emit(launcher: FakeLauncher, index: number, record: Record<string, unknown>): void {
    launcher.outputs[index]!.write(`${JSON.stringify(record)}\n`);
  }

  /** Collects every protocol line the runner writes to one agent, from its first byte. */
  function captureInput(launcher: FakeLauncher, index: number): () => Array<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    launcher.inputs[index]!.on('data', (chunk: Buffer) => chunks.push(chunk));
    return () => Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async function startOf(launcher: FakeLauncher, index: number): Promise<Record<string, unknown>> {
    await vi.waitFor(() => expect(launcher.inputs.length).toBeGreaterThan(index));
    const lines = captureInput(launcher, index);
    let start: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      start = lines().find((record) => record.type === 'start');
      expect(start).toBeDefined();
    });
    return start!;
  }

  async function spawnRunning(
    context: ReturnType<typeof setup>,
    idempotencyKey: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const { manager, record, repository } = context;
    const response = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey, ...overrides }));
    const agentId = (response.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING'));
    return agentId;
  }

  async function finish(context: ReturnType<typeof setup>, index: number, agentId: string, state = 'SUCCEEDED'): Promise<void> {
    emit(context.launcher, index, { type: 'terminal', state, usage });
    await vi.waitFor(() => expect(context.repository.findAgent(context.record.ownerId, context.record.id, agentId)?.status).toBe(state));
  }

  async function status(context: ReturnType<typeof setup>, agentId: string): Promise<Record<string, unknown>> {
    const response = await context.manager.dispatch(context.record.ownerId, context.record, 'agent_status', { workspaceId: context.record.id, agentId });
    return response.data as Record<string, unknown>;
  }

  /** Runs one persisting agent that records a user turn and an unanswered tool call, then ends. */
  async function sealedPredecessor(context: ReturnType<typeof setup>, state = 'SUCCEEDED'): Promise<string> {
    const agentId = await spawnRunning(context, 'first-key');
    emit(context.launcher, 0, { type: 'session_message', seq: 0, message: userMessage('inspect the repository') });
    emit(context.launcher, 0, { type: 'session_message', seq: 1, message: assistantCall });
    await vi.waitFor(() => expect(context.repository.findSession(agentId)?.messageCount).toBe(2));
    await finish(context, 0, agentId, state);
    return agentId;
  }

  it('leaves the start record and status unchanged when session persistence is off', async () => {
    const context = setup();
    const { manager, record, launcher, repository } = context;
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const start = await startOf(launcher, 0);
    expect(Object.keys(start)).toEqual(['type', 'requestId', 'agentId', 'prompt', 'tools', 'gateway', 'model', 'limits']);
    const agentId = start.agentId as string;
    expect(repository.findSession(agentId)).toBeUndefined();
    emit(launcher, 0, { type: 'session_message', seq: 0, message: userMessage('ignored') });
    await finish(context, 0, agentId);
    const data = await status(context, agentId);
    expect(data).not.toHaveProperty('session');
    expect(data).not.toHaveProperty('run');
    expect(data).not.toHaveProperty('continuedFrom');
    expect((context.store.database.prepare('SELECT COUNT(*) AS count FROM agent_session_messages').get() as { count: number }).count).toBe(0);
    await manager.stop();
  });

  it('refuses continueFrom when session persistence is off', async () => {
    const { manager, record, launcher } = setup();
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { continueFrom: `agent_${'a'.repeat(24)}` })))
      .rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(launcher.launches).toHaveLength(0);
    await manager.stop();
  });

  it('persists runtime messages with a chained digest and seals the session on terminal', async () => {
    const context = setup('network-none', persistingConfig);
    const { manager, record, launcher, repository } = context;
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record));
    const start = await startOf(launcher, 0);
    // A fresh persisting agent receives an empty log so it knows to report its messages.
    expect(start.session).toEqual({ messages: [], headSha256: AGENT_SESSION_GENESIS_SHA256 });
    const agentId = start.agentId as string;
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING'));
    const messages = [userMessage('inspect the repository'), assistantCall, toolResult];
    messages.forEach((message, seq) => emit(launcher, 0, { type: 'session_message', seq, message }));
    await vi.waitFor(() => expect(repository.findSession(agentId)?.messageCount).toBe(3));
    const log = repository.loadSessionLog(agentId, 1);
    expect(log.messages).toEqual(messages);
    const head = messages.reduce(
      (previous, message) => chainAgentSessionHead(previous, createHash('sha256').update(JSON.stringify(message)).digest('hex')),
      AGENT_SESSION_GENESIS_SHA256
    );
    expect(log.headSha256).toBe(head);
    expect(await status(context, agentId)).toMatchObject({
      session: { persisted: true, continuable: false, messages: 3 }, run: { resumable: false }, continuedFrom: null
    });
    await finish(context, 0, agentId);
    const sealed = repository.findSession(agentId)!;
    expect(sealed).toMatchObject({ state: 'SEALED', continuable: true });
    expect(sealed.retainUntil).toBeGreaterThan(Date.now());
    expect(await status(context, agentId)).toMatchObject({ session: { persisted: true, continuable: true, messages: 3, bytes: log.bytes } });
    // A record arriving after the terminal transition is fenced.
    emit(launcher, 0, { type: 'session_message', seq: 3, message: userMessage('late') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repository.findSession(agentId)?.messageCount).toBe(3);
    await manager.stop();
  });

  it('fences appends from a stale runner epoch, a stale generation, or a stopped agent', async () => {
    const context = setup('network-none', persistingConfig);
    const { record, repository } = context;
    const agentId = await spawnRunning(context, 'fence-key');
    const append = (overrides: Partial<Parameters<AgentStateRepository['appendSessionMessage']>[0]>) => repository.appendSessionMessage({
      ownerId: record.ownerId, workspaceId: record.id, agentId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('task'), now: Date.now(), ...overrides
    });
    expect(append({ runnerEpoch: 2 })).toBe('FENCED');
    expect(append({ generation: 2 })).toBe('FENCED');
    expect(append({ ownerId: 'someone-else' })).toBe('FENCED');
    expect(repository.findSession(agentId)).toMatchObject({ messageCount: 0, continuable: true });
    expect(append({})).toBe('APPENDED');
    await finish(context, 0, agentId);
    expect(append({ seq: 1 })).toBe('FENCED');
    expect(repository.findSession(agentId)?.messageCount).toBe(1);
    await context.manager.stop();
  });

  it('marks the session not continuable on a sequence gap or an invalid message without failing the run', async () => {
    const context = setup('network-none', persistingConfig);
    const { record, repository } = context;
    const agentId = await spawnRunning(context, 'gap-key-1');
    const append = (seq: number, message: unknown) => repository.appendSessionMessage({
      ownerId: record.ownerId, workspaceId: record.id, agentId, generation: 1, runnerEpoch: 1, seq, message, now: Date.now()
    });
    expect(append(0, { role: 'bashExecution', command: 'ls' })).toBe('DISCONTINUED');
    expect(append(0, userMessage('task'))).toBe('IGNORED');
    expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING');

    const second = setup('network-none', persistingConfig);
    const secondId = await spawnRunning(second, 'gap-key-1');
    expect(second.repository.appendSessionMessage({
      ownerId: second.record.ownerId, workspaceId: second.record.id, agentId: secondId, generation: 1, runnerEpoch: 1,
      seq: 1, message: userMessage('skipped one'), now: Date.now()
    })).toBe('DISCONTINUED');
    await finish(second, 0, secondId);
    expect(await status(second, secondId)).toMatchObject({ session: { persisted: true, continuable: false, messages: 0 } });
    await context.manager.stop();
    await second.manager.stop();
  });

  it('keeps the run going but stops continuation when the session exceeds its bounds', async () => {
    const config = RunnerAgentsConfigSchema.parse({ ...persistingConfig, limits: { ...persistingConfig.limits, maxSessionMessages: 1 } });
    const context = setup('network-none', config);
    const { manager, record, launcher, repository } = context;
    const agentId = await spawnRunning(context, 'bounded-key');
    emit(launcher, 0, { type: 'session_message', seq: 0, message: userMessage('task') });
    emit(launcher, 0, { type: 'session_message', seq: 1, message: assistantCall });
    await vi.waitFor(() => expect(repository.findSession(agentId)?.continuable).toBe(false));
    expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING');
    await finish(context, 0, agentId);
    expect(await status(context, agentId)).toMatchObject({ session: { persisted: true, continuable: false, messages: 1 } });
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey: 'next-key', continueFrom: agentId })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await manager.stop();
  });

  it('continues a sealed session in a new agent that replays the exact log', async () => {
    const context = setup('network-none', persistingConfig);
    const { manager, record, launcher, repository, gateway } = context;
    const predecessorId = await sealedPredecessor(context);
    const predecessorLog = repository.loadSessionLog(predecessorId, 1);
    const response = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'continue-key', prompt: 'now fix the failing test', continueFrom: predecessorId
    }));
    const successorId = (response.data as { agentId: string }).agentId;
    expect(successorId).not.toBe(predecessorId);
    const start = await startOf(launcher, 1);
    expect(start.agentId).toBe(successorId);
    expect(start.session).toEqual({ messages: [userMessage('inspect the repository'), assistantCall], headSha256: predecessorLog.headSha256 });
    // A new agent gets its own container and lease.
    expect(launcher.launches[1]!.containerName).not.toBe(launcher.launches[0]!.containerName);
    expect(gateway.issued[1]!.leaseId).not.toBe(gateway.issued[0]!.leaseId);
    await vi.waitFor(() => expect(repository.findAgent(record.ownerId, record.id, successorId)?.status).toBe('RUNNING'));
    expect(repository.findSession(successorId)).toMatchObject({
      continuedFrom: predecessorId, rootAgentId: predecessorId, messageCount: 2, headSha256: predecessorLog.headSha256, state: 'ACTIVE'
    });
    // The successor's own log continues after the copied messages.
    emit(launcher, 1, { type: 'session_message', seq: 2, message: userMessage('now fix the failing test') });
    await vi.waitFor(() => expect(repository.findSession(successorId)?.messageCount).toBe(3));
    expect(await status(context, successorId)).toMatchObject({ continuedFrom: predecessorId, run: { resumable: false } });
    // The predecessor's log is untouched.
    expect(repository.loadSessionLog(predecessorId, 1).headSha256).toBe(predecessorLog.headSha256);
    // Replaying the same spawn returns the same successor instead of refusing it.
    const replayed = await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'continue-key', prompt: 'now fix the failing test', continueFrom: predecessorId
    }));
    expect(replayed.data).toMatchObject({ agentId: successorId, replayed: true });
    await manager.stop();
  });

  it('refuses at admission a continuation whose replayed session and prompt cannot fit one start record', async () => {
    const config = RunnerAgentsConfigSchema.parse({ ...persistingConfig, limits: { ...persistingConfig.limits, maxSessionBytes: 7_864_320 } });
    const context = setup('network-none', config);
    const { manager, record, launcher, repository } = context;
    const predecessorId = await spawnRunning(context, 'large-key');
    expect(repository.appendSessionMessage({
      ownerId: record.ownerId, workspaceId: record.id, agentId: predecessorId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('x'.repeat(7_800_000)), now: Date.now()
    })).toBe('APPENDED');
    await finish(context, 0, predecessorId);
    expect(repository.findSession(predecessorId)).toMatchObject({ state: 'SEALED', continuable: true });
    // Control characters are escaped to six bytes each, so this prompt fits the prompt limit but not the record.
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'too-large-key', prompt: '\u0001'.repeat(100_000), continueFrom: predecessorId
    }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(launcher.launches).toHaveLength(1);
    // The predecessor stays continuable, and a prompt that fits is admitted and launched.
    expect(repository.findSession(predecessorId)).toMatchObject({ continuable: true });
    await manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'fits-key', prompt: 'continue', continueFrom: predecessorId
    }));
    const start = await startOf(launcher, 1);
    expect(Buffer.byteLength(JSON.stringify(start), 'utf8')).toBeLessThanOrEqual(8 * 1024 * 1024);
    await manager.stop();
  });

  // One session may not be allowed more than the smallest budget, so the per-session bound follows it.
  const sessionBudgetConfig = (limits: Record<string, number>) => RunnerAgentsConfigSchema.parse({
    ...persistingConfig, limits: { ...persistingConfig.limits, maxSessionBytes: Math.min(...Object.values(limits)), ...limits }
  });
  const messageBytes = (...messages: unknown[]) => messages.reduce<number>((total, message) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'), 0);

  it('keeps the run going but stops recording when the workspace session byte budget would be exceeded', async () => {
    const context = setup('network-none', sessionBudgetConfig({ workspaceSessionBytes: messageBytes(userMessage('task'), assistantCall) - 1 }));
    const { record, launcher, repository } = context;
    const agentId = await spawnRunning(context, 'budget-key');
    emit(launcher, 0, { type: 'session_message', seq: 0, message: userMessage('task') });
    emit(launcher, 0, { type: 'session_message', seq: 1, message: assistantCall });
    await vi.waitFor(() => expect(repository.findSession(agentId)?.continuable).toBe(false));
    expect(repository.findSession(agentId)).toMatchObject({ messageCount: 1, bytes: messageBytes(userMessage('task')) });
    expect(repository.findAgent(record.ownerId, record.id, agentId)?.status).toBe('RUNNING');
    await finish(context, 0, agentId);
    expect(await status(context, agentId)).toMatchObject({ session: { persisted: true, continuable: false, messages: 1 } });
    await context.manager.stop();
  });

  it('refuses a continuation whose copied log would exceed the workspace session byte budget', async () => {
    const logBytes = messageBytes(userMessage('inspect the repository'), assistantCall);
    const context = setup('network-none', sessionBudgetConfig({ workspaceSessionBytes: logBytes * 2 - 1 }));
    const { manager, record, launcher, repository } = context;
    const predecessorId = await sealedPredecessor(context);
    expect(repository.findSession(predecessorId)).toMatchObject({ bytes: logBytes, continuable: true });
    const refused = manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey: 'over-budget-key', continueFrom: predecessorId }));
    await expect(refused).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', retryable: false });
    await expect(refused).rejects.toThrow(/workspace session byte budget/);
    expect(launcher.launches).toHaveLength(1);
    expect(repository.findAgent(record.ownerId, record.id, predecessorId)?.status).toBe('SUCCEEDED');
    expect(repository.findSuccessor(predecessorId)).toBeUndefined();
    // Nothing was reserved, so the predecessor stays continuable once the budget allows the copy.
    expect(repository.findSession(predecessorId)).toMatchObject({ state: 'SEALED', continuable: true });
    expect((context.store.database.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM agent_sessions').get() as { bytes: number }).bytes).toBe(logBytes);
    await manager.stop();
  });

  it('counts every workspace of a principal against its session byte budget', async () => {
    const firstBytes = messageBytes(userMessage('task'));
    const context = setup('network-none', sessionBudgetConfig({ principalSessionBytes: firstBytes * 2 - 1, workspaceSessionBytes: firstBytes * 2 - 1 }));
    const { manager, record, repository, store } = context;
    const firstId = await spawnRunning(context, 'principal-key-1');
    expect(repository.appendSessionMessage({
      ownerId: record.ownerId, workspaceId: record.id, agentId: firstId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('task'), now: Date.now()
    })).toBe('APPENDED');
    const other = { ...workspace('network-none', record.ownerId), id: `ws_${'v'.repeat(24)}`, idempotencyKey: 'workspace-key-2' };
    store.create(other);
    const response = await manager.dispatch(other.ownerId, other, 'agent_spawn', spawnInput(other, { idempotencyKey: 'principal-key-2' }));
    const secondId = (response.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(other.ownerId, other.id, secondId)?.status).toBe('RUNNING'));
    // The other workspace holds nothing yet, but the principal's total would pass its budget.
    expect(repository.appendSessionMessage({
      ownerId: other.ownerId, workspaceId: other.id, agentId: secondId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('task'), now: Date.now()
    })).toBe('DISCONTINUED');
    expect(repository.findSession(secondId)).toMatchObject({ messageCount: 0, bytes: 0, continuable: false });
    await manager.stop();
  });

  it('counts every principal against the instance session byte budget', async () => {
    const bytes = messageBytes(userMessage('task'));
    const context = setup('network-none', sessionBudgetConfig({ workspaceSessionBytes: bytes, principalSessionBytes: bytes, globalSessionBytes: bytes * 2 - 1 }));
    const { manager, record, repository, store } = context;
    const firstId = await spawnRunning(context, 'instance-key-1');
    expect(repository.appendSessionMessage({
      ownerId: record.ownerId, workspaceId: record.id, agentId: firstId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('task'), now: Date.now()
    })).toBe('APPENDED');
    const otherOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'other-owner' });
    const other = { ...workspace('network-none', otherOwner), id: `ws_${'u'.repeat(24)}`, idempotencyKey: 'workspace-key-3' };
    store.create(other);
    const response = await manager.dispatch(other.ownerId, other, 'agent_spawn', spawnInput(other, { idempotencyKey: 'instance-key-2' }));
    const secondId = (response.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(repository.findAgent(other.ownerId, other.id, secondId)?.status).toBe('RUNNING'));
    expect(repository.appendSessionMessage({
      ownerId: other.ownerId, workspaceId: other.id, agentId: secondId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('task'), now: Date.now()
    })).toBe('DISCONTINUED');
    await manager.stop();
  });

  it('frees the session byte budget once retention purges the stored logs', async () => {
    const logBytes = messageBytes(userMessage('inspect the repository'), assistantCall);
    const context = setup('network-none', sessionBudgetConfig({ workspaceSessionBytes: logBytes * 2 - 1 }));
    const { manager, record, repository } = context;
    const firstId = await sealedPredecessor(context);
    const secondId = await spawnRunning(context, 'second-key');
    const append = () => repository.appendSessionMessage({
      ownerId: record.ownerId, workspaceId: record.id, agentId: secondId, generation: 1, runnerEpoch: 1, seq: 0,
      message: userMessage('x'.repeat(logBytes)), now: Date.now()
    });
    // A sealed log keeps counting until it is purged.
    expect(repository.purgeExpiredSessions(Date.now())).toBe(0);
    expect(repository.findSession(firstId)).toMatchObject({ state: 'SEALED', bytes: logBytes });
    expect(repository.purgeExpiredSessions(Date.now() + persistingConfig.limits.sessionRetentionMs + 1)).toBe(1);
    expect(repository.findSession(firstId)).toMatchObject({ state: 'PURGED', bytes: 0 });
    expect(append()).toBe('APPENDED');
    await manager.stop();
  });

  it('lets exactly one of two concurrent continuations win', async () => {
    const context = setup('network-none', persistingConfig);
    const { manager, record } = context;
    const predecessorId = await sealedPredecessor(context);
    const results = await Promise.allSettled(['race-key-a', 'race-key-b'].map((idempotencyKey) =>
      manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey, continueFrom: predecessorId }))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'CONFLICT' });
    await manager.stop();
  });

  it('keeps an interrupted session continuable while the run itself is never resumable', async () => {
    const context = setup('network-none', persistingConfig);
    const predecessorId = await sealedPredecessor(context, 'INTERRUPTED');
    expect(await status(context, predecessorId)).toMatchObject({
      status: 'INTERRUPTED', session: { persisted: true, continuable: true, messages: 2 }, run: { resumable: false }
    });
    const response = await context.manager.dispatch(context.record.ownerId, context.record, 'agent_spawn', spawnInput(context.record, {
      idempotencyKey: 'after-interrupt', continueFrom: predecessorId
    }));
    expect(response.data).toMatchObject({ replayed: false });
    await context.manager.stop();
  });

  it('refuses to continue a running agent', async () => {
    const context = setup('network-none', persistingConfig);
    const agentId = await spawnRunning(context, 'running-key');
    await expect(context.manager.dispatch(context.record.ownerId, context.record, 'agent_spawn', spawnInput(context.record, {
      idempotencyKey: 'too-early', continueFrom: agentId
    }))).rejects.toMatchObject({ code: 'CONFLICT', retryable: true });
    await context.manager.stop();
  });

  it('refuses to continue another owner\'s agent or one from an earlier workspace generation', async () => {
    const context = setup('network-none', persistingConfig);
    const { manager, record, repository, store } = context;
    const predecessorId = await sealedPredecessor(context);
    const otherOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'other-owner' });
    const otherWorkspace: WorkspaceRecord = { ...workspace('network-none', otherOwner), id: `ws_${'o'.repeat(24)}`, idempotencyKey: 'other-workspace' };
    store.create(otherWorkspace);
    await expect(manager.dispatch(otherOwner, otherWorkspace, 'agent_spawn', spawnInput(otherWorkspace, { continueFrom: predecessorId })))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => repository.requireContinuable(record.ownerId, record.id, record.generation + 1, predecessorId))
      .toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }));
    await manager.stop();
  });

  it('refuses to continue a session purged by retention', async () => {
    const context = setup('network-none', persistingConfig);
    const { manager, record, repository } = context;
    const predecessorId = await sealedPredecessor(context);
    const sealed = repository.findSession(predecessorId)!;
    expect(repository.purgeExpiredSessions(sealed.retainUntil! - 1)).toBe(0);
    expect(repository.purgeExpiredSessions(sealed.retainUntil!)).toBe(1);
    expect(await status(context, predecessorId)).toMatchObject({ session: { persisted: false, continuable: false, messages: 0, bytes: 0 } });
    expect((context.store.database.prepare('SELECT COUNT(*) AS count FROM agent_session_messages WHERE agent_id=?').get(predecessorId) as { count: number }).count).toBe(0);
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, { idempotencyKey: 'after-purge', continueFrom: predecessorId })))
      .rejects.toMatchObject({ code: 'EXPIRED' });
    await manager.stop();
  });

  it('refuses to continue an agent whose model profile is no longer enabled', async () => {
    const context = setup('network-none', persistingConfig);
    const { store, record, repository } = context;
    const predecessorId = await sealedPredecessor(context);
    await context.manager.stop();
    repository.openWorkspaceAdmission(record.ownerId, record.id, record.generation, Date.now());
    // The instance now offers a different profile only.
    const config = RunnerAgentsConfigSchema.parse({
      ...persistingConfig,
      profiles: [{ ...persistingConfig.profiles[0]!, id: 'replacement', displayName: 'Replacement' }]
    });
    const launcher = new FakeLauncher();
    const manager = new AgentManager(config, store, {
      repository, launcher, gateway: new FakeGateway(), spendLedger: new ModelSpendLedger(store.database, { log: vi.fn() }),
      toolExecutor: vi.fn(async () => ({ ok: true as const, message: 'read', data: {}, truncated: false }))
    });
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'other-profile', profileId: 'replacement', continueFrom: predecessorId
    }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('no longer enabled') });
    expect(launcher.launches).toHaveLength(0);
    expect(repository.findSuccessor(predecessorId)).toBeUndefined();
    await manager.stop();
  });

  it('runs a continuation on the predecessor\'s profile when profileId is omitted', async () => {
    const context = setup('network-none', twoProfileConfig);
    const { manager, record, launcher, repository } = context;
    const predecessorId = await sealedPredecessor(context);
    const input: Record<string, unknown> = spawnInput(record, { idempotencyKey: 'inherit-key', continueFrom: predecessorId });
    delete input.profileId;
    const response = await manager.dispatch(record.ownerId, record, 'agent_spawn', input);
    const successorId = (response.data as { agentId: string }).agentId;
    const start = await startOf(launcher, 1);
    expect(start.agentId).toBe(successorId);
    expect(repository.findAgent(record.ownerId, record.id, successorId)?.profileId).toBe('default');
    await manager.stop();
  });

  it('refuses a continuation on a different profile than its predecessor', async () => {
    const context = setup('network-none', twoProfileConfig);
    const { manager, record, launcher, repository } = context;
    const predecessorId = await sealedPredecessor(context);
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'mismatch-key', profileId: 'other', continueFrom: predecessorId
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('model profile of the agent it continues') });
    expect(launcher.launches).toHaveLength(1);
    expect(repository.findSuccessor(predecessorId)).toBeUndefined();
    // Naming the predecessor's own profile explicitly is accepted.
    await expect(manager.dispatch(record.ownerId, record, 'agent_spawn', spawnInput(record, {
      idempotencyKey: 'same-profile-key', profileId: 'default', continueFrom: predecessorId
    }))).resolves.toMatchObject({ data: { replayed: false } });
    await manager.stop();
  });

  it('deletes persisted sessions when the workspace closes but keeps them across a runner stop', async () => {
    const context = setup('network-none', persistingConfig);
    const { manager, record, repository, store } = context;
    const predecessorId = await sealedPredecessor(context);
    await manager.stop();
    expect(repository.findSession(predecessorId)).toMatchObject({ state: 'SEALED', continuable: true, messageCount: 2 });
    await manager.stopWorkspace(record.ownerId, record.id, 'workspace closed');
    expect(repository.findSession(predecessorId)).toBeUndefined();
    expect((store.database.prepare('SELECT COUNT(*) AS count FROM agent_session_messages').get() as { count: number }).count).toBe(0);
  });
});
