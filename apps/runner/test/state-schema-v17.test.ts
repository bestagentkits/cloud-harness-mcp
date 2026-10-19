import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RunnerAgentsConfigSchema, type AgentRuntimeKind } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { downgradeStateSchemaToV16, migratePrincipalSchema } from '../src/principal-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const schemaVersion = (database: DatabaseSync) => (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
const columns = (database: DatabaseSync, table: string) =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const limits = RunnerAgentsConfigSchema.parse({
  image: 'agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  profiles: [{
    id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, maxProxyOperations: ['files_read']
  }]
}).limits;

describe('state schema v17', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function open(): { store: StateStore; path: string } {
    const directory = mkdtempSync(join(tmpdir(), 'state-v17-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    return { store: new StateStore(path), path };
  }

  function workspace(store: StateStore): { ownerId: string; workspaceId: string } {
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const now = Date.now();
    const record: WorkspaceRecord = {
      id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
      repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
      containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
      gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
    };
    store.create(record);
    return { ownerId, workspaceId: record.id };
  }

  function reserve(
    repository: AgentStateRepository,
    ids: { ownerId: string; workspaceId: string },
    agentId: string,
    options: { runtime?: AgentRuntimeKind; continuedFrom?: string } = {}
  ): void {
    const now = Date.now();
    repository.reserveSpawn({
      id: agentId, ownerId: ids.ownerId, workspaceId: ids.workspaceId, workspaceGeneration: 1, idempotencyKey: `spawn-${agentId}`,
      payloadHash: 'p'.repeat(64), promptHash: 'q'.repeat(64), profileId: 'default', proxyOperations: ['files_read'],
      budget: { ttlSeconds: 30, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
      containerName: `container-${agentId}`, networkName: `network-${agentId}`, gatewayLeaseId: `lease-${agentId}`,
      now, expiresAt: now + 30_000,
      ...(options.runtime ? { runtime: options.runtime } : {}),
      session: options.continuedFrom ? { continuedFrom: options.continuedFrom } : {}
    });
  }

  function finish(repository: AgentStateRepository, ids: { ownerId: string; workspaceId: string }, agentId: string, runResumable: boolean): void {
    repository.transitionStatus({
      ownerId: ids.ownerId, workspaceId: ids.workspaceId, agentId, generation: 1,
      expectedStatuses: ['SPAWNING'], status: 'INTERRUPTED', now: Date.now(), terminalReason: 'runner restart', outcomeUnknown: true, runResumable
    });
  }

  it('adds the agent engine and resumable-run columns idempotently, defaulting to the coding engine', () => {
    const { store } = open();
    try {
      expect(schemaVersion(store.database)).toBe(17);
      expect(columns(store.database, 'agents')).toContain('runtime');
      expect(columns(store.database, 'agent_sessions')).toContain('run_resumable');
      migratePrincipalSchema(store.database);
      expect(schemaVersion(store.database)).toBe(17);
      const ids = workspace(store);
      const repository = new AgentStateRepository(store.database, limits);
      reserve(repository, ids, `agent_${'a'.repeat(24)}`);
      expect(repository.findAgent(ids.ownerId, ids.workspaceId, `agent_${'a'.repeat(24)}`)?.runtime).toBe('pi-coding');
      expect(() => store.database.prepare("UPDATE agents SET runtime='bridge'").run()).toThrow();
    } finally {
      store.close();
    }
  });

  it('keeps a continuation on its predecessor\'s engine and walks the lineage', () => {
    const { store } = open();
    try {
      const ids = workspace(store);
      const repository = new AgentStateRepository(store.database, limits);
      const root = `agent_${'r'.repeat(24)}`;
      const child = `agent_${'c'.repeat(24)}`;
      reserve(repository, ids, root, { runtime: 'pi-durable' });
      finish(repository, ids, root, true);
      expect(repository.findSession(root)).toMatchObject({ state: 'SEALED', runResumable: true });
      expect(() => reserve(repository, ids, child, { continuedFrom: root })).toThrow(/engine/);
      reserve(repository, ids, child, { runtime: 'pi-durable', continuedFrom: root });
      expect(repository.lineageDepth(root)).toBe(0);
      expect(repository.lineageDepth(child)).toBe(1);
      expect(repository.lineageRoot(child)).toBe(root);
      expect(repository.durableLineageRoots(ids.ownerId, ids.workspaceId)).toEqual([root]);
    } finally {
      store.close();
    }
  });

  it('reports a fully purged durable lineage for deletion and resets its resumable run', () => {
    const { store } = open();
    try {
      const ids = workspace(store);
      const repository = new AgentStateRepository(store.database, limits);
      const durable = `agent_${'d'.repeat(24)}`;
      const coding = `agent_${'k'.repeat(24)}`;
      reserve(repository, ids, durable, { runtime: 'pi-durable' });
      reserve(repository, ids, coding);
      finish(repository, ids, durable, true);
      finish(repository, ids, coding, false);
      const purged: string[] = [];
      expect(repository.purgeExpiredSessions(Date.now() + limits.sessionRetentionMs + 1, 100, purged)).toBe(2);
      expect(purged).toEqual([durable]);
      expect(repository.findSession(durable)).toMatchObject({ state: 'PURGED', runResumable: false });
    } finally {
      store.close();
    }
  });

  it('refuses to downgrade over durable agents unless data loss is allowed', () => {
    const { store } = open();
    try {
      const ids = workspace(store);
      reserve(new AgentStateRepository(store.database, limits), ids, `agent_${'d'.repeat(24)}`, { runtime: 'pi-durable' });
      expect(() => downgradeStateSchemaToV16(store.database)).toThrow(/durable-runtime agents exist/);
      expect(schemaVersion(store.database)).toBe(17);
      downgradeStateSchemaToV16(store.database, true);
      expect(schemaVersion(store.database)).toBe(16);
      expect(columns(store.database, 'agents')).not.toContain('runtime');
      expect(columns(store.database, 'agent_sessions')).not.toContain('run_resumable');
    } finally {
      store.close();
    }
  });

  it('migrates a v16 database forward with every agent on the coding engine', () => {
    const { store, path } = open();
    const ids = workspace(store);
    reserve(new AgentStateRepository(store.database, limits), ids, `agent_${'a'.repeat(24)}`);
    downgradeStateSchemaToV16(store.database);
    store.close();
    const reopened = new StateStore(path);
    try {
      expect(schemaVersion(reopened.database)).toBe(17);
      expect(reopened.database.prepare('SELECT runtime FROM agents').get()).toEqual({ runtime: 'pi-coding' });
      expect(reopened.database.prepare('SELECT run_resumable FROM agent_sessions').get()).toEqual({ run_resumable: 0 });
    } finally {
      reopened.close();
    }
  });
});
