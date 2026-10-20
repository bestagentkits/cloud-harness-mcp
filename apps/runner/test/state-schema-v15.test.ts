import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RunnerAgentsConfigSchema } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { downgradeStateSchemaToV14, migratePrincipalSchema } from '../src/principal-store.js';
import { StateStore, downgradeStateSchemaToV13, type WorkspaceRecord } from '../src/state-store.js';

const schemaVersion = (database: DatabaseSync) => (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
const hasTable = (database: DatabaseSync, name: string) =>
  database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const limits = RunnerAgentsConfigSchema.parse({
  image: 'agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  profiles: [{
    id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, maxProxyOperations: ['files_read']
  }]
}).limits;

describe('state schema v15', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function open(): { store: StateStore; path: string } {
    const directory = mkdtempSync(join(tmpdir(), 'state-v15-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    return { store: new StateStore(path), path };
  }

  function persistAgent(store: StateStore): string {
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
      repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
      containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
      gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 1, error: null
    };
    store.create(workspace);
    const id = `agent_${'a'.repeat(24)}`;
    new AgentStateRepository(store.database, limits).reserveSpawn({
      id, ownerId, workspaceId: workspace.id, workspaceGeneration: 1, idempotencyKey: 'spawn-key',
      payloadHash: 'p'.repeat(64), promptHash: 'q'.repeat(64), profileId: 'default', proxyOperations: ['files_read'],
      budget: { ttlSeconds: 30, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
      containerName: 'agent-container', networkName: 'agent-network', gatewayLeaseId: 'lease-id',
      now, expiresAt: now + 30_000, session: {}
    });
    return id;
  }

  it('adds the session tables idempotently', () => {
    const { store } = open();
    try {
      expect(schemaVersion(store.database)).toBe(15);
      expect(hasTable(store.database, 'agent_sessions')).toBe(true);
      expect(hasTable(store.database, 'agent_session_messages')).toBe(true);
      migratePrincipalSchema(store.database);
      expect(schemaVersion(store.database)).toBe(15);
    } finally {
      store.close();
    }
  });

  it('allows at most one successor per persisted session', () => {
    const { store } = open();
    try {
      const agentId = persistAgent(store);
      const row = store.database.prepare('SELECT * FROM agent_sessions WHERE agent_id=?').get(agentId) as Record<string, unknown>;
      expect(row).toMatchObject({ state: 'ACTIVE', continuable: 1, message_count: 0, head_sha256: '0'.repeat(64), continued_from: null });
      store.database.prepare('UPDATE agent_sessions SET continued_from=? WHERE agent_id=?').run('agent_predecessor', agentId);
      expect(() => store.database.prepare(`INSERT INTO agent_sessions
        (agent_id, owner_id, workspace_id, workspace_generation, root_agent_id, continued_from, message_count, bytes, head_sha256,
         state, continuable, retain_until, created_at, updated_at)
        SELECT agent_id, owner_id, workspace_id, workspace_generation, root_agent_id, continued_from, 0, 0, head_sha256,
         'ACTIVE', 1, NULL, 1, 1 FROM agent_sessions WHERE agent_id=?`).run(agentId)).toThrow();
    } finally {
      store.close();
    }
  });

  it('refuses to downgrade over persisted sessions unless data loss is allowed', () => {
    const { store, path } = open();
    persistAgent(store);
    expect(() => downgradeStateSchemaToV14(store.database)).toThrow();
    expect(schemaVersion(store.database)).toBe(15);
    downgradeStateSchemaToV14(store.database, true);
    expect(schemaVersion(store.database)).toBe(14);
    expect(hasTable(store.database, 'agent_sessions')).toBe(false);
    expect(hasTable(store.database, 'agent_session_messages')).toBe(false);
    store.close();

    const reopened = new StateStore(path);
    try {
      expect(schemaVersion(reopened.database)).toBe(15);
      expect(hasTable(reopened.database, 'agent_sessions')).toBe(true);
      downgradeStateSchemaToV13(reopened.database);
      expect(schemaVersion(reopened.database)).toBe(13);
    } finally {
      reopened.close();
    }
  });
});
