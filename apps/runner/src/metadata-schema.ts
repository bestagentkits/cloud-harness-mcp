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
    if (row.version === 6) {
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
    const postV4 = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (postV4 === 4) database.exec(`
      ALTER TABLE secret_references ADD COLUMN purpose TEXT NOT NULL DEFAULT 'runtime' CHECK (purpose IN ('runtime', 'provisioning'));
      ALTER TABLE global_secret_references ADD COLUMN purpose TEXT NOT NULL DEFAULT 'runtime' CHECK (purpose IN ('runtime', 'provisioning'));
      UPDATE metadata_schema_meta SET version = 5 WHERE singleton = 1;
    `);
    const postV5 = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (postV5 === 5) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='principals'").get()) {
        throw new Error('metadata migration requires the principals table; construct StateStore on this database first');
      }
      database.exec(`
      CREATE TABLE mcp_gateway_servers (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT,
        transport TEXT NOT NULL CHECK (transport IN ('streamable-http', 'sse')),
        endpoint TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('unknown', 'connected', 'connecting', 'disconnected', 'error', 'disabled')),
        tool_count INTEGER NOT NULL DEFAULT 0,
        last_connected_at INTEGER,
        last_error TEXT,
        last_checked_at INTEGER,
        permission_default TEXT NOT NULL CHECK (permission_default IN ('allow', 'deny')),
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DELETED')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(principal_id, id),
        UNIQUE(principal_id, name)
      );
      CREATE INDEX mcp_servers_principal_updated ON mcp_gateway_servers(principal_id, updated_at DESC, id);

      CREATE TABLE mcp_gateway_tools (
        id TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        upstream_name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        schema_bytes INTEGER NOT NULL DEFAULT 0,
        annotations_json TEXT,
        availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
        discovered_at INTEGER NOT NULL,
        PRIMARY KEY(principal_id, server_id, upstream_name),
        UNIQUE(principal_id, qualified_name),
        FOREIGN KEY(principal_id, server_id) REFERENCES mcp_gateway_servers(principal_id, id) ON DELETE CASCADE
      );
      CREATE INDEX mcp_tools_principal_server ON mcp_gateway_tools(principal_id, server_id);

      CREATE TABLE mcp_gateway_tool_permissions (
        principal_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        permission TEXT NOT NULL CHECK (permission IN ('allow', 'deny')),
        PRIMARY KEY(principal_id, server_id, tool_name),
        FOREIGN KEY(principal_id, server_id) REFERENCES mcp_gateway_servers(principal_id, id) ON DELETE CASCADE
      );

      CREATE TABLE mcp_gateway_traces (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        server_id TEXT,
        server_name TEXT NOT NULL,
        tool TEXT,
        operation TEXT NOT NULL,
        client_id TEXT,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error', 'denied')),
        error_code TEXT,
        error_message TEXT,
        request_bytes INTEGER,
        response_bytes INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX mcp_traces_principal_created ON mcp_gateway_traces(principal_id, created_at DESC, id);
      CREATE INDEX mcp_traces_principal_server ON mcp_gateway_traces(principal_id, server_id, created_at DESC);

      UPDATE metadata_schema_meta SET version = 6 WHERE singleton = 1;
    `);
    }
    const migrated = (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number }).version;
    if (migrated !== 6) throw new Error(`unsupported metadata schema version ${migrated}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

const metadataVersion = (database: DatabaseSync): number | undefined =>
  (database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined)?.version;

/** Unwind a v6 ledger to v5. Must run before the caller opens its own transaction. */
function unwindFromV6(database: DatabaseSync): void {
  if (metadataVersion(database) === 6) downgradeMetadataSchemaToV5(database);
}

export function downgradeMetadataSchemaToV5(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || row.version !== 6) throw new Error('metadata schema must be version 6 before downgrade');
    database.exec(`
      DROP TABLE IF EXISTS mcp_gateway_traces;
      DROP TABLE IF EXISTS mcp_gateway_tool_permissions;
      DROP TABLE IF EXISTS mcp_gateway_tools;
      DROP TABLE IF EXISTS mcp_gateway_servers;
      UPDATE metadata_schema_meta SET version = 5 WHERE singleton = 1;
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function downgradeMetadataSchemaToV4(database: DatabaseSync): void {
  unwindFromV6(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || row.version !== 5) throw new Error('metadata schema must be version 5 before downgrade');
    database.exec(`
      ALTER TABLE secret_references DROP COLUMN purpose;
      ALTER TABLE global_secret_references DROP COLUMN purpose;
      UPDATE metadata_schema_meta SET version = 4 WHERE singleton = 1;
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function downgradeMetadataSchemaToV3(database: DatabaseSync): void {
  unwindFromV6(database);
  if (metadataVersion(database) === 5) {
    downgradeMetadataSchemaToV4(database);
  }
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
  unwindFromV6(database);
  if (metadataVersion(database) === 5) {
    downgradeMetadataSchemaToV4(database);
  }
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
  unwindFromV6(database);
  if (metadataVersion(database) === 5) {
    downgradeMetadataSchemaToV4(database);
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || (row.version !== 2 && row.version !== 3 && row.version !== 4 && row.version !== 5 && row.version !== 6)) throw new Error('metadata schema must be version 2, 3, 4, 5, or 6 before downgrade');
    if (row.version === 4) {
      database.exec(`
        DROP TABLE IF EXISTS global_secret_versions;
        DROP TABLE IF EXISTS global_secret_references;
      `);
    }
    if (row.version >= 3) {
      database.exec(`
        ALTER TABLE secret_references DROP COLUMN description;
      `);
    }
    database.exec(`
      DROP TABLE IF EXISTS api_keys;
      DROP INDEX IF EXISTS api_keys_principal_created;
      DROP INDEX IF EXISTS api_keys_active_expiry;
      UPDATE metadata_schema_meta SET version = 1 WHERE singleton = 1;
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
