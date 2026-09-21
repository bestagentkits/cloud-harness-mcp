# Phase 10 (issue #220, Phase 9): analytics charts and decision visualizations

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-10` (task-10 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-10-analytics-charts.md`

## Summary

The Overview now carries an Analytics section whose charts are built from data the
harness actually retains: retained-audit volume per time bucket, cost and tokens by
model profile, budget burn of running agents, workspace expiry buckets, and MCP
reliability (success/error counts with p50/p95 latency) from gateway traces. Every
chart is internal SVG with no dependency, no gradient and no inline style; each mark
is focusable with its numbers in the accessible name, and the same numbers ship as a
table beside the figure. A cost *trend* is deliberately absent — the harness keeps
per-agent usage, not a dated ledger — and the section says so instead of drawing a
curve it cannot support.

Phase 10 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — `buildMetricsProjection` now also returns an
  evenly spaced `series` of bucket counts across the validated window (so a chart never
  invents shape); `buildOverviewProjection` adds `usageByProfile` (tokens and cost per
  model profile) and `budgetBurn` (running agents only, most-used first); new
  `buildReliabilityProjection` derives per-server success/error counts and p50/p95
  latency from gateway traces, projecting only the fields the answer needs.
- `apps/api/src/dashboard-router.ts` — `GET /api/v1/reliability` composes that
  projection with a bounded server-side fan-out (five servers, 200 traces each) so the
  browser still makes one request.
- `apps/api/dashboard/dashboard-render.js` — `renderBarChart` and `renderBarRows`
  (internal SVG, focusable marks, `role="list"`, accessible names, table fallback) plus
  `renderAnalyticsSection`; `renderOverview` places the section between the decision
  panels and Access.
- `apps/api/dashboard/dashboard.js` — the Overview loader adds `/metrics?window=24h`
  and `/reliability` to its bounded requests.
- `docs/design-guidelines.md` — the analytics contract, including the explicit note
  about the missing cost ledger.

## Verification

- `npx vitest run dashboard` — 25 files, 321 tests, all passing; API typecheck and
  eslint clean.
- `apps/api/test/dashboard-analytics.test.ts` — SVG structure and accessibility
  (`tabindex="0"`, `aria-label` with the value, `role="list"`, table fallback), the
  absence of gradients/inline styles/external URLs, zero-division safety (a flat series
  renders 1px bars rather than NaN), empty-chart notes, the five charts with their real
  numbers (including `80% of cost limit` and `3 error(s), p50 40 ms, p95 120 ms`), the
  cost-trend disclosure, series bucketing (evenly spaced, oldest first), reliability
  percentiles (p50 30 ms / p95 50 ms over five traces), per-profile aggregation, and
  running-only budget burn ordering.
- `apps/api/test/dashboard-ui-contract.test.ts` — the client-side tracking guard now
  checks call shapes (`gtag(`, `posthog`, `plausible(`, `mixpanel`) rather than the word
  "analytics", which now names a dashboard section; persistence guards are unchanged.

## Residual

Execution health and cost *trends* over time are not charted because neither a dated
outcome series nor a dated cost ledger is retained. The activity-volume chart states
that it counts retained audit events in the window, and the section states the cost
trend limitation in the UI rather than only in this report.
