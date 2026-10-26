import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeAutomationSchema } from '../src/automation-schema.js';

// The tables as the first release created them: GitHub-only connections and no provider columns.
const FIRST_RELEASE_DDL = `
  CREATE TABLE automation_connections (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('github')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    generation INTEGER NOT NULL CHECK(generation > 0),
    secret_generation INTEGER NOT NULL CHECK(secret_generation > 0),
    secret_json TEXT NOT NULL,
    secret_rotated_at INTEGER NOT NULL,
    last_delivery_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX automation_connections_owner ON automation_connections(owner_id);
  CREATE TABLE automation_deliveries (
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
  CREATE TABLE automation_workflows (
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
`;

// The first release's own write, which names its columns.
const insertConnection = (database: DatabaseSync, id: string, provider: string): void => {
  database.prepare(`INSERT INTO automation_connections
    (id, owner_id, provider, name, enabled, generation, secret_generation, secret_json, secret_rotated_at, last_delivery_at, created_at, updated_at)
    VALUES (?, 'owner', ?, 'Main', 1, 3, 2, '{"sealed":true}', 10, 20, 1, 30)`).run(id, provider);
};

const columns = (database: DatabaseSync, table: string): string[] =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((entry) => entry.name);

const connectionsSql = (database: DatabaseSync): string =>
  (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_connections'").get() as { sql: string }).sql;

describe('automation schema', () => {
  const databases: DatabaseSync[] = [];
  const open = (): DatabaseSync => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    return database;
  };
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  it('widens a first-release connections table without losing rows or columns', () => {
    const database = open();
    database.exec(FIRST_RELEASE_DDL);
    insertConnection(database, 'ahc_old', 'github');

    initializeAutomationSchema(database);

    expect(connectionsSql(database)).toContain("'linear'");
    expect(database.prepare('SELECT * FROM automation_connections WHERE id = ? AND provider = ?').get('ahc_old', 'github')).toEqual({
      id: 'ahc_old', owner_id: 'owner', provider: 'github', name: 'Main', enabled: 1, generation: 3, secret_generation: 2,
      secret_json: '{"sealed":true}', secret_rotated_at: 10, last_delivery_at: 20, created_at: 1, updated_at: 30,
      outbound_json: null, config_json: null
    });
    expect(columns(database, 'automation_deliveries')).toEqual(expect.arrayContaining(['provider', 'event_json']));
    expect(columns(database, 'automation_workflows')).toEqual(expect.arrayContaining(['provider', 'resource_ref', 'publish_ref_json']));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'automation_connections_owner'").get()).toBeDefined();
  });

  it('accepts every provider after widening and still rejects an unknown one', () => {
    const database = open();
    database.exec(FIRST_RELEASE_DDL);
    initializeAutomationSchema(database);
    for (const provider of ['github', 'linear', 'jira', 'custom']) insertConnection(database, `ahc_${provider}`, provider);
    expect(() => insertConnection(database, 'ahc_other', 'gitlab')).toThrow(/CHECK/);
  });

  it('is idempotent on a fresh and on a widened database', () => {
    const fresh = open();
    initializeAutomationSchema(fresh);
    initializeAutomationSchema(fresh);
    expect(columns(fresh, 'automation_connections')).toEqual(expect.arrayContaining(['outbound_json', 'config_json']));

    const widened = open();
    widened.exec(FIRST_RELEASE_DDL);
    insertConnection(widened, 'ahc_old', 'github');
    initializeAutomationSchema(widened);
    const before = connectionsSql(widened);
    initializeAutomationSchema(widened);
    expect(connectionsSql(widened)).toBe(before);
    expect(widened.prepare('SELECT count(*) AS count FROM automation_connections').get()).toEqual({ count: 1 });
  });

  it('widens a table that admits only some providers and keeps its later columns', () => {
    const database = open();
    database.exec(FIRST_RELEASE_DDL.replace("CHECK(provider IN ('github'))", "CHECK(provider IN ('github', 'custom'))"));
    database.exec('ALTER TABLE automation_connections ADD COLUMN outbound_json TEXT; ALTER TABLE automation_connections ADD COLUMN config_json TEXT');
    insertConnection(database, 'ahc_custom', 'custom');
    database.prepare("UPDATE automation_connections SET outbound_json = '{\"sealed\":1}', config_json = '{\"baseUrl\":\"x\"}'").run();

    initializeAutomationSchema(database);

    insertConnection(database, 'ahc_jira', 'jira');
    expect(database.prepare("SELECT outbound_json, config_json FROM automation_connections WHERE id = 'ahc_custom'").get())
      .toEqual({ outbound_json: '{"sealed":1}', config_json: '{"baseUrl":"x"}' });
  });

  it('leaves the original table intact when the widening copy fails', () => {
    const database = open();
    database.exec(FIRST_RELEASE_DDL);
    insertConnection(database, 'ahc_old', 'github');
    // A leftover table under the rebuild name makes the copy fail part way.
    database.exec('CREATE TABLE automation_connections_widened (id TEXT)');
    expect(() => initializeAutomationSchema(database)).toThrow();
    expect(connectionsSql(database)).not.toContain("'linear'");
    expect(database.prepare('SELECT id FROM automation_connections').all()).toEqual([{ id: 'ahc_old' }]);
  });
});
