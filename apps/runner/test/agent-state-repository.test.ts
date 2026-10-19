import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerAgentLimitsSchema, type AgentBudget, type RunnerAgentLimits } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentStateRepository,
  MAX_AGENT_EFFECT_RECEIPT_BYTES,
  type AgentRecord,
  type AgentSpawnReservation
} from '../src/agent-state-repository.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];
afterEach(() => {
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
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
function workspace(ownerId = 'owner', networkProfile: WorkspaceRecord['networkProfile'] = 'network-none', idSuffix?: string): WorkspaceRecord {
  const now = Date.now();
  const id = idSuffix ? `ws_${idSuffix.repeat(24)}` : `ws_${'w'.repeat(24)}`;
  return {
    id,
    ownerId,
    idempotencyKey: `idem-${id}`,
    repositoryUrl: 'https://github.com/example/repository.git',
    repositoryRef: null,
    containerName: 'executor',
    workspacePath: `/tmp/${id}`,
    environmentId: null,
    status: 'ACTIVE',
    networkProfile,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 600_000,
    hardExpiresAt: now + 3_600_000,
    gitAuthorName: null,
    gitAuthorEmail: null,
    mutationLockedUntil: null,
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
  openStores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const workspaceRecord = workspace(ownerId);
  store.create(workspaceRecord);
  return { store, repository: new AgentStateRepository(store.database, agentLimits), workspace: workspaceRecord, path };
}

describe('AgentStateRepository', () => {
  it('serializes concurrent spawn reservations and replays one durable agent ID', async () => {
    const { store, repository, workspace: workspaceRecord, path } = setup();
    const secondStore = new StateStore(path);
    openStores.push(secondStore);
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
    const otherOwner = store.resolvePrincipal({ kind: 'owner', ownerId: 'other' });
    const otherWorkspace = workspace(otherOwner, 'network-none', 'other');
    store.create(otherWorkspace);
    expect(() => repository.reserveSpawn(reservation(otherWorkspace, 'e', { parentAgentId: first.id }))).toThrow('agent was not found');
    store.close();
  });
  it('rejects agent admission for a network-enabled workspace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-agent-state-'));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, 'state.db'));
    openStores.push(store);
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const workspaceRecord = workspace(ownerId, 'dependency-access');
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

  it('manages agent_effects ledger, replay, conflict, and restart repair unknown transitions', () => {
    const { store, repository, workspace: workspaceRecord } = setup();
    const agent = repository.reserveSpawn(reservation(workspaceRecord)).record;

    const effectInput = {
      ownerId: workspaceRecord.ownerId,
      workspaceId: workspaceRecord.id,
      agentId: agent.id,
      agentGeneration: agent.generation,
      runnerEpoch: 1,
      requestId: 'req-effect-1',
      kind: 'files_write',
      payloadHash: 'hash-write-1',
      now: Date.now()
    };

    // First reservation -> INTENT, not replayed
    const first = repository.reserveEffect(effectInput);
    expect(first).toMatchObject({ replayed: false, effect: { state: 'INTENT', kind: 'files_write' } });

    // Same request -> replayed
    const replay = repository.reserveEffect(effectInput);
    expect(replay).toMatchObject({ replayed: true, effect: { state: 'INTENT' } });

    // Different payload hash -> conflict
    expect(() => repository.reserveEffect({ ...effectInput, payloadHash: 'different-hash' })).toThrow('different payload');

    // Transition INTENT -> DISPATCHED
    expect(repository.transitionEffect({
      agentId: agent.id,
      agentGeneration: agent.generation,
      requestId: 'req-effect-1',
      kind: 'files_write',
      expectedState: 'INTENT',
      state: 'DISPATCHED',
      runnerEpoch: 1,
      now: Date.now()
    })).toBe(true);

    // Stale epoch transition -> fails
    expect(repository.transitionEffect({
      agentId: agent.id,
      agentGeneration: agent.generation,
      requestId: 'req-effect-1',
      kind: 'files_write',
      expectedState: 'DISPATCHED',
      state: 'APPLIED',
      runnerEpoch: 99,
      now: Date.now()
    })).toBe(false);

    // Transition to APPLIED with correct epoch
    expect(repository.transitionEffect({
      agentId: agent.id,
      agentGeneration: agent.generation,
      requestId: 'req-effect-1',
      kind: 'files_write',
      expectedState: 'DISPATCHED',
      state: 'APPLIED',
      runnerEpoch: 1,
      now: Date.now()
    })).toBe(true);

    // Another effect in DISPATCHED state when crash/repair happens
    repository.reserveEffect({ ...effectInput, requestId: 'req-effect-2' });
    repository.transitionEffect({
      agentId: agent.id,
      agentGeneration: agent.generation,
      requestId: 'req-effect-2',
      kind: 'files_write',
      expectedState: 'INTENT',
      state: 'DISPATCHED',
      runnerEpoch: 1,
      now: Date.now()
    });

    // Startup repair transitions in-flight DISPATCHED effect to UNKNOWN
    repository.prepareWorkspaceStartupRepair(workspaceRecord.ownerId, workspaceRecord.id, workspaceRecord.generation, Date.now());
    const row = store.database.prepare('SELECT state FROM agent_effects WHERE request_id = ?').get('req-effect-2') as { state: string };
    expect(row.state).toBe('UNKNOWN');

    store.close();
  });

  describe('effect receipts', () => {
    function running(repository: AgentStateRepository, workspaceRecord: WorkspaceRecord, suffix: string, epoch: number, session: AgentSpawnReservation['session'] = {}) {
      const agent = repository.reserveSpawn(reservation(workspaceRecord, suffix, { session })).record;
      const record = repository.transitionStatus({
        ownerId: agent.ownerId, workspaceId: agent.workspaceId, agentId: agent.id, generation: agent.generation,
        runtimeEpoch: epoch, expectedStatuses: ['SPAWNING'], status: 'RUNNING', now: Date.now()
      });
      if (!record) throw new Error('expected a running agent');
      return record;
    }
    function receiptSetup() {
      const context = setup();
      const repository = new AgentStateRepository(context.store.database, limits(), 'runner-test');
      const epoch = repository.bumpEpoch('runner-test', Date.now());
      return { ...context, repository, epoch };
    }
    const fenceOf = (agent: AgentRecord, runnerEpoch: number) => ({
      ownerId: agent.ownerId, workspaceId: agent.workspaceId, agentId: agent.id, agentGeneration: agent.generation, runnerEpoch
    });
    const reserveInput = (agent: AgentRecord, runnerEpoch: number, overrides: Record<string, unknown> = {}) => ({
      ownerId: agent.ownerId, workspaceId: agent.workspaceId, agentId: agent.id, agentGeneration: agent.generation, runnerEpoch,
      requestId: 'toolu_1', kind: 'files_write', payloadHash: 'a'.repeat(64), replayClass: 'conditional-write' as const,
      fenced: true, now: Date.now(), ...overrides
    });

    it('stores the exact result text with the outcome and returns it to a repeated request', () => {
      const { repository, workspace: workspaceRecord, epoch } = receiptSetup();
      const agent = running(repository, workspaceRecord, 'r', epoch);
      const { effect } = repository.reserveEffect(reserveInput(agent, epoch));
      expect(effect).toMatchObject({ rootAgentId: agent.id, state: 'INTENT', replayClass: 'conditional-write', workspaceGeneration: 1, resultJson: null });
      const key = { rootAgentId: agent.id, requestId: 'toolu_1', kind: 'files_write' };
      expect(repository.dispatchEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['INTENT'], intendedSha256: 'b'.repeat(64), now: Date.now() })).toBe(true);
      const text = '{"ok":true,"message":"File written","data":{"sha256":"bbbb"}}';
      expect(repository.completeEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['DISPATCHED'], state: 'APPLIED', receipt: { text }, now: 1_000 })).toBe(true);

      const replay = repository.reserveEffect(reserveInput(agent, epoch));
      expect(replay.replayed).toBe(true);
      expect(replay.effect).toMatchObject({
        state: 'APPLIED', resultJson: text, intendedSha256: 'b'.repeat(64), executorGeneration: epoch,
        retainUntil: 1_000 + limits().sessionRetentionMs, reconciled: false
      });
      expect(replay.effect.resultSha256).toMatch(/^[0-9a-f]{64}$/);
      // A completed effect cannot be completed again.
      expect(repository.completeEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['DISPATCHED'], state: 'REJECTED', receipt: { text: 'x' }, now: 2_000 })).toBe(false);
      expect(() => repository.reserveEffect(reserveInput(agent, epoch, { payloadHash: 'c'.repeat(64) }))).toThrow('different payload');
    });

    it('validates request IDs, digests, and the receipt bound', () => {
      const { repository, workspace: workspaceRecord, epoch } = receiptSetup();
      const agent = running(repository, workspaceRecord, 'v', epoch);
      expect(() => repository.reserveEffect(reserveInput(agent, epoch, { requestId: '../escape' }))).toThrow('invalid effect request ID');
      expect(() => repository.reserveEffect(reserveInput(agent, epoch, { requestId: 'x'.repeat(129) }))).toThrow('invalid effect request ID');
      expect(() => repository.reserveEffect(reserveInput(agent, epoch, { intendedSha256: 'NOT-A-DIGEST' }))).toThrow('SHA-256');
      repository.reserveEffect(reserveInput(agent, epoch));
      const key = { rootAgentId: agent.id, requestId: 'toolu_1', kind: 'files_write' };
      repository.dispatchEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['INTENT'], now: Date.now() });
      expect(() => repository.completeEffect({
        ...key, fence: fenceOf(agent, epoch), expectedStates: ['DISPATCHED'], state: 'APPLIED',
        receipt: { text: 'x'.repeat(MAX_AGENT_EFFECT_RECEIPT_BYTES + 1) }, now: Date.now()
      })).toThrow('exceeds');
      expect(() => repository.completeEffect({
        ...key, fence: fenceOf(agent, epoch), expectedStates: ['DISPATCHED'], state: 'UNKNOWN', receipt: { text: 'x' }, now: Date.now()
      })).toThrow('no receipt');
    });

    it('refuses effects, usage, and session messages from a stale runner epoch or agent generation', () => {
      const { repository, workspace: workspaceRecord, epoch } = receiptSetup();
      const agent = running(repository, workspaceRecord, 'e', epoch);
      expect(() => repository.reserveEffect(reserveInput(agent, epoch + 1))).toThrow('lifecycle fence');
      expect(() => repository.reserveEffect(reserveInput({ ...agent, generation: agent.generation + 1 }, epoch))).toThrow('lifecycle fence');
      repository.reserveEffect(reserveInput(agent, epoch));
      const key = { rootAgentId: agent.id, requestId: 'toolu_1', kind: 'files_write' };
      repository.dispatchEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['INTENT'], now: Date.now() });

      const next = repository.bumpEpoch('runner-test', Date.now());
      expect(repository.completeEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['DISPATCHED'], state: 'APPLIED', receipt: { text: '{}' }, now: Date.now() })).toBe(false);
      expect(repository.dispatchEffect({ ...key, fence: fenceOf(agent, next), expectedStates: ['DISPATCHED'], now: Date.now() })).toBe(false);
      expect(repository.findEffect(key)).toMatchObject({ state: 'DISPATCHED', resultJson: null });
      expect(repository.addUsage(agent.ownerId, agent.workspaceId, agent.id, agent.generation, { toolTimeMs: 50 }, { runnerEpoch: epoch }).toolTimeMs).toBe(0);
      expect(repository.appendSessionMessage({
        ownerId: agent.ownerId, workspaceId: agent.workspaceId, agentId: agent.id, generation: agent.generation,
        runnerEpoch: epoch, seq: 0, message: { role: 'user', content: 'late' }, now: Date.now()
      })).toBe('FENCED');
    });

    it('scopes request IDs to a lineage and fences a continued predecessor', () => {
      const { repository, workspace: workspaceRecord, epoch } = receiptSetup();
      const predecessor = running(repository, workspaceRecord, 'p', epoch);
      repository.reserveEffect(reserveInput(predecessor, epoch));
      const key = { rootAgentId: predecessor.id, requestId: 'toolu_1', kind: 'files_write' };
      repository.dispatchEffect({ ...key, fence: fenceOf(predecessor, epoch), expectedStates: ['INTENT'], now: Date.now() });
      repository.completeEffect({ ...key, fence: fenceOf(predecessor, epoch), expectedStates: ['DISPATCHED'], state: 'APPLIED', receipt: { text: '{"ok":true}' }, now: Date.now() });
      for (const [from, to] of [['RUNNING', 'CANCELLING'], ['CANCELLING', 'SUCCEEDED']] as const) {
        repository.transitionStatus({
          ownerId: predecessor.ownerId, workspaceId: predecessor.workspaceId, agentId: predecessor.id, generation: predecessor.generation,
          expectedStatuses: [from], status: to, now: Date.now()
        });
      }
      const successor = running(repository, workspaceRecord, 's', epoch, { continuedFrom: predecessor.id });
      expect(repository.lineageRoot(successor.id)).toBe(predecessor.id);

      // The successor's repeat of the predecessor's request finds the predecessor's receipt.
      const replay = repository.reserveEffect(reserveInput(successor, epoch));
      expect(replay).toMatchObject({ replayed: true, effect: { agentId: predecessor.id, state: 'APPLIED', resultJson: '{"ok":true}' } });
      // An unrelated agent with the same request ID has its own lineage.
      const other = running(repository, workspaceRecord, 'o', epoch);
      expect(repository.reserveEffect(reserveInput(other, epoch)).replayed).toBe(false);

      // The predecessor's writer is fenced once it has a successor.
      expect(repository.addUsage(predecessor.ownerId, predecessor.workspaceId, predecessor.id, predecessor.generation, { toolTimeMs: 50 }, { runnerEpoch: epoch }).toolTimeMs).toBe(0);
      expect(repository.addUsage(successor.ownerId, successor.workspaceId, successor.id, successor.generation, { toolTimeMs: 50 }, { runnerEpoch: epoch }).toolTimeMs).toBe(50);
    });

    it('purges receipt content past retention but keeps the outcome, and deletes effects with the workspace sessions', () => {
      const { repository, workspace: workspaceRecord, epoch, store } = receiptSetup();
      const agent = running(repository, workspaceRecord, 'g', epoch);
      repository.reserveEffect(reserveInput(agent, epoch));
      const key = { rootAgentId: agent.id, requestId: 'toolu_1', kind: 'files_write' };
      repository.dispatchEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['INTENT'], now: Date.now() });
      repository.completeEffect({ ...key, fence: fenceOf(agent, epoch), expectedStates: ['DISPATCHED'], state: 'APPLIED', receipt: { text: '{"ok":true}' }, now: 1_000 });
      expect(repository.purgeExpiredReceipts(1_000 + limits().sessionRetentionMs - 1)).toBe(0);
      expect(repository.purgeExpiredReceipts(1_000 + limits().sessionRetentionMs)).toBe(1);
      expect(repository.findEffect(key)).toMatchObject({ state: 'APPLIED', resultJson: null, resultSha256: null, retainUntil: null });

      repository.deleteWorkspaceSessions(agent.ownerId, agent.workspaceId);
      expect(repository.findEffect(key)).toBeUndefined();
      expect((store.database.prepare('SELECT count(*) AS count FROM agent_effects').get() as { count: number }).count).toBe(0);
    });
  });
});
