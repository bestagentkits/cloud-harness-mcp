# Agent traces

Every coding-agent run (`agent_spawn`) leaves one durable trace when the
operator has enabled agent traces. A trace records the run, each model call,
each tool call, and the gateway settlement as spans with identifiers, timings,
tokens, cost, and outcome only. Prompts, model output, tool arguments, and
credentials are never recorded, so a trace is safe to read and share with the
owner.

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
- `coverage: "partial"` marks a run that did not complete normally (cancelled,
  timed out, failed, lease expired, or interrupted by a runner restart). Spans
  the run never closed read `UNKNOWN`.
- `reconciliationStatus` compares model-call span sums with the agent usage
  ledger: tokens must match exactly; cost may differ by one micro-dollar per
  model call of rounding. `unreconciled` lists its reasons on the trace.

<!-- cloudharness-tool:agent_traces_list -->
### `agent_traces_list`

List your traces, newest first, with KPI aggregates over the filtered window.

- Optional filters: `workspaceId`, `agentId`, `profileId`, `state`,
  `workflowId`, `since`, `until` (ISO timestamps; `since` before `until`).
- Optional paging: `cursor`, `limit` (1–100, default 25).
- `summary` carries state counts, token and cost totals, model-call p50/p95,
  time to first token, and per-profile cohorts.

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

Page through one trace's spans in start order: `agent_run`, `model_call`,
`tool_call`, and `gateway`. Tool calls carry the operation name, outcome, and
an input digest only.

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
