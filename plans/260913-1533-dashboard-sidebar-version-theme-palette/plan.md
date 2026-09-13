---
title: "Dashboard sidebar version, theme icon, and CMD+K command palette"
description: "Add a server-version readout to the dashboard sidebar, replace the three-button theme selector with a single cycling icon control, add a CMD+K/CTRL+K command palette over existing sanitized list endpoints, and repair the unregistered /dashboard/models shell route."
status: in-progress
priority: P1
effort: 1d
issue: 178
branch: mrgoonie/sidebar-version
tags: [dashboard, ui, accessibility, csp]
blockedBy: []
blocks: []
created: 2026-09-13
---

# Dashboard sidebar version, theme icon, and CMD+K command palette

## Overview

Three additive operator-dashboard capabilities plus one adjacent defect repair,
delivered against the existing no-build, CSP-constrained static shell in
`apps/api/dashboard/`:

1. **Sidebar version** — the running server version, visible in the left rail on
   every dashboard page.
2. **Theme icon** — the three-button `System / Light / Dark` group becomes one
   cycling icon control in the top bar.
3. **CMD+K / CTRL+K command palette** — a keyboard-driven search and navigation
   surface over workspaces, projects, secrets, API keys, model credentials and
   profiles, knowledge items, and artifacts, built by client-side fan-out over
   the existing sanitized list endpoints.
4. **`/dashboard/models` shell route** — currently unregistered, so every Models
   link 404s. Repaired because the palette promotes Models to a first-class
   navigation target.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Operators can see which server version they are talking to, from any dashboard page | P1 |
| 2 | Theme control is a single icon control, still exposing all three states and persisting server-side | P1 |
| 3 | `CMD+K` / `CTRL+K` opens a searchable palette over dashboard resources and pages | P1 |
| 4 | Every navigation target the dashboard advertises resolves to a served page | P1 |

## Non-Goals

- No new server-side search endpoint, no new MCP tool, no new public contract.
- No client storage (`localStorage` / `sessionStorage` / `document.cookie`) — forbidden by
  `docs/design-guidelines.md` and enforced by `apps/api/test/dashboard-ui-contract.test.ts`.
- No fuzzy-match dependency (there is no bundler) and no new runtime dependency of any kind.
- No change to `deploy.yml`, `.releaserc.json`, or the release pipeline ordering.
- No new design language, icon set, or CSS framework.
- No knowledge items in the palette index. `GET /api/v1/knowledge` returns each
  item's full `content` (`apps/api/src/dashboard-response.ts:73,137`), up to
  262 144 characters per item (`packages/contracts/src/knowledge-schemas.ts:33`),
  so a 100-item fetch could move ~26 MB for a navigation palette. Knowledge keeps
  its own page-level search.
- No secret descriptions in the palette index. Descriptions are unredacted free
  text (partly derived from imported `.env` comments); the palette indexes the
  secret **name** only.
- No palette coverage beyond the first page of a paginated resource. The bound is
  disclosed in the UI rather than implied away.

## Accepted scope additions (with rationale)

- **`/dashboard/models` route registration** — a one-line repair in
  `apps/api/src/dashboard-assets.ts`. Without it the palette and the existing nav
  link both 404. Directly required for Goal 4.
- **`apps/api/src/index.ts` `--version` output** — currently hardcodes `0.19.2`
  while `apps/api/package.json` reads `0.39.0`. Phase 1 introduces a
  single-source-of-truth version module; leaving a third hardcoded copy beside it
  would be exactly the "second convention beside the existing one" that
  `AGENTS.md` prohibits. One-line consumer change.

## Cross-Plan Dependencies

None. This plan neither blocks nor is blocked by any other plan in the store.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Version authority and sidebar version](./phase-01-version-authority-sidebar.md) | Pending |
| 2 | [Theme icon control](./phase-02-theme-icon-control.md) | Pending |
| 3 | [CMD+K command palette](./phase-03-command-palette.md) | Pending |
| 4 | [Documentation sync](./phase-04-docs-sync.md) | Pending |
| 5 | [Ship to main and deploy convergence](./phase-05-ship-and-deploy.md) | Pending |

Phases are strictly sequential: phases 1-3 all edit `apps/api/dashboard/index.html`
and `apps/api/dashboard/dashboard.css`, so they must not run concurrently.

## Dependencies

- Phase 2 depends on Phase 1 (shares `index.html` top bar and `dashboard.css`).
- Phase 3 depends on Phase 2 (shares `index.html`, `dashboard.css`, `dashboard.js`).
- Phase 4 depends on Phases 1-3 (documents the shipped UI).
- Phase 5 depends on Phase 4 (ships the documented revision).

## Validation Log

### Verification Results (validate gate)
- **Tier:** Full (5 phases)
- **Roles run:** Fact Checker, Flow Tracer, Scope Auditor, Contract Verifier
- **Claims checked:** 60+ across five phases
- **Verified:** all cited paths, symbols, endpoints, and config keys resolved
- **Failed:** the defects listed under Red Team Review, all now corrected in the
  phase files
- **Unverified:** 0 outstanding

Contract Verifier consumer audit (all confirmed complete, no missed consumers):
`createDashboardAssetsRouter` — 3 call sites (`apps/api/src/app.ts`,
`apps/api/test/dashboard-app-mount.test.ts` twice); `apiVersion` — confined to
`apps/api/src/dashboard-router.ts`; `theme-control` / `theme-opt` /
`data-theme-value` — confined to `index.html`, `dashboard.js`, `dashboard.css`,
and the UI contract test; `dashboard.js` importers — 1 test module;
`dashboard-render.js` importers — 1 test module and `dashboard.js`; the
`0.19.2` literal — no test or script asserts it. Phase 4's conclusion that no
`.agents/skills/cloudharness/` or `plugins/cloud-harness/` edit is required was
independently confirmed, so `npm run plugin:sync` must not run for this change.

## Red Team Review

### Session — 2026-09-13
**Findings:** 12 (9 accepted, 3 rejected as duplicates)
**Severity breakdown:** 2 Critical, 7 High, 3 Medium
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer,
plus a Contract Verifier pass

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Eight-wide fan-out collides with the 8-concurrent per-principal limit; throttled sources cached as empty forever | Critical | Accept | Phase 3 (batched ≤3, single-flight, failures stay retryable), Phase 5 |
| 2 | CSP smoke is vacuous — the assets router emits no CSP, so a clean console proves nothing | Critical | Accept | Phase 5 (mount real `dashboardSecurity`; assert the header before browser assertions) |
| 3 | `GET /knowledge` returns full item `content` (up to 262 144 chars/item); caps apply only after download | High | Accept | Phase 3 (knowledge excluded), Phase 4 (docs corrected) |
| 4 | Secret `description` is unredacted free text and would propagate into a global list | High | Accept | Phase 3 (name-only index) |
| 5 | No in-flight latch — reopening during a pending load starts another full fan-out | High | Accept | Phase 3 (stored load promise + generation guard) |
| 6 | Cache goes stale after same-document CRUD reloads and `Refresh`; the "navigation always destroys the cache" claim was false | High | Accept | Phase 3 (invalidate in `announce`, on `pushState`, 60 s TTL) |
| 7 | Server pagination ignored — resources past page one are unfindable, undocumented | High | Accept | Phase 3 (explicit `limit=100`, standing disclosure note), Phase 4 |
| 8 | Mount test's `require('../../apps/api/package.json')` resolves to a nonexistent path and ESM has no `require` | High | Accept | Phase 1 (uses the existing `readFileSync(new URL(...))` convention) |
| 9 | Version regex rejects `+build` metadata that the release producer accepts, narrowing the `/api/v1/server` contract | High | Accept | Phase 1 (character allowlist instead of a SemVer grammar) |
| 10 | Model list responses carry extra principal/revision metadata the palette does not need | Medium | Accept | Phase 3 (frozen field allowlist per source) |
| 11 | Duplicate of #1 raised independently by two reviewers | Medium | Reject | Duplicate |
| 12 | Duplicate of #5 raised independently by two reviewers | Medium | Reject | Duplicate |

All twelve findings carried `file:line` evidence and passed the evidence filter.

### Whole-Plan Consistency Sweep
- Files reread: `plan.md`, `phase-01`…`phase-05`
- Decision deltas checked: 7 — palette source list (8 → 7, knowledge removed),
  concurrency model (unbounded parallel → batches of 3), cache lifecycle (page
  lifetime → invalidate + TTL + generation), secret indexing (name + description
  → name only), version validation (SemVer regex → character allowlist),
  mount-test manifest read (`require` → `readFileSync`), harness middleware
  (assets only → assets + security + limiter)
- Reconciled stale references: 9 — the "staleness is a non-issue" claim, the
  "metadata only" claim in Phases 3 and 4, the eight-source mapping table, the
  `Bounds` cap-vs-fetch mismatch, the `+build` regex in Phase 1's architecture and
  security sections, the `require(...)` expression, the harness architecture
  diagram, the Phase 5 success criteria, and the CSP risk note
- Unresolved contradictions: **0**

## Known risk carried into delivery

Production runs the **pre-version-bump** commit: `deploy.yml` deploys
`workflow_run.head_sha` (the merge commit) on CI success for `main`, while
`release.yml` pushes the `chore(release): X [skip ci]` version commit that never
re-triggers CI. The sidebar readout therefore lags the GitHub tag by one release.
It is labelled **"Server version"** so it states the literal truth about the
running binary. Pipeline ordering is out of scope for this plan and is filed
separately.
