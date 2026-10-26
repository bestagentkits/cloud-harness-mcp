import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWorkflowStateWaiting, initializeAutomationSchema, WorkflowSchemaMigrationError } from '../src/automation-schema.js';

/** The workflow table as releases before WAITING_FOR_HUMAN created it. */
const NARROW_TABLE = `
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
  CREATE INDEX automation_workflows_owner ON automation_workflows(owner_id, created_at);
  CREATE INDEX automation_workflows_state ON automation_workflows(state, next_attempt_at);
  CREATE INDEX automation_workflows_resource ON automation_workflows(rule_id, resource_key, terminal_at);
  CREATE UNIQUE INDEX automation_workflows_one_active
    ON automation_workflows(rule_id, resource_key) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');
`;

const STATES = ['QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function narrowDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(NARROW_TABLE);
  STATES.forEach((state, index) => insert(database, `wfl_${index}`, state, `acme/widgets#${index}`));
  return database;
}

function insert(database: DatabaseSync, id: string, state: string, resourceKey: string, ruleId = 'rule_1'): void {
  database.prepare(`INSERT INTO automation_workflows (id, owner_id, rule_id, rule_generation, rule_snapshot_json, connection_id, delivery_id,
    event_type, repository, resource_number, resource_url, resource_key, label, prompt, state, publish_state, next_attempt_at, created_at, updated_at)
    VALUES (?, 'owner', ?, 1, '{}', 'con_1', ?, 'github.issue.label_added', 'acme/widgets', 7, 'https://github.com/acme/widgets/issues/7', ?,
    'claude', 'prompt', ?, 'NONE', 1, 1, 1)`).run(id, ruleId, `dlv_${id}`, resourceKey, state);
}

const tableSql = (database: DatabaseSync) =>
  (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_workflows'").get() as { sql: string }).sql;
const indexNames = (database: DatabaseSync) =>
  (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'automation_workflows' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);

describe('workflow state migration to WAITING_FOR_HUMAN', () => {
  it('widens the state CHECK once, keeping every row in every state and every index', () => {
    const database = narrowDatabase();
    const before = indexNames(database);
    initializeAutomationSchema(database);
    initializeAutomationSchema(database);

    expect(tableSql(database)).toContain("'WAITING_FOR_HUMAN'");
    expect(indexNames(database)).toEqual(expect.arrayContaining(before));
    const rows = database.prepare('SELECT id, state FROM automation_workflows ORDER BY id').all() as { id: string; state: string }[];
    expect(rows).toEqual(STATES.map((state, index) => ({ id: `wfl_${index}`, state })));
    // The in-place columns survived the rebuild with their defaults.
    expect(database.prepare("SELECT approval_generation, paused_ms FROM automation_workflows WHERE id = 'wfl_0'").get()).toEqual({ approval_generation: 0, paused_ms: 0 });
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('is a no-op on a database that already names the state', () => {
    const database = narrowDatabase();
    initializeAutomationSchema(database);
    const sql = tableSql(database);
    ensureWorkflowStateWaiting(database);
    expect(tableSql(database)).toBe(sql);
  });

  it('accepts a waiting workflow and still rejects an unknown state', () => {
    const database = narrowDatabase();
    initializeAutomationSchema(database);
    insert(database, 'wfl_waiting', 'WAITING_FOR_HUMAN', 'acme/widgets#100');
    expect(() => insert(database, 'wfl_bogus', 'PAUSED', 'acme/widgets#101')).toThrow(/CHECK constraint/u);
  });

  it('keeps one active workflow per rule and subject, a waiting one included', () => {
    const database = narrowDatabase();
    initializeAutomationSchema(database);
    insert(database, 'wfl_waiting', 'WAITING_FOR_HUMAN', 'acme/widgets#200');
    expect(() => insert(database, 'wfl_second', 'QUEUED', 'acme/widgets#200')).toThrow(/UNIQUE constraint/u);
    // A finished workflow for the same subject is not active.
    insert(database, 'wfl_done', 'COMPLETED', 'acme/widgets#200');
  });

  it('refuses a table whose state CHECK it cannot recognise and leaves it untouched', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec("CREATE TABLE automation_workflows (id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(length(state) > 0))");
    expect(() => ensureWorkflowStateWaiting(database)).toThrow(WorkflowSchemaMigrationError);
    expect(tableSql(database)).not.toContain('WAITING_FOR_HUMAN');
  });

  it('creates a fresh database with the waiting state directly', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    initializeAutomationSchema(database);
    expect(tableSql(database)).toContain("'WAITING_FOR_HUMAN'");
    expect(indexNames(database)).toContain('automation_workflows_one_active');
  });
});
