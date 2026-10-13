# Phase 5 (issue #220, Phase 4): actionable Runtime — tasks, sessions, task DAG

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-5` (task-5 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-05-runtime-operations.md`

## Summary

Runtime stops being a passive list. The cockpit's Runtime tab shows a task table
with status, duration, exit code, dependencies, a bounded output disclosure and a
cancel for every non-terminal task; the dependency graph as internal SVG with
focusable, text-labelled nodes and the task table as its fallback; and sessions as
named, closeable rows whose output is read through a read-only, bounded call.

Phase 5 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — `tasks_status`, `tasks_cancel`,
  `tasks_graph`, `sessions_open`, `sessions_io` and `sessions_close` join the
  response union. Task projections keep identity, status, exit code, dependencies
  and timing; session projections keep identity, status and lifecycle timestamps.
  Both bound their `output` field to 8 KB with an explicit truncation marker.
- `apps/api/src/dashboard-router.ts` — principal-scoped routes
  `GET /workspaces/:id/tasks/graph` (registered before the task-detail route so
  `graph` is never parsed as an id), `GET /workspaces/:id/tasks/:taskId`,
  `POST /workspaces/:id/tasks/:taskId/cancel`,
  `POST /workspaces/:id/sessions`, `GET /workspaces/:id/sessions/:sessionId/io`
  and `POST /workspaces/:id/sessions/:sessionId/close`. **The IO route never
  accepts client-supplied stdin and pins `waitMs: 0`**, so the dashboard reads a
  bounded slice rather than driving a terminal.
- `apps/api/dashboard/dashboard-render.js` — `taskStatusLabel`, `taskDuration`,
  `renderTaskList`, `taskGraphLayout`, `renderTaskGraph`, `renderSessionsPanel`,
  `renderRuntimePanel`.
- `apps/api/dashboard/dashboard.js` — the cockpit Runtime tab and the legacy
  `/dashboard/workspaces/:id/runtime` route share one loader; cancel, read, close
  and open are wired with confirmations, live-region feedback and pending state.
- `docs/design-guidelines.md` — the runtime contract, including why the IO view is
  read-only.

## Verification

- `npx vitest run dashboard` — 20 files, 281 tests, all passing.
- `apps/api/test/dashboard-runtime.test.ts` — duration measurement (including the
  absent-timestamp case), outcome/exit/dependency/output rendering, cancel shown
  only for live tasks, dependency-depth layout with a cycle guard and an
  unknown-node edge, SVG node semantics (`tabindex="0"`, `aria-label`, text state,
  semantic status class, edge markup), the read-only bounded session view with its
  truncation notice, and the composed cockpit panel.
- The duration test caught a real defect before merge: `Number(null)` is `0`, so a
  running task with `finishedAt: null` measured as zero duration. Absent timestamps
  are now treated as absent before coercion.
- Manual reasoning on the route order: `/tasks/graph` precedes `/tasks/:taskId`, so
  the graph is not shadowed by the detail route.

## Residual

Task output beyond the 8 KB projection bound requires a follow-up cursor read; the
UI states truncation rather than hiding it. Sessions remain read-only by design,
which the issue permits ("Do not turn the Dashboard into an unrestricted terminal").
