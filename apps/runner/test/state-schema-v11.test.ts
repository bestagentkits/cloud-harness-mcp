import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migratePrincipalSchema } from '../src/principal-store.js';
import { StateStore, downgradeStateSchemaToV10, downgradeStateSchemaToV9 } from '../src/state-store.js';

const tempDbPath = () => join(tmpdir(), `test-state-v11-${randomBytes(8).toString('hex')}.sqlite`);
const STAMP = 1_700_000_000_000;

const OWNER = 'p_owner';
const OTHER_OWNER = 'p_other';
const SOURCE_A = `sk_${'a'.repeat(24)}`;
const SOURCE_B = `sk_${'b'.repeat(24)}`;
const REVISION_A = `skrev_${'1'.repeat(24)}`;
const REVISION_B = `skrev_${'2'.repeat(24)}`;
const SET_ID = `skset_${'s'.repeat(24)}`;
const JOB_ID = `skjob_${'j'.repeat(24)}`;
const WORKSPACE_ID = `ws_${'w'.repeat(24)}`;

const SKILL_TABLES = [
  'skill_sources',
  'skill_revisions',
  'skill_sets',
  'skill_set_items',
  'workspace_skill_set_snapshots',
  'workspace_skill_assignments',
  'skill_catalog_entries',
  'skill_import_jobs'
];

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function addPrincipal(database: DatabaseSync, owner: string): void {
  database.prepare(
    'INSERT OR IGNORE INTO principals (id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(owner, 'https://auth.example.com', owner, STAMP, STAMP);
}

/** Inserts a source plus an immutable revision and points the source at it, inside one transaction. */
function addSource(
  database: DatabaseSync,
  options: { owner: string; sourceId: string; revisionId: string; slug: string }
): void {
  addPrincipal(database, options.owner);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO skill_sources (owner_id, id, slug, display_name, description, kind, provider, state, tags, generation, created_at, updated_at)
      VALUES (?, ?, ?, 'Test Skill', '', 'owner', 'custom', 'enabled', '[]', 1, ?, ?)
    `).run(options.owner, options.sourceId, options.slug, STAMP, STAMP);
    database.prepare(`
      INSERT INTO skill_revisions (owner_id, skill_source_id, id, parent_revision_id, origin, bundle_sha256, content_sha256, has_executable_assets, created_at)
      VALUES (?, ?, ?, NULL, 'import', ?, ?, 1, ?)
    `).run(options.owner, options.sourceId, options.revisionId, 'a'.repeat(64), 'b'.repeat(64), STAMP);
    database.prepare('UPDATE skill_sources SET current_revision_id = ? WHERE owner_id = ? AND id = ?')
      .run(options.revisionId, options.owner, options.sourceId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function addWorkspace(database: DatabaseSync, owner: string, workspaceId: string, status = 'CLOSED'): void {
  database.prepare(`
    INSERT INTO workspaces (id, owner_id, idempotency_key, repository_url, repository_ref, container_name, workspace_path,
      status, network_profile, created_at, last_activity_at, expires_at, generation, error, hard_expires_at)
    VALUES (?, ?, ?, 'https://github.com/example/repository.git', 'main', NULL, '/tmp/workspace', ?, 'network-none', ?, ?, ?, 1, NULL, ?)
  `).run(workspaceId, owner, `idem-${workspaceId}`, status, STAMP, STAMP, STAMP + 3_600_000, STAMP + 14_400_000);
}

function addSetItem(database: DatabaseSync, owner: string, sourceId: string, revisionId: string): void {
  database.prepare(`
    INSERT INTO skill_set_items (owner_id, skill_set_id, ordinal, skill_source_id, revision_id, name)
    VALUES (?, ?, 0, ?, ?, 'tdd')
  `).run(owner, SET_ID, sourceId, revisionId);
}

describe('StateStore schema version 11 migration and skill registry', () => {
  it('migrates a fresh database to exact version 11 and creates every skill table', () => {
    const store = new StateStore(tempDbPath());
    try {
      const version = (store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version;
      expect(version).toBe(11);
      const tables = tableNames(store.database);
      for (const table of SKILL_TABLES) expect(tables.has(table)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('commits a cyclic source/revision pair only inside one transaction and rejects it otherwise', () => {
    const store = new StateStore(tempDbPath());
    try {
      addPrincipal(store.database, OWNER);
      // Autocommit: the deferred foreign key is checked at the end of the single statement, so
      // pointing at a revision that does not exist yet must fail loudly.
      expect(() => store.database.prepare(`
        INSERT INTO skill_sources (owner_id, id, slug, display_name, kind, provider, current_revision_id, created_at, updated_at)
        VALUES (?, ?, 'racy', 'Racy', 'owner', 'custom', ?, ?, ?)
      `).run(OWNER, SOURCE_A, REVISION_A, STAMP, STAMP)).toThrow(/FOREIGN KEY/i);

      // Inside one transaction the deferred constraint is satisfied by the time it is checked.
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_A, revisionId: REVISION_A, slug: 'tdd' });
      const row = store.database.prepare('SELECT current_revision_id FROM skill_sources WHERE owner_id = ? AND id = ?')
        .get(OWNER, SOURCE_A) as { current_revision_id: string };
      expect(row.current_revision_id).toBe(REVISION_A);
      expect(store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('preserves knowledge-plane rows across a v10 to v11 migration with foreign keys enabled', () => {
    const store = new StateStore(tempDbPath());
    try {
      store.database.exec('PRAGMA foreign_keys = ON');
      downgradeStateSchemaToV10(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(10);
      expect(tableNames(store.database).has('skill_sources')).toBe(false);

      addPrincipal(store.database, OWNER);
      store.database.prepare(`
        INSERT INTO knowledge_items (id, principal_id, kind, scope, project_id, workspace_id, title, content, content_sha256,
          journal_type, occurred_at, generation, created_at, updated_at, expires_at, deleted_at, provenance_json)
        VALUES ('kn_keep', ?, 'memory', 'owner', NULL, NULL, 'keep-me', 'body', ?, NULL, NULL, 1, ?, ?, NULL, NULL, '{"source":"owner"}')
      `).run(OWNER, 'c'.repeat(64), STAMP, STAMP);

      migratePrincipalSchema(store.database);

      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(11);
      expect((store.database.prepare("SELECT title FROM knowledge_items WHERE id = 'kn_keep'").get() as { title: string }).title).toBe('keep-me');
      expect(store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const table of SKILL_TABLES) expect(tableNames(store.database).has(table)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('rejects cross-owner rows and same-owner cross-source revision assignment', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_A, revisionId: REVISION_A, slug: 'tdd' });
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_B, revisionId: REVISION_B, slug: 'review' });
      addPrincipal(store.database, OTHER_OWNER);

      // A revision owned by someone else cannot be referenced.
      expect(() => addSetItem(store.database, OTHER_OWNER, SOURCE_A, REVISION_A)).toThrow(/FOREIGN KEY/i);

      // A revision that belongs to a different source cannot become this source's current revision.
      expect(() => store.database.prepare('UPDATE skill_sources SET current_revision_id = ? WHERE owner_id = ? AND id = ?')
        .run(REVISION_B, OWNER, SOURCE_A)).toThrow(/FOREIGN KEY/i);
    } finally {
      store.close();
    }
  });

  it('blocks revision deletion while a live workspace snapshot holds it and cascades on workspace delete', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_A, revisionId: REVISION_A, slug: 'tdd' });
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_B, revisionId: REVISION_B, slug: 'review' });
      store.database.prepare(`
        INSERT INTO skill_sets (owner_id, id, name, description, generation, created_at, updated_at)
        VALUES (?, ?, 'Core', '', 1, ?, ?)
      `).run(OWNER, SET_ID, STAMP, STAMP);
      addSetItem(store.database, OWNER, SOURCE_A, REVISION_A);

      // A revision referenced by a set item is a garbage-collection root.
      expect(() => store.database.prepare('DELETE FROM skill_revisions WHERE owner_id = ? AND id = ?').run(OWNER, REVISION_A))
        .toThrow(/FOREIGN KEY/i);

      addWorkspace(store.database, OWNER, WORKSPACE_ID);
      store.database.prepare(`
        INSERT INTO workspace_skill_set_snapshots (owner_id, workspace_id, ordinal, skill_set_id, skill_set_generation, snapshot_sha256, created_at)
        VALUES (?, ?, 0, ?, 1, ?, ?)
      `).run(OWNER, WORKSPACE_ID, SET_ID, 'd'.repeat(64), STAMP);
      store.database.prepare(`
        INSERT INTO workspace_skill_assignments (owner_id, workspace_id, ordinal, name, skill_source_id, revision_id, tier, pinned)
        VALUES (?, ?, 0, 'tdd', ?, ?, 'owner', 1)
      `).run(OWNER, WORKSPACE_ID, SOURCE_A, REVISION_A);

      // Deleting the workspace cascades to its snapshots and assignments.
      store.database.prepare('DELETE FROM workspaces WHERE owner_id = ? AND id = ?').run(OWNER, WORKSPACE_ID);
      expect(store.database.prepare('SELECT count(*) as count FROM workspace_skill_assignments').get()).toEqual({ count: 0 });
      expect(store.database.prepare('SELECT count(*) as count FROM workspace_skill_set_snapshots').get()).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('rejects in-place revision content updates, illegal state transitions, and malformed tags', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_A, revisionId: REVISION_A, slug: 'tdd' });

      expect(() => store.database.prepare('UPDATE skill_revisions SET content_sha256 = ? WHERE owner_id = ? AND id = ?')
        .run('e'.repeat(64), OWNER, REVISION_A)).toThrow(/immutable/i);

      // enabled -> archived is allowed, archived -> enabled is not.
      store.database.prepare("UPDATE skill_sources SET state = 'archived' WHERE owner_id = ? AND id = ?").run(OWNER, SOURCE_A);
      expect(() => store.database.prepare("UPDATE skill_sources SET state = 'enabled' WHERE owner_id = ? AND id = ?")
        .run(OWNER, SOURCE_A)).toThrow(/illegal skill state transition/i);

      expect(() => store.database.prepare(`
        INSERT INTO skill_sources (owner_id, id, slug, display_name, kind, tags, created_at, updated_at)
        VALUES (?, ?, 'bad-tags', 'Bad', 'owner', 'not-json', ?, ?)
      `).run(OWNER, SOURCE_B, STAMP, STAMP)).toThrow(/CHECK/i);
    } finally {
      store.close();
    }
  });

  it('keeps an import job durable across a reopen and terminal exactly once', () => {
    const path = tempDbPath();
    const first = new StateStore(path);
    addPrincipal(first.database, OWNER);
    first.database.prepare(`
      INSERT INTO skill_import_jobs (owner_id, id, source_kind, source_ref, state, progress_json, created_at, updated_at)
      VALUES (?, ?, 'skills-sh', 'mattpocock/skills', 'running', '{}', ?, ?)
    `).run(OWNER, JOB_ID, STAMP, STAMP);
    first.close();

    const second = new StateStore(path);
    try {
      expect((second.database.prepare('SELECT state FROM skill_import_jobs WHERE owner_id = ? AND id = ?')
        .get(OWNER, JOB_ID) as { state: string }).state).toBe('running');

      second.database.prepare("UPDATE skill_import_jobs SET state = 'succeeded', result_json = '{\"count\":1}' WHERE owner_id = ? AND id = ?")
        .run(OWNER, JOB_ID);
      expect((second.database.prepare('PRAGMA foreign_key_check').all())).toEqual([]);

      // A terminal job must not be rewritten.
      expect(() => second.database.prepare("UPDATE skill_import_jobs SET result_json = '{\"count\":2}' WHERE owner_id = ? AND id = ?")
        .run(OWNER, JOB_ID)).toThrow(/terminal/i);
    } finally {
      second.close();
    }
  });

  it('round-trips v11 to v10 to v9 and refuses the downgrade while skill rows exist', () => {
    const store = new StateStore(tempDbPath());
    try {
      addSource(store.database, { owner: OWNER, sourceId: SOURCE_A, revisionId: REVISION_A, slug: 'tdd' });

      expect(() => downgradeStateSchemaToV10(store.database)).toThrow(/skill tables contain records/i);
      downgradeStateSchemaToV10(store.database, true);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(10);

      downgradeStateSchemaToV9(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(9);

      migratePrincipalSchema(store.database);
      expect((store.database.prepare('SELECT version FROM schema_meta').get() as { version: number }).version).toBe(11);
      expect(tableNames(store.database).has('skill_sources')).toBe(true);
      expect(tableNames(store.database).has('knowledge_items')).toBe(true);
    } finally {
      store.close();
    }
  });
});
