# Phase 5: Dashboard MCP Servers UI

## Context Links
- Plan: `plans/260914-0414-mcp-gateway/plan.md`
- UI: `apps/api/dashboard/index.html`, `apps/api/dashboard/dashboard.js`, `apps/api/dashboard/dashboard-render.js`, `apps/api/dashboard/dashboard-api.js`, `apps/api/dashboard/dashboard.css`
- Shell route: `apps/api/src/dashboard-assets.ts`
- Design contract: `docs/design-guidelines.md`
- Tests: `apps/api/test/mcp-servers-dashboard-ui.test.ts` (new), `apps/api/test/dashboard-ui-contract.test.ts`, `apps/api/test/dashboard-app-mount.test.ts`

## Requirements
- A new `MCP Servers` navigation entry, page at `/dashboard/mcp-servers`, and detail page at `/dashboard/mcp-servers/:serverId`.
- The list shows name, transport, status, tool count, last connected, and enabled, with visually distinct Connected/Connecting/Disconnected/Error/Disabled status pills.
- Actions: Add, Edit, Enable/Disable, Test/Reconnect, Refresh tools, Delete.
- The add/edit form covers name, description, URL, authentication/headers with secret references, and enabled; it never asks the browser for a saved secret's plaintext.
- The detail page has Overview / Tools / Permissions / Logs tabs; Tools is searchable and can refresh; Permissions edits the server default and per-tool overrides; Logs lists recent calls and can reveal sanitized detail.
- A gateway card shows the single `/mcp-gateway` endpoint with a working copy control and the explanatory sentence.
- The gateway card names the credential lane the endpoint accepts. `/mcp-gateway` is served on the same Streamable HTTP + OAuth/Access-bearer lane as `/mcp`; the managed API-key Worker lane is **not** extended in this task, so the card must say so rather than showing one unconditional URL.
- The card lists the two hard limitations an operator will hit first: HTTP redirects are refused (a vendor base URL that 301s to `/mcp` must be configured as its final URL), and `stdio` downstream servers are unsupported.
- No new visual language, no framework, no inline styles, no client storage; match the existing design system exactly.
- The whole surface is served verbatim from `apps/api/dashboard/` (no build step). `index.html` changes require an API restart.

## Tasks & Steps

### Task 5.1 — API client wrappers
- **Goal:** typed dashboard API helpers for the new section.
- **Target files and symbols:** `apps/api/dashboard/dashboard-api.js` (`api()` wrapper, line 9).
- **Steps:**
  1. Append, following the Knowledge wrapper style (lines 39-55) and `encodeURIComponent` for ids:
     ```js
     export const listMcpServers = () => api('/mcp-servers');
     export const getMcpServer = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}`);
     export const createMcpServer = (payload) => api('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
     export const updateMcpServer = (serverId, payload) => api(`/mcp-servers/${encodeURIComponent(serverId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
     export const deleteMcpServer = (serverId, expectedGeneration) => api(`/mcp-servers/${encodeURIComponent(serverId)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
     export const setMcpServerEnabled = (serverId, enabled, expectedGeneration) => api(`/mcp-servers/${encodeURIComponent(serverId)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled, expectedGeneration }) });
     export const setMcpServerPermissions = (serverId, payload) => api(`/mcp-servers/${encodeURIComponent(serverId)}/permissions`, { method: 'PUT', body: JSON.stringify(payload) });
     export const testMcpServer = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/test`, { method: 'POST' });
     export const refreshMcpServerTools = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/refresh`, { method: 'POST' });
     export const listMcpServerLogs = (serverId, cursor) => api(`/mcp-servers/${encodeURIComponent(serverId)}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
     export const getMcpGatewayEndpoint = () => api('/mcp-gateway');
     ```
  2. Do not add a browser-side fetch to any third-party URL (`connect-src 'self'` forbids it).
- **Success criteria:** `dashboard-api.js` exports all eleven helpers and no new global.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0.

### Task 5.2 — Render functions
- **Goal:** pure renderers for the index and detail views, using the module-local `escape`.
- **Target files and symbols:** `apps/api/dashboard/dashboard-render.js` (module-local `escape`, line 1).
- **Steps:**
  1. Add a `mcpStatusLabel(status)` helper mapping `connected → Connected` (pill class `active`), `connecting → Connecting` (`reaping`), `disconnected → Disconnected` (neutral), `error → Error` (`failed`), `disabled → Disabled` (neutral), `unknown → Unknown` (neutral).
  2. `renderMcpServersIndex(data)`: a gateway card (`.panel`) with `<h2>Your Cloud Harness MCP Gateway</h2>`, the endpoint value in `.mono`, a `<button type="button" class="copy" data-copy="${escape(endpoint)}">Copy</button>`, the sentence "Connect this single MCP endpoint to your AI client. Tools from your configured MCP servers are discovered and executed through Cloud Harness.", a lane line derived from `authMode` ("Authenticates with your Cloud Harness Access session / owner bearer token; the managed API-key lane is not yet available for this endpoint."), and a `.page-note` listing the redirect and stdio limitations; then an "Add MCP server" trigger button (`data-mcp-add`, `aria-haspopup="dialog"`); then a `.desktop-table` + `.mobile-list` pair with columns Name / Transport / Status / Tools / Last connected / Enabled / Actions.
     - Actions per row: Edit (`data-mcp-edit="<id>"`), Enable/Disable (`data-mcp-toggle="<id>" data-next-enabled="true|false"`), Test (`data-mcp-test="<id>"`), Refresh tools (`data-mcp-refresh="<id>"`), Delete (`data-mcp-delete="<id>"`), and a link to the detail page.
     - Empty state: `<tr><td colspan="7">No MCP servers configured.</td></tr>` plus a `.empty` list item with guidance.
  3. `renderMcpServerDetail(server, tools, traces, activeTab)`: header with name, status pill, transport, sanitized endpoint, enabled state, last connected, last error, tool count; a tab bar using `.knowledge-nav-tabs`-style markup generalized to `mcp-nav-tabs`/`mcp-tab-btn` with `data-mcp-tab="overview|tools|permissions|logs"`; then the active panel:
     - overview: a `.facts` definition list of the fields above and the gateway endpoint card.
     - tools: a search input (`id="mcp-tool-search"`), a Refresh tools button (`data-mcp-refresh`), a table Tool / Description / Permission / Availability, and for each tool a details expansion rendering `escape(JSON.stringify(tool.inputSchema, null, 2))` inside `<pre class="mono">`.
     - permissions: a form (`id="mcp-permissions-form"`) with a server-default select (`allow`/`deny`) and one select per tool (`name="tool:<toolName>"`), plus a Save button; include the current `generation` as a hidden input.
     - logs: a table Time / Tool / Client / Duration / Status and a `<details>` per row with the sanitized error and ids. Include a "Load more" button when a cursor exists.
  4. Every interpolated value must pass through `escape`; no `style=` attribute and no `<style>` element anywhere.
- **Success criteria:** both renderers return CSP-safe HTML for representative fixtures.
- **Verify:** `npx vitest run apps/api/test/mcp-servers-dashboard-ui.test.ts` exits 0.

### Task 5.3 — Navigation and dialogs
- **Goal:** the section is reachable and the add/edit form uses the existing dialog pattern.
- **Target files and symbols:** `apps/api/dashboard/index.html`.
- **Steps:**
  1. Add the nav anchor under `Configuration`, immediately after the GitHub entry (line 36) and before the Observability group header (line 37):
     `<a href="/dashboard/mcp-servers" data-section="mcp-servers"><svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">…</svg>MCP Servers</a>` — use a simple plug/link style icon consistent with the other inline SVGs.
  2. Add a `<dialog id="mcp-server-dialog">` before `#command-palette` containing a `<form id="mcp-server-form" class="stack-form">` with:
     - hidden `<input name="serverId">` and hidden `<input name="expectedGeneration">`;
     - Name (`maxlength="63"`, required, pattern for the server-name regex);
     - Description (`maxlength="500"`);
     - Transport `<select name="transport">` with `streamable-http` and `sse` only, and a disabled `stdio` option labelled `stdio (unsupported)`;
     - URL (`type="url"`, required, `maxlength="2048"`, `inputmode="url"`);
     - a header editor: at least one `.form-row` with a header name input and a value-mode select (`literal` | `secret reference`), a literal value input, and a secret-reference `<select>` populated from the existing global secrets list, plus an "Add header" button (`data-mcp-add-header`);
     - an Enabled checkbox;
     - a Test connection button (`data-mcp-dialog-test`) and a `.form-status[aria-live="polite"]` result region that reports `Connected — N tools discovered` or the sanitized error;
     - Cancel and Save submit buttons.
  3. Reuse the existing dialog semantics: `role` is not set manually (native `<dialog>` + `showModal()`), Escape closes, focus is trapped by the existing controller.
  4. Never pre-fill a saved secret's value: when editing, secret-reference headers render as `{ kind: 'secret', secretRef }` with an empty value input and a note that the value is write-only.
- **Success criteria:** the page markup contains the nav entry and the dialog; no inline styles.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-app-mount.test.ts` exits 0.

### Task 5.4 — Loaders, binders, palette entry
- **Goal:** the section loads, mutates, and is reachable from the command palette.
- **Target files and symbols:** `apps/api/dashboard/dashboard.js` (`load()` line 634, palette commands line 287, imports line 22).
- **Steps:**
  1. Import the new API wrappers and renderers.
  2. Add `const mcpServerMatch = location.pathname.match(/^\/dashboard\/mcp-servers\/(mcps_[A-Za-z0-9_-]{20,80})$/);` next to the other route regexes (line 478).
  3. In `load()`, add branches before the 404 fallback:
     `else if (location.pathname === '/dashboard/mcp-servers') await loadMcpServers();`
     `else if (mcpServerMatch) await loadMcpServerDetail(mcpServerMatch[1]);`
  4. `loadMcpServers()` mirrors `loadKnowledge` (line 1269): `selectNavigation('mcp-servers')`, `setTitle('MCP Servers', '…')`, hide `#command-surface`, `setBusy(true)`, `Promise.all([listMcpServers(), getMcpGatewayEndpoint()])`, `content.innerHTML = renderMcpServersIndex(...)`, `bindMcpServersControls()`, `setBusy(false)`.
  5. `loadMcpServerDetail(serverId, tab = 'overview')` loads `getMcpServer` and `listMcpServerLogs` only when the logs tab is active, then renders and binds.
  6. `bindMcpServersControls()`:
     - `[data-mcp-add]` → fetch the global secrets list (`GET /api/v1/secrets`, via a new `listGlobalSecrets` wrapper if one does not exist) and open the dialog in create mode.
     - `[data-mcp-edit]` → open the dialog in edit mode from the already-loaded server object.
     - Form submit → build the payload (`headers` array from the header rows; omit a secret value entirely) and call `createMcpServer`/`updateMcpServer` through `submitForm(form, 'Saving…', action, onSuccess)` (line 709), then `announce('MCP server saved.')` and reload.
     - `[data-mcp-toggle]` → `setMcpServerEnabled(id, next, generation)` then `announce(...)` and reload.
     - `[data-mcp-test]` → `testMcpServer(id)`, then `announce(result.status === 'connected' ? \`Connected — ${result.toolCount} tools discovered.\` : \`Connection failed: ${result.error}\`)`.
     - `[data-mcp-refresh]` → `refreshMcpServerTools(id)` then reload.
     - `[data-mcp-delete]` → `confirmAction({ title: 'Delete MCP server?', description: \`Delete "${name}"? Its cached tools, permission overrides, and recorded logs are removed.\`, target: id, label: 'Delete server', pendingLabel: 'Deleting…', action })` (line 1641), then reload. The BFF closes that server's cached connection, so a resolved credential does not stay resident.
     - `[data-mcp-tab]` → `loadMcpServerDetail(serverId, tab)`.
     - `#mcp-tool-search` input → client-side filter of the rendered tool rows (do not refetch per keystroke).
     - `#mcp-permissions-form` submit → `setMcpServerPermissions(id, { permissionDefault, tools: [{ name, permission }], expectedGeneration })` — the frozen field name from Phase 1; sending `default` is rejected with 400 by the strict runner schema.
     - `[data-mcp-add-header]` → clone a header row.
  7. Add the palette page command next to the Knowledge entry (line 295): `{ id: 'page:mcp-servers', group: 'Pages', label: 'MCP Servers', hint: 'Manage downstream MCP integrations', href: '/dashboard/mcp-servers' }`.
  8. Remember: `dashboard.js` has no HTML escaper — build all markup in `dashboard-render.js`; when setting text from `dashboard.js`, use `textContent`.
- **Success criteria:** navigation renders the section, and every action wires to its API helper.
- **Verify:** `npx vitest run apps/api/test/mcp-servers-dashboard-ui.test.ts apps/api/test/dashboard-ui-behavior.test.ts` exits 0.

### Task 5.5 — Shell routes
- **Goal:** the two page paths serve the dashboard shell.
- **Target files and symbols:** `apps/api/src/dashboard-assets.ts` (route list, line 42).
- **Steps:**
  1. Add `'/mcp-servers'` and `'/mcp-servers/:serverId'` to the `router.get([...])` array.
  2. Remember this file is read at process start, so an API restart is required for the shell to serve the new paths.
- **Success criteria:** `GET /dashboard/mcp-servers` returns 200 with the shell.
- **Verify:** `npx vitest run apps/api/test/dashboard-app-mount.test.ts` exits 0.

### Task 5.6 — CSS
- **Goal:** the section looks native to the console with no new design language.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`.
- **Steps:**
  1. Reuse `.panel`, `.desktop-table`, `.mobile-list`, `.stack-form`, `.form-row`, `.form-row-actions`, `.form-status`, `.inline-form`, `.facts`, `.empty`, `.status`, `.copy`, `.mono`, `.tag-badge`, `.skeleton`, `.toast`, `.dialog-actions`, `.page-note`.
  2. Add only a small section block: `.mcp-nav-tabs` (mirroring the `.knowledge-nav-tabs` rules), `.mcp-tab-btn`, `.mcp-tab-btn.active`, `.mcp-header-rows`, `.mcp-tool-schema` (`pre` styling), and `.mcp-endpoint` (a bordered copy row). Use only existing tokens; OKLCH only; no hex; no `gradient()`.
  3. Because the primary action in the gateway card is `<button type="button">` and `.accent-btn` has no CSS rule, style it through `button[type="submit"]` semantics in the form or add a minimal `.mcp-endpoint .copy` rule — do not rely on `.accent-btn`.
  4. Add the mobile rules that hide `.desktop-table` and show `.mobile-list` inside the new section; verify the tabs wrap at 375px.
- **Success criteria:** the contract test still rejects no-hex/no-gradient and the new classes exist.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0.

### Task 5.7 — UI tests
- **Goal:** the section's rendering and route wiring are pinned.
- **Target files and symbols:** create `apps/api/test/mcp-servers-dashboard-ui.test.ts`; edit `apps/api/test/dashboard-ui-contract.test.ts` (nav loop, line 44) and `apps/api/test/dashboard-app-mount.test.ts` (route list, line 44).
- **Steps:**
  1. Import `renderMcpServersIndex` and `renderMcpServerDetail` from `../dashboard/dashboard-render.js` and assert, for representative fixtures: the gateway heading and endpoint appear; a `Connected` pill carries the `active` class; each server name/transport/tool count renders; a `Disable` action appears for an enabled server and `Enable` for a disabled one; an empty list renders the empty state; the detail view renders the four tab buttons; a `deny` tool renders its permission; the logs table renders a trace row.
  2. End every renderer case with `expect(html).not.toContain('style=')` and `expect(html).not.toContain('<style>')`.
  3. Assert that server-supplied text with `<img src=x onerror=…>` is escaped (the raw tag does not appear).
  4. Add `['/dashboard/mcp-servers', 'MCP Servers']` to the contract-test nav loop.
  5. Add `'/mcp-servers'` and `'/mcp-servers/:serverId'` to the app-mount route list.
- **Success criteria:** all dashboard suites pass.
- **Verify:** `npx vitest run apps/api/test/mcp-servers-dashboard-ui.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-app-mount.test.ts apps/api/test/dashboard-ui-behavior.test.ts` exits 0.

## Verification

```bash
npm run typecheck -w @cloud-harness/api
npx vitest run apps/api/test/mcp-servers-dashboard-ui.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-app-mount.test.ts apps/api/test/dashboard-mcp-gateway-api.test.ts
```

Success: every command exits 0; the contract test still enforces OKLCH-only, no inline
styles, and no forbidden client storage; the new section renders the gateway endpoint and
the status pills.

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
