import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downgradeStateSchemaToV5,
  migratePrincipalSchema,
  resolveOwnerPrincipal
} from '../src/principal-store.js';
import { StateStore } from '../src/state-store.js';

describe('StateSchema v6 Migration and Downgrade', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ch-schema-v6-test-'));
    dbPath = join(tmpDir, 'state.sqlite3');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates fresh database to version 6 and creates toolkit tables', () => {
    const store = new StateStore(dbPath);
    const row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
    expect(row.version).toBe(6);

    const tables = (store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    expect(tables).toContain('toolkit_cache_entries');
    expect(tables).toContain('workspace_toolkits');

    const wsCols = (store.database.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map(c => c.name);
    expect(wsCols).toContain('request_fingerprint');

    store.close();
  });

  it('performs transactional downgrade to v5 and refuses downgrade when active rows exist without allowDataLoss', () => {
    const store = new StateStore(dbPath);
    const ownerId = resolveOwnerPrincipal(store.database, 'owner-test-1');

    store.upsertToolkitCacheEntry({
      cacheKey: 'test-key-1',
      ownerId,
      sourceIdentity: 'mattpocock/skills',
      resolvedRevision: 'abc123',
      adapterVersion: 1,
      bundleSha256: 'a'.repeat(64),
      status: 'READY',
      byteCount: 100,
      fileCount: 2,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      errorSummary: null
    });
    expect(() => downgradeStateSchemaToV5(store.database, false)).toThrow('cannot downgrade state schema to v5: toolkit tables contain active records');

    // Downgrade with allowDataLoss = true
    downgradeStateSchemaToV5(store.database, true);

    const versionAfter = (store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
    expect(versionAfter).toBe(5);

    const tablesAfter = (store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    expect(tablesAfter).not.toContain('toolkit_cache_entries');
    expect(tablesAfter).not.toContain('workspace_toolkits');

    // Re-migrate to v6
    migratePrincipalSchema(store.database);
    const versionReMigrated = (store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
    expect(versionReMigrated).toBe(6);

    store.close();
  });
});
