import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migratePrincipalSchema } from '../src/principal-store.js';
import { StateStore, downgradeStateSchemaToV12, downgradeStateSchemaToV13 } from '../src/state-store.js';

const schemaVersion = (database: DatabaseSync) => (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
const hasSnapshots = (database: DatabaseSync) =>
  database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_catalog_snapshots'").get() !== undefined;

describe('state schema v14', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function open(): { store: StateStore; path: string } {
    const directory = mkdtempSync(join(tmpdir(), 'state-v14-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    return { store: new StateStore(path), path };
  }

  it('adds the catalog snapshot table idempotently', () => {
    const { store } = open();
    try {
      expect(schemaVersion(store.database)).toBe(16);
      expect(hasSnapshots(store.database)).toBe(true);
      migratePrincipalSchema(store.database);
      expect(schemaVersion(store.database)).toBe(16);
    } finally {
      store.close();
    }
  });

  it('refuses a provider snapshot without its principal and credential', () => {
    const { store } = open();
    try {
      expect(() => store.database.prepare(`
        INSERT INTO model_catalog_snapshots (cache_key, source, provider, entries_json, fetched_at)
        VALUES ('provider:x', 'provider', 'openai', '[]', 1)
      `).run()).toThrow();
      expect(() => store.database.prepare(`
        INSERT INTO model_catalog_snapshots (cache_key, source, provider, principal_id, credential_id, credential_version, entries_json, fetched_at)
        VALUES ('provider:y', 'provider', 'openai', 'p_missing', 'cred_missing', 1, '[]', 1)
      `).run()).toThrow();
    } finally {
      store.close();
    }
  });

  it('downgrades to v13 by dropping the cache, and the next open migrates again', () => {
    const { store, path } = open();
    store.database.prepare(`
      INSERT INTO model_catalog_snapshots (cache_key, source, provider, entries_json, fetched_at)
      VALUES ('openrouter:public', 'openrouter', 'openrouter', '[]', 1)
    `).run();
    downgradeStateSchemaToV13(store.database);
    expect(schemaVersion(store.database)).toBe(13);
    expect(hasSnapshots(store.database)).toBe(false);
    store.close();

    const reopened = new StateStore(path);
    try {
      expect(schemaVersion(reopened.database)).toBe(16);
      expect(hasSnapshots(reopened.database)).toBe(true);
      downgradeStateSchemaToV12(reopened.database);
      expect(schemaVersion(reopened.database)).toBe(12);
    } finally {
      reopened.close();
    }
  });
});
