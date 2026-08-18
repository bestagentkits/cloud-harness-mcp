import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerAgentLimitsSchema, type AgentBudget, type RunnerAgentLimits } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStateRepository, type AgentSpawnReservation } from '../src/agent-state-repository.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

const budget: AgentBudget = {
  ttlSeconds: 30,
  maxOutputBytes: 262_144,
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxCostMicros: 1_000_000
};

function limits(overrides: Partial<RunnerAgentLimits> = {}): RunnerAgentLimits {
  return RunnerAgentLimitsSchema.parse(overrides);
}

function workspace(ownerId = 'owner', networkMode: WorkspaceRecord['networkMode'] = 'none'): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws_${ownerId === 'owner' ? 'w' : 'x'.repeat(1)}`.padEnd(27, 'w'),
    ownerId,
    idempotencyKey: `workspace-${ownerId}`,
    repositoryUrl: 'https://github.com/example/repository.git',
    repositoryRef: null,
    containerName: 'executor',
    workspacePath: `/tmp/${ownerId}`,
    status: 'ACTIVE',
    networkMode,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 600_000,
    generation: 1,
    error: null
  };
}

function reservation(workspaceRecord: WorkspaceRecord, suffix = 'a', overrides: Partial<AgentSpawnReservation> = {}): AgentSpawnReservation {
  const now = Date.now();
  return {
    id: `agent_${suffix.repeat(24)}`,
    ownerId: workspaceRecord.ownerId,
    workspaceId: workspaceRecord.id,
    workspaceGeneration: workspaceRecord.generation,
    idempotencyKey: `spawn-${suffix.repeat(8)}`,
    payloadHash: suffix.repeat(64),
    promptHash: suffix.repeat(64),
    profileId: 'default',
    proxyOperations: ['files_read', 'files_apply_patch'],
    budget,
    containerName: `agent-${suffix}`,
    networkName: `agent-net-${suffix}`,
    gatewayLeaseId: `lease-${suffix}`,
    now,
    expiresAt: now + 30_000,
    ...overrides
  };
}

function setup(agentLimits = limits()): { store: StateStore; repository: AgentStateRepository; workspace: WorkspaceRecord; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-agent-state-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'state.db');
  const store = new StateStore(path);
  const workspaceRecord = workspace();
  store.create(workspaceRecord);
  return { store, repository: new AgentStateRepository(store.database, agentLimits), workspace: workspaceRecord, path };
}

describe('AgentStateRepository', () => {
  it('serializes concurrent spawn reservations and replays one durable agent ID', async () => {
    const { store, repository, workspace: workspaceRecord, path } = setup();
    const secondStore = new StateStore(path);
    const secondRepository = new AgentStateRepository(secondStore.database, limits());
    const first = reservation(workspaceRecord, 'a');
    const retry = { ...first, id: `agent_${'b'.repeat(24)}` };
    const [one, two] = await Promise.all([
      Promise.resolve().then(() => repository.reserveSpawn(first)),
      Promise.resolve().then(() => secondRepository.reserveSpawn(retry))
    ]);
    expect(new Set([one.record.id, two.record.id])).toEqual(new Set([first.id]));
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(repository.listAgentPage(workspaceRecord.ownerId, workspaceRecord.id, { limit: 10 }).records).toHaveLength(1);
    secondStore.close();
    store.close();
  });

  it('makes foreign and missing agent handles equally non-enumerating', () => {
    const { store, repository, workspace: workspaceRecord } = setup();
    const created = repository.reserveSpawn(reservation(workspaceRecord));
    expect(repository.findAgent('foreign-owner', workspaceRecord.id, created.record.id)).toBeUndefined();
    expect(repository.findAgent(workspaceRecord.ownerId, `ws_${'z'.repeat(24)}`, created.record.id)).toBeUndefined();
    expect(repository.findAgent(workspaceRecord.ownerId, workspaceRecord.id, `agent_${'z'.repeat(24)}`)).toBeUndefined();
    expect(() => repository.reserveMessage({
      ownerId: 'foreign-owner', workspaceId: workspaceRecord.id, agentId: created.record.id, generation: 1,
      idempotencyKey: 'message-foreign', payloadHash: 'f'.repeat(64), mode: 'steer', now: Date.now()
    })).toThrow('agent was not found in this workspace');
    expect(() => repository.reserveMessage({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: `agent_${'z'.repeat(24)}`, generation: 1,
      idempotencyKey: 'message-missing', payloadHash: 'f'.repeat(64), mode: 'steer', now: Date.now()
    })).toThrow('agent was not found in this workspace');
    store.close();
  });

  it('rejects spawn replay payload mismatch and fenced workspace or parent state', () => {
    const { store, repository, workspace: workspaceRecord } = setup();
    const first = reservation(workspaceRecord);
    repository.reserveSpawn(first);
    expect(() => repository.reserveSpawn({ ...first, id: `agent_${'b'.repeat(24)}`, payloadHash: 'b'.repeat(64) }))
      .toThrow('different payload');
    expect(() => repository.reserveSpawn(reservation(workspaceRecord, 'c', { workspaceGeneration: 2 }))).toThrow('workspace was not found');
    expect(() => repository.reserveSpawn(reservation(workspaceRecord, 'd', { parentAgentId: first.id }))).toThrow('agent was not found');
    const otherWorkspace = workspace('other');
    store.create(otherWorkspace);
    expect(() => repository.reserveSpawn(reservation(otherWorkspace, 'e', { parentAgentId: first.id }))).toThrow('agent was not found');
    store.close();
  });
  it('rejects agent admission for a network-enabled workspace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-agent-state-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    const workspaceRecord = workspace('owner', 'bridge');
    store.create(workspaceRecord);
    const repository = new AgentStateRepository(store.database, limits());
    expect(() => repository.reserveSpawn(reservation(workspaceRecord))).toThrow('not eligible');
    store.close();
  });


  it('admits exactly one final capacity slot and frees it only after terminal transition', () => {
    const capped = limits({ globalActive: 1, principalActive: 1, workspaceActive: 1, parentActive: 1 });
    const { store, repository, workspace: workspaceRecord } = setup(capped);
    const first = repository.reserveSpawn(reservation(workspaceRecord, 'a')).record;
    expect(() => repository.reserveSpawn(reservation(workspaceRecord, 'b'))).toThrow('active capacity');
    expect(repository.transitionStatus({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: first.id, generation: first.generation,
      expectedStatuses: ['SPAWNING'], status: 'FAILED', now: Date.now(), terminalReason: 'launch failed'
    })?.status).toBe('FAILED');
    expect(repository.reserveSpawn(reservation(workspaceRecord, 'b')).record.status).toBe('SPAWNING');
    store.close();
  });

  it('applies status and parent filters before stable decimal-cursor pagination', () => {
    const { store, repository, workspace: workspaceRecord } = setup();
    const parent = repository.reserveSpawn(reservation(workspaceRecord, 'a')).record;
    repository.transitionStatus({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: parent.id, generation: parent.generation,
      expectedStatuses: ['SPAWNING'], status: 'RUNNING', now: Date.now()
    });
    const child = repository.reserveSpawn(reservation(workspaceRecord, 'b', { parentAgentId: parent.id })).record;
    const unrelated = repository.reserveSpawn(reservation(workspaceRecord, 'c')).record;
    expect(repository.listActiveAgents(workspaceRecord.ownerId, workspaceRecord.id, workspaceRecord.generation).map(({ id }) => id))
      .toEqual([parent.id, child.id, unrelated.id]);
    expect(repository.listAgentPage(workspaceRecord.ownerId, workspaceRecord.id, {
      limit: 10, parentAgentId: parent.id
    }).records.map(({ id }) => id)).toEqual([child.id]);
    expect(repository.listAgentPage(workspaceRecord.ownerId, workspaceRecord.id, {
      limit: 10, status: 'RUNNING'
    }).records.map(({ id }) => id)).toEqual([parent.id]);
    const firstPage = repository.listAgentPage(workspaceRecord.ownerId, workspaceRecord.id, { limit: 1 });
    expect(firstPage).toMatchObject({ records: [{ id: unrelated.id }] });
    expect(firstPage.nextCursor).toMatch(/^[1-9]\d*$/);
    const secondPage = repository.listAgentPage(workspaceRecord.ownerId, workspaceRecord.id, {
      limit: 1, cursor: firstPage.nextCursor!
    });
    expect(secondPage.records[0]?.id).toBe(child.id);
    store.close();
  });

  it('persists message reservation, replay, mismatch, delivery, and restart-unknown states', () => {
    const { store, repository, workspace: workspaceRecord } = setup();
    const agent = repository.reserveSpawn(reservation(workspaceRecord)).record;
    repository.transitionStatus({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: agent.id, generation: agent.generation,
      expectedStatuses: ['SPAWNING'], status: 'RUNNING', now: Date.now()
    });
    const message = {
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: agent.id, generation: agent.generation,
      idempotencyKey: 'message-key', payloadHash: 'm'.repeat(64), mode: 'steer' as const, now: Date.now()
    };
    expect(repository.reserveMessage(message)).toMatchObject({ replayed: false, message: { state: 'RESERVED' } });
    expect(repository.reserveMessage(message)).toMatchObject({ replayed: true, message: { state: 'RESERVED' } });
    expect(() => repository.reserveMessage({ ...message, payloadHash: 'n'.repeat(64) })).toThrow('different payload');
    expect(repository.transitionMessage({
      ...message, expectedState: 'RESERVED', state: 'SENT', now: Date.now()
    })?.state).toBe('SENT');
    const pending = { ...message, idempotencyKey: 'message-pending', payloadHash: 'p'.repeat(64) };
    repository.reserveMessage(pending);
    repository.prepareWorkspaceStartupRepair(workspaceRecord.ownerId, workspaceRecord.id, workspaceRecord.generation, Date.now());
    expect(repository.reserveMessage(pending)).toMatchObject({ replayed: true, message: { state: 'UNKNOWN' } });
    store.close();
  });

  it('atomically evicts log chunks and advances the retained cursor watermark', () => {
    const logLimits = limits({
      maxLogBytesPerAgent: 6,
      maxLogEventsPerAgent: 10,
      maxLogEventBytes: 32,
      globalRetainedBytes: 100,
      principalRetainedBytes: 100,
      workspaceRetainedBytes: 100
    });
    const { store, repository, workspace: workspaceRecord } = setup(logLimits);
    const agent = repository.reserveSpawn(reservation(workspaceRecord)).record;
    repository.appendLog(workspaceRecord.ownerId, workspaceRecord.id, agent.id, agent.generation, 'text', 'abcde', Date.now());
    repository.appendLog(workspaceRecord.ownerId, workspaceRecord.id, agent.id, agent.generation, 'text', 'uvwxyz', Date.now());
    const page = repository.readLogs(workspaceRecord.ownerId, workspaceRecord.id, agent.id, agent.generation, '0', 1_024);
    expect(page).toMatchObject({ retainedBaseCursor: '5', truncated: true, nextCursor: '11', hasMore: false });
    expect(page.events.map((event) => event.content)).toEqual(['uvwxyz']);
    store.close();
  });

  it('retains spawn tombstones through the closed-workspace lookup horizon', () => {
    const tombstoneLimits = limits({ retentionSeconds: 60, lookupHorizonSeconds: 120 });
    const { store, repository, workspace: workspaceRecord } = setup(tombstoneLimits);
    const agent = repository.reserveSpawn(reservation(workspaceRecord)).record;
    repository.transitionStatus({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: agent.id, generation: agent.generation,
      expectedStatuses: ['SPAWNING'], status: 'RUNNING', now: Date.now()
    });
    repository.transitionStatus({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: agent.id, generation: agent.generation,
      expectedStatuses: ['RUNNING'], status: 'CANCELLING', now: Date.now()
    });
    const terminal = repository.transitionStatus({
      ownerId: workspaceRecord.ownerId, workspaceId: workspaceRecord.id, agentId: agent.id, generation: agent.generation,
      expectedStatuses: ['CANCELLING'], status: 'SUCCEEDED', now: Date.now()
    });
    const closed = store.updateFenced(workspaceRecord.id, workspaceRecord.generation, ['ACTIVE'], { status: 'CLOSED' });
    expect(closed?.status).toBe('CLOSED');
    expect(() => repository.compactClosedWorkspace(
      workspaceRecord.ownerId, workspaceRecord.id, workspaceRecord.generation, terminal!.terminalAt!
    )).toThrow('retention horizon');
    const compactedAt = terminal!.terminalAt! + 60_000;
    expect(repository.compactClosedWorkspace(workspaceRecord.ownerId, workspaceRecord.id, workspaceRecord.generation, compactedAt)).toBe(1);
    expect(repository.findAgent(workspaceRecord.ownerId, workspaceRecord.id, agent.id)).toBeUndefined();
    expect(repository.findTombstone(workspaceRecord.ownerId, workspaceRecord.id, agent.id)?.payloadHash).toBe(agent.payloadHash);
    expect(repository.findTombstoneByIdempotency(workspaceRecord.ownerId, workspaceRecord.id, agent.idempotencyKey)?.agentId).toBe(agent.id);
    expect(repository.purgeExpiredTombstones(workspaceRecord.ownerId, workspaceRecord.id, compactedAt + 59_999)).toBe(0);
    expect(repository.findTombstone(workspaceRecord.ownerId, workspaceRecord.id, agent.id)).toBeDefined();
    expect(repository.purgeExpiredTombstones(workspaceRecord.ownerId, workspaceRecord.id, compactedAt + 60_000)).toBe(1);
    expect(repository.findTombstone(workspaceRecord.ownerId, workspaceRecord.id, agent.id)).toBeUndefined();
    store.close();
  });
});
