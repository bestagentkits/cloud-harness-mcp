---
phase: 2
title: "Dashboard Settings page"
status: pending
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 2: Dashboard Settings page

## Goal

An operator can open `/dashboard/settings`, see the effective default network
profile, its source, and egress readiness, then change or reset it — with the
credential-exfiltration tradeoff visible before saving.

## Context

The dashboard is one static shell (`apps/api/dashboard/index.html`) served by
`createDashboardAssetsRouter()` for an explicit path allowlist
(`apps/api/src/dashboard-assets.ts:42-61`), not for every path: a new page path
must be registered there or the shell is not served. Navigation is static HTML,
pages render from JS (`dashboard.js` `load()` dispatch at line 657, renderers in
`dashboard-render.js`), and mutations are JSON with `x-csrf-token` plus a host and
Origin allowlist (`dashboard-security.ts:12-27`, `dashboard-session.ts:59`).
BFF responses are mapped through `mapDashboardData`/`sendRunnerResponse`
(`apps/api/src/dashboard-response.ts:34-43, 209`), whose `DashboardResponseOperation`
union is an explicit allowlist.

Adding a page therefore touches: the assets allowlist, the nav, the dispatch
branch, the palette collection, a loader, a renderer, the response-operation
union, and the BFF routes.

## Tasks & Steps

### Task 2.1 — BFF routes and response-operation typing

- **Goal:** authenticated dashboard clients can read, update, and reset the
  instance default network profile and probe egress readiness.
- **Target files and symbols:**
  - `apps/api/src/dashboard-response.ts` — the `DashboardResponseOperation` union
    (lines 34-43), `mapDashboardData` (line 125) and `operationMessages` (line 199).
  - `apps/api/src/dashboard-router.ts` — inside `createDashboardRouter`, beside the
    existing `router.get('/api/v1/toolkits', ...)` handler (line 155).
  - `apps/api/src/dashboard-assets.ts` — the path allowlist array (lines 42-61).
- **Steps:**
  1. Add `'settings_get' | 'settings_update' | 'settings_network_check'` to the
     `DashboardResponseOperation` union. Give each a message entry in
     `operationMessages` in the style of the existing entries, and confirm
     `mapDashboardData` forwards the settings payload unchanged (its default
     branch already returns `data`).
  2. Add `'/settings'` to the dashboard assets path allowlist next to the other
     single-segment page paths (keep the existing entry ordering/style).
  3. In `dashboard-router.ts` add `router.get('/api/v1/settings', ...)`: require
     `principal(request, response)` to be external, return
     `503 { error: 'settings_unavailable', message: 'Settings are temporarily unavailable.' }`
     when `runner.callInternal` is missing (mirroring lines 159-162), otherwise
     `sendRunnerResponse(response, 'settings_get', await runner.callInternal('settings_get', {}, selected))`.
  4. Add `router.post('/api/v1/settings', ...)` parsing the body with
     `z.object({ defaultNetworkProfile: z.union([z.enum(['network-none','dependency-access']), z.null()]) }).strict()`
     and forwarding it to `settings_update`. An invalid body flows to the existing
     `ZodError` handler → 400.
  5. Add `router.post('/api/v1/settings/network-check', ...)` forwarding `{}` to
     `settings_network_check`.
  6. Add no session or CSRF code: the router-level gates at lines 67-78 already
     cover mutations, and `GET` intentionally has no CSRF requirement.
- **Success criteria:** each route returns the mapped runner envelope as
  `{ data: ... }`; an unauthenticated request is rejected by the existing gates;
  a mutation without the CSRF token is rejected.
- **Verify:** `npx vitest run apps/api/test/dashboard-router.test.ts` exits 0 with
  added cases asserting: `GET /api/v1/settings` proxies `settings_get`;
  `POST /api/v1/settings` with `{ defaultNetworkProfile: 'network-none' }` proxies
  `settings_update` with that input; `{ defaultNetworkProfile: 'local-host' }` and
  an unknown extra key both return 400; `POST /api/v1/settings/network-check`
  proxies `settings_network_check`.

### Task 2.2 — Settings page: navigation, route, loader, renderer

- **Goal:** `/dashboard/settings` renders the current setting, its source, the
  egress readiness control, and the save/reset actions.
- **Target files and symbols:**
  - `apps/api/dashboard/index.html` — the `Configuration` nav group (line 31).
  - `apps/api/dashboard/dashboard.js` — `load()` dispatch (line 657),
    `PALETTE_PAGE_COMMANDS` (line 308), `setTitle`/`selectNavigation` (lines 646, 650),
    `api()` mutation usage and the `renderProfile` loader (line 1275) as patterns.
  - `apps/api/dashboard/dashboard-render.js` — beside `renderProfile` (line 115).
  - `apps/api/dashboard/dashboard.css` — only if a needed primitive is missing.
- **Steps:**
  1. Add to the Configuration nav group, after the MCP Servers link (line 37):
     `<a href="/dashboard/settings" data-section="settings">` with a `nav-ic` svg
     (copy the exact attributes used by the neighbouring links) and the label
     `Settings`.
  2. Add `else if (location.pathname === '/dashboard/settings') await loadSettings();`
     to the `load()` chain.
  3. Add a `PALETTE_PAGE_COMMANDS` entry using that collection's contract:
     `{ id: 'page:settings', group: 'Pages', label: 'Settings', hint: 'Instance defaults for workspaces and network egress', href: '/dashboard/settings' }`.
     Do not invent new keys: `renderPaletteResults` renders `label`/`group`/`hint`/`href`.
  4. Implement `loadSettings()`: `selectNavigation('settings')`,
     `setTitle('Settings', 'Instance-wide defaults applied to new workspaces.')`,
     hide `#command-surface`, show a loading skeleton, then
     `const { data } = await api('/settings')` and
     `content.innerHTML = renderSettings(data)`.
     Wire the three actions with `addEventListener('click', ...)` after rendering:
     Save → `POST /settings` with `{ defaultNetworkProfile: <selected value> }`;
     Reset → `POST /settings` with `{ defaultNetworkProfile: null }`;
     Check egress → `POST /settings/network-check` with `{}`.
     After each response, re-render from the returned `data` (the readiness result
     from the check is merged into the rendered state) and write a short status
     line into `#settings-status`, matching the existing `status-message` pattern.
  5. Implement `renderSettings(data)` in `dashboard-render.js` returning:
     - a `.panel` with a `<select id="settings-network-profile">` offering
       `dependency-access` ("Dependency access — public DNS and TCP 80/443 egress;
       required for `gh` and the GitHub API"), `network-none` ("No network —
       air-gapped isolation"), and an empty option "Use runner default";
       the matching option is `selected` when `data.defaultNetworkProfile.source === 'setting'`,
       otherwise the empty option is selected;
     - a facts list showing the effective value and its source (`setting` → "Set in
       this dashboard", `environment` → "Runner default (WORKSPACE_NETWORK_PROFILE or
       built-in)"), plus the readiness line when the check has run
       (`Ready` / `Not ready: <reason>`);
     - a `<p class="warning">` stating that egress lets repository-controlled code
       reach the network and exfiltrate any credential injected into the workspace,
       including a global `GH_TOKEN`, and that a fine-grained token scoped to the
       needed repositories is safer;
     - the three buttons (Save, Reset to runner default, Check egress readiness) and
       `<p id="settings-status" class="status-message" aria-live="polite"></p>`.
  6. Escape every interpolated value with the module-local `escape` helper
     (`dashboard-render.js:1`).
- **Success criteria:** the page loads without console errors, shows the effective
  value and source, and each of the three actions round-trips through the BFF.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts`
  exits 0 after adding cases that assert: `index.html` contains the
  `data-section="settings"` nav link; `dashboard.js` contains the
  `/dashboard/settings` dispatch branch and a `page:settings` palette entry with an
  `href`; selecting the Settings palette result navigates to `/dashboard/settings`;
  `renderSettings` output marks the stored profile selected, marks the empty option
  selected for the environment source, and includes the credential warning text.

### Task 2.3 — Remove the retired field from dashboard markup and scripts

- **Goal:** no dashboard file presents the retired `networkMode` field or its
  legacy `none`/`bridge` values.
- **Target files and symbols:**
  - `apps/api/dashboard/index.html` lines 105-109.
  - `apps/api/dashboard/dashboard-render.js` line 20 (`workspace.networkMode === 'bridge'`).
- **Steps:**
  1. In `index.html` rename the select to `<select id="open-network-profile" name="networkProfile">`
     with the label `Network profile (optional)`, and replace the options with the
     contract values `network-none` ("No network (air-gapped isolation)") and
     `dependency-access` ("Dependency access (public DNS, TCP 80/443)"), leaving
     `dependency-access` selected to match the shipped default.
  2. In `dashboard-render.js` line 20 delete the legacy
     `|| workspace.networkMode === 'bridge'` disjunct so the warning depends only on
     `workspace.networkProfile === 'dependency-access'`. Keep `networkLabel`
     (line 3) and its `profile ?? workspace.networkMode` fallback: it renders
     legacy records that still carry the old field.
  3. Keep the dialog otherwise unchanged; it currently has no JavaScript consumer
     and wiring it is out of scope for this change.
- **Success criteria:** the string `networkMode` survives only in the
  `networkLabel` legacy-record fallback, and the dashboard markup sends
  `networkProfile`.
- **Verify:** `grep -rn "networkMode" apps/api/dashboard apps/api/test` prints at
  most the single `networkLabel` line in `dashboard-render.js:3`;
  `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0.

### Task 2.4 — Manual smoke against a local dashboard

- **Goal:** observe the page and the mutations against the real surface.
- **Steps:**
  1. Start the local stack the way `docs/development.md` prescribes for the
     dashboard (or the local backend when the runner cannot run on this host).
  2. Open `/dashboard/settings` in the browser; confirm the layout, the effective
     value, the source, the warning, and that Check egress readiness reports a
     result.
  3. Save `network-none`, reload, confirm the value and source persist; reset to the
     runner default, reload, confirm the source returns to "Runner default".
- **Success criteria:** the observations match the rendered page; capture the
  browser state as evidence.
- **Verify:** the browser shows the saved value after a reload with no console
  errors.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

## Guardrails
- No new secrets, no token material, and no environment values in the page.
- Stay inside the existing design-token and primitive classes documented in
  `docs/design-guidelines.md`; no new CSS framework, no inline styles.
- The Settings page never starts or mutates a workspace, and saving a setting is
  not evidence that egress is ready.
