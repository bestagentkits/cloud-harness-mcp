---
title: Traces
description: Durable traces of coding-agent runs — KPIs, span waterfall, reconciliation, and export.
---

# Traces

`/dashboard/traces` lists one trace per coding-agent run. A trace shows where a run
spent its time, tokens, and cost: the run itself, every model call, every tool call,
its budget events (the cost reservation, the lease issue, a limit that ended the run,
and the settlement against the reservation), and the model gateway's settlement. The
**Traces** entry appears in the sidebar only
when the operator has enabled agent traces (`AGENT_TRACES_ENABLED=true`, see
[environment variables](../reference/environment-variables.md)).

A trace holds identifiers, timings, token counts, cost, outcomes, and input digests.
It never holds prompts, model output, or credentials. Tool arguments are kept only as
a digest, unless the operator sets `AGENT_TRACE_PREVIEW_BYTES` to keep a short,
redacted preview.

## The list

The top of the page is a KPI strip over the filtered window: trace count, errors
(with partial and unreconciled counts), tokens, cost, model-call latency p50/p95, and
time to first token. A figure the runner did not observe reads as **unknown**, never
`0`: when no trace in the window has a known cost, the cost tile reads **unknown**
rather than `$0.00`. Latency appears only when timed calls exist. Below the list, the **By
profile** table compares model profiles that have at least 20 traces; smaller profiles
read "Too few traces to compare".

Filter by state, time window, profile, agent, or workspace. Filters live in the URL, so
a filtered view can be shared or reloaded. **Load more** pages further back; if
retention removed the page a cursor pointed to, reload the list.

While a listed trace is still running, the rows refresh every few seconds and stop as
soon as no trace is running or you navigate away. A refresh leaves the filter form and
the KPI strip as they are, so a filter you are typing is not lost.

## One trace

Opening a trace shows:

- **Trace** — state, finish reason, model profile and revision, parent trace for a child
  agent, timings, model and tool call counts, tokens, cost and its provenance, span
  count, and when retention removes the trace.
- **Reconciliation** — span sums compared with the agent usage ledger and the gateway
  settlement. Tokens must match exactly; cost may differ by one micro-dollar per model
  call of rounding. An unreconciled trace lists its reasons.
- **Spans** — a waterfall in tree order. Each bar sits on the run's time axis; a span
  that never closed (the run was cancelled, timed out, or interrupted) draws dashed to
  the end and reads `unknown`.

A trace whose data is incomplete is marked **partial**: a span never closed, a model
call reported no usage, the gateway settlement is missing or counted requests without
usage, the trace hit its span cap, or a runner restart interrupted the run. A failed
run with complete data is not partial. Traces survive the workspace they came from
until retention removes them.

## Export

Each trace offers **JSON**, **CSV**, and **OTLP JSON** downloads. Exports are pulled
from the Dashboard or with the `agent_trace_export` tool; nothing is pushed to an
external collector. Import the OTLP JSON file into any OpenTelemetry-compatible viewer.

## From other pages

An agent's detail page shows a **Traces** panel with its recent runs and the newest
run's waterfall. An automation run links to its agent's traces.
