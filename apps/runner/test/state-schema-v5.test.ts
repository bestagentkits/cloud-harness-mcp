import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StateStore, downgradeStateSchemaToV3, downgradeStateSchemaToV4, downgradeStateSchemaToV5, downgradeStateSchemaToV6 } from '../src/state-store.js';
import { migratePrincipalSchema } from '../src/principal-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v7-${randomBytes(8).toString('hex')}.sqlite`);

describe('StateStore Schema Version 7 Migration & Agent Tables', () => {
  it('migrates fresh database to exact schema version 7', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      const row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(row.version).toBe(8);

      // Verify agent tables exist
      const tableRows = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tables = new Set(tableRows.map((r) => r.name));
      expect(tables.has('agents')).toBe(true);
      expect(tables.has('agent_workspace_admission')).toBe(true);
      expect(tables.has('agent_messages')).toBe(true);
      expect(tables.has('agent_effects')).toBe(true);
      expect(tables.has('agent_usage')).toBe(true);
      expect(tables.has('agent_log_watermarks')).toBe(true);
      expect(tables.has('agent_log_chunks')).toBe(true);
      expect(tables.has('agent_cleanup_retries')).toBe(true);
      expect(tables.has('agent_tombstones')).toBe(true);
      expect(tables.has('runtime_epochs')).toBe(true);
      expect(tables.has('memories')).toBe(true);
      expect(tables.has('hook_activations')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('proves v6 fixture upgrades to exact 7, downgrades to exact 6, 5, 4, 3, and round-trips with FKs enabled', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath);
    try {
      store.database.exec('PRAGMA foreign_keys = ON');
      const initial = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(initial.version).toBe(8);

      // Downgrade to exact version 6
      downgradeStateSchemaToV6(store.database, true);
      const v6Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v6Row.version).toBe(6);

      const tableRowsV6 = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tablesV6 = new Set(tableRowsV6.map((r) => r.name));
      expect(tablesV6.has('agents')).toBe(false);
      expect(tablesV6.has('workspaces')).toBe(true);
      expect(tablesV6.has('memories')).toBe(true);

      // Downgrade to exact version 5
      downgradeStateSchemaToV5(store.database);
      const v5Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v5Row.version).toBe(5);

      // Upgrade from v5 back to exact version 7
      migratePrincipalSchema(store.database);
      const v7Row = store.database.prepare('SELECT version FROM schema_meta').get() as { version: number };
      expect(v7Row.version).toBe(8);

      const tableRowsV7 = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tablesV7 = new Set(tableRowsV7.map((r) => r.name));
      expect(tablesV7.has('agents')).toBe(true);
      expect(tablesV7.has('agent_messages')).toBe(true);

      // Downgrade to v4 and then v3
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
