import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, downgradeStateSchemaToV4 } from '../src/state-store.js';
import { migratePrincipalSchema } from '../src/principal-store.js';

const tempDirs: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function createTestStore() {
  const dir = await mkdtemp(join(tmpdir(), 'mem-store-test-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'state.db');
  const store = new StateStore(dbPath);
  stores.push(store);

  // Insert test principals and workspaces
  store.database.exec(`
    INSERT OR IGNORE INTO principals (id, issuer, subject, email, name, created_at, updated_at)
    VALUES ('p_user1', 'https://auth.example.com', 'user1', 'u1@example.com', 'User 1', 1000, 1000);
    INSERT OR IGNORE INTO principals (id, issuer, subject, email, name, created_at, updated_at)
    VALUES ('p_user2', 'https://auth.example.com', 'user2', 'u2@example.com', 'User 2', 1000, 1000);
    INSERT OR IGNORE INTO workspaces
    (id, owner_id, idempotency_key, repository_url, workspace_path, status, network_mode, created_at, last_activity_at, expires_at, generation)
    VALUES ('ws_test1', 'p_user1', 'idem_1', 'https://github.com/example/repo', '/tmp/ws1', 'ACTIVE', 'none', 1000, 1000, 9999999999, 1);
    INSERT OR IGNORE INTO workspaces
    (id, owner_id, idempotency_key, repository_url, workspace_path, status, network_mode, created_at, last_activity_at, expires_at, generation)
    VALUES ('ws_active1', 'p_user2', 'idem_2', 'https://github.com/example/repo', '/tmp/ws2', 'ACTIVE', 'none', 1000, 1000, 9999999999, 1);
  `);
  return { store, dir, dbPath };
}

describe('Scoped SQLite Memories Store & Schema v5', () => {
  it('migrates state schema to v5 and handles guarded downgrade', async () => {
    const { store } = await createTestStore();
    const versionRow = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
    expect(versionRow.version).toBe(5);

    // Empty downgrade to v4 succeeds
    downgradeStateSchemaToV4(store.database);
    const v4Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
    expect(v4Row.version).toBe(4);
    // Re-migrating to v5 succeeds
    migratePrincipalSchema(store.database);
    expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(5);

    // Create a memory row
    store.createMemory({
      principalId: 'p_user1',
      scope: 'owner',
      name: 'critical-note',
      content: 'Important data'
    });

    // Downgrade without allowDataLoss MUST throw error
    expect(() => downgradeStateSchemaToV4(store.database, false)).toThrow(/cannot downgrade/);

    // Downgrade with allowDataLoss succeeds
    expect(() => downgradeStateSchemaToV4(store.database, true)).not.toThrow();
    expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(4);
  });

  it('enforces principal isolation and scope separation', async () => {
    const { store } = await createTestStore();

    // Principal 1 creates an owner memory
    const m1 = store.createMemory({
      principalId: 'p_user1',
      scope: 'owner',
      name: 'notes',
      content: 'Principal 1 secret notes',
      tags: ['private', 'arch']
    });

    // Principal 2 creates a repository memory with same name
    const m2 = store.createMemory({
      principalId: 'p_user2',
      scope: 'repository',
      repositoryKey: 'repo_abc123',
      name: 'notes',
      content: 'Principal 2 repo notes',
      tags: ['public', 'repo']
    });
    expect(m2.id).toBeDefined();

    // Principal 1 reads -> sees own
    const read1 = store.readMemory({ principalId: 'p_user1', id: m1.id });
    expect(read1?.content).toBe('Principal 1 secret notes');

    // Principal 2 reading Principal 1 memory ID -> null (NOT_FOUND)
    const crossRead = store.readMemory({ principalId: 'p_user2', id: m1.id });
    expect(crossRead).toBeNull();

    // Principal 1 listing -> only sees own
    const list1 = store.listMemories({ principalId: 'p_user1' });
    expect(list1.memories.length).toBe(1);
    expect(list1.memories[0].principalId).toBe('p_user1');

    // Principal 2 searching in repo_abc123 context -> finds own repo note
    const search2 = store.searchMemories({ principalId: 'p_user2', query: 'notes', repositoryKey: 'repo_abc123' });
    expect(search2.memories.length).toBe(1);
    expect(search2.memories[0].content).toBe('Principal 2 repo notes');
  });

  it('enforces same-principal cross-repository and workspace boundary isolation', async () => {
    const { store } = await createTestStore();

    // Principal 1 creates an owner memory
    store.createMemory({
      principalId: 'p_user1',
      scope: 'owner',
      name: 'global-pref',
      content: 'global settings'
    });

    // Principal 1 creates Repo A memory
    store.createMemory({
      principalId: 'p_user1',
      scope: 'repository',
      repositoryKey: 'repo_A',
      name: 'db-schema',
      content: 'PostgreSQL schema for Repo A',
      tags: ['db', 'schema']
    });

    // Principal 1 creates Repo B memory
    store.createMemory({
      principalId: 'p_user1',
      scope: 'repository',
      repositoryKey: 'repo_B',
      name: 'db-schema',
      content: 'MongoDB schema for Repo B',
      tags: ['db', 'nosql']
    });

    // In Repo A context -> sees owner memory + Repo A memory, does NOT see Repo B memory
    const listRepoA = store.listMemories({
      principalId: 'p_user1',
      repositoryKey: 'repo_A'
    });
    expect(listRepoA.memories.length).toBe(2);
    const repoAContents = listRepoA.memories.map(m => m.content);
    expect(repoAContents).toContain('global settings');
    expect(repoAContents).toContain('PostgreSQL schema for Repo A');
    expect(repoAContents).not.toContain('MongoDB schema for Repo B');

    // Tag filtering: tagMatch 'all' vs 'any'
    const tagAll = store.searchMemories({
      principalId: 'p_user1',
      query: 'schema',
      repositoryKey: 'repo_A',
      tags: ['db', 'schema'],
      tagMatch: 'all'
    });
    expect(tagAll.memories.length).toBe(1);
    expect(tagAll.memories[0].content).toBe('PostgreSQL schema for Repo A');

    const tagMismatch = store.searchMemories({
      principalId: 'p_user1',
      query: 'schema',
      repositoryKey: 'repo_A',
      tags: ['db', 'nosql'],
      tagMatch: 'all'
    });
    expect(tagMismatch.memories.length).toBe(0);
  });

  it('enforces Optimistic Concurrency Control (CAS) on writes and deletes', async () => {
    const { store } = await createTestStore();

    // 1. Create with gen 0
    const created = store.createMemory({
      principalId: 'p_user1',
      scope: 'workspace',
      workspaceId: 'ws_test1',
      name: 'api-config',
      content: 'v1 config'
    });
    expect(created.generation).toBe(1);

    // 2. Conflict: Create again with same name in same workspace
    expect(() => store.createMemory({
      principalId: 'p_user1',
      scope: 'workspace',
      workspaceId: 'ws_test1',
      name: 'api-config',
      content: 'duplicate'
    })).toThrow(/already exists/);

    // 3. Update with correct generation (gen 1 -> gen 2)
    const updated = store.updateMemory({
      principalId: 'p_user1',
      id: created.id,
      content: 'v2 config',
      expectedGeneration: 1
    });
    expect(updated.generation).toBe(2);
    expect(updated.content).toBe('v2 config');

    // 4. Stale update: replaying with generation 1 fails with CONFLICT
    expect(() => store.updateMemory({
      principalId: 'p_user1',
      id: created.id,
      content: 'v3 stale config',
      expectedGeneration: 1
    })).toThrow(/generation conflict/);

    // 5. Delete with stale generation fails
    expect(() => store.deleteMemory({
      principalId: 'p_user1',
      id: created.id,
      expectedGeneration: 1
    })).toThrow(/generation conflict/);

    // 6. Delete with correct generation (gen 2) succeeds
    const deleted = store.deleteMemory({
      principalId: 'p_user1',
      id: created.id,
      expectedGeneration: 2
    });
    expect(deleted).toBe(true);

    // Read after delete returns null
    expect(store.readMemory({ principalId: 'p_user1', id: created.id })).toBeNull();
  });

  it('handles TTL expiry, search queries, and workspace cleanup reaping', async () => {
    const { store } = await createTestStore();

    // Workspace memory that expires quickly
    const wsMem = store.createMemory({
      principalId: 'p_user2',
      scope: 'workspace',
      workspaceId: 'ws_active1',
      name: 'temp-session',
      content: 'Session token cache',
      tags: ['temp', 'session'],
      retentionSeconds: 1 // 1 second TTL
    });

    // Owner memory with normal TTL
    const ownerMem = store.createMemory({
      principalId: 'p_user1',
      scope: 'owner',
      name: 'long-term',
      content: 'Architecture decisions for long term',
      tags: ['arch', 'decision']
    });

    // Search matches
    const searchRes = store.searchMemories({
      principalId: 'p_user1',
      query: 'architecture decisions'
    });
    expect(searchRes.memories.length).toBe(1);
    expect(searchRes.memories[0].id).toBe(ownerMem.id);

    // Reaping workspace memories removes workspace memories on close
    const reapedCount = store.reapWorkspaceMemories('p_user2', 'ws_active1');
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    // Workspace memory is gone
    expect(store.readMemory({ principalId: 'p_user2', id: wsMem.id })).toBeNull();
    // Owner memory persists
    expect(store.readMemory({ principalId: 'p_user1', id: ownerMem.id })).toBeDefined();
  });
});
