import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RunnerAgentsConfigSchema } from '@cloud-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStateRepository } from '../src/agent-state-repository.js';
import { downgradeStateSchemaToV15, migratePrincipalSchema } from '../src/principal-store.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const schemaVersion = (database: DatabaseSync) => (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
const columns = (database: DatabaseSync, table: string) =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const hasIndex = (database: DatabaseSync, name: string) =>
  database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !== undefined;
const limits = RunnerAgentsConfigSchema.parse({
  image: 'agent:test',
  gatewayUrl: 'http://model-gateway:3210',
  profiles: [{
    id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
    inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
    maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000, maxProxyOperations: ['files_read']
  }]
}).limits;
const RECEIPT_COLUMNS = [
  'root_agent_id', 'replay_class', 'pre_image_sha256', 'intended_sha256', 'result_sha256', 'result_json',
  'result_reconciled', 'executor_generation', 'workspace_generation', 'retain_until'
];

describe('state schema v16', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function open(): { store: StateStore; path: string } {
    const directory = mkdtempSync(join(tmpdir(), 'state-v16-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    return { store: new StateStore(path), path };
  }

  function persistAgent(store: StateStore): { ownerId: string; workspaceId: string; agentId: string } {
    const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: `ws_${'w'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
      repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
      containerName: 'executor', workspacePath: '/tmp/workspace', environmentId: null, status: 'ACTIVE', networkProfile: 'network-none',
      createdAt: now, lastActivityAt: now, expiresAt: now + 600_000, hardExpiresAt: now + 3_600_000,
      gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null, generation: 3, error: null
    };
    store.create(workspace);
    const agentId = `agent_${'a'.repeat(24)}`;
    new AgentStateRepository(store.database, limits).reserveSpawn({
      id: agentId, ownerId, workspaceId: workspace.id, workspaceGeneration: 3, idempotencyKey: 'spawn-key',
      payloadHash: 'p'.repeat(64), promptHash: 'q'.repeat(64), profileId: 'default', proxyOperations: ['files_read'],
      budget: { ttlSeconds: 30, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
      containerName: 'agent-container', networkName: 'agent-network', gatewayLeaseId: 'lease-id',
      now, expiresAt: now + 30_000, session: {}
    });
    return { ownerId, workspaceId: workspace.id, agentId };
  }

  it('adds the receipt columns and lineage indexes idempotently', () => {
    const { store } = open();
    try {
      expect(schemaVersion(store.database)).toBe(16);
      expect(columns(store.database, 'agent_effects')).toEqual(expect.arrayContaining(RECEIPT_COLUMNS));
      for (const index of ['agent_effects_lineage', 'agent_effects_workspace', 'agent_effects_receipt_retention']) {
        expect(hasIndex(store.database, index)).toBe(true);
      }
      migratePrincipalSchema(store.database);
      expect(schemaVersion(store.database)).toBe(16);
    } finally {
      store.close();
    }
  });

  it('backfills the lineage root and workspace generation of effects recorded before receipts existed', () => {
    const { store, path } = open();
    const { ownerId, workspaceId, agentId } = persistAgent(store);
    downgradeStateSchemaToV15(store.database);
    expect(schemaVersion(store.database)).toBe(15);
    expect(columns(store.database, 'agent_effects')).not.toContain('root_agent_id');
    store.database.prepare('UPDATE agent_sessions SET root_agent_id=? WHERE agent_id=?').run('agent_lineage_root', agentId);
    store.database.prepare(`INSERT INTO agent_effects
      (owner_id, workspace_id, agent_id, agent_generation, runner_epoch, request_id, kind, payload_hash, state, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 'call-1', 'files_write', ?, 'UNKNOWN', 1, 1)`).run(ownerId, workspaceId, agentId, 'h'.repeat(64));
    store.close();

    const reopened = new StateStore(path);
    try {
      expect(schemaVersion(reopened.database)).toBe(16);
      expect(reopened.database.prepare('SELECT root_agent_id, workspace_generation, result_json, result_reconciled FROM agent_effects').get())
        .toEqual({ root_agent_id: 'agent_lineage_root', workspace_generation: 3, result_json: null, result_reconciled: 0 });
      // The lineage key is unique: the same request cannot be recorded twice for one lineage.
      expect(() => reopened.database.prepare(`INSERT INTO agent_effects
        (owner_id, workspace_id, agent_id, agent_generation, runner_epoch, request_id, kind, payload_hash, state, created_at, updated_at, root_agent_id)
        VALUES (?, ?, ?, 2, 1, 'call-1', 'files_write', ?, 'INTENT', 1, 1, 'agent_lineage_root')`)
        .run(ownerId, workspaceId, agentId, 'h'.repeat(64))).toThrow();
    } finally {
      reopened.close();
    }
  });

  it('refuses to downgrade over stored receipts unless data loss is allowed', () => {
    const { store } = open();
    try {
      const { ownerId, workspaceId, agentId } = persistAgent(store);
      store.database.prepare(`INSERT INTO agent_effects
        (owner_id, workspace_id, agent_id, agent_generation, runner_epoch, request_id, kind, payload_hash, state, created_at, updated_at,
         root_agent_id, result_json, result_sha256)
        VALUES (?, ?, ?, 1, 1, 'call-1', 'files_read', ?, 'APPLIED', 1, 1, ?, '{"ok":true}', ?)`)
        .run(ownerId, workspaceId, agentId, 'h'.repeat(64), agentId, 'r'.repeat(64));
      expect(() => downgradeStateSchemaToV15(store.database)).toThrow(/receipts exist/);
      expect(schemaVersion(store.database)).toBe(16);
      downgradeStateSchemaToV15(store.database, true);
      expect(schemaVersion(store.database)).toBe(15);
      expect(columns(store.database, 'agent_effects')).not.toContain('result_json');
      expect((store.database.prepare('SELECT count(*) AS count FROM agent_effects').get() as { count: number }).count).toBe(1);
    } finally {
      store.close();
    }
  });
});
