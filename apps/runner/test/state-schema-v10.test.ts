import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  StateStore,
  downgradeStateSchemaToV9,
  downgradeStateSchemaToV8
} from '../src/state-store.js';
import { migratePrincipalSchema } from '../src/principal-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v10-${randomBytes(8).toString('hex')}.sqlite`);

describe('StateStore Schema Version 10 Migration & Knowledge Plane', () => {
  it('migrates fresh database to exact schema version 10', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(row.version).toBe(10);

      // Verify knowledge tables exist
      const tableRows = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tables = new Set(tableRows.map((r) => r.name));
      expect(tables.has('knowledge_items')).toBe(true);
      expect(tables.has('knowledge_tags')).toBe(true);
      expect(tables.has('knowledge_links')).toBe(true);
      expect(tables.has('knowledge_fts')).toBe(true);
      expect(tables.has('knowledge_embeddings')).toBe(true);
      expect(tables.has('knowledge_index_jobs')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('proves v10 fixture upgrades to exact 10, downgrades to exact 9, 8, and round-trips with FKs enabled', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.exec('PRAGMA foreign_keys = ON');
      const initial = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(initial.version).toBe(10);

      // Downgrade to exact version 9
      downgradeStateSchemaToV9(store.database);
      const v9Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v9Row.version).toBe(9);

      const tableRowsV9 = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tablesV9 = new Set(tableRowsV9.map((r) => r.name));
      expect(tablesV9.has('knowledge_items')).toBe(false);
      expect(tablesV9.has('knowledge_tags')).toBe(false);
      expect(tablesV9.has('knowledge_links')).toBe(false);
      expect(tablesV9.has('knowledge_fts')).toBe(false);
      expect(tablesV9.has('knowledge_embeddings')).toBe(false);
      expect(tablesV9.has('knowledge_index_jobs')).toBe(false);
      expect(tablesV9.has('agent_model_profiles')).toBe(true);

      // Downgrade to exact version 8
      downgradeStateSchemaToV8(store.database);
      const v8Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v8Row.version).toBe(8);

      // Re-upgrade to exact version 10
      migratePrincipalSchema(store.database);
      const v10Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v10Row.version).toBe(10);

      const tableRowsV10 = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tablesV10 = new Set(tableRowsV10.map((r) => r.name));
      expect(tablesV10.has('knowledge_items')).toBe(true);
      expect(tablesV10.has('knowledge_tags')).toBe(true);
      expect(tablesV10.has('knowledge_links')).toBe(true);
      expect(tablesV10.has('knowledge_fts')).toBe(true);
      expect(tablesV10.has('knowledge_embeddings')).toBe(true);
      expect(tablesV10.has('knowledge_index_jobs')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('migrates existing legacy memories into knowledge items and tags with FTS populated', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      // Downgrade to v9
      downgradeStateSchemaToV9(store.database);
      store.database.prepare("INSERT INTO principals (id, issuer, subject, created_at, updated_at) VALUES ('p_test', 'https://auth.example.com', 'test-user', 1000, 1000)").run();
      // Create legacy memories and memory_tags if needed, insert legacy records
      const now = Date.now();
      store.database.prepare(`
        INSERT INTO memories
        (id, principal_id, scope, repository_key, workspace_id, name, content, content_sha256, generation, created_at, updated_at, expires_at, deleted_at, provenance_json)
        VALUES
        ('mem_owner1', 'p_test', 'owner', NULL, NULL, 'owner-doc', 'Owner Content', '1111111111111111111111111111111111111111111111111111111111111111', 1, ${now}, ${now}, ${now + 100000}, NULL, '{"source":"owner","trust":"owner-controlled","mutableBy":"owner"}'),
        ('mem_repo1', 'p_test', 'repository', 'repo_hash123', NULL, 'repo-doc', 'Repo Content', '2222222222222222222222222222222222222222222222222222222222222222', 1, ${now}, ${now}, ${now + 100000}, NULL, '{"source":"repository","trust":"untrusted-executor","mutableBy":"repository-commit"}')
      `).run();

      store.database.prepare(`
        INSERT INTO memory_tags (principal_id, memory_id, tag)
        VALUES
        ('p_test', 'mem_owner1', 'global'),
        ('p_test', 'mem_repo1', 'repo-tag')
      `).run();

      // Migrate to v10
      migratePrincipalSchema(store.database);

      const items = store.database.prepare("SELECT * FROM knowledge_items WHERE principal_id = 'p_test' ORDER BY id").all() as any[];
      expect(items.length).toBe(2);

      const ownerItem = items.find((i) => i.id === 'kn_owner1');
      expect(ownerItem).toBeDefined();
      expect(ownerItem.scope).toBe('owner');
      expect(ownerItem.title).toBe('owner-doc');
      expect(ownerItem.content).toBe('Owner Content');

      const repoItem = items.find((i) => i.id === 'kn_repo1');
      expect(repoItem).toBeDefined();
      expect(repoItem.scope).toBe('project');
      expect(repoItem.project_id).toContain('prj_imported_');
      expect(repoItem.title).toBe('repo-doc');

      // Check tags
      const tags = store.database.prepare("SELECT * FROM knowledge_tags WHERE principal_id = 'p_test'").all() as any[];
      expect(tags.length).toBe(2);

      // Check FTS
      const ftsHits = store.database.prepare("SELECT item_id FROM knowledge_fts WHERE knowledge_fts MATCH 'Owner'").all() as any[];
      expect(ftsHits.map((h) => h.item_id)).toContain('kn_owner1');
    } finally {
      store.close();
    }
  });
});
