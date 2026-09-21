---
title: "Dashboard UX overhaul: operator-centric IA, workspace cockpit, agents, activity and decision metrics"
description: "Deliver issue #220 as a sequence of incremental phase PRs: one canonical page registry, operator-intent navigation, a Workspace Cockpit, first-class Agents, actionable Runtime, contextual Git/Finalize, Automation/Deploy, Activity/Approvals, and a decision-oriented Overview backed by server-side projections."
status: in_progress
priority: P1
effort: "8-14d across 12 PRs"
tags: [dashboard, ia, ux, agents, api, accessibility]
created: 2026-09-21
issue: 220
branch: mrgoonie/dashboard-ux-overhaul-operator-centric-ia-worksp
source: "https://github.com/bestagentkits/cloud-harness-mcp/issues/220"
---

# Dashboard UX overhaul (issue #220)

## Overview

Issue [#220](https://github.com/bestagentkits/cloud-harness-mcp/issues/220) is an
epic: the Dashboard answers "what is my inventory" instead of "what needs my
attention, what is running, who owns it, what is about to expire, and what should
I do next". The backend already exposes far more capability than the UI surfaces;
the gap is information architecture, not missing backend power.

Current state, verified on this branch at `fb2bde8`:

- `/dashboard` serves the workspace index and `/dashboard/overview` serves the
  overview (allowlist in `apps/api/src/dashboard-assets.ts:40-59`; dispatch chain
  in `apps/api/dashboard/dashboard.js:960-976`; the mount test asserts the shell
  title is `Workspaces | Cloud Harness`, `apps/api/test/dashboard-app-mount.test.ts:37-47`).
- Page metadata is duplicated across five places: static sidebar markup in
  `apps/api/dashboard/index.html:28-44`, the `data-section` active-state switch in
  `apps/api/dashboard/dashboard.js:951-953`, `PALETTE_PAGE_COMMANDS`
  (`dashboard.js:606-621`), the pathname dispatch chain (`dashboard.js:960-976`),
  and the server allowlist (`dashboard-assets.ts:40-59`), plus the route/title
  assertion table in `apps/api/test/dashboard-ui-contract.test.ts:149`.
- Sidebar groups mirror subsystems (`Runtime`, `Configuration`,
  `Observability`), and `Profile` occupies a sidebar slot under `Observability`
  while `docs/design-guidelines.md` describes an `Account` group.
- Workspace detail exposes only Files and Runtime
  (`dashboard.js:2688`) with a thin `renderRuntime` list
  (`apps/api/dashboard/dashboard-render.js:140`).
- Overview aggregates client-side into inventory metrics
  (`renderOverview`, `dashboard-render.js:441`).
- No page registry, no agents UI, no approvals inbox, no activity center, no
  workspace Git UI, and no server-side overview/metrics/activity projections
  exist anywhere in `apps/api`.

There is no prior plan, PR, or in-flight branch for this issue: the worktree
branch is identical to `origin/main`, and `gh pr list --search 220` returns
nothing.

## Goals

| # | Goal | Phase |
|---|------|-------|
| 1 | One authoritative page registry drives nav, active state, palette, routing, headings, and the server allowlist | 1 |
| 2 | `/dashboard` is Overview; workspaces live at `/dashboard/workspaces`; Profile leaves the sidebar | 1 |
| 3 | Resource pages share one layout and one CRUD interaction model (dialogs/drawers, not permanent forms) | 2 |
| 4 | Workspace detail becomes a cockpit (Summary…Activity) with high-value header state and lifecycle actions | 3 |
| 5 | Agents are first-class: list, hierarchy, detail, logs, usage/budget, steer/follow-up/cancel | 4 |
| 6 | Runtime is actionable: task detail/cancel, `tasks_graph` DAG, session controls | 5 |
| 7 | Git is contextual with Finalize as the happy path | 6 |
| 8 | Automation (skills/hooks by lifecycle) and Deploy are discoverable in workspace context | 7 |
| 9 | Activity Center unifies events (with Audit intact) and Approvals is a working inbox | 8 |
| 10 | Overview leads with attention/running/cost/expiry from server-side projections | 9 |
| 11 | Analytics are internal-SVG, accessible, bounded, and decision-useful | 10 |
| 12 | State-conveying micro-interactions within reduced-motion limits | 11 |
| 13 | Docs and tests reflect the shipped architecture and the issue's DoD is evidenced on the issue | 12 |

## Phase map

Plan phase numbers are 1-12; each maps to one issue phase and one PR. Phases run
in order; a phase branches only after its predecessor merges.

| Plan phase | Issue phase | Deliverable | Depends on |
|---|---|---|---|
| 1 | Phase 0 | Page registry + route/navigation migration | — |
| 2 | Phase 1 | Common resource-page layout + CRUD interaction model | 1 |
| 3 | Phase 2 | Workspace Cockpit shell + Summary + bounded REST adapters | 1, 2 |
| 4 | Phase 3 | Agent Control Center (global, workspace, detail) | 1, 3 |
| 5 | Phase 4 | Runtime: tasks, sessions, task DAG | 3 |
| 6 | Phase 5 | Git tab + Finalize workflow | 3 |
| 7 | Phase 6 | Automation (skills/hooks) + Deploy | 3 |
| 8 | Phase 7 | Activity Center + Approvals | 1, 3 |
| 9 | Phase 8 | Decision-oriented Overview + server aggregation | 4, 5, 8 |
| 10 | Phase 9 | Analytics charts / decision visualizations | 9 |
| 11 | Phase 10 | Micro-interactions and state feedback | 10 |
| 12 | Phase 11 | Docs sync, regression sweep, issue closure evidence | 11 |

## Decisions

1. **No framework rewrite.** Keep vanilla ESM under `apps/api/dashboard/` and
   extract small modules opportunistically. The issue forbids replacing the
   Dashboard with React/Next, and `docs/design-guidelines.md` treats the strict
   CSP as a hard constraint.
2. **Registry as the single source.** A JS module under `apps/api/dashboard/`
   owns page identity/label/group/route/title/help/icon/palette membership and is
   consumed by shell rendering, active state, palette, client route matching and
   headings. The server allowlist in `apps/api/src/dashboard-assets.ts` is a
   TypeScript module that cannot import browser ESM, so parity is **asserted by
   test** rather than shared by import (see Phase 1 Task 1.4).
3. **Additive, bounded adapters only.** Browser code never calls runner endpoints
   directly. New Dashboard REST projections reuse `DashboardRunnerClient` and
   the existing principal/redaction/CSRF patterns. No public MCP contract or
   runner security-model change; if a phase needs one, it stops and asks.
4. **Server-side aggregation over browser fan-out.** Overview, metrics and
   activity become read-only server projections with validated windows.
5. **Metrics are honest about scope.** Cost and usage are labelled by the scope
   actually stored (retained agents), never as an unsupported "today".
6. **Internal SVG only.** Charts are hand-built SVG with text/table fallbacks and
   keyboard focus; no chart CDN, no new dependency.
7. **One phase per PR, auto-merged on green CI,** with post-merge CI convergence
   before the next phase starts. Each PR leaves the Dashboard usable.
8. **Docs move with code.** `docs/design-guidelines.md` and the affected
   `docs-site/` pages are updated in the same phase that changes the UI contract.

## Non-goals

- React/Next or any framework rewrite; new UI/runtime dependencies or CDNs.
- Changing the public MCP tool contracts, the runner security model, or the
  credential-free ingress posture.
- `npm run verify:production`, live deployments, or any production operation.
- Docker and e2e suites (not selected for this goal).
- Fixing failures unrelated to the Dashboard.
- An unrestricted browser terminal for workspace sessions.

## Verification

Per phase (in addition to the phase file's own acceptance criteria):

```bash
npx vitest run dashboard
npm run verify
```

Browser QA evidence (saved under `plans/reports/`, never committed): dark, light
and system themes; desktop, tablet and ~375px; keyboard-only navigation;
reduced-motion mode; loading/empty/error states for every new surface.

Beyond the local gates, each phase PR must land with green required CI checks,
be auto-merged, and show converged post-merge CI before the next phase starts.

Final phase: walk the issue's Definition-of-Done list item by item against the
running Dashboard and post the mapping as an evidence comment on issue #220.

## Risks

| Risk | Mitigation |
|---|---|
| Registry extraction breaks existing route/heading contracts (mount test asserts a fixed title per route) | Phase 1 updates the assertions deliberately and adds registry-parity tests before behaviour changes |
| New adapters leak internal fields (owner IDs, runner tokens, container names) | Every phase adds a redaction assertion for each new adapter payload |
| Cockpit/adapter surface grows too large for one PR | Phase 3 splits adapters from UI wiring and keeps each commit usable |
| Cost/usage charts imply data the harness does not retain | Scope labels are explicit and asserted by test |
| Phase drift against the issue's stated scope | Each phase re-inspects the issue first and reports deltas instead of silently narrowing |

## Validation Log

### Verification Results (plan fact-check)

- Claims checked: 24 (registry, router, dispatch, palette, redirect and test references)
- Verified: 24 | Failed: 0 | Unverified: 0
- Tier: Full (12 phases)
- Evidence: every `file:line` claim was confirmed by `rg`/read on this branch before
  implementation. Two symbol references were corrected first: `requestBody` is a
  local `const` at `apps/api/dashboard/dashboard.js:945` (not a module export), and
  `api()` is defined at `apps/api/dashboard/dashboard-api.js:9`.

### Validation decisions (interview with the owner, 2026-09-21)

Goal level: deliver the whole epic phase by phase; one phase per PR; auto-merge
after required CI checks pass with post-merge convergence; per-phase verification
is targeted suites + `npm run verify` + browser QA; internal docs and the docs
site move together.

Plan level (three user-visible IA calls):

1. `Skills` stays a shipped page and lives under **Configure**.
2. `Audit` keeps a temporary **Operate** rail entry, removed in phase 8 once the
   Activity Center owns an Audit tab.
3. `Integrations` uses sub-routes plus compatibility redirects rather than query
   tabs.

### Red Team Review

Four lenses run against the plan and this phase's diff, with code evidence:
Assumption Destroyer, Failure-Mode Analyst, Security Adversary, Scope & Complexity
Critic. Findings and resolutions:

1. **The server allowlist cannot import the browser registry** (compiled TypeScript
   versus browser ESM) — resolved: the router exports `DASHBOARD_SHELL_PATHS` and
   `apps/api/test/dashboard-pages.test.ts` asserts parity in both directions.
2. **A shell route without a page (or the reverse) drifts silently** — resolved by
   the same bidirectional assertion; `/` maps to the Overview route.
3. **The home route prefix-matches every path** — found during implementation by the
   "sibling prefix" test; fixed by making `/dashboard` exact-only in `pageForPath`.
4. **Detail routes regress when the if/else chain becomes a registry lookup** —
   resolved: workspace/files/runtime, project, knowledge and MCP-server matchers run
   before the registry dispatch, with tests for each.
5. **Removing Profile from the rail makes it unreachable** — resolved: the profile
   page stays palette-visible and the top-bar chip still links to it; both asserted.
6. **The renames break deep links** — resolved: labels changed (`Models & Budgets`,
   `API Access`), routes unchanged.
7. **Integrations consolidation hides the MCP server detail view** — resolved:
   `/dashboard/mcp-servers/:serverId` keeps serving and marks Integrations current;
   `/dashboard/github` and `/dashboard/mcp-servers` redirect to their tabs.
8. **Redirect destinations reachable from a variable** (open-redirect class) —
   resolved at registration: each redirect uses a literal destination, and the mount
   test asserts the behaviour of every entry in the exported table. Residual: a
   pattern-based analyzer still flags pre-existing static `location.href` literals
   (15 occurrences in `HEAD`, 15 in the worktree; this phase's diff changes two of
   those lines from one static path to another).
9. **Registry icons are injected as markup** — resolved: icons are trusted static
   strings in `dashboard-pages.js` and every text value passes through the renderer's
   `escapeHtml` (`apps/api/dashboard/dashboard-render.js:1`).
10. **Dropping static rail markup could break styling or the UI contract** —
    resolved: `.nav-group`, `.nav-ic` and `aria-current` are preserved and the
    contract test now asserts the registry contract instead of literals.
11. **Palette copy regresses when hints move** — resolved: `paletteHint` moved into
    each registry entry with the wording preserved; only the Overview destination
    changed, and its test was updated deliberately.
12. **The mount test pinned one title for every route** — resolved: it now iterates
    `DASHBOARD_SHELL_PATHS`, with added cases for the redirects and the registry asset.
13. **Dead rail entries for pages that do not exist yet** — resolved: Agents,
    Activity and Approvals get their registry entry and shell path in the phases that
    build them (4 and 8), never as placeholders.
14. **Epic scope risk** — mitigated: one phase per PR, each independently green and
    usable; this PR is phase 1 of 12.

### Whole-Plan Consistency Sweep

- The phase map in this plan, phase files 1-12, and the goal task tree agree
  (plan phase N = goal task N = issue phase N−1).
- Phase 1's acceptance criteria match what the diff and its tests deliver.
- No stale claim remains: phase 1 no longer implies `/agents`, `/activity` or
  `/approvals` ship in it; they land with phases 4 and 8.
- Decisions 1-8 agree with the phase files; documentation moves in the same phase as
  the UI contract it describes (`docs/design-guidelines.md` was updated in phase 1).
- The single unresolved item is the analyzer false positive in finding 8, which is
  outside the repository's own gates (`npm run verify` runs plugin check, eslint,
  typecheck, tests and build).

<!-- slug: issue-220-dashboard-ux-overhaul -->
