import type { DatabaseSync } from 'node:sqlite';
import { AutomationProviderSchema } from '@cloud-harness/contracts';
import { initializeCodingActionSchema } from './agent-governance/action-schema.js';
import { initializeAgentApprovalSchema } from './agent-governance/approval-schema.js';

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
      state TEXT NOT NULL CHECK(state IN ('QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_HUMAN', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
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
      ON automation_workflows(rule_id, resource_key) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_HUMAN');
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
  initializeAgentApprovalSchema(database);
  ensureWorkflowStateWaiting(database);
}

const ONE_ACTIVE_INDEX = 'automation_workflows_one_active';
const ONE_ACTIVE_SQL = `CREATE UNIQUE INDEX ${ONE_ACTIVE_INDEX}
  ON automation_workflows(rule_id, resource_key) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_HUMAN')`;
const STATE_CHECK = /CHECK\s*\(\s*state\s+IN\s*\(([^()]*)\)\s*\)/u;

export class WorkflowSchemaMigrationError extends Error {}

/**
 * Widens the workflow state CHECK of a database created before WAITING_FOR_HUMAN existed. SQLite cannot
 * alter a CHECK, so the table is rebuilt once from its own stored definition (which already carries
 * every column added in place), inside a savepoint: copy the rows by explicit column list, swap the
 * tables, and recreate every index, with the one-active index now also covering waiting workflows.
 * Before release the row count, the index set and `PRAGMA integrity_check` must match; anything else
 * rolls the rebuild back and throws, so startup stops instead of running on a damaged table. A database
 * whose CHECK already names the state is left alone, which makes the call idempotent.
 */
export function ensureWorkflowStateWaiting(database: DatabaseSync): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_workflows'").get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'WAITING_FOR_HUMAN'")) return;
  const check = STATE_CHECK.exec(table.sql);
  if (!check) throw new WorkflowSchemaMigrationError('automation_workflows has no recognisable state CHECK');
  const states = check[1]!.split(',').map((value) => value.trim());
  const running = states.indexOf("'RUNNING'");
  if (running < 0) throw new WorkflowSchemaMigrationError('automation_workflows state CHECK has no RUNNING state');
  const widened = [...states.slice(0, running + 1), "'WAITING_FOR_HUMAN'", ...states.slice(running + 1)];
  const createV2 = table.sql
    .replace(STATE_CHECK, `CHECK(state IN (${widened.join(', ')}))`)
    .replace(/^CREATE TABLE\s+("?automation_workflows"?|\[automation_workflows\]|`automation_workflows`)/u, 'CREATE TABLE automation_workflows_v2');
  if (!createV2.startsWith('CREATE TABLE automation_workflows_v2')) throw new WorkflowSchemaMigrationError('automation_workflows definition is not recognisable');
  const indexes = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'automation_workflows' AND sql IS NOT NULL ORDER BY name")
    .all() as { name: string; sql: string }[];
  const columns = (database.prepare('PRAGMA table_info(automation_workflows)').all() as { name: string }[]).map((column) => `"${column.name}"`).join(', ');
  database.exec('SAVEPOINT automation_workflows_waiting');
  try {
    const before = (database.prepare('SELECT COUNT(*) AS count FROM automation_workflows').get() as { count: number }).count;
    database.exec('DROP TABLE IF EXISTS automation_workflows_v2');
    database.exec(createV2);
    database.exec(`INSERT INTO automation_workflows_v2 (${columns}) SELECT ${columns} FROM automation_workflows`);
    database.exec('DROP TABLE automation_workflows');
    database.exec('ALTER TABLE automation_workflows_v2 RENAME TO automation_workflows');
    for (const index of indexes) database.exec(index.name === ONE_ACTIVE_INDEX ? ONE_ACTIVE_SQL : index.sql);
    if (!indexes.some((index) => index.name === ONE_ACTIVE_INDEX)) database.exec(ONE_ACTIVE_SQL);
    const after = (database.prepare('SELECT COUNT(*) AS count FROM automation_workflows').get() as { count: number }).count;
    const rebuilt = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'automation_workflows' AND sql IS NOT NULL")
      .all() as { name: string }[]).map((index) => index.name));
    const integrity = database.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (after !== before) throw new WorkflowSchemaMigrationError(`automation_workflows rebuild changed the row count (${before} to ${after})`);
    if (!indexes.every((index) => rebuilt.has(index.name)) || !rebuilt.has(ONE_ACTIVE_INDEX)) throw new WorkflowSchemaMigrationError('automation_workflows rebuild lost an index');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new WorkflowSchemaMigrationError('automation_workflows rebuild failed the integrity check');
    database.exec('RELEASE automation_workflows_waiting');
  } catch (error) {
    database.exec('ROLLBACK TO automation_workflows_waiting');
    database.exec('RELEASE automation_workflows_waiting');
    throw error;
  }
}
