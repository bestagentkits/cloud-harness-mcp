# Phase 01 (PR1): Durable agent traces, MCP read tools, Dashboard Traces (#394)

Branch: `feat/394-agent-traces` from `origin/dev`. Target `dev`. Effort about 24h.
Wave W1, which can run in parallel with PR2. Merges first.

## Context

- Pi events are projected in `apps/agent-runtime/src/agent-worker.ts:189-197` through
  `projectAgentEvent` (`apps/agent-runtime/src/events.ts`). Turns, text deltas, tools,
  queue and notices reach the runner as bounded JSON records. Cumulative `usage` is
  emitted on `turn_end` and `agent_end`.
- `AgentManager` (`apps/runner/src/agent-manager.ts`) is the single runner-side
  consumer. Its hook points are `spawn` :290, `launch` :425, `onRecord` :651,
  `proxyTool` :677, `cleanup` :795 (where `gateway.revokeAndDrain` returns the
  settlement that `spendLedger.settle` records), `finishTerminal` :862, `interrupt`
  :880, `reconcileInterrupted` :897, `reap` :906, and `reconcileUsage` :983.
- Agent rows and usage are deleted on compaction
  (`apps/runner/src/agent-state-repository.ts:1040`). Traces therefore need their own
  tables and retention.
- The profile revision is resolved at spawn (`agent-manager.ts:54`, `:355`).
- `parent_agent_id` exists on `agents` (`principal-store.ts:406` onward).

## Data flow

```
Pi session event -> projectAgentEvent -> runner record (bounded JSON)
  -> AgentManager.onRecord -> AgentTraceRecorder.observe(record)
       turn_started   => open model_call span (runner clock start)
       first text_delta => set ttft_ms (in memory, written at turn end)
       turn_ended + usage => close model_call span; usage = reconcileUsage delta
       tool started/ended => open/close tool_call span (digest of input, outcome)
       notice(auto-retry) => attribute retry_count on current model_call
  -> AgentManager.proxyTool => tool_call span for brokered proxy ops
  -> cleanup(settlement) => gateway span (reasoning tokens, requests, requestsWithoutUsage, costMicros)
       => trace reconciliation record (ledger vs span sums)
  -> finishTerminal/interrupt/reap => close agent_run span, trace state + finish reason
  -> reconcileInterrupted (startup) => open traces INCOMPLETE, open spans UNKNOWN
MCP / Dashboard read: tool -> runner op -> AgentTraceStore (owner-scoped) -> redacted DTO
```

Writes are batched per span boundary: there is no write per `text_delta`.

## Files to create

| File | Purpose |
|------|---------|
| `packages/contracts/src/agent-traces-api.ts` | Trace/span DTOs, span kind and state enums, list/get/spans/export input and result schemas, `TRACE_SPAN_KINDS` (agent_run, model_call, tool_call, gateway, budget, hook, plus workflow, action, decision, approval reserved for later PRs) |
| `packages/contracts/test/agent-traces-api.test.ts` | Schema bounds, redaction-safe shapes, cursor format |
| `apps/runner/src/agent-trace-schema.ts` | `initializeAgentTraceSchema(database)`: additive and idempotent |
| `apps/runner/src/agent-trace-store.ts` | Insert/update spans, cursor pages, aggregates (p50/p95, TTFT), retention purge, quota enforcement |
| `apps/runner/src/agent-trace-recorder.ts` | Stateful per-agent recorder with in-memory open spans, observe/finish hooks, attribute allowlist and redaction, reconciliation |
| `apps/runner/src/agent-trace-export.ts` | `json` and pull-only `otlp-json` mapping. No network. |
| `apps/runner/test/support/agent-runtime-fakes.ts` | Shared scripted launcher/gateway that emits turns, usage, tools, settlements and terminal states. Reused by PR4 and PR6. |
| `apps/runner/test/agent-trace-store.test.ts` | Schema idempotency, indexes, cursors, retention, quota, aggregates |
| `apps/runner/test/agent-trace-recorder.test.ts` | Failure matrix (below) |
| `apps/runner/test/agent-manager-traces.test.ts` | End-to-end through AgentManager with the fakes |
| `apps/api/src/dashboard-traces-router.ts` | `GET /dashboard/api/traces`, `/traces/:traceId`, `/traces/:traceId/spans`, `/traces/:traceId/export` |
| `apps/api/test/dashboard-traces-router.test.ts` | Auth, owner scoping, redaction, export content-type |
| `apps/api/dashboard/dashboard-traces.js` | List view with filters and summary; detail with waterfall and span table; cursor paging |
| `apps/api/test/dashboard-traces-ui.test.ts` | Render contract (no secret fields, unknown shown as "unknown", not 0) |
| `test/integration/agent-traces-http.test.ts` | MCP tools over HTTP: concurrent cursors, gap/expiry detection, cross-principal forbidden |
| `docs-site/dashboard/traces.md` | User guide |

## Files to modify (append-only where marked)

| File | Change |
|------|--------|
| `packages/contracts/src/index.ts` | Append `export * from './agent-traces-api.js'` |
| `packages/contracts/src/runner-api.ts` | Add `agent_traces_list`, `agent_trace_get`, `agent_trace_spans`, `agent_trace_export` to `RunnerOperationSchema` (:4) and their input map |
| `packages/contracts/src/tool-schemas.ts` | Four `TOOL_SPECS` entries (:1475). All are read-only and idempotent (add to the sets at :1425 onward), none open-world |
| `packages/contracts/src/config.ts` | Append the trace flag block: `agentTraces: { enabled (false), retentionDays (14, 1-90), maxSpansPerTrace (2000), maxTracesPerPrincipal (5000), previewBytes (0, max 512) }` |
| `apps/runner/src/config.ts` | Map `AGENT_TRACES_ENABLED`, `AGENT_TRACE_RETENTION_DAYS`, `AGENT_TRACE_MAX_SPANS`, `AGENT_TRACE_MAX_PER_PRINCIPAL`, `AGENT_TRACE_PREVIEW_BYTES` |
| `.env.example` | Same keys, commented, defaults off |
| `apps/runner/src/agent-manager.ts` | Optional `traceRecorder` dependency. Calls at spawn, launch, onRecord, proxyTool, cleanup, finishTerminal, interrupt, reconcileInterrupted, reap and reconcileUsage. Every recorder call is wrapped so a trace failure never fails the agent: log once, mark the trace `coverage: partial` |
| `apps/runner/src/workspace-service.ts` | Construct the recorder when the flag is on and pass it into AgentManager (:382). One dispatch case for the four ops in `execute` (:2976), placed in the owner-scoped early branch, since traces outlive workspaces |
| `apps/runner/src/state-store.ts` | Call `initializeAgentTraceSchema` next to the automation initializer |
| `apps/runner/src/index.ts` | Schedule the retention purge alongside existing maintenance timers |
| `apps/agent-runtime/src/events.ts` | Optional bounded `outcome` and `errorClass` on `turn_ended` (backward compatible; old images report `unknown`) |
| `apps/agent-runtime/src/protocol-schemas.ts` | Matching optional fields |
| `apps/api/src/dashboard-router.ts` | Mount `dashboard-traces-router` |
| `apps/api/dashboard/dashboard-pages.js`, `apps/api/src/dashboard-assets.ts` | Register `/dashboard/traces` and `/dashboard/traces/:id`, plus the new asset (parity test `apps/api/test/dashboard-pages.test.ts`) |
| `apps/api/dashboard/dashboard.js` | Route-switch entries. Traces tab hook in `loadAgentDetail` (:4192), reusing #393's `createAgentRefresh` if it has merged |
| `apps/api/dashboard/dashboard-render.js` | Traces tab in `renderAgentDetail` (:353). "View trace" link in `renderAutomationRunDetail` (:2680) |
| `apps/api/dashboard/dashboard.css` | Delimited `/* traces */` section at the end |
| `test/e2e/pi-agent.docker.test.ts` | After exit, assert one trace with 3 model_call spans, 2 tool_call spans, matching profile revision, and token sums equal to `agent_usage` |
| `docs/mcp-api.md`, `docs/system-architecture.md`, `docs/configuration.md`, `docs/security-model.md` (redaction, retention, no push egress) | Behavioural docs |
| `.agents/skills/cloudharness/SKILL.md` and `references/` | Document all four tools exactly once (skill contract test) |

## Must not touch

`principal-store.ts` migration chain, `agent-state-repository.ts` compaction (traces must
not depend on it), `automation-service.ts`, `event-outbox.ts`, the `apps/runner/src/decision-plane/` directory,
`apps/model-gateway/**` except reading the fake provider, `apps/api/dashboard/dashboard-api.js`.

## Schema

`initializeAgentTraceSchema` creates the following with `CREATE TABLE IF NOT EXISTS`,
no FKs and no `schema_meta` bump:

- `agent_traces(trace_id PK, principal_id, workspace_id, agent_id, generation, run_id, parent_trace_id, workflow_id NULL, profile_id, profile_revision_id, state CHECK(RUNNING,COMPLETED,FAILED,CANCELLED,TIMED_OUT,EXPIRED,INCOMPLETE), finish_reason, started_at, ended_at, prompt_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, requests, requests_without_usage, cost_micros, cost_provenance CHECK(estimated,gateway_settlement,unknown), reconciliation_json, coverage CHECK(full,partial), span_count, truncated, expires_at)`.
  Indexes: `(principal_id, started_at DESC)`, `(principal_id, profile_id, started_at)`,
  `(agent_id)`, `(workflow_id)`, `(expires_at)`.
- `agent_trace_spans(trace_id, span_seq, span_id, parent_span_id, kind, name, state CHECK(OPEN,OK,ERROR,UNKNOWN), started_at, ended_at, ttft_ms, prompt_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, attributes_json, input_digest, error_class, PRIMARY KEY(trace_id, span_seq))`.
  Index `(trace_id, kind)`.

There are deliberately no foreign keys. `agent_effects` cascades on workspace delete
(`apps/runner/src/principal-store.ts:468-489`), and traces must survive both workspace delete and
compaction. `agent-trace-store.test.ts` deletes the workspace row with
`PRAGMA foreign_keys=ON` and asserts the trace and spans are still readable.

Trace ID: `trc_` plus the base32 of `sha256(agentId|generation)`, truncated, so restart
re-attachment is deterministic. Timestamps use the runner clock only.

## Failure matrix (agent-trace-recorder tests)

Each case must assert trace state, span states and totals:

1. Two model calls and two tools succeed.
2. Gateway 401/429/500: model_call ERROR with `error_class`; retries as attributes with no double count.
3. Missing usage: span tokens are null, `requests_without_usage` comes from the settlement, coverage partial.
4. Stream termination mid-turn: span UNKNOWN, trace FAILED.
5. Cancel, timeout, lease expiry, reap.
6. Runner crash: `reconcileInterrupted` sets INCOMPLETE and leaves open spans UNKNOWN.
7. Nested child agent: `parent_trace_id` set; parent totals exclude the child; list aggregates do not double count.
8. Span cap reached: `truncated=1`, a final marker span, no unbounded growth.
9. Retention expiry: purge removes the trace; cursor reads return `TRACE_EXPIRED`.
10. Redaction: tool inputs containing secrets are stored only as digests. Previews (when bytes > 0) pass `redact()`.
11. Overhead: the write count for N text deltas is O(turns), not O(deltas).

## Reconciliation tolerance

Token sums across model_call spans equal the `agent_usage` delta sum exactly. Cost differs by at most
1 micro-dollar per span (floor rounding from `reconcileUsage`). A larger gap is
recorded in `reconciliation_json` and shown as "unreconciled". Document this in `docs/mcp-api.md`.
p50/p95 and TTFT are reported only where both timestamps exist; per-profile cohorts
are reported only when n >= 20, otherwise `insufficient_sample`.

## Tests (Windows-friendly)

```
npm run build -w @cloud-harness/contracts
npx vitest run packages/contracts/test/agent-traces-api.test.ts
npx vitest run apps/runner/test/agent-trace-store.test.ts apps/runner/test/agent-trace-recorder.test.ts apps/runner/test/agent-manager-traces.test.ts
npx vitest run apps/agent-runtime/test
npx vitest run apps/api/test/dashboard-traces-router.test.ts apps/api/test/dashboard-traces-ui.test.ts apps/api/test/dashboard-pages.test.ts
npm run build -w @cloud-harness/api
npx vitest run test/integration/agent-traces-http.test.ts
npx vitest run packages/contracts/test/cloudharness-skill-contract.test.ts
npm run typecheck && npm run lint && npm run plugin:sync && npm run plugin:check
npm run docs:reference && npm run docs:check
```

CI coverage: everything above is in `npm run verify`. `test/e2e/pi-agent.docker.test.ts`
runs in the Docker job through `npm run test:e2e`; it is Linux-only locally.

## Feature flag

`AGENT_TRACES_ENABLED=false` by default. When off, no recorder is constructed, the tools
return `FEATURE_DISABLED`, and the Dashboard hides the nav entry. The schema initializer always
runs, because it is inert.

## Docs

`docs/mcp-api.md` (tools, cursor semantics, tolerance), `docs/configuration.md`,
`docs/security-model.md`, `docs/system-architecture.md`, `docs-site/dashboard/traces.md`,
`docs-site/dashboard/` navigation, generated references, and the skill.

## Risks

| Risk | L x I | Mitigation |
|------|-------|------------|
| Recorder exception breaks the agent lifecycle | M x H | All calls are guarded; failures downgrade coverage; a test injects a store failure |
| Write amplification on long runs | M x M | Span-boundary writes only; span cap; overhead test |
| Secret leakage via tool args | L x H | Digests by default, preview 0 bytes, `redact()`, a test with a seeded secret across MCP, browser and export |
| Conflict with #393 and #408 in dashboard and workspace-service | H x M | Append-only edits; rebase; hook #393's refresh when it is present |
| Pi `message_end` usage shape is unverified locally | M x M | Use the runner-side cumulative usage already consumed by `reconcileUsage`; do not depend on Pi internals |

## Rollback

Set `AGENT_TRACES_ENABLED=false`. Reverting the code leaves the two tables orphaned and harmless.
They can optionally be dropped manually by the owner. No other table changes.
