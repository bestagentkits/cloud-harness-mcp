# Agent traces

Every coding-agent run (`agent_spawn`) leaves one durable trace when the
operator has enabled agent traces. A trace records the run, each model call,
each tool call, its budget events (cost reservation, lease issue, a limit that
ended the run, and the settlement), and the gateway settlement as spans with
identifiers, timings, tokens, cost, and outcome. Prompts, model output, and
credentials are never recorded. Tool arguments are recorded only as a one-way
digest, unless the operator sets `AGENT_TRACE_PREVIEW_BYTES` to keep a short,
redacted preview (off by default, at most 512 bytes).

Use traces to answer "where did the time and money go" after a run, to compare
model profiles, and to explain a failed, cancelled, or timed-out run. Use
`agent_status` and `agent_logs` while a run is still in progress.

## Rules

- All four tools are read-only and scoped to your identity. Another identity's
  trace is reported as `NOT_FOUND`, exactly like a missing one.
- `FEATURE_DISABLED` means the operator has not enabled traces. Do not retry;
  fall back to `agent_status` usage.
- A trace outlives its workspace until retention removes it. `TRACE_EXPIRED`
  means retention removed the trace, or the page a cursor continued from.
  Restart the listing without a cursor.
- A cursor belongs to the call and filters that returned it. Reusing it with
  different filters fails with `INVALID_INPUT`.
- A figure the runner did not observe is `null`, never `0`. Latency
  percentiles and time to first token appear only when timed samples exist;
  per-profile cohorts need at least 20 traces.
- `coverage` is about data completeness, not the outcome. It is `"partial"`
  when a runner restart interrupted the run, recording degraded, the span cap
  truncated the trace, a model call reported no usage, a span ended `UNKNOWN`
  (the run never closed it), no gateway settlement arrived, or the gateway
  counted requests without usage. A failed run with complete data is `"full"`.
- `tokens.prompt` is uncached input; the whole prompt is
  `prompt + cacheRead + cacheWrite`.
- The `hook` span kind is reserved: no operation an agent can reach runs a
  workspace hook, so agent traces never contain one.
- A trace of an agent a coding automation started carries that run's
  `workflowId`, so `agent_traces_list` with `workflowId` finds it. Each brokered
  action (an edit, a command, a commit, a push, the pull request) adds an
  `action` span with its decision, reason code and outcome. The runner commits
  and publishes after the agent ends, so `action` spans can be appended to a
  trace that is already finished; read the spans again rather than treating a
  finished trace as frozen.
- `reconciliationStatus` compares model-call span sums with the agent usage
  ledger: tokens must match exactly; cost may differ by one micro-dollar per
  model call of rounding. `unreconciled` lists its reasons on the trace.

<!-- cloudharness-tool:agent_traces_list -->
### `agent_traces_list`

List your traces, newest first, with KPI aggregates over the filtered window
on the first page.

- Optional filters: `workspaceId`, `agentId`, `profileId`, `state`,
  `workflowId`, `since`, `until` (ISO timestamps; `since` before `until`).
- Optional paging: `cursor`, `limit` (1–100, default 25).
- `summary` carries state counts, token and cost totals, model-call p50/p95,
  time to first token, and per-profile cohorts. It is `null` on a page read
  with a `cursor`, or with `includeSummary: false` (use that when you only
  need rows). Its `costMicros` is `null` when no trace has a known cost.

<!-- cloudharness-example:agent_traces_list
{"agentId":"agent_aaaaaaaaaaaaaaaaaaaa","state":"FAILED","limit":25}
-->

<!-- cloudharness-tool:agent_trace_get -->
### `agent_trace_get`

Read one trace: state, finish reason, model profile and revision, totals with
cost provenance, coverage, and the reconciliation detail.

- Required: `traceId`, copied from a list result.

<!-- cloudharness-example:agent_trace_get
{"traceId":"trc_aaaaaaaaaaaaaaaaaaaaaaaaaa"}
-->

<!-- cloudharness-tool:agent_trace_spans -->
### `agent_trace_spans`

Page through one trace's spans in recording order (span sequence, not start
time): `agent_run`, `model_call`, `tool_call`, `budget`, `gateway`, and, for a
coding automation, `action`. Tool
calls carry the operation name, outcome, and an input digest, plus a redacted
preview only when the operator enabled one. A failed model call's `errorClass`
`budget` is a gateway budget refusal (raise the agent's budget, up to the model
profile's limits); `rate_limit` is
provider throttling (wait and retry).

- Required: `traceId`. Optional: `kind`, `cursor`, `limit` (1–500, default 200).

<!-- cloudharness-example:agent_trace_spans
{"traceId":"trc_aaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"model_call","limit":200}
-->

<!-- cloudharness-tool:agent_trace_export -->
### `agent_trace_export`

Export one trace as a bounded document you pull: `json` (trace and spans),
`csv` (one row per span), or `otlp-json` (OpenTelemetry OTLP/JSON). Nothing is
pushed to a collector. `truncated: true` means the document hit its size bound.

- Required: `traceId`. Optional: `format` (default `json`).

<!-- cloudharness-example:agent_trace_export
{"traceId":"trc_aaaaaaaaaaaaaaaaaaaaaaaaaa","format":"otlp-json"}
-->
