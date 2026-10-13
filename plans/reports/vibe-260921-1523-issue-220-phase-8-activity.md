# Phase 8 (issue #220, Phase 7): Activity Center and Approvals

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-8` (task-8 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-08-activity-and-approvals.md`

## Summary

`/dashboard/activity` is now one operational timeline with All / Agents / Tasks / MCP
/ Deployments / Audit filters over a single event grammar, and every row states
whether it is retained audit or live runtime data. `/dashboard/approvals` is a
working inbox for pending privilege grants with Approve and Reject, a rail badge that
exists only while something is pending, and an empty state that explains itself.

Phase 8 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/dashboard/dashboard-pages.js` — Activity and Approvals join the registry
  under **Operate** (nav, palette, title, help, icon). Audit history left the rail in
  this phase, as the plan intended: it keeps its route and palette entry and is
  reachable from the Activity Audit filter.
- `apps/api/src/dashboard-assets.ts` — `/activity` and `/approvals` join the shell
  allowlist; the registry/allowlist parity test covers both.
- `apps/api/dashboard/dashboard-render.js` — `ACTIVITY_FILTERS`, `activityEvent`
  (one grammar: when, category, status, actor/resource, summary, next step, and a
  `durable` flag), `renderActivityCenter`, `renderApprovals`.
- `apps/api/dashboard/dashboard.js` — the Activity loader derives categories from the
  retained audit actions and overlays live agent state, sorts the merged timeline, and
  labels each row; the Approvals loader lists pending grants, confirms each decision,
  and drives the rail badge (`updateApprovalsBadge`, `refreshApprovalsBadge`).
- `docs/design-guidelines.md` — the activity/approvals contract, including why a row
  must say which kind of record it is.

## Verification

- `npx vitest run dashboard` — 23 files, 303 tests, all passing; the API typecheck is
  clean.
- `apps/api/test/dashboard-activity.test.ts` — the six filters, durable vs live
  labelling, per-category counts, active-filter state, a filtered view showing only its
  category, the empty view, and the approvals inbox (context, digest, both decisions,
  audited-decision copy, empty state, and "Not reported" for missing fields).
- `apps/api/test/dashboard-pages.test.ts` — the rail no longer lists Audit, still lists
  Activity and Approvals, and keeps Audit reachable from the palette.

## Residual

The Tasks, MCP and Deployments categories are derived from retained audit actions
rather than a live per-category feed, because a global task or trace feed would need a
per-workspace fan-out that the contracts do not expose as one call. The panel states
each row's kind, so the derivation is visible rather than implied.
