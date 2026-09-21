---
phase: 1
title: "Canonical Dashboard page registry and route/navigation migration (issue Phase 0)"
status: pending
priority: P1
effort: "1-1.5d"
dependencies: []
---

# Phase 1: Canonical Dashboard page registry and route/navigation migration

Issue phase: **Phase 0**. Deliverable: one authoritative page registry, the
operator-intent navigation, `/dashboard` as Overview, and the workspace index at
`/dashboard/workspaces`.

## Goal

Page identity lives in exactly one place. Navigation, active state, the command
palette, client route matching, the page heading/help, and the server shell
allowlist all derive from that registry or are asserted against it by test.
`/dashboard` renders the Overview, `/dashboard/workspaces` renders the workspace
index, `Profile` has no sidebar slot, and every page remains reachable.

## Decisions taken in this phase

1. **Registry is browser ESM; the server keeps its own list and a test asserts
   parity.** `apps/api/src/dashboard-assets.ts` is TypeScript compiled by tsc and
   cannot import a browser ESM module. The allowlist is exported as
   `DASHBOARD_SHELL_PATHS`, and the parity test imports both sides.
2. **Routes stay stable where the issue only renames labels.** `Models` becomes
   `Models & Budgets` and `API keys` becomes `API Access` at the *label* level;
   `/dashboard/models` and `/dashboard/api-keys` keep working so bookmarks and
   existing links do not break.
3. **No page becomes unreachable.** The issue's proposed navigation omits
   `Skills` and `Audit`, but both are shipped pages. `Skills` moves under
   `Configure`; `Audit` stays under `Operate` in this phase and is removed from
   the sidebar by Phase 8 once `/dashboard/activity` owns an Audit tab.
4. **Integrations is one page with secondary routes.** GitHub and MCP Servers
   become `/dashboard/integrations/github` and
   `/dashboard/integrations/mcp-servers`; the existing `/dashboard/github` and
   `/dashboard/mcp-servers` become compatibility redirects, and the MCP server
   detail route `/dashboard/mcp-servers/:serverId` keeps resolving for
   drill-down.
5. **`/dashboard/overview` redirects to `/dashboard`** with an HTTP 302 from the
   assets router, so the old Overview URL keeps working.

## Tasks and steps

### Task 1.1 — Create the registry module

- **Goal:** `apps/api/dashboard/dashboard-pages.js` exports the page registry and
  the derived helpers the shell, palette and router need.
- **Target:** new file `apps/api/dashboard/dashboard-pages.js`. Follow the module
  style already used by `dashboard-render.js` (plain ESM, exported functions,
  JSDoc comments explaining why).
- **Shape:**
  ```js
  export const DASHBOARD_GROUPS = [
    { id: 'home', label: 'Home' },
    { id: 'operate', label: 'Operate' },
    { id: 'configure', label: 'Configure' },
    { id: 'data', label: 'Data' },
    { id: 'admin', label: 'Admin' }
  ];
  export const DASHBOARD_PAGES = [
    { id: 'overview', route: '/dashboard', label: 'Overview', group: 'home',
      title: 'Overview', help: '…', icon: '<svg …>', palette: true, nav: true },
    …
  ];
  ```
  Required entries (id → route, group, nav, palette):
  `overview /dashboard home`, `workspaces /dashboard/workspaces operate`,
  `agents /dashboard/agents operate`, `activity /dashboard/activity operate`,
  `approvals /dashboard/approvals operate`, `audit /dashboard/audit operate`
  (temporary, see Decision 3), `projects /dashboard/projects configure`,
  `secrets /dashboard/secrets configure`,
  `models /dashboard/models configure` (label `Models & Budgets`),
  `skills /dashboard/skills configure`,
  `integrations /dashboard/integrations configure`,
  `integrations-github /dashboard/integrations/github configure` (nav `false`),
  `integrations-mcp-servers /dashboard/integrations/mcp-servers configure`
  (nav `false`), `knowledge /dashboard/knowledge data`,
  `artifacts /dashboard/artifacts data`, `api-keys /dashboard/api-keys admin`
  (label `API Access`), `settings /dashboard/settings admin`,
  `profile /dashboard/profile` (group `account`, nav `false`, palette `true`).
- **Helpers to export:**
  - `pageForPath(pathname)` — exact match, then longest registered route prefix
    that yields a whole-segment match, returning `{ page, params }`; handles the
    dynamic detail routes listed in Task 1.5.
  - `navGroups()` — groups in `DASHBOARD_GROUPS` order, each with its
    `nav: true` pages in registry order, dropping empty groups.
  - `palettePageCommands()` — `{ id: 'page:' + page.id, group: 'Pages',
    label, hint, href }` for `palette: true` pages, preserving the current
    `PALETTE_PAGE_COMMANDS` entry shape.
  - `documentTitle(page)` — `"<title> | Cloud Harness"`.
- **Success criteria:** every page the server allowlist serves has a registry
  entry; no page id, label, route or group literal remains duplicated in
  `index.html`, `dashboard.js` or `dashboard-assets.ts`.
- **Verify:** `npx vitest run apps/api/test/dashboard-pages.test.ts` (created in
  Task 1.7) exits 0.

### Task 1.2 — Serve the registry module

- **Goal:** the browser can load the registry under the strict CSP.
- **Target:** `apps/api/src/dashboard-assets.ts` (`createDashboardAssetsRouter`).
- **Steps:**
  1. Add `router.get('/assets/dashboard-pages.js', (_request, response) => response.sendFile('dashboard-pages.js', options));` beside the existing four asset routes.
  2. In `apps/api/dashboard/index.html`, import the module from the existing
     module script (`import … from '/dashboard/assets/dashboard-pages.js'`) —
     no new inline script and no `style=`.
- **Success criteria:** `curl -sS $DASHBOARD/assets/dashboard-pages.js` returns the
  module with `Cache-Control: no-store`; the CSP header is unchanged.
- **Verify:** extend `apps/api/test/dashboard-app-mount.test.ts` with a case
  asserting the new asset responds 200 with `content-type: text/javascript`.

### Task 1.3 — Render navigation and the page header from the registry

- **Goal:** the sidebar and `#page-title` / `#page-help` are produced from the
  registry instead of static markup, and active state comes from `pageForPath`.
- **Target:** `apps/api/dashboard/index.html` (sidebar block at lines 28-44, page
  header at line 50) and `apps/api/dashboard/dashboard.js`
  (`sidebar.querySelectorAll('a[data-section]')` at 951-953).
- **Steps:**
  1. Replace the static nav links and `<p class="nav-group">` labels with an
     empty `<nav id="sidebar-nav">` container; keep the `.nav-ic`, `.nav-group`
     and `aria-current` contract classes so `dashboard.css` and the UI contract
     test keep passing.
  2. Add a `renderNav()` that writes `navGroups()` through the existing
     `insertRendered` helper, and a `renderPageHeader(page)` that sets
     `#page-title`, `#page-help` and `document.title`.
  3. Call both before route dispatch; delete the `data-section` active-state
     loop in favour of a registry-driven `aria-current` pass keyed on the resolved
     page id.
  4. Keep the top-bar `#profile-chip` untouched; the `profile` page is no longer
     rendered as a sidebar link.
- **Success criteria:** the sidebar DOM equals `navGroups()` at runtime; the
  `Profile` link is absent from the sidebar but present in the palette and the
  top-bar chip; icons render as before.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts` exits 0 after Task 1.7 updates both.

### Task 1.4 — Derive the command palette index from the registry

- **Goal:** palette page commands have one source.
- **Target:** `apps/api/dashboard/dashboard.js` — `PALETTE_PAGE_COMMANDS` at
  606-621.
- **Steps:**
  1. Replace the literal array with `export const PALETTE_PAGE_COMMANDS = palettePageCommands();`.
  2. Keep `buildPaletteIndex`, `rankPaletteMatches`,
     `createPaletteIndexLoader`, `isPaletteHotkey`, `chunkPaletteRequests`
     exported with unchanged signatures; the existing behaviour tests import them.
  3. Keep the current `hint` strings by moving them into the registry entry
     (`paletteHint`), so palette copy does not regress.
- **Success criteria:** palette destinations equal the set of `palette: true`
  pages; `/dashboard/overview` is no longer a palette destination (it is
  `/dashboard`).
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-behavior.test.ts`.

### Task 1.5 — Registry-driven client routing

- **Goal:** the pathname dispatch chain becomes a registry lookup and the route
  migration lands.
- **Target:** `apps/api/dashboard/dashboard.js` — dispatch chain at 960-976 and
  the detail matchers at 800-803.
- **Steps:**
  1. Keep a `PAGE_LOADERS` map from page id to the existing `load*` functions and
     a `DETAIL_LOADERS` list for `/dashboard/workspaces/:id(/(files|runtime))?`,
     `/dashboard/projects/:projectId`, `/dashboard/knowledge/:id` and
     `/dashboard/mcp-servers/:serverId`.
  2. Dispatch with `pageForPath(location.pathname)`: registered page → its
     loader; detail route → its loader; otherwise the existing not-found
     behaviour.
  3. `/dashboard` now loads the Overview; the workspace index loader moves to
     `/dashboard/workspaces`.
  4. Update every internal link that assumed the old mapping: the sidebar entry
     (registry), `paletteEntryFor` workspace hrefs are already
     `/dashboard/workspaces/:id`, `renderWorkspaceIndex` back-links, and the
     "Manage skills" link at `index.html:117`.
- **Success criteria:** `/dashboard` renders Overview; `/dashboard/workspaces`
  renders the workspace index; a workspace card link still opens the detail page;
  a back-link from a workspace returns to `/dashboard/workspaces`.
- **Verify:** `npx vitest run dashboard`.

### Task 1.6 — Server allowlist: new routes, exported list, and the Overview redirect

- **Goal:** the shell is served for every registry route and `/dashboard/overview`
  redirects.
- **Target:** `apps/api/src/dashboard-assets.ts`.
- **Steps:**
  1. Export `export const DASHBOARD_SHELL_PATHS = […] as const;` holding the
     shell path array, and keep `createDashboardAssetsRouter()` consuming it.
  2. Add `/workspaces`, `/agents`, `/activity`, `/approvals`, `/integrations`,
     `/integrations/github`, `/integrations/mcp-servers`.
  3. Add `router.get('/overview', (_request, response) => response.redirect(302, '/dashboard'));`
     before the shell route.
  4. Keep `/github`, `/mcp-servers`, `/mcp-servers/:serverId`, `/profile`,
     `/models`, `/api-keys`, `/audit`, `/skills` and all existing paths served so
     no current deep link 404s.
- **Success criteria:** every `DASHBOARD_SHELL_PATHS` entry returns the themed
  shell; `/dashboard/overview` returns 302 with `location: /dashboard`.
- **Verify:** `npx vitest run dashboard`.

### Task 1.7 — Tests

- **Goal:** the new invariants are enforced, and the tests that encoded the old IA
  are updated deliberately.
- **Target tests:** new `apps/api/test/dashboard-pages.test.ts`; updated
  `apps/api/test/dashboard-ui-contract.test.ts` (route/title table at line 149,
  `data-section="settings"` assertion at 171),
  `apps/api/test/dashboard-app-mount.test.ts` (title assertion at 47),
  `apps/api/test/dashboard-ui-behavior.test.ts`.
- **Required cases:**
  - Registry ↔ `DASHBOARD_SHELL_PATHS` parity in both directions (dynamic
    `import()` of the browser module plus the exported TS list).
  - Every registry route has non-empty `label`, `title` and `help`; ids unique;
    groups valid; `nav: true` pages belong to a declared group.
  - Nav groups render in the documented order and only include `nav: true` pages.
  - Active state: `pageForPath('/dashboard/workspaces/ws_<id>/runtime')` resolves
    the workspaces page (or the workspace detail context) and marks exactly one
    sidebar link `aria-current="page"`.
  - Palette destinations equal `palette: true` pages, and include `profile`.
  - `/dashboard` → Overview, `/dashboard/workspaces` → workspace index,
    `/dashboard/overview` → 302 → `/dashboard`.
  - `Profile` is absent from the sidebar markup and present in the top-bar chip.
- **Success criteria:** the new suite fails if any literal route/label is
  reintroduced in `index.html` or `dashboard.js`.
- **Verify:** `npx vitest run dashboard` then `npm run verify`.

### Task 1.8 — Documentation

- **Goal:** the design contract describes the shipped IA.
- **Target:** `docs/design-guidelines.md` (navigation groups, route ownership,
  registry as the page-identity owner) and the affected `docs-site/dashboard/`
  page(s) that list the sidebar.
- **Success criteria:** no doc still describes `Profile` under `Observability`,
  the old `/dashboard` workspace mapping, or a top-level GitHub/MCP Servers
  sidebar slot.
- **Verify:** `npm run docs:build` when `docs-site/` changes; `npm run verify`.

## Acceptance criteria

- One authoritative source for page identity, label, grouping and route.
- Existing DOM/accessibility contracts pass or are intentionally updated in this
  phase's diff.
- `/dashboard` resolves to Overview; `/dashboard/workspaces` resolves to the
  workspace list; `/dashboard/overview` redirects to `/dashboard`.
- Profile leaves the sidebar and stays reachable from the top-bar chip and the
  command palette.
- The command palette still resolves all global destinations.
- No shipped page became unreachable.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Plus browser QA (evidence under `plans/reports/`, not committed): sidebar groups
and active rail at desktop and ~375px, palette keyboard flow, `/dashboard`,
`/dashboard/workspaces`, `/dashboard/overview` redirect, dark and light themes,
reduced-motion emulation.

## Risks

| Risk | Mitigation |
|---|---|
| Mount test asserts a fixed `<title>` for every route | The static shell title becomes the Overview title and the test asserts per-route titles from the registry |
| Removing static nav markup breaks CSS or the UI contract test | Keep `.nav-group`, `.nav-ic` and `aria-current` contracts; run the contract test after each edit |
| Palette regressions (`hint` copy, ranking, batches) | Move hints into the registry, keep exported helper signatures, keep the existing behaviour suite green |
| Integrations consolidation loses the MCP detail page | Keep `/dashboard/mcp-servers/:serverId` served and asserted |
