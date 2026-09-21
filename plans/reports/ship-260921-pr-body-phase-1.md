## Summary

Phase 0 of #220 — the canonical Dashboard page registry and the route/navigation
migration. One registry owns page identity, route, label, group, heading, help,
icon and palette membership; navigation rendering, active state, the command
palette, client route dispatch and the page heading all derive from it, and the
server shell allowlist asserts parity in test.

This PR deliberately does **not** close the epic. It is PR 1 of 12.

## What changed

- `apps/api/dashboard/dashboard-pages.js` (new) — the registry plus `pageForPath`,
  `navGroups`, `navigationPageId`, `documentTitle`, `palettePageCommands`, child
  routes, aliases and the compatibility-redirect table.
- `apps/api/dashboard/dashboard.js` — the sidebar renders from the registry, the
  17-branch pathname chain became a `PAGE_LOADERS` lookup, `PALETTE_PAGE_COMMANDS`
  is derived, and GitHub/MCP Servers share one Integrations page with secondary
  navigation.
- `apps/api/src/dashboard-assets.ts` — exports `DASHBOARD_SHELL_PATHS` and
  `DASHBOARD_COMPAT_REDIRECTS`, serves `/workspaces` and `/integrations*`, and
  redirects `/overview`, `/github` and `/mcp-servers` to their new destinations.
- Tests — new `dashboard-pages.test.ts` (registry shape, bidirectional allowlist
  parity, group order, detail-route resolution, prefix precision, palette
  derivation, shell-markup ownership) plus updated mount, contract and behaviour
  suites.
- `docs/design-guidelines.md` — navigation groups, route ownership, Integrations
  tabs and the Profile entry point.

## Operator-visible result

- `/dashboard` is the Overview; the workspace index is at `/dashboard/workspaces`.
- Rail groups are Home / Operate / Configure / Data / Admin; `Models & Budgets`
  and `API Access` carry the new labels while keeping their old routes.
- Profile left the rail and stays reachable from the top-bar chip and the palette.
- GitHub and MCP Servers are tabs of one Integrations page; `/dashboard/mcp-servers/:id`
  still serves the server drill-down.

## Verification

- `npx vitest run dashboard` — 16 files, 247 tests, all passing.
- `npm run typecheck -w @cloud-harness/api` — clean.
- `npm run verify` — plugin check, eslint, typecheck and the compile step pass;
  145 of 146 test files pass (1344/1345 tests). The one failure,
  `apps/runner/test/toctou-script-tamper.test.ts > runs the verified bytes once the
  digest matches`, asserts that a script with no shebang fails as an execution
  error; it is host-dependent by the test's own comment, nothing under
  `apps/runner/` or `packages/` differs from `main` on this branch, and the suite
  is green on Linux CI for `main`.
- Browser QA against the real shell assets with a stubbed BFF: rail groups and
  order, active state per route, Integrations secondary nav, palette keyboard flow
  (13 destinations, no per-subsystem GitHub/MCP entries), the three redirects, the
  375x812 render and the light theme. Screenshots:
  `~/.pi/browser-artifacts/phase-1-overview-desktop-dark.png`,
  `~/.pi/browser-artifacts/phase-1-workspaces-375px-dark.png`,
  `~/.pi/browser-artifacts/phase-1-integrations-github-light.png`.

## Plan

`plans/260921-1422-issue-220-dashboard-ux-overhaul/` (plan index, 12 phase
contracts, validation log and red-team record) and the phase report at
`plans/reports/vibe-260921-1444-issue-220-phase-1-registry-and-ia.md`.

Refs #220
