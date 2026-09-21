# Phase 9 (issue #220, Phase 8): decision-oriented Overview and server-side aggregation

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-9` (task-9 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-09-decision-overview.md`

## Summary

`/dashboard` now answers four operator questions above the fold — **Needs attention**,
**Running now**, **Cost**, **Expiring soon** — and every tile links into the filtered
view that explains it. Access and Server moved below the decision metrics. The page
reads one server projection instead of fanning out, and the Activity Center now reads
its timeline from a server-composed projection too.

Phase 9 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — three read-only projections:
  `buildOverviewProjection` (attention reasons for failed/quarantined workspaces, leases
  inside 15 minutes, failed / limit-exceeded / timed-out agents and pending approvals;
  running counts; a cost figure whose `scope` names what was measured — "running agents",
  because the harness retains per-agent usage rather than a daily ledger; expiry buckets
  at 15 minutes, 1 hour and 4 hours), `buildMetricsProjection` over `METRIC_WINDOWS`
  (`1h`/`24h`/`7d`) with an explicit scope string, and `buildActivityProjection` which
  merges the retained audit timeline with live agent rows and marks each row's kind.
- `apps/api/src/dashboard-router.ts` — `GET /api/v1/overview`, `GET /api/v1/metrics`
  (an unsupported window is a 400, not a silent default) and `GET /api/v1/activity`.
  Each is principal-scoped and bounded (100-200 records per source).
- `apps/api/dashboard/dashboard-render.js` — `renderOverview` becomes the decision
  layout: four linked tiles, an attention list, expiry buckets, then Access and Server.
- `apps/api/dashboard/dashboard.js` — the Overview loader makes three bounded requests
  (`/overview`, `/profile`, `/server`) instead of six, refreshes the approvals badge, and
  the Activity loader consumes the server projection rather than merging client-side.
- `docs/design-guidelines.md` — the decision-metric contract, including why the cost tile
  never claims "today".

## Verification

- `npx vitest run dashboard` — 24 files, 312 tests, all passing; the API typecheck and
  eslint are clean.
- `apps/api/test/dashboard-overview.test.ts` — attention reasons include only the
  actionable states (a healthy workspace and a running agent are excluded, a pending
  approval is not), every reason links into a dashboard view, cost counts only running
  agents and states its scope, expiry buckets are correct per window, missing sources
  degrade to zeros rather than invented values, metric windows are validated (`30d`
  throws) with in-window filtering and scope wording, the activity projection labels
  durable vs live rows and sorts newest first, and the renderer places decision tiles
  above Access with the hour bucket on the expiry tile.
- `apps/api/test/dashboard-ui-behavior.test.ts` — the Overview escaping test now covers
  the decision shape (tile order, attention labels, cost scope text, the endpoint copy
  affordance).

## Residual

`GET /api/v1/metrics` counts retained audit events per window because that is the only
history the harness keeps; it says so in `scope`, and the charts phase draws from it
rather than from a fabricated trend.
