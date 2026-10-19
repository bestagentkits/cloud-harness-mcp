import type { DatabaseSync } from 'node:sqlite';

/**
 * Creates the durable agent trace tables. Additive and idempotent, with no schema version bump and
 * deliberately no foreign keys: agent rows, usage and effects are compacted or cascade on workspace
 * delete, and a trace must survive both until its own retention removes it. Rows hold identifiers,
 * runner-clock timestamps, token and cost figures, bounded outcomes and digests only.
 */
export function initializeAgentTraceSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_traces (
      trace_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      run_id TEXT,
      parent_trace_id TEXT,
      workflow_id TEXT,
      profile_id TEXT,
      profile_revision_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETED','FAILED','CANCELLED','TIMED_OUT','EXPIRED','INCOMPLETE')),
      finish_reason TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      prompt_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      requests INTEGER,
      requests_without_usage INTEGER,
      cost_micros INTEGER,
      cost_provenance TEXT NOT NULL CHECK(cost_provenance IN ('estimated','gateway_settlement','unknown')),
      reconciliation_json TEXT,
      coverage TEXT NOT NULL CHECK(coverage IN ('full','partial')),
      span_count INTEGER NOT NULL DEFAULT 0 CHECK(span_count >= 0),
      truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
      expires_at INTEGER NOT NULL
    );
    DROP INDEX IF EXISTS agent_traces_principal_started;
    CREATE INDEX IF NOT EXISTS agent_traces_principal_started_trace ON agent_traces(principal_id, started_at, trace_id);
    CREATE INDEX IF NOT EXISTS agent_traces_principal_profile ON agent_traces(principal_id, profile_id, started_at);
    CREATE INDEX IF NOT EXISTS agent_traces_agent ON agent_traces(agent_id);
    CREATE INDEX IF NOT EXISTS agent_traces_workflow ON agent_traces(workflow_id);
    CREATE INDEX IF NOT EXISTS agent_traces_expires ON agent_traces(expires_at);
    CREATE TABLE IF NOT EXISTS agent_trace_spans (
      trace_id TEXT NOT NULL,
      span_seq INTEGER NOT NULL CHECK(span_seq >= 0),
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('OPEN','OK','ERROR','UNKNOWN')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      ttft_ms INTEGER,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_micros INTEGER,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      input_digest TEXT,
      error_class TEXT,
      PRIMARY KEY(trace_id, span_seq)
    );
    CREATE INDEX IF NOT EXISTS agent_trace_spans_kind ON agent_trace_spans(trace_id, kind);
  `);
}
