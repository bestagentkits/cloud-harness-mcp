import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migratePrincipalSchema } from '../src/principal-store.js';
import { StateStore, downgradeStateSchemaToV11 } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v12-${randomBytes(8).toString('hex')}.sqlite`);
const STAMP = 1_700_000_000_000;
const OWNER = 'p_owner';
const SOURCE_A = `sk_${'a'.repeat(24)}`;
const REVISION_A = `skrev_${'1'.repeat(24)}`;

function schemaVersion(database: DatabaseSync): number {
  return (database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
}

function revisionColumns(database: DatabaseSync): Set<string> {
  const rows = database.prepare('PRAGMA table_info(skill_revisions)').all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function addPrincipal(database: DatabaseSync, owner: string): void {
  database.prepare(
    'INSERT OR IGNORE INTO principals (id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(owner, 'https://auth.example.com', owner, STAMP, STAMP);
}

/** Inserts a source plus an immutable revision, optionally declaring a version, in one transaction. */
function addSource(
  database: DatabaseSync,
  options: { version?: string | null }
): void {
  addPrincipal(database, OWNER);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO skill_sources (owner_id, id, slug, display_name, description, kind, provider, state, tags, generation, created_at, updated_at)
      VALUES (?, ?, 'test-skill', 'Test Skill', '', 'owner', 'custom', 'enabled', '[]', 1, ?, ?)
    `).run(OWNER, SOURCE_A, STAMP, STAMP);
    database.prepare(`
      INSERT INTO skill_revisions (owner_id, skill_source_id, id, parent_revision_id, origin, bundle_sha256, content_sha256, has_executable_assets, created_at, version)
      VALUES (?, ?, ?, NULL, 'import', ?, ?, 1, ?, ?)
    `).run(OWNER, SOURCE_A, REVISION_A, 'a'.repeat(64), 'b'.repeat(64), STAMP, options.version ?? null);
    database.prepare('UPDATE skill_sources SET current_revision_id = ? WHERE owner_id = ? AND id = ?')
      .run(REVISION_A, OWNER, SOURCE_A);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

describe('state schema v12', () => {
  it('adds the revision version column additively and is idempotent', () => {
    const store = new StateStore(tempDbPath());
    try {
      expect(schemaVersion(store.database)).toBe(12);
      expect(revisionColumns(store.database).has('version')).toBe(true);

      // Re-running the migration must not throw and must not change the version.
      migratePrincipalSchema(store.database);
      expect(schemaVersion(store.database)).toBe(12);
    } finally {
      store.close();
    }
  });

  it('stores a declared version and keeps revisions without one at NULL', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { version: '1.2.3' });
      const row = store.database
        .prepare('SELECT version FROM skill_revisions WHERE owner_id = ? AND id = ?')
        .get(OWNER, REVISION_A) as { version: string | null };
      expect(row.version).toBe('1.2.3');
    } finally {
      store.close();
    }
  });

  it('rejects an UPDATE that rewrites a revision version', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { version: '1.2.3' });
      expect(() =>
        store.database
          .prepare('UPDATE skill_revisions SET version = ? WHERE owner_id = ? AND id = ?')
          .run('9.9.9', OWNER, REVISION_A)
      ).toThrow(/immutable/i);
    } finally {
      store.close();
    }
  });

  it('refuses a downgrade while a declared version exists and reverses with allowDataLoss', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { version: '1.2.3' });
      expect(() => downgradeStateSchemaToV11(store.database)).toThrow(/declared version/i);

      downgradeStateSchemaToV11(store.database, true);
      expect(schemaVersion(store.database)).toBe(11);
      expect(revisionColumns(store.database).has('version')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('downgrades cleanly when no revision declares a version', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { version: null });
      downgradeStateSchemaToV11(store.database);
      expect(schemaVersion(store.database)).toBe(11);
      expect(revisionColumns(store.database).has('version')).toBe(false);
    } finally {
      store.close();
    }
  });
});
