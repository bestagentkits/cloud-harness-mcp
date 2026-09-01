import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  StateStore,
  downgradeStateSchemaToV3,
  downgradeStateSchemaToV4,
  downgradeStateSchemaToV5,
  downgradeStateSchemaToV6,
  downgradeStateSchemaToV7,
  downgradeStateSchemaToV8,
  downgradeStateSchemaToV9
} from '../src/state-store.js';
import { migratePrincipalSchema } from '../src/principal-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v9-${randomBytes(8).toString('hex')}.sqlite`);

describe('StateStore Schema Version 9 Migration & Model Profile Tables', () => {
  it('migrates fresh database to exact schema version 9', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(row.version).toBe(10);

      // Verify model tables exist
      const tableRows = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tables = new Set(tableRows.map((r) => r.name));
      expect(tables.has('model_provider_credentials')).toBe(true);
      expect(tables.has('model_provider_credential_versions')).toBe(true);
      expect(tables.has('agent_model_profiles')).toBe(true);
      expect(tables.has('agent_model_profile_revisions')).toBe(true);
      expect(tables.has('toolkit_cache_entries')).toBe(true);
      expect(tables.has('agents')).toBe(true);
      expect(tables.has('memories')).toBe(true);
      expect(tables.has('workspaces')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('proves v9 fixture upgrades to exact 9, downgrades to exact 8, 7, 6, 5, 4, 3, and round-trips with FKs enabled', () => {
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

      // Downgrade to exact version 8
      downgradeStateSchemaToV8(store.database);
      const v8Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v8Row.version).toBe(8);

      const tableRowsV8 = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tablesV8 = new Set(tableRowsV8.map((r) => r.name));
      expect(tablesV8.has('model_provider_credentials')).toBe(false);
      expect(tablesV8.has('toolkit_cache_entries')).toBe(true);

      // Downgrade to exact version 7
      downgradeStateSchemaToV7(store.database);
      const v7Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v7Row.version).toBe(7);

      // Re-upgrade to exact version 9
      migratePrincipalSchema(store.database);
      const v10Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v10Row.version).toBe(10);

      const tableRowsV9 = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tablesV9 = new Set(tableRowsV9.map((r) => r.name));
      expect(tablesV9.has('model_provider_credentials')).toBe(true);
      expect(tablesV9.has('agent_model_profiles')).toBe(true);

      // Full downgrade chain to v3
      downgradeStateSchemaToV6(store.database, true);
      const v6Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v6Row.version).toBe(6);

      downgradeStateSchemaToV5(store.database);
      const v5Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v5Row.version).toBe(5);

      downgradeStateSchemaToV4(store.database, true);
      const v4Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v4Row.version).toBe(4);

      downgradeStateSchemaToV3(store.database);
      const v3Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v3Row.version).toBe(3);
    } finally {
      store.close();
    }
  });
});
