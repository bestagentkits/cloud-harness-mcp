# Phase 1 (issue #220, Phase 0): page registry and route/navigation migration

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-operator-centric-ia-worksp`
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-01-page-registry-and-ia.md`

## Outcome

The Dashboard now has one authoritative page registry. Navigation, active state,
the command palette, client route matching and the page heading/help all derive
from it, `/dashboard` is the Overview, the workspace index moved to
`/dashboard/workspaces`, Profile left the sidebar, and GitHub plus MCP Servers
became tabs of a single Integrations page. The server keeps its own shell path
list, and a test asserts the two agree in both directions.

## Changes

| File | Change |
|---|---|
| `apps/api/dashboard/dashboard-pages.js` (new) | The registry: 13 pages with route, label, group, title, help, icon, palette membership; `pageForPath`, `navGroups`, `navigationPageId`, `documentTitle`, `palettePageCommands`, child routes, aliases and the compatibility-redirect table |
| `apps/api/dashboard/dashboard.js` | Sidebar rendered from the registry (`renderSidebarNavMarkup`), registry-driven `selectNavigation` (heading + help + document title), `PAGE_LOADERS` replacing the 17-branch pathname chain, `PALETTE_PAGE_COMMANDS` derived, Integrations secondary navigation |
| `apps/api/dashboard/dashboard-render.js` | Exports `escapeHtml` so the shell renders registry text through the renderers' escaping path |
| `apps/api/dashboard/index.html` | Sidebar reduced to an empty container, Overview shell title, page header and content defaults |
| `apps/api/src/dashboard-assets.ts` | Exported `DASHBOARD_SHELL_PATHS` and `DASHBOARD_COMPAT_REDIRECTS`, new routes (`/workspaces`, `/integrations`, `/integrations/github`, `/integrations/mcp-servers`), literal-destination redirects for `/overview`, `/github`, `/mcp-servers`, and the new `dashboard-pages.js` asset |
| `apps/api/test/dashboard-pages.test.ts` (new) | Registry shape, allowlist parity in both directions, group order, detail-route resolution, prefix precision, palette derivation, shell-markup ownership, registry-driven routing |
| `apps/api/test/dashboard-app-mount.test.ts` | Serves every `DASHBOARD_SHELL_PATHS` entry, asserts the three redirects, serves the registry asset |
| `apps/api/test/dashboard-ui-contract.test.ts` | Navigation assertions now target the registry contract instead of shell literals |
| `apps/api/test/dashboard-ui-behavior.test.ts` | Palette expects the Overview at `/dashboard` |
| `docs/design-guidelines.md` | Navigation groups, route ownership, Integrations tabs, Profile entry point |

## Verification

- `npx vitest run dashboard` — **16 files, 247 tests, all passing** (includes the new registry suite).
- `npm run typecheck -w @cloud-harness/api` — clean.
- `npm run verify` — plugin check, eslint, typecheck and build pass; **145 of 146 test files pass (1344 of 1345 tests)**. The single failure is
  `apps/runner/test/toctou-script-tamper.test.ts > runs the verified bytes once the digest matches`,
  which asserts that a script with no shebang fails as an execution error rather
  than an integrity verdict. It is host-dependent by design (the test's own
  comment names the platform difference) and **not caused by this diff**:
  `git status` shows no modification under `apps/runner/` or `packages/`, and the
  suite is green on Linux CI for `main` (`gh run list --branch main` shows the
  Release and Deploy runs succeeding at `b880572`).

Browser QA against the real shell assets with a stubbed BFF (harness at
`/tmp/ch-dash-qa/server.mjs`, outside the repo):

| Check | Evidence |
|---|---|
| `/dashboard` = Overview | `title="Overview \| Cloud Harness"`, `heading="Overview"`, Overview marked `aria-current="page"` |
| Groups and order | `["Home","Operate","Configure","Data","Admin"]` |
| Rail contents | 12 links: Overview, Workspaces, Audit, Projects, Secrets, Models & Budgets, Skills, Integrations, Knowledge, Artifacts, API Access, Settings |
| Profile leaves the rail | `profileInSidebar=false`, `profile-chip href="/dashboard/profile"` |
| `/dashboard/workspaces` | `title="Workspaces \| Cloud Harness"`, `current=["workspaces"]`, command surface visible |
| `/dashboard/integrations/github` | `title="Integrations \| Cloud Harness"`, `current=["integrations"]`, secondary nav `GitHub (current) / MCP Servers` |
| Compatibility redirects | `/dashboard/overview → /dashboard`, `/dashboard/github → /dashboard/integrations/github`, `/dashboard/mcp-servers → /dashboard/integrations/mcp-servers` (302) |
| Command palette (`Meta+K`) | 13 page destinations, `Integrations` and `Profile` present, no per-subsystem GitHub/MCP entries, `aria-activedescendant="palette-opt-0"`, `aria-expanded="true"` |
| Responsive / theme | 375×812 render and light theme captured |

Screenshots (outside the repo, since browser artifacts cannot be written into the
workspace root):

- `/Users/duynguyen/.pi/browser-artifacts/phase-1-overview-desktop-dark.png`
- `/Users/duynguyen/.pi/browser-artifacts/phase-1-workspaces-375px-dark.png`
- `/Users/duynguyen/.pi/browser-artifacts/phase-1-integrations-github-light.png`

## Reported tool finding (not a regression)

A pattern-based analyzer reports ~36 "potential open redirect" findings in
`dashboard.js`. They are matches on static same-origin path assignments to
`location.href`, including lines this diff never touches (for example the
`#clear-filters` handler). Evidence: the file contains 15 `location.href`
occurrences in `HEAD` and 15 in the working tree, and this diff rewrites exactly
one of those lines, from one static Dashboard path to another. The repository's
own gates (`npm run verify`) run plugin check, eslint, typecheck, tests and
build; none of them report this. Recorded rather than "fixed" by refactoring 36
untouched assignments.

## Decisions taken in this phase

1. `Skills` lives under **Configure** (the issue's proposed nav omits it, but it is a shipped page).
2. `Audit` keeps a temporary **Operate** entry until phase 8 gives the Activity Center an Audit tab.
3. `Integrations` uses sub-routes with compatibility redirects; `/dashboard/mcp-servers/:serverId` keeps serving as a drill-down.
4. Labels changed (`Models & Budgets`, `API Access`), routes unchanged, so deep links survive.
5. Agents, Activity and Approvals get their registry entry and shell path in the phases that build them (4 and 8), never as dead rail entries.

## Next

Phase 2 (issue Phase 1): shared resource-page layout and CRUD interaction model
for Projects, Secrets, Artifacts, API Access, Integrations and Models & Budgets.
