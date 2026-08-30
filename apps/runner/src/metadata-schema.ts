import type { DatabaseSync } from 'node:sqlite';

export function migrateMetadataSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO metadata_schema_meta(singleton, version) VALUES (1, 0);
  `);
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number };
    if (row.version === 4) {
      database.exec('COMMIT');
      return;
    }
    if (row.version === 0) database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DELETED')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(principal_id, id),
        UNIQUE(principal_id, name)
      );
      CREATE INDEX projects_principal_updated ON projects(principal_id, updated_at DESC, id);

      CREATE TABLE environments (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DELETED')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(principal_id, id),
        UNIQUE(principal_id, project_id, name),
        FOREIGN KEY(principal_id, project_id) REFERENCES projects(principal_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX environments_principal_project ON environments(principal_id, project_id, updated_at DESC, id);

      CREATE TABLE secret_references (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DELETED')),
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(principal_id, id),
        UNIQUE(principal_id, environment_id, name),
        FOREIGN KEY(principal_id, environment_id) REFERENCES environments(principal_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX secret_refs_principal_environment ON secret_references(principal_id, environment_id, updated_at DESC, id);

      CREATE TABLE secret_versions (
        principal_id TEXT NOT NULL,
        secret_reference_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, secret_reference_id, version),
        FOREIGN KEY(principal_id, secret_reference_id) REFERENCES secret_references(principal_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX secret_versions_key ON secret_versions(key_version, principal_id, secret_reference_id, version);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_generation INTEGER NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX audit_principal_created ON audit_events(principal_id, created_at DESC, id);

      UPDATE metadata_schema_meta SET version = 1 WHERE singleton = 1;
    `);
    const current = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (current === 1) database.exec(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        display_prefix TEXT NOT NULL,
        secret_hash BLOB NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        UNIQUE(principal_id, id)
      );
      CREATE INDEX api_keys_principal_created ON api_keys(principal_id, created_at DESC, id);
      CREATE INDEX api_keys_active_expiry ON api_keys(principal_id, state, expires_at);
      UPDATE metadata_schema_meta SET version = 2 WHERE singleton = 1;
    `);
    const postV2 = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (postV2 === 2) database.exec(`
      ALTER TABLE secret_references ADD COLUMN description TEXT;
      UPDATE metadata_schema_meta SET version = 3 WHERE singleton = 1;
    `);
    const postV3 = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (postV3 === 3) database.exec(`
      CREATE TABLE global_secret_references (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DELETED')),
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(principal_id, id),
        UNIQUE(principal_id, name)
      );
      CREATE INDEX global_secret_refs_principal ON global_secret_references(principal_id, updated_at DESC, id);

      CREATE TABLE global_secret_versions (
        principal_id TEXT NOT NULL,
        secret_reference_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, secret_reference_id, version),
        FOREIGN KEY(principal_id, secret_reference_id) REFERENCES global_secret_references(principal_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX global_secret_versions_key ON global_secret_versions(key_version, principal_id, secret_reference_id, version);

      UPDATE metadata_schema_meta SET version = 4 WHERE singleton = 1;
    `);
    const migrated = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (migrated !== 4) throw new Error(`unsupported metadata schema version ${migrated}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function downgradeMetadataSchemaToV3(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || row.version !== 4) throw new Error('metadata schema must be version 4 before downgrade');
    database.exec(`
      DROP TABLE IF EXISTS global_secret_versions;
      DROP TABLE IF EXISTS global_secret_references;
      UPDATE metadata_schema_meta SET version = 3 WHERE singleton = 1;
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function downgradeMetadataSchemaToV2(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || (row.version !== 3 && row.version !== 4)) throw new Error('metadata schema must be version 3 or 4 before downgrade');
    if (row.version === 4) {
      database.exec(`
        DROP TABLE IF EXISTS global_secret_versions;
        DROP TABLE IF EXISTS global_secret_references;
      `);
    }
    database.exec(`
      ALTER TABLE secret_references DROP COLUMN description;
      UPDATE metadata_schema_meta SET version = 2 WHERE singleton = 1;
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function downgradeMetadataSchemaToV1(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || (row.version !== 2 && row.version !== 3 && row.version !== 4)) throw new Error('metadata schema must be version 2, 3, or 4 before downgrade');
    if (row.version === 4) {
      database.exec(`
        DROP TABLE IF EXISTS global_secret_versions;
        DROP TABLE IF EXISTS global_secret_references;
      `);
    }
    if (row.version >= 3) {
      database.exec('ALTER TABLE secret_references DROP COLUMN description;');
    }
    database.exec(`
      DROP TABLE api_keys;
      UPDATE metadata_schema_meta SET version = 1 WHERE singleton = 1;
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
