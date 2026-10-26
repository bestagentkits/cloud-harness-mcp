import type { DatabaseSync } from 'node:sqlite';
import { AutomationProviderSchema } from '@cloud-harness/contracts';
import { initializeCodingActionSchema } from './agent-governance/action-schema.js';

/** Every provider the stored CHECK must admit, as SQL string literals. */
const PROVIDER_LITERALS = AutomationProviderSchema.options.map((provider) => `'${provider}'`);

const connectionsTable = (name: string): string => `
    CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN (${PROVIDER_LITERALS.join(', ')})),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      generation INTEGER NOT NULL CHECK(generation > 0),
      secret_generation INTEGER NOT NULL CHECK(secret_generation > 0),
      secret_json TEXT NOT NULL,
      secret_rotated_at INTEGER NOT NULL,
      last_delivery_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      outbound_json TEXT,
      config_json TEXT
    )`;

/** Columns added after a table first shipped; all nullable, so older code that names its columns still writes rows. */
const ADDED_COLUMNS: readonly [table: string, column: string][] = [
  ['automation_deliveries', 'provider TEXT'],
  ['automation_deliveries', 'event_json TEXT'],
  ['automation_workflows', 'provider TEXT'],
  ['automation_workflows', 'resource_ref TEXT'],
  ['automation_workflows', 'publish_ref_json TEXT']
];

const tableColumns = (database: DatabaseSync, table: string): string[] =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((entry) => entry.name);

/**
 * The first release limited `provider` to GitHub with a CHECK constraint, which SQLite can only
 * change by rebuilding the table. The copy keeps every row and every column both definitions share,
 * runs in one savepoint, and is skipped once the stored definition admits every current provider.
 */
function widenConnectionProviders(database: DatabaseSync): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_connections'").get() as { sql: string } | undefined;
  if (!table) {
    database.exec(`${connectionsTable('automation_connections')};`);
    return;
  }
  if (PROVIDER_LITERALS.every((literal) => table.sql.includes(literal))) return;
  database.exec('SAVEPOINT automation_connections_widen');
  try {
    database.exec(`${connectionsTable('automation_connections_widened')};`);
    const kept = new Set(tableColumns(database, 'automation_connections'));
    const shared = tableColumns(database, 'automation_connections_widened').filter((column) => kept.has(column)).join(', ');
    database.exec(`INSERT INTO automation_connections_widened (${shared}) SELECT ${shared} FROM automation_connections;
      DROP TABLE automation_connections;
      ALTER TABLE automation_connections_widened RENAME TO automation_connections;`);
    database.exec('RELEASE automation_connections_widen');
  } catch (error) {
    database.exec('ROLLBACK TO automation_connections_widen');
    database.exec('RELEASE automation_connections_widen');
    throw error;
  }
}

function addMissingColumns(database: DatabaseSync): void {
  for (const [table, definition] of ADDED_COLUMNS) {
    const column = definition.split(' ', 1)[0]!;
    if (!tableColumns(database, table).includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

/**
 * Creates the webhook automation tables. Additive and idempotent, with no schema version bump and
 * no foreign keys, so an older release ignores them and a code-only rollback needs no data change:
 * older code reads rows with `SELECT *` and maps only the fields it knows, and inserts with an
 * explicit column list, so the added nullable columns are invisible to it.
 * Raw webhook payloads are never stored: a delivery keeps only its digest and the bounded,
 * normalized fields a rule matches on and an agent prompt quotes.
 *
 * Rule index columns are provider-neutral despite their names: `repository_key` holds the rule's
 * scope (repository, team key, project key, custom event name) and `label_key` its trigger value,
 * with an empty string for an omitted optional filter.
 */
export function initializeAutomationSchema(database: DatabaseSync): void {
  widenConnectionProviders(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS automation_connections_owner ON automation_connections(owner_id);
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      generation INTEGER NOT NULL CHECK(generation > 0),
      match_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      label_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automation_rules_owner ON automation_rules(owner_id, connection_id);
    CREATE INDEX IF NOT EXISTS automation_rules_match ON automation_rules(connection_id, repository_key, label_key);
    CREATE TABLE IF NOT EXISTS automation_deliveries (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider_delivery_id TEXT NOT NULL,
      provider_event TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      event_type TEXT,
      repository TEXT,
      resource_number INTEGER,
      resource_url TEXT,
      label TEXT,
      sender_login TEXT,
      sender_type TEXT,
      title TEXT,
      body TEXT,
      state TEXT NOT NULL CHECK(state IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'QUARANTINED')),
      outcome TEXT,
      workflows_created INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      UNIQUE(connection_id, provider_delivery_id)
    );
    CREATE INDEX IF NOT EXISTS automation_deliveries_owner ON automation_deliveries(owner_id, received_at);
    CREATE INDEX IF NOT EXISTS automation_deliveries_pending ON automation_deliveries(state, received_at);
    CREATE INDEX IF NOT EXISTS automation_deliveries_rate ON automation_deliveries(connection_id, received_at);
    CREATE INDEX IF NOT EXISTS automation_deliveries_payload ON automation_deliveries(connection_id, payload_sha256);
    CREATE TABLE IF NOT EXISTS automation_workflows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_generation INTEGER NOT NULL,
      rule_snapshot_json TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      repository TEXT NOT NULL,
      resource_number INTEGER NOT NULL,
      resource_url TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
      workspace_id TEXT,
      agent_id TEXT,
      agent_status TEXT,
      error_code TEXT,
      result_text TEXT,
      usage_json TEXT,
      publish_state TEXT NOT NULL CHECK(publish_state IN ('NONE', 'PENDING', 'DELIVERED', 'FAILED')),
      publish_attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      start_attempts INTEGER NOT NULL DEFAULT 0,
      workspace_closed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      UNIQUE(delivery_id, rule_id)
    );
    CREATE INDEX IF NOT EXISTS automation_workflows_owner ON automation_workflows(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS automation_workflows_state ON automation_workflows(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS automation_workflows_resource ON automation_workflows(rule_id, resource_key, terminal_at);
    CREATE UNIQUE INDEX IF NOT EXISTS automation_workflows_one_active
      ON automation_workflows(rule_id, resource_key) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');
    CREATE TABLE IF NOT EXISTS automation_transitions (
      workflow_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('system', 'owner')),
      code TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY(workflow_id, seq)
    );
  `);
  addMissingColumns(database);
  // Coding receipts and the nullable coding columns, added in place on existing databases.
  initializeCodingActionSchema(database);
}
