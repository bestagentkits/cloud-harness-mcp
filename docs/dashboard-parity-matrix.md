# Dashboard 2.0 parity matrix

> **Migration artifact.** This matrix exists only for the Dashboard 2.0
> migration (epic
> [#458](https://github.com/bestagentkits/cloud-harness-mcp/issues/458)). It is
> deleted together with the legacy shell in the P6 removal follow-up. It is
> not evergreen guidance: code, schemas and tests own behaviour, and the
> pointers below say where.

This document maps the legacy Dashboard (`apps/api/dashboard/`, vanilla JS) to
Dashboard 2.0 (`apps/dashboard/`, React, decided in
[ADR 0005](adr/0005-dashboard-react-rewrite.md)). Each P3/P4 PR marks the rows
it closes and keeps every security row intact.

Source: a static code-read audit (no browser run) of `main` at `e8bd0aa6` on
2026-10-20. UI-caller columns were derived by grepping every `api(` call and
every helper exported by `apps/api/dashboard/dashboard-api.js` across
`apps/api/dashboard/dashboard*.js`. Values that change often (limits, CSP
text, timings, versions, test counts) are not copied here; the pointer names
the owning file or symbol.

## Conventions

Owner files:

| Short name | File |
| --- | --- |
| `dashboard.js` | `apps/api/dashboard/dashboard.js` (page loaders, controllers) |
| `dashboard-render.js` | `apps/api/dashboard/dashboard-render.js` (HTML string renderers) |
| `dashboard-models.js` | `apps/api/dashboard/dashboard-models.js` (models page, profile wizard) |
| `dashboard-pages.js` | `apps/api/dashboard/dashboard-pages.js` (page registry) |
| `dashboard-api.js` | `apps/api/dashboard/dashboard-api.js` (fetch wrapper and helpers) |
| `dashboard-terminal.js` | `apps/api/dashboard/dashboard-terminal.js` (terminal client and pane) |
| `index.html` | `apps/api/dashboard/index.html` (shell and static dialogs) |
| `dashboard-inbox.js` | `apps/api/dashboard/dashboard-inbox.js` (inbox and notification preferences) |
| `dashboard-traces.js` | `apps/api/dashboard/dashboard-traces.js` (trace list, detail and agent panel) |
| `dashboard-policies.js` | `apps/api/dashboard/dashboard-policies.js` (agent policy editor) |
| router | `apps/api/src/dashboard-router.ts` |
| control router | `apps/api/src/dashboard-control-router.ts` |
| gateway router | `apps/api/src/dashboard-gateway-router.ts` |
| terminal router | `apps/api/src/dashboard-terminal-router.ts` |
| inbox router | `apps/api/src/dashboard-inbox-router.ts` |
| policies router | `apps/api/src/dashboard-policies-router.ts` |
| traces router | `apps/api/src/dashboard-traces-router.ts` |
| assets | `apps/api/src/dashboard-assets.ts` |
| security | `apps/api/src/dashboard-security.ts` |
| session | `apps/api/src/dashboard-session.ts` |
| response | `apps/api/src/dashboard-response.ts` |

Phases: P1 scaffold, build and canary; P2 router shell and shared primitives;
P3 core pages; P4 sensitive and complex flows; P5 CX/AX and Dewee; P6
cutover and legacy removal (see the
[child issue drafts](../plans/261020-1224-dashboard-2-react-dewee/child-issues/)).
P4c ports the legacy pages that were built on `dev` after this audit and
joined the React line in the #541 merge (see [section 12.5](#125-p4c-dev-only-legacy-pages)).

Test classes: **(a)** BFF or security contract, keep unchanged; **(b)**
frontend behaviour through a fake DOM, port to Playwright; **(c)**
markup-coupled, replace with a behavioural test (see
[section 9](#9-markup-coupled-tests-to-replace-with-behavioural-tests)).

The "Feature" column names `<x>` in `apps/dashboard/src/features/<x>`.

## 1. Non-negotiable invariants

These apply to every phase. A PR that weakens one is blocked.

| Invariant | Owner | React note |
| --- | --- | --- |
| Strict CSP | `dashboardSecurity` in security | ADR 0005 adds only `font-src 'self'`. No inline script, no runtime-injected `<style>` (watch Radix `react-remove-scroll` and toast libraries). CSSOM and the React `style` prop are allowed. Any other directive needs an ADR change and a test. |
| Session cookie plus `x-csrf-token` from `GET /dashboard/api/v1/session`, token held in memory only | session, `bootstrapSession`/`api` in `dashboard-api.js` | Token never enters storage, a query-cache dump or logs. On 401, drop the token and bootstrap again. |
| Mutations need an allowlisted Origin matching Host, a JSON body and the body limit | `dashboardSecurity`, router (`requireJson`, `express.json`) | The only exception is `POST /skill-archives` (raw zip, own media types and limit in the control router). |
| Mount order: request security, pre-auth limits, Access JWT, per-principal limits on `/dashboard/api/v1`, dashboard router, assets router | `apps/api/src/app.ts`, limits in `apps/api/src/request-security.ts` | The client must budget requests: the terminal long-poll and the fan-out routes share one principal's concurrency budget. |
| No secret in the browser: secret values, provider keys and integration credentials are write-only. Only `POST /api-keys` returns plaintext, once. | projections in response, `api_key_create` handler in control router | One-time reveals are cleared on dismiss, link click, `pagehide` and session end. |
| Same-origin versioned assets with `private, immutable` caching; shell `no-store` | assets | The allowlist is built from `.vite/manifest.json` at startup. The manifest is never served as an asset. The legacy `apps/api/dashboard/` stays in the image until P6 (see [section 11](#11-server-side-changes-react-needs-p1)). |
| Theme and display name via server cookies, `data-theme` injected on first paint | `PUT /preferences` in router, `forcedTheme` in assets | A new shell must keep the `<html lang="en">` tag `forcedTheme` replaces, or change both together. |
| `/dashboard/mcp-oauth/callback` handled by the server; nginx turns off its access log | gateway router, `deploy/nginx/cloud-harness-mcp.conf` | The React router never claims this path. It stays a server-side 303. |
| `/cdn-cgi/access/logout` belongs to Cloudflare Access | `index.html` sign-out link | A native link outside the router. |

## 2. Routes and pages

The legacy registry is `DASHBOARD_PAGES` in `dashboard-pages.js`, loaders are
`PAGE_LOADERS` in `dashboard.js`, and the server shell list is
`DASHBOARD_SHELL_PATHS` in assets. `apps/api/test/dashboard-pages.test.ts`
forces the two lists to agree. React replaces this with one route identity
(ADR 0005) and an **allowlist** SPA fallback: only HTML navigations to known
Dashboard route prefixes get the shell, unknown `/dashboard/*` paths still
404, and `/dashboard/api/`, `/dashboard/assets/` and `/dashboard/mcp-oauth/`
are never answered by the fallback.

| Legacy route | Page key / loader | Feature | Phase | Deep-link params (keep as search params) | BFF reads (legacy loader) | Security note | Tests to port |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/dashboard` | overview / `loadOverview` | `overview` | P3 | none | `/profile`, `/server`, `/overview`, `/metrics?window=24h`, `/reliability`; approvals badge reads `/privilege-grants` and `/package-plans` | Fan-out route (F5) | `dashboard-overview` (a), `dashboard-analytics` (b), `dashboard-agent-series` (b) |
| `/dashboard/workspaces` | workspaces / `loadIndex` | `workspaces` | P3 | `q`, `status`, `expiring` | `/workspaces` | Fix R1: the filter must stay on this route | `dashboard-ui-behavior` (b) |
| `/dashboard/workspaces/:ws_id[/tab]` | cockpit / `loadWorkspace` | `workspace-cockpit` | P3 (summary, agents, runtime, automation, deploy, artifacts, activity), P4 (terminal, files, git), P4c (repository scope #563, skill grant #565) | `path`, `file` (files), `staged` (git), `repository` (files, git, terminal) | `/workspaces/:id`, `/context`, `/agents`, `/runtime`, `/tasks/graph`, `/skills`, `/hooks`, `/deployments`, `/artifacts`, `/activity`, `/files`, `/files/content`, `/git/status`, `/git/diff`, `/git/log`, `/worktrees`, `/terminals`, `/repositories` (all under `/workspaces/:id`) | Tabs and id pattern: `pathMatch` regexes in `performLoad`; multi-repository reads and writes carry `repositoryId` (`withRepository`, `inRepository` in `dashboard.js`) | `dashboard-cockpit` (a/b), `dashboard-runtime` (b), `dashboard-automation` (b), `dashboard-git` (a+b), `dashboard-multi-repository` (a+b), `dashboard-skill-run-approval` (b) |
| `/dashboard/agents[/:agent_id]` | agents / `loadAgents` | `agents` | P3 | `status`, `workspaceId`, `profileId`, `parentAgentId`, `attention` | `/agents`, `/agents/:id`, `/agents/:id/logs`; the detail's Traces panel (P4c, #560) reads `/traces?agentId=` | Fan-out without `workspaceId` (F5) | `dashboard-agents` (b) |
| `/dashboard/inbox` | inbox / `loadInbox` | `inbox` | P4c (#557) | `unread=1` | `/inbox?limit=…`, `/notification-preferences`; the shell reads `/inbox/status` once per document for the nav entry and unread badge | Nav entry hidden until notifications are available; a notification link is followed only when it is a relative `/dashboard` path (`safeNotificationLink`) | `dashboard-inbox-ui` (b), `dashboard-inbox-router` (a) |
| `/dashboard/traces[/:trc_id]` | traces / `loadTraces`, `loadTraceDetail` | `traces` | P4c (#560) | `state`, `profileId`, `agentId`, `workspaceId`, `window` | `/traces`, `/traces/:id`, `/traces/:id/spans`; the shell reads `/traces/status` once per document for the nav entry; export is a native download of `/traces/:id/export?format=` | Nav entry hidden until traces are enabled; unobserved figures read "unknown", never 0; waterfall uses SVG geometry, no inline style | `dashboard-traces-ui` (b), `dashboard-traces-router` (a), `agent-traces-http` (a, integration) |
| `/dashboard/automations[/rules\|/connections\|/deliveries\|/runs/:wfl_id]` | automations / `loadAutomations` | `automations` | P4c (#561) | `ruleId`, `state` (runs), `connectionId` (deliveries) | `/automations/workflows`, `/automations/workflows/:id` (`actionsCursor`), `/automations/rules`, `/automations/connections`, `/automations/deliveries` | Connection signing secret is a one-time reveal (section 8); the runner's notification links point at `/dashboard/automations/runs/:id`; a disabled or unavailable runner renders a blocked state | `dashboard-automations-ui` (b), `dashboard-automations-router` (a), `dashboard-automation-bff` (a), `automations-webhook-http` (a, integration) |
| `/dashboard/activity` | activity / `loadActivity` | `activity` | P3 | `filter` | `/activity`; approvals badge reads `/privilege-grants` and `/package-plans` | Fan-out | `dashboard-activity` (b) |
| `/dashboard/approvals` | approvals / `loadApprovals` | `approvals` | P3 (read), P4 (approve/reject) | none | `/privilege-grants`, `/package-plans` | Badge refreshes only on page loads (R13); React uses query invalidation | `dashboard-activity` (b), `dashboard-privilege-grants` (a) |
| `/dashboard/packages` | packages / `loadPackages` | `packages` | P4 | none | `/packages` | Approve sends the `planDigest` shown | `dashboard-packages` (a) |
| `/dashboard/terminals` | terminals / `loadTerminals` | `terminals` | P4 | none | `/terminals`, `/workspaces` | Not in nav (`navParent: workspaces`) | `dashboard-terminal` (b), `dashboard-terminal-router` (a) |
| `/dashboard/audit` | audit / `loadAudit` | `audit` | P3 | `cursor` | `/audit?limit=…` | Not in nav (folded into Activity) | `dashboard-audit-gaps` (a) |
| `/dashboard/projects[/:prj_id]` | projects / `loadProjects`, `loadProject` | `projects` | P3 (project, environment), P4 (environment secrets) | none | `/projects`, `/projects/:id/environments`, `/environments/:id/secrets` | Secrets write-only | `dashboard-ui-behavior` (b) |
| `/dashboard/secrets` | secrets / `loadGlobalSecrets` | `secrets` | P4 | none | `/secrets` | Write-only; bulk `.env` text cleared when its dialog closes | `dashboard-ui-behavior` (b) |
| `/dashboard/models` | models / `loadModels` | `models` | P4 | none | `/provider-credentials`, `/agent-model-profiles`, `/agent-model-config-status`, `/model-providers`, `/model-catalog`, `/model-spend` | Provider keys write-only; `model_*` responses pass through unmapped (F7) | `dashboard-models-wizard` (b+c), `dashboard-models-spend` (b), `dashboard-models-router` (a) |
| `/dashboard/skills` | skills / `loadSkills` | `skills` | P3 | Skills tab is not in the URL (R16); React should add it | `/skills`, `/skills/search`, `/skills/:id/revisions`, `/skills/:id/diff`, `/skills/:id/usage`, `/skill-sets`, `/toolkit-registry`, `/skill-imports/:jobId` | Zip upload has its own parser and limit | `dashboard-skills-ui` (b), `dashboard-skills-mapper` (a) |
| `/dashboard/integrations[/github]` | integrations / `loadGitHub` | `integrations` | P4 | `state`, `installation_id` (GitHub App callback) | `/github` | `state` is a one-time setup value; the query is cleared with `replaceState` after `POST /github/complete` | `dashboard-github-error-message` (a) |
| `/dashboard/mcp-servers[/:mcps_id]` | mcp-servers / `loadMcpServers`, `loadMcpServerDetail` | `mcp-servers` | P4 | `oauth`, `reason` (callback outcome, announced once then cleared); detail tab not in the URL (R16) | `/mcp-servers`, `/mcp-servers/:id`, `/mcp-servers/:id/logs`, `/mcp-servers/:id/oauth`, `/mcp-gateway`; the add/edit dialog reads `/secrets` | Header secret-reference values are never shown; endpoints pass the server's SSRF guard | `mcp-servers-dashboard-ui` (c), `dashboard-mcp-gateway-api` (a), `mcp-oauth` (a) |
| `/dashboard/knowledge[/:kn_id]` | knowledge / `loadKnowledge` | `knowledge` | P3 | `kind`, `scope`, `projectId`, `q`, `cursor` | `/knowledge`, `/knowledge/:id`, `/knowledge-graph`, `POST /knowledge/search`; create dialog reads `/projects` | Markdown escaped; no `style=`, no `<style>` | `knowledge-dashboard-ui` (c), `knowledge-api` (a) |
| `/dashboard/artifacts` | artifacts / `loadArtifacts` | `artifacts` | P4 | `cursor` | `/artifacts?limit=…`; download is a native link to `/artifacts/:id/download` | Download stays under `/dashboard/api/v1/artifacts/` | `dashboard-ui-contract` (c) |
| `/dashboard/api-keys` | api-keys / `loadApiKeys` | `api-keys` | P4 | none | `/api-keys` | One-time reveal (D3) | `dashboard-ui-behavior` (b) |
| `/dashboard/settings/agent-policies`, `/dashboard/projects/:prj_id/agent-policies` | agent-policies / `loadAgentPolicies` | `agent-policies` | P4c (#562) | none | `/agent-policies`, `/agent-policies/{global,projects/:id}`, `…/history` (`beforeVersion`), `/agent-policies/revisions/:id`, `/agent-policies/diff`; the project route also reads `/projects` | Not in nav (`navParent: settings`); every preview is the runner's answer; saves send `expectedVersion` and confirm a weakening change with its `weakeningDigest` | `dashboard-policies-ui` (b), `dashboard-policies-router` (a) |
| `/dashboard/settings` | settings / `loadSettings` | `settings` | P3 (lifecycle, network, OAuth session), P4 (TypeSafe credential) | none | `/settings`, `/settings/oauth` (`fetchOAuthSettings`), `/typesafe/status` and `/integration-credentials` (`fetchTypesafeSettings`) | `settings_*` responses pass through unmapped (F7); TypeSafe key write-only | `dashboard-lifecycle-settings` (b), `dashboard-oauth-settings` (b), `dashboard-typesafe` (a+b), `dashboard-router` (a) |
| `/dashboard/profile` | profile / `loadProfile` | `profile` | P3 | none | `/profile` | Display name via server cookie | `dashboard-ui-behavior` (b) |

The P4c rows exist only in the legacy shell. In React mode `/inbox`,
`/traces` and `/automations` are not in `DASHBOARD_REACT_ROUTES`
(`apps/api/src/dashboard-react-assets.ts`), so the server answers with the
not-found shell and status 404. The agent-policies paths match the `/settings`
and `/projects` prefixes, get the shell, and render the client-side not-found
page. Until each row is done they are reachable only through the legacy shell
(`CLOUD_HARNESS_DASHBOARD_UI=legacy` or `?ui=legacy`), and P6 cannot remove
the legacy shell.

The command palette (`PALETTE_SOURCE_REQUESTS` in `dashboard.js`) also reads
`/workspaces`, `/projects`, `/secrets`, `/api-keys`, `/provider-credentials`,
`/agent-model-profiles` and `/artifacts` from any page (feature
`shell/palette`, P2).

### 2.1 Legacy redirects (server, 302, keep)

| From | To | Owner |
| --- | --- | --- |
| `/dashboard/overview` | `/dashboard` | `DASHBOARD_COMPAT_REDIRECTS` in assets |
| `/dashboard/github` | `/dashboard/integrations/github` | same |
| `/dashboard/integrations/mcp-servers` | `/dashboard/mcp-servers` | same |

The client copy of `DASHBOARD_COMPAT_REDIRECTS` in `dashboard-pages.js` is not
imported anywhere and exists only for a parity test. React can drop it; the
server redirects stay.

### 2.2 Navigation behaviour to reproduce

| Legacy behaviour | Owner | React equivalent |
| --- | --- | --- |
| `navigateTo` accepts only `/dashboard*` paths and falls back to `/dashboard` | `dashboardNavigationPath`, `navigateTo` in `dashboard.js` | Router `basepath: /dashboard`; off-site links stay native |
| Global link interceptor skips modifier clicks, `download`, non-`_self` targets and hash links | document click listener in `dashboard.js` | TanStack Router `<Link>`; asset, logout and download links stay plain `<a>` |
| Each navigation aborts in-flight reads (`setNavigationSignal`) and serializes loads | `load`/`performLoad` in `dashboard.js`, `dashboard-api.js` | Route-scoped query `signal`. Mutations are not aborted by navigation (same as legacy). |
| Load failure shows "This page could not load." with Retry | `performLoad` | Route error boundary with retry |
| Desktop workspace drawer via `pushState({drawer})`, modal on narrow screens | workspace drawer controller in `dashboard.js` | Child route or search param; Back closes it |
| `document.title` is `${title} \| Cloud Harness` | `documentTitle` in `dashboard-pages.js` | Route `head` |

## 3. Dialogs

| # | Legacy dialog | Opened from | Feature | Phase | Close / draft | Secret | React note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | `confirm-dialog` (`index.html`) | `confirmAction` (see 3.1) | `shared/confirm` | P2 | Cancel autofocused; Esc cancels | no | Radix AlertDialog; pending label on the action; a failure closes the dialog and shows the page alert |
| D2 | `file-conflict-dialog` | 409 from file PUT/PATCH/DELETE (`openFileConflict`) | `workspace-files` | P4 | Keeps unsaved editor text; Review latest, Copy changes | no | Fix R11 (stacked `once` listeners) |
| D3 | `api-key-reveal-dialog` | after `POST /api-keys` (`createApiKeyRevealController`) | `api-keys` | P4 | Acknowledge or Esc only; key cleared on dismiss, any link click, `pagehide`, copy failure | **one-time reveal** | Key lives in component state only: not in the query cache, not logged. E2E proves each clear path. |
| D4 | `bulk-import-dialog` | `.open-bulk-import`, `#open-global-bulk-import` | `secrets` | P4 | Every close clears textarea, preview and status | write-only `.env` text | No draft, no dirty prompt |
| D5 | `open-workspace-dialog` (launch workspace) | `#open-workspace-btn` opens it with `showModal`; skill-set list and preview are wired (`/skill-sets`, `POST /skill-sets/preview`) | `workspaces` | P4 | **Submit and Cancel have no handler (R4)** | no | Implement on `POST /workspaces` (`idempotencyKey` required, kept across retries); keep the skill-set preview |
| D6 | `model-credential-dialog` | add credential, rotate (`bindModelCredentialDialog`) | `models` | P4 | Close resets the form and clears the key | provider key write-only (`type=password`) | Clear the key from form state before the request |
| D7 | `model-profile-dialog` (wizard, `createModelWizard`) | add, edit, duplicate, review price | `models` | P4 | Close blocked while busy; close aborts combobox and clears the key | key may be entered in the wizard | Restorable wizard step (non-secret fields only); keep combobox ARIA semantics |
| D8 | `knowledge-conflict-dialog` | 409 on save (`openKnowledgeConflict`) | `knowledge` | P3 | Base, server and "your changes" panes | no | "Load current server version" must confirm before discarding the draft (R10) |
| D9 | `create-knowledge-dialog` | `#open-create-knowledge-btn` | `knowledge` | P3 | Reset on open and cancel | no | `project` scope loads `/projects` |
| D10 | `mcp-server-dialog` | add, edit (`openMcpDialog`) | `mcp-servers` | P4 | Close does not clear typed values (R6) | literal header value is a plain input | Reset on close; masked header value input |
| D11 | `command-palette` | `#open-palette`, Ctrl/Cmd+K | `shell/palette` | P2 | Esc, backdrop, item selection | no | Index cache invalidated on announce and `pagehide` (`createPaletteIndexLoader`) |
| — | `create-project-dialog` (`dashboard-render.js`) | `#open-create-project` | `projects` | P3 | dialog form | no | |
| — | `create-global-secret-dialog` | `#open-create-global-secret` | `secrets` | P4 | dialog form | value write-only | |
| — | `snapshot-dialog` | `#open-create-snapshot` | `artifacts` | P4 | dialog form | no | |
| — | `create-api-key-dialog` | `#open-create-api-key` | `api-keys` | P4 | dialog form, then D3 | leads to reveal | |
| — | `finalize-workspace-dialog` | `#finalize-workspace` | `workspace-cockpit` | P4 | dialog form | no | Pushes to the remote (external effect) |
| — | `open-session-dialog` | `#open-session` | `workspace-runtime` | P4 | dialog form | no | `idempotencyKey` required (fix R5) |
| — | `skill-upload-dialog` | `#open-skill-upload` | `skills` | P3 | dialog form | no | Zip with its own media types and size limit |
| — | `skill-editor-dialog` | `#open-skill-editor` | `skills` | P3 | dialog form | no | |
| — | `skill-import-dialog` | **no opener** | — | — | dead markup (R15) | — | Do not port |

Shared modal infrastructure (P2): `createModalController`, `trapModalFocus`
and `dismissOnBackdrop` in `dashboard.js`. In React, Radix Dialog owns the
focus trap, `inert` and focus return to the invoker.

### 3.1 Confirm steps

Actions that confirm through D1 in the legacy UI, and must keep confirming:
deleting a global secret, secret reference, environment or project; deleting
an artifact; revoking an API key; disconnecting GitHub; removing TypeSafe;
approving or rejecting a privilege grant or package plan; rolling back or
removing a package; closing a terminal; removing a worktree; running a deploy;
cancelling an agent, task or session; closing a workspace; deleting a file or
knowledge item; deleting a model profile, credential or spend limit; deleting
an MCP server. Call sites: every `confirmAction(` in `dashboard.js` and
`dashboard-models.js`.

Actions without a legacy confirm, to decide in their phase: lease renew,
recover, MCP enable toggle, MCP OAuth disconnect, tool refresh, advanced git
actions (checkout, merge, rebase: R12), "New session" while a PTY runs, skill
import cancel, bulk skill archive/disable, skill restore. Proposal: git
checkout/merge/rebase and "New session" while running get a confirm in P4.

## 4. BFF API parity matrix by feature

All paths are under `/dashboard/api/v1`. React **does not rewrite the API**:
it calls these endpoints with the same bodies, fences and idempotency keys.
GET needs no CSRF; every POST/PUT/PATCH/DELETE needs `x-csrf-token`, the
session cookie and a valid Origin.

Fence legend: **gen** = strict `expectedGeneration` > 0; **gen0** = create with
`expectedGeneration: 0`; **sha** = `expectedSha256` / `expectedContentSha256` /
`expectedManifestSha256`; **idem** = required `idempotencyKey`; **digest** =
`planDigest`. The executable schemas are in the routers, in
`packages/contracts/src/` and in the runner's internal request schemas.

"Override" marks handlers that used to spread `request.body` **after** the
path-derived keys, so a body key with the same name won (finding F1, fixed in
#490). These handlers now merge through `withPathIds` in
[`apps/api/src/dashboard-path-ids.ts`](../apps/api/src/dashboard-path-ids.ts):
the path id always wins, and a body that repeats a path id with a different
value is refused with `400 path_id_mismatch` before the runner is called.
React should still send only schema fields and not repeat path ids.

"UI caller" is the legacy caller found by grep; **none** means no legacy code
calls the route (collected in [4.13](#413-routes-without-a-legacy-ui-caller)).

### 4.1 Session, profile, server

| Method | Path | Owner | Fence | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/session` | router, session | — | `bootstrapSession` | `shell/session` | P2 | Each call mints a new session (F10): bootstrap once per tab, again on 401 |
| GET | `/profile` | router | — | overview, profile, top-bar chip | `profile`, `shell` | P2/P3 | |
| GET | `/server` | router | — | overview | `overview` | P3 | `managedOAuthUrl`, limits, version |
| PUT | `/preferences` | router | strict schema | theme toggle, profile | `shell/theme`, `profile` | P2 | Sets the theme and display-name cookies |

### 4.2 Workspaces, files, git, runtime, automation

| Method | Path | Owner | Fence / idem | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/workspaces` | router | cursor, limit | — | index, terminals, palette | `workspaces` | P3 |
| POST | `/workspaces` | router | **idem** | — | **none** (R4) | `workspaces` | P4 |
| GET | `/workspaces/:id`, `/workspaces/:id/context` | router | — | cockpit | `workspace-cockpit` | P3 |
| POST | `/workspaces/:id/close` | router | **gen** | — | cockpit, confirm | `workspace-cockpit` | P4 |
| POST | `/workspaces/:id/lease-renew` | router | bounded `extensionSeconds` | yes | cockpit, no confirm | `workspace-cockpit` | P3 |
| POST | `/workspaces/:id/recover` | router | mode enum | yes | cockpit, no confirm | `workspace-cockpit` | P4 |
| POST | `/workspaces/:id/finalize` | router | optional idem | yes | finalize dialog | `workspace-cockpit` | P4 |
| GET | `/workspaces/:id/files`, `/files/content` | router | path, offset, limit | — | files tab | `workspace-files` | P4 |
| PUT | `/workspaces/:id/files/content` | router | optional **sha**, 409 → D2 | yes | file editor | `workspace-files` | P4 |
| PATCH | `/workspaces/:id/files/content` | router | optional **sha** | yes | `submitPatchEdit` | `workspace-files` | P4 |
| DELETE | `/workspaces/:id/files/content` | router | optional **sha**, `recursive` | yes | delete file, confirm | `workspace-files` | P4 |
| POST | `/workspaces/:id/files/move`, `/files/directory` | router | — | yes | files tab | `workspace-files` | P4 |
| GET | `/workspaces/:id/git/status`, `/git/diff`, `/git/log`, `/worktrees` | router | `staged`, limit | — | git tab | `workspace-git` | P4 |
| POST | `/workspaces/:id/git/{fetch,pull,checkout,branch,merge,rebase}` | router | — | yes | git tab, **no confirm (R12)** | `workspace-git` | P4 |
| POST / DELETE | `/workspaces/:id/worktrees[/:name]` | router | name pattern | yes (id and name) | git tab (remove confirms) | `workspace-git` | P4 |
| GET | `/workspaces/:id/agents` | router | status | — | cockpit agents tab | `workspace-cockpit` | P3 |
| GET | `/workspaces/:id/runtime`, `/tasks/graph` | router | pageQuery | — | runtime tab | `workspace-runtime` | P3 |
| GET | `/workspaces/:id/tasks/:taskId` | router | cursor | — | **none** | `workspace-runtime` | P3 (decide) |
| POST | `/workspaces/:id/tasks/:taskId/cancel` | router | — | runtime tab, confirm | `workspace-runtime` | P4 |
| POST | `/workspaces/:id/sessions` | router | **idem** | yes | open-session dialog (new key per submit: R5) | `workspace-runtime` | P4 |
| GET | `/workspaces/:id/sessions/:sid/io` | router | cursor | — | runtime tab | `workspace-runtime` | P4 |
| POST | `/workspaces/:id/sessions/:sid/close` | router | — | runtime tab, confirm | `workspace-runtime` | P4 |
| GET | `/workspaces/:id/skills`, `/hooks`, `/deployments` | router | — | automation and deploy tabs | `workspace-automation` | P3 |
| POST | `/workspaces/:id/skills/:name/run` | router | **sha** plus privilege grant | yes | automation tab | `workspace-automation` | P4 |
| POST | `/workspaces/:id/hooks/run` | router | **sha** | yes | automation tab | `workspace-automation` | P4 |
| POST | `/workspaces/:id/hooks/{activate,deactivate}` | router | `manifestSha256` | yes | **none** | `workspace-automation` | P4 (decide) |
| POST | `/workspaces/:id/deployments/run` | router | bounded `timeoutMs` | yes | deploy tab, confirm | `workspace-deploy` | P4 |
| GET | `/workspaces/:id/artifacts`, `/activity` | router | — | cockpit tabs | `workspace-cockpit` | P3 |

F3: the workspace artifacts and activity projections read a global first page
and then filter by workspace, so they can truncate silently. React must not
claim "nothing here" as an absolute.

### 4.3 Agents

| Method | Path | Owner | Fence / idem | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/agents` | router | status, limit, cursor, filters | — | agents page | `agents` | P3 |
| GET | `/agents/:agentId`, `/agents/:agentId/logs` | router | cursor | — | agent detail | `agents` | P3 |
| POST | `/agents/:agentId/messages` | router | **idem** (R5), bounded message | yes | agent detail | `agents` | P3 |
| POST | `/agents/:agentId/cancel` | router | bounded reason, confirm | yes | agent detail | `agents` | P3 |

Idempotency (R5): React creates the key **once per intent** (when the form
opens or on first input), keeps it across retries after a network failure,
and makes a new one only after a successful response.

### 4.4 Overview, metrics, activity, audit

| Method | Path | Owner | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/overview` | router | overview | `overview` | P3 | Fan-out |
| GET | `/metrics?window=` | router | overview | `overview` | P3 | Unknown window → 400 |
| GET | `/reliability` | router | overview | `overview` | P3 | Several runner calls |
| GET | `/activity` | router | activity | `activity` | P3 | Fan-out |
| GET | `/audit` | control router | audit page | `audit` | P3 | cursor, limit |

### 4.5 Projects, environments, secrets

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET / POST | `/projects` | control router | POST **gen0**, strict | — | projects page, knowledge dialog, palette | `projects` | P3 |
| PATCH / DELETE | `/projects/:projectId` | control router | **gen** | — | delete confirms | `projects` | P3 |
| GET / POST | `/projects/:id/environments` | control router | POST strict | — | project detail | `projects` | P3 |
| PATCH / DELETE | `/environments/:environmentId` | control router | **gen** | — | delete confirms | `projects` | P3 |
| GET | `/environments/:id/secrets` | control router | — | — | project detail | `secrets` | P4 |
| POST | `/environments/:id/secrets[/bulk]` | control router | **gen0**; bounded bulk items | yes | create, bulk review in D4 | `secrets` | P4 |
| PUT / PATCH / DELETE | `/environments/:id/secrets/:name` | control router | **gen** | yes (id and name) | rotate, description, delete confirms | `secrets` | P4 |
| GET / POST | `/secrets`, `/secrets/bulk` | control router | **gen0** | — | secrets page, MCP dialog, palette | `secrets` | P4 |
| PUT / PATCH / DELETE | `/secrets/:name` | control router | **gen** | yes | rotate, description, delete confirms | `secrets` | P4 |

Secret values only flow in. Responses carry the `secretKeys` projection plus
readiness (response). The `.env.example` download builds names and
descriptions with empty values and revokes its object URL immediately.

### 4.6 Models, credentials, spend

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET / POST | `/provider-credentials` | control router | POST strict, `apiKey` inbound | — | `listModelCredentials`, `createModelCredential` | `models` | P4 | Metadata-only response |
| PUT | `/provider-credentials/:id/rotate` | control router | **gen** | path wins | `rotateModelCredential` | `models` | P4 | |
| DELETE | `/provider-credentials/:id` | control router | **gen**, confirm | — | `deleteModelCredential` | `models` | P4 | |
| GET / POST | `/agent-model-profiles` | control router | — | — | `listModelProfiles`, `createModelProfile` | `models` | P4 | Unmapped passthrough (F7) |
| POST | `/agent-model-profiles/validate` | control router | dry run | — | **none** | `models` | P4: drop | Profile rules run in the wizard and again on save |
| PATCH | `/agent-model-profiles/:id` | control router | — | yes | `updateModelProfile` | `models` | P4 | |
| POST | `/agent-model-profiles/:id/{activate,disable}` | control router | **gen**, no confirm | — | `activateModelProfile`, `disableModelProfile` | `models` | P4 | |
| DELETE | `/agent-model-profiles/:id` | control router | **gen**, confirm | — | `deleteModelProfile` | `models` | P4 | |
| GET | `/agent-model-config-status`, `/model-providers`, `/model-catalog` | control router | — | — | `getModelConfigStatus`, `listModelProviders`, `searchModelCatalog` | `models` | P4 | Combobox search is debounced (`dashboard-models.js`) |
| POST | `/model-catalog/refresh`, `/model-connection/verify` | control router | — | — | `refreshModelCatalog`, `verifyModelConnection` | `models` | P4 | |
| GET | `/model-spend` | control router | — | — | `getModelSpend` | `models` | P4 | |
| GET | `/model-spend/policies` | control router | — | — | **none** | `models` | P4: drop | `/model-spend` windows carry each policy |
| PUT | `/model-spend/policies` | control router | upsert by scope and period | — | `setModelSpendPolicy` | `models` | P4 | |
| DELETE | `/model-spend/policies/:id` | control router | **gen**, confirm | — | `deleteModelSpendPolicy` | `models` | P4 | |
| GET | `/decision-plane/status` | control router | — | — | **none** | `models` | P4: defer (#494) | |

### 4.7 Skills and toolkits

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET / POST | `/skills` | control router | POST **gen0** | — | skills page, editor | `skills` | P3 |
| GET | `/skills/search` | control router | — | — | library search | `skills` | P3 |
| GET | `/skills/:skillId` | control router | — | — | **none** | `skills` | P3 (decide) |
| GET / POST | `/skills/:skillId/revisions` | control router | POST gen ≥ 0 | yes | detail, editor | `skills` | P3 |
| GET | `/skills/:skillId/revisions/:revisionId` | control router | — | — | **none** | `skills` | P3 (decide) |
| GET | `/skills/:skillId/diff`, `/skills/:skillId/usage` | control router | — | — | detail | `skills` | P3 |
| POST | `/skills/:skillId/revisions/:revisionId/fork` | control router | **gen0** | yes | detail | `skills` | P3 |
| POST | `/skills/:skillId/restore` | control router | **gen** | yes | detail, no confirm | `skills` | P3 |
| PATCH | `/skills/:skillId` | control router | **gen** | yes | **none** | `skills` | P3 (decide) |
| POST | `/skills/:skillId/archive` | control router | **gen** | yes | **none** | `skills` | P3 (decide) |
| POST | `/skills/bulk` | control router | gen | — | bulk actions | `skills` | P3 |
| GET / POST | `/skill-sets` | control router | POST **gen0** | — | skills page; launch-workspace dialog lists sets | `skills`, `workspaces` | P3 |
| POST | `/skill-sets/preview` | control router | — | — | launch-workspace dialog (D5) | `workspaces` | P4 |
| GET / PATCH / DELETE | `/skill-sets/:skillSetId` | control router | PATCH/DELETE **gen** | PATCH yes | **none** | `skills` | P3 (decide) |
| GET | `/toolkit-registry` | control router | — | — | skills registry tab | `skills` | P3 |
| GET | `/toolkits` | router | — | — | **none** | `workspaces` | P4 (decide) |
| POST | `/toolkits/preview` | router | — | — | **none** | `workspaces` | P4 (decide) |
| POST | `/skill-imports` | control router | **gen0** | — | import form | `skills` | P3 |
| GET | `/skill-imports/:jobId` | control router | — | — | import poller (T1) | `skills` | P3 |
| POST | `/skill-imports/:jobId/cancel` | control router | **gen** (legacy hard-codes 1: R9) | yes | import form | `skills` | P3 |
| POST | `/skill-archives` | control router, `requireArchiveMediaType` in security | **gen0** fixed on the server; zip size limit in the control router | — | upload dialog | `skills` | P3 |

### 4.8 Artifacts and knowledge

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET / POST | `/artifacts` | control router | POST **gen0**, strict | — | artifacts page, snapshot dialog, palette | `artifacts` | P4 |
| GET | `/artifacts/:artifactId` | control router | offset, limit | — | **none** | `artifacts` | P4 (decide) |
| GET | `/artifacts/:artifactId/download` | control router | — | — | native download link | `artifacts` | P4 |
| POST | `/artifacts/:artifactId/restore` | control router | path wins | — | **none** | `artifacts` | P4 (decide) |
| DELETE | `/artifacts/:artifactId` | control router | **gen**, confirm | — | artifacts page | `artifacts` | P4 |
| GET / POST | `/knowledge` | control router | POST **gen0** | — | `listKnowledge`, `createKnowledgeItem` | `knowledge` | P3 |
| GET / PUT / DELETE | `/knowledge/:id` | control router | PUT revision, 409 → D8; DELETE **gen** | PUT yes | `getKnowledgeItem`, `updateKnowledgeItem`, `deleteKnowledgeItem` | `knowledge` | P3 |
| POST | `/knowledge/search` | control router | — (no side effect, still CSRF) | — | `searchKnowledge` | `knowledge` | P3 |
| GET | `/knowledge-graph` | control router | — | — | `getKnowledgeGraph` | `knowledge` | P3 |
| POST / DELETE | `/knowledge/links` | control router | gen0 / optional gen | — | **none** (helpers exist but are unused: R15) | `knowledge` | P3 (decide) |

### 4.9 GitHub, integration credentials, approvals, packages

| Method | Path | Owner | Fence | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/github` | control router | — | integrations page | `integrations` | P4 | |
| POST | `/github/setup` | control router | strict | integrations page | `integrations` | P4 | Returns a one-time `url` and `state`; navigate natively |
| POST | `/github/complete` | control router | strict `state`, `installationId` | callback handling | `integrations` | P4 | Clear the query after completion |
| POST | `/github/reconcile` | control router | — | integrations page | `integrations` | P4 | |
| POST | `/github/disconnect` | control router | body `{installationId}`, confirm | integrations page | `integrations` | P4 | |
| DELETE | `/github/installations/:id` | control router | — | **none** (duplicate of disconnect) | — | P4: drop | `POST /github/disconnect` is the one shape |
| GET / POST | `/integration-credentials` | control router | **gen0**, value inbound | settings (TypeSafe) | `settings` | P4 | Write-only |
| PUT / DELETE | `/integration-credentials/:id[/rotate]` | control router | **gen** | settings (TypeSafe) | `settings` | P4 | |
| GET | `/typesafe/status` | control router | — | settings | `settings` | P4 | |
| GET | `/privilege-grants` | control router | — | approvals, approvals badge | `approvals` | P3 | |
| POST | `/privilege-grants/:id/{approve,reject}` | control router | confirm | approvals | `approvals` | P4 | |
| GET | `/packages` | control router | — | packages | `packages` | P4 | |
| GET | `/package-plans` | control router | — | approvals, approvals badge | `approvals` | P3 | |
| POST | `/package-plans/:id/approve` | control router | **digest** equal to the shown plan, confirm | approvals | `approvals` | P4 | |
| POST | `/package-plans/:id/reject` | control router | confirm | approvals | `approvals` | P4 | |
| POST | `/packages/rollback`, `/packages/remove` | control router | schema parse, confirm | packages | `packages` | P4 | |

### 4.10 API keys, event subscriptions, settings

| Method | Path | Owner | Fence | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api-keys` | control router | — | API keys page, palette | `api-keys` | P4 | |
| POST | `/api-keys` | control router | strict name and expiry; 503 when disabled | create dialog | `api-keys` | P4 | **One-time plaintext `data.apiKey`** → D3 |
| DELETE | `/api-keys/:keyId` | control router | **gen**, confirm | API keys page | `api-keys` | P4 | |
| GET | `/event-subscriptions` | control router | — | **none** | `api-keys` | P4: defer (#494) | 503 when events are off |
| POST | `/event-subscriptions/:id/revoke` | control router | — | **none** | `api-keys` | P4: defer (#494) | |
| GET / POST | `/settings` | router | schema parse | settings | `settings` | P3 | Unmapped passthrough (F7) |
| GET / POST | `/settings/oauth` | router | schema parse | settings | `settings` | P3 | |
| POST | `/settings/network-check` | router | — | settings | `settings` | P3 | |

### 4.11 MCP servers, gateway, downstream OAuth

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET / POST | `/mcp-servers` | control router | POST: server-side SSRF guard | — | `listMcpServers`, `createMcpServer` | `mcp-servers` | P4 | SSE with a secret-reference header is rejected |
| GET / PATCH / DELETE | `/mcp-servers/:id` | control router | DELETE **gen**, confirm | PATCH yes | `getMcpServer`, `updateMcpServer`, `deleteMcpServer` | `mcp-servers` | P4 | |
| POST | `/mcp-servers/:id/enabled` | control router | no confirm | yes | `setMcpServerEnabled` | `mcp-servers` | P4 | |
| PUT | `/mcp-servers/:id/permissions` | control router | picks only permission fields and gen | — | `setMcpServerPermissions` | `mcp-servers` | P4 | |
| GET | `/mcp-servers/:id/logs` | control router | cursor | — | `listMcpServerLogs` | `mcp-servers` | P4 | |
| POST | `/mcp-servers/:id/{test,refresh}` | gateway router | — | — | `testMcpServer`, `refreshMcpServerTools` | `mcp-servers` | P4 | Calls the downstream MCP server |
| GET | `/mcp-gateway` | gateway router | — | — | `getMcpGatewayEndpoint` | `mcp-servers` | P4 | Public URL from an allowlisted Host |
| GET | `/mcp-servers/:id/oauth` | gateway router | — | — | `getMcpServerOAuth` | `mcp-servers` | P4 | |
| POST | `/mcp-servers/:id/oauth/start` | gateway router | — | — | `startMcpServerOAuth` | `mcp-servers` | P4 | Returns `authorizationUrl` (state and PKCE challenge, no verifier); navigate natively |
| POST | `/mcp-servers/:id/oauth/disconnect` | gateway router | no confirm | — | `disconnectMcpServerOAuth` | `mcp-servers` | P4 | |
| GET | `/dashboard/mcp-oauth/callback` (outside `/api/v1`) | gateway router | one-time `state` | — | browser redirect | server | keep | 303 to the server page with `oauth` and `reason`; HEAD also runs it (F11) |

### 4.12 Terminal

| Method | Path | Owner | Body | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/terminals` | terminal router | — | terminals page | `terminals` | P4 |
| GET / POST | `/workspaces/:id/terminals` | terminal router | strict `{cwd?, cols?, rows?}` | GET: `terminalPanel` in `dashboard.js`; POST: `createTerminalClient.open` (`createTerminalClient.list` exists but is unused) | `terminal` | P4 |
| POST | `/workspaces/:id/terminals/:tid/input` | terminal router | strict `{data}` (chunked by the client) | `createTerminalClient.input` | `terminal` | P4 |
| POST | `/workspaces/:id/terminals/:tid/resize` | terminal router | strict `{cols, rows}` | `createTerminalClient.resize` | `terminal` | P4 |
| POST | `/workspaces/:id/terminals/:tid/close` | terminal router | strict `{}` | terminal pane, terminals page | `terminal` | P4 |
| GET | `/workspaces/:id/terminals/:tid/output` | terminal router | cursor, bounded `waitMs` | `createTerminalClient.read` (long-poll) | `terminal` | P4 |

Terminal bodies are strict, so they cannot override path ids.

### 4.13 Routes without a legacy UI caller

Grep found no legacy caller for:

- `POST /workspaces` (the launch dialog opens and previews skill sets, but
  submit and cancel are not wired: R4)
- `GET /workspaces/:id/tasks/:taskId`
- `POST /workspaces/:id/hooks/{activate,deactivate}`
- `GET /toolkits`, `POST /toolkits/preview`
- `GET /skills/:skillId`, `GET /skills/:skillId/revisions/:revisionId`
- `PATCH /skills/:skillId`, `POST /skills/:skillId/archive`
- `GET`, `PATCH`, `DELETE /skill-sets/:skillSetId`
- `POST /agent-model-profiles/validate`
- `GET /model-spend/policies`
- `GET /decision-plane/status`
- `GET /artifacts/:artifactId`, `POST /artifacts/:artifactId/restore`
- `POST`, `DELETE /knowledge/links`
- `DELETE /github/installations/:installationId`
- `GET /event-subscriptions`, `POST /event-subscriptions/:id/revoke`

Each phase that owns one of these routes records one decision in its PR:
**re-host** (add UI with tests), **defer** (name the follow-up issue) or
**drop** (no UI, with the reason). No BFF route is deleted in this epic.

P4 decisions (#484):

| Route | Decision | Reason |
| --- | --- | --- |
| `POST /agent-model-profiles/validate` | drop | The wizard runs the profile rules before save and the create and update routes validate again; a dry run adds a round trip and no new answer |
| `GET /model-spend/policies` | drop | Each `/model-spend` window already carries its policy with the generation the editor fences on |
| `GET /decision-plane/status` | defer (#494) | No P4 page owns decision-plane health |
| `DELETE /github/installations/:installationId` | drop | Duplicate of `POST /github/disconnect`, which the page uses |
| `GET /event-subscriptions`, `POST /event-subscriptions/:id/revoke` | defer (#494) | Needs a design for MCP Events on the API access page |

### 4.14 Inbox, traces, automations, agent policies, repositories (P4c)

These routes were added on `dev` after the audit. Each one passes the
principal's runner call through its own operation schema; none returns a
secret except the automation connection create and rotate responses.

| Method | Path | Owner | Fence | UI caller | Feature | Phase | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/inbox/status`, `/inbox` | inbox router | — | shell nav badge, inbox page | `inbox` | P4c (#557) | |
| POST | `/inbox/read` | inbox router | schema parse | inbox page | `inbox` | P4c (#557) | |
| GET / PUT | `/notification-preferences` | inbox router | schema parse | inbox page | `inbox` | P4c (#557) | The inbox channel cannot be turned off |
| GET | `/traces/status` | traces router | — | shell nav entry | `traces` | P4c (#560) | A disabled feature answers `enabled: false`, not an error |
| GET | `/traces`, `/traces/:traceId`, `/traces/:traceId/spans` | traces router | strict query | traces page, agent detail panel | `traces` | P4c (#560) | Unknown query parameters are refused |
| GET | `/traces/:traceId/export` | traces router | strict query | native download link | `traces` | P4c (#560) | Sent as an attachment with its own media type, never inline |
| GET / POST | `/automations/connections` | control router | schema parse | automations page | `automations` | P4c (#561) | POST returns the signing secret once (section 8) |
| PATCH / DELETE | `/automations/connections/:id` | control router | schema parse, DELETE confirm | automations page | `automations` | P4c (#561) | |
| POST | `/automations/connections/:id/rotate-secret` | control router | confirm | automations page | `automations` | P4c (#561) | Returns the new signing secret once |
| GET / POST | `/automations/rules` | control router | schema parse | automations page | `automations` | P4c (#561) | |
| PATCH / DELETE | `/automations/rules/:id` | control router | schema parse, DELETE confirm | automations page | `automations` | P4c (#561) | |
| POST | `/automations/rules/:id/preview` | control router | schema parse | rule preview dialog | `automations` | P4c (#561) | Dry run, no side effect |
| GET | `/automations/workflows`, `/automations/workflows/:id`, `/automations/deliveries` | control router | schema parse | automations page | `automations` | P4c (#561) | |
| POST | `/automations/workflows/:id/cancel` | control router | confirm | run detail | `automations` | P4c (#561) | |
| GET | `/agent-policies`, `/agent-policies/{global,projects/:projectId}`, `…/history`, `/agent-policies/revisions/:revisionId`, `/agent-policies/diff` | policies router | — | agent policies page | `agent-policies` | P4c (#562) | |
| PUT / DELETE | `/agent-policies/global`, `/agent-policies/projects/:projectId` | policies router | `expectedVersion`; weakening confirm with `weakeningDigest`; DELETE confirm | agent policies page | `agent-policies` | P4c (#562) | The path id wins over a body id but a conflicting one is dropped, not refused; #547 moves these routes to the path-id rule |
| POST | `…/validate`, `/agent-policies/simulate` | policies router | schema parse | agent policies page | `agent-policies` | P4c (#562) | The runner's answer only; nothing is decided in the browser |
| POST | `/agent-policies/revisions/:revisionId/rollback` | policies router | confirm | agent policies page | `agent-policies` | P4c (#562) | |
| GET | `/workspaces/:id/repositories` | router | `status` is `true` or `false` | cockpit summary, repository selector | `workspace-cockpit` | P4c (#563) | A failed status read degrades to the registry |
| any | `repositoryId` on `/workspaces/:id/files*`, `/git/*`, `/worktrees*`, `POST /terminals` | router, terminal router | `RepositorySelectorSchema`; terminal refuses an unknown repository | cockpit Files, Git, Terminal | `workspace-cockpit` | P4c (#563) | Query on reads, body on writes |
| POST | `/workspaces/:id/skills/:name/run` with `approvalGrantToken`, then `/privilege-grants/:id/{approve,reject}` | router, control router | grant bound to the run | cockpit Automation | `workspace-cockpit` | P4c (#565) | Legacy completes the skill privilege grant (#511); the React Automation tab does not yet |

## 5. Keyboard shortcuts

| Keys | Scope | Action | Legacy owner | Phase |
| --- | --- | --- | --- | --- |
| Ctrl/Cmd+K | page, **ignored while focus is in the terminal** | open or close palette | palette keydown handler in `dashboard.js` | P2 |
| ↑ ↓ Home End Enter Esc | palette input | move, select, close | palette input handler | P2 |
| Esc | modal, drawer, cockpit `<details>` | close and return focus | `createModalController`, `row-edit` handler | P2 |
| Tab / Shift+Tab | modal | focus trap | `trapModalFocus` | P2 (Radix) |
| Ctrl/Cmd+S | knowledge editor | save, blocks the browser save | knowledge editor handler | P3 |
| Enter / Space | knowledge graph node | open node | graph node handler | P3 |
| `TERMINAL_RELEASE_SHORTCUT` | inside the terminal | move focus out of xterm; key not sent to the shell | `dashboard-terminal.js`, `dashboard-render.js` | P4 |
| ↑ ↓ Enter Esc Tab | model combobox in the wizard | navigate, commit, close | combobox in `dashboard-models.js` | P4 |

Keep `aria-keyshortcuts` on the palette button. While focus is in the
terminal, no global shortcut fires.

## 6. Polling and timers

The legacy UI has no `setInterval`; every recurring behaviour is a
`setTimeout` chain or a long-poll. Intervals, limits and backoff live in the
named owners. In React each poller has exactly one owner (a query
`refetchInterval` or one controller) and stops when its route unmounts.

| # | Legacy owner | Mechanism | Legacy defect | React equivalent | Phase |
| --- | --- | --- | --- | --- | --- |
| T1 | `createImportPollingController` (skill import) | bounded `setTimeout` chain | never stopped on navigation; unhandled rejections (R7) | query `refetchInterval`, stop on terminal state and unmount | P3 |
| T2 | `readLoop` in `createTerminalSession` | output long-poll with empty-reply floor and capped exponential backoff | — | app-level terminal controller outside routes | P4 |
| T3 | input pump in `createTerminalSession` | ordered queue with capped retry; 429 drops the queue | — | same | P4 |
| T4 | resize observer in `mountTerminalPane` | debounced `ResizeObserver`; unchanged size skipped | — | same | P4 |
| T5 | theme observer in `mountTerminalPane` | `MutationObserver` on `data-theme` | — | read theme tokens | P4 |
| T7 | `createPaletteIndexLoader` | max-age cache, invalidated on announce and `pagehide` | — | query `staleTime` with the same invalidation | P2 |
| T8–T10 | combobox search, knowledge preview, skills search | debounces | — | keep the values from the owners | P3/P4 |
| T11–T13 | toast removal, update cue, copy chip revert | one-shot timeouts | — | keep (Motion only for dialogs and toasts) | P2 |
| T15 | `refreshApprovalsBadge` | no timer; only on Overview, Activity and Approvals loads | stale badge (R13) | invalidate after approve/reject and on window focus | P3 |
| T16 | `createTracesView` (trace list, detail, agent panel) | the shell's one polling controller, only while a shown trace is `RUNNING`; a failed read stops it | — | query `refetchInterval` while running, stop on a terminal state and unmount | P4c |
| T17 | `inboxStatus` / `updateInboxBadge` | no timer; read once per document and updated by the inbox page | — | one query shared by the nav badge and the page, invalidated after mark-read | P4c |

Navigation read baseline. `apps/dashboard/e2e/navigation-budget.spec.ts` tours
Overview → Workspaces → Agents → Agent detail (Follow on) → Activity → Skills
(import running) → Overview in one document and fails when a navigation reads
more than the classic loader did, or when the agent detail or import polls
outlive their page. The baseline counts page reads only; the shell's
`/session`, `/profile` and `/preferences` are read once per document.

| Page | Classic loader reads | Count | React (measured) |
| --- | --- | --- | --- |
| Overview | `/server`, `/overview`, `/metrics`, `/reliability`, plus `refreshApprovalsBadge` (`/privilege-grants`, `/package-plans`) | 6 | 6 |
| Workspaces | `/workspaces` | 1 | 1 |
| Agents | `/agents` | 1 | 1 |
| Agent detail | `/agents/:id`, `/agents/:id/logs` | 2 | 2 (Follow then polls both every 5 s, until the page is left) |
| Activity | `/activity`, plus `refreshApprovalsBadge` | 3 | 3 |
| Skills | `/skills` | 1 | 1 (an import then polls `/skill-imports/:id` every 1.5 s, until terminal or the page is left) |

Budget: every Access subject has one per-principal request and concurrency
budget on `/api/v1` (`principalRequestLimits` in
`apps/api/src/request-security.ts`, finding F6). An open terminal holds one
concurrent slot. Fan-out routes (`/agents` without `workspaceId`, `/overview`,
`/activity`) can cost many runner calls. P3 measures requests per page move
and must not exceed the legacy baseline.

## 7. Terminal lifecycle

Owner: `createTerminalSession` and `mountTerminalPane` in
`dashboard-terminal.js`. Phase P4, feature `terminal`.

| Item | Legacy | React requirement |
| --- | --- | --- |
| Runner PTY on navigation, Refresh or popstate | survives (no close call) | survives; no route change calls close |
| xterm view | disposed on every `load()`; Refresh tears it down (R2) | app-level controller; the view re-mounts when the route returns, with no manual reattach |
| Reattach | replays from cursor `0` using the runner's retained output | keep the next cursor per terminal so a live view does not replay; still support replay from `0` |
| Dispose race while open is in flight | returns early and orphans the PTY until idle expiry (R8) | if disposed after a successful open, close immediately |
| States | `PHASE_BY_STATUS` (`lost` = 404/410) | same set and copy (`TERMINAL_WORKSPACE_ENDED_MESSAGE`) |
| Opening | visiting the tab never starts a shell | same |
| "New session" | closes a running PTY without asking | confirm while running |
| Assets | xterm packages from `node_modules` through `DASHBOARD_VENDOR_ASSETS` in assets, checked at startup; versions in `apps/api/package.json` | bundled by Vite as a lazy chunk within the ADR budget; the vendor map can go after cutover |
| CSP adapter | global monkey-patch of `document.createElement` and `Element.prototype.setAttribute` (R14) | no global monkey-patch; use narrowly scoped constructed stylesheets or prove the xterm version injects no `<style>`; CSP test required |

## 8. One-time reveals and sensitive client data

| Data | Where it appears | Legacy clearing | React requirement (P4 E2E) |
| --- | --- | --- | --- |
| API key plaintext (`data.apiKey`) | D3 read-only input and the reveal controller variable | dismiss, Esc, any link click (capture), `pagehide`, copy failure | component state only; never in the query cache, devtools dumps, console or screenshots; cleared on navigation, dismiss and session end |
| Provider keys, secret values, integration credentials | password inputs or textareas in forms | cleared on close; removed from the DOM before the request | form state reset on close; no drafts; no storage |
| Bulk `.env` text | D4 textarea | cleared on every close | same |
| CSRF token | module variable in `dashboard-api.js` | dropped on 401 | memory only |
| GitHub setup `state`, OAuth `authorizationUrl` | JSON response, then navigation | not stored | not stored; native navigation |
| `?oauth=`, `?state=&installation_id=` | URL | `replaceState` after handling | remove the search params after handling |
| Automation connection signing secret | create and rotate responses, read-only field (`bindAutomationSecretReveal`) | cleared on dismiss | component state only, same clear paths as the API key (D3) (P4c, #561) |
| Clipboard | API key copy, knowledge draft copy, file conflict copy, `data-copy` chips, automation secret and webhook URL | — | keep, with a screen-reader announcement |

`localStorage` (allowed by the ADR) holds only non-secret preferences. Wizard
restore state lives in `sessionStorage` under the `ch-dashboard-restore:`
prefix (`apps/dashboard/src/lib/restorable-state.ts`), written and read back
through a per-wizard allowlist (`parseStoredWizard` and
`models-restore-shapes.ts` for the model profile wizard), and cleared on
cancel and save. Neither store ever holds tokens, keys, secret values, file
contents or drafts of secret forms. The P4 E2E suites
(`apps/dashboard/e2e/one-time-reveal.spec.ts`, `write-paths.spec.ts`,
`bff-write-security.spec.ts`) check the DOM, form values, both stores,
IndexedDB, cookies, the console and every read response for the secret.

## 9. Markup-coupled tests to replace with behavioural tests

Class (c) tests break as soon as markup changes. None is deleted before its
replacement lands in the same phase. Assertions that are currently the only
CSP or XSS guard (`not.toContain('<script>')`, `not.toMatch(/\sstyle=/)`,
`<img src=x` payloads) become runtime checks; they are never dropped.

| Location | Current assertion | Behaviour it proxies | Replacement test | Phase |
| --- | --- | --- | --- | --- |
| `apps/api/test/dashboard-ui-contract.test.ts` (landmark and CSS checks) | CSS/HTML contain selectors, tokens, `@media`, landmark ids | landmarks, focus entry to `main`, reduced motion, breakpoints | Playwright: `getByRole` landmarks, tab into `main`, emulate `prefers-reduced-motion` and check computed `transition-duration` | P2 |
| `dashboard-ui-contract.test.ts` (no hex) | no raw hex in CSS | tokens only | token lint (stylelint or a test on the token file) | P1/P2 |
| `dashboard-ui-contract.test.ts` (no `style=`, no `setAttribute('style')`) | source text | CSP: no inline style | Playwright: after rendering every route, no element carries a markup `style` attribute and `securitypolicyviolation` count is 0 | P2 |
| `dashboard-ui-contract.test.ts` (artifact link prefix) | source contains `/dashboard/api/v1/artifacts/` | downloads keep the dashboard prefix | Playwright: click download, assert the request URL | P4 |
| `dashboard-ui-contract.test.ts` (only `.style.transform`) | regex over source | only transform via CSSOM | drop (the React `style` prop is CSSOM); keep the CSP-violation check | P2 |
| `dashboard-ui-contract.test.ts` (save state) | source contains `dataset.saveState = 'saved'` | save feedback goes saving → saved | Playwright: submit, assert the save state by role or attribute | P3 |
| `apps/api/test/dashboard-design-tokens.test.ts` (block parity) | parses `dashboard.css`, light blocks identical | light and dark tokens consistent | compare computed custom properties under `data-theme=light` and system light | P2 |
| `dashboard-design-tokens.test.ts` (contrast) | WCAG AA computed from CSS text | readable text in both themes | axe-core in Playwright per theme | P2 |
| `apps/api/test/dashboard-pages.test.ts` (shell markup) | HTML lacks authored nav labels, has `#sidebar-nav`, `<title>` | nav comes from the registry | Playwright: nav labels equal the route registry; `document.title` after navigation | P2 |
| `dashboard-pages.test.ts` (source routing) | source contains `PALETTE_PAGE_COMMANDS`, `PAGE_LOADERS[page.id]` | routing goes through the registry | navigate each route and assert the page; unit test that the route tree equals the fallback allowlist | P2 |
| `apps/api/test/dashboard-resource-page.test.ts` (primary action) | ids, `accent-btn`, `data-dialog` | one primary action per page | Playwright: count primary buttons per page | P3 |
| `dashboard-resource-page.test.ts` (dialog labelling) | `aria-labelledby`, `aria-describedby`, escaped `data-copy` | dialogs labelled and described; copy chips escape ids | `getByRole('dialog', {name})`; copy chip writes the exact value; a hostile id does not execute | P2 |
| `dashboard-resource-page.test.ts` (history navigation) | source contains `pushState`, `popstate`, `setNavigationSignal` | same-document navigation | Playwright: set `window.__marker`, click nav, marker survives | P2 |
| `apps/api/test/dashboard-models-wizard.test.ts` (combobox markup) | `innerHTML` contains `role="option" aria-selected="true"`, status spans | combobox semantics and status text | `getByRole('option', {selected: true})`, status by role or label | P4 |
| `dashboard-models-wizard.test.ts` (shell slice) | regex slice of `index.html` for the wizard dialog | wizard exists and is wired | Playwright: open the dialog and drive the wizard | P4 |
| `apps/api/test/dashboard-models-spend.test.ts` (markup) | `data-price-provenance`, table headers, `<label for>` | price provenance and spend labels | visible text "Catalog price", "Custom price (override)" by role or text | P4 |
| `apps/api/test/dashboard-skills-ui.test.ts` (skeleton ids) | skeleton contains table and title ids | each region exists | `getByRole('table', {name})`, empty-state text | P3 |
| `dashboard-skills-ui.test.ts` (no `<script>`) | output lacks `<script>` | XSS: skill data escaped | React render test with hostile payloads plus zero CSP violations | P3 |
| `apps/api/test/dashboard-ui-behavior.test.ts` (form ids) | `data-href`, `save-display-name`, rotate form class | forms exist and link correctly | Playwright: click the settings link and assert the URL; edit and save the display name | P3/P4 |
| `apps/api/test/dashboard-activity.test.ts` (button classes) | approve/reject classes, status tone spans | approve/reject controls with tone | `getByRole('button', {name: 'Approve'})` | P4 |
| `apps/api/test/dashboard-agents.test.ts` (filter and detail ids) | filter ids, selected option, message form, cancel id | filters and detail actions | change a filter and assert URL and list; cancel confirms | P3 |
| `apps/api/test/dashboard-analytics.test.ts` (chart markup) | chart classes, `<caption>`, no `style=` | chart has an accessible table fallback | `getByRole('table')` by caption; zero CSP violations | P3 |
| `apps/api/test/dashboard-agent-series.test.ts` (chart markup) | chart classes, header text | data shown as text, not colour only | header text visible | P3 |
| `apps/api/test/dashboard-terminal.test.ts` (panel markup) | disabled close button id, `<kbd>` hint | close disabled without a terminal; shortcut hint shown | close disabled when empty; the release shortcut moves focus out | P4 |
| `dashboard-terminal.test.ts` (fake stylesheet strings) | CSS strings on the fake stylesheet | CSP adapter works | Playwright: open a terminal, zero CSP violations, xterm renders | P4 |
| `apps/api/test/dashboard-typesafe.test.ts` (panel markup) | remove-button id present or absent, `<dt>`/`<dd>` text | remove shown only when configured | state-driven visibility | P4 |
| `apps/api/test/dashboard-oauth-settings.test.ts` (form markup) | checked checkbox, selected option | form defaults and disabled states | choose a preset, assert the reflected value | P3 |
| `apps/api/test/dashboard-router.test.ts` (settings ids) | control ids in settings markup | settings page has save/reset/check controls | keep the (a) payload assertions; replace the id checks with a Playwright smoke test | P3 |
| `apps/api/test/dashboard-app-mount.test.ts` (asset URL substrings) | HTML contains versioned asset URLs | asset URLs are versioned | HTTP test: take asset URLs from the shell (manifest mode too), GET returns 200 with `private, immutable` | P1 |
| `dashboard-app-mount.test.ts` (`app.ts` source match) | source text of middleware order | API budget is reserved for `/dashboard/api/v1` | HTTP test: exhaust the budget on `/dashboard/api/v1` → 429 while pre-auth paths are unaffected | P1 |
| `apps/api/test/knowledge-dashboard-ui.test.ts` (markdown strings) | exact tag strings | markdown renders safely | keep one escaping assertion and the no-style check as a security test; replace string equality with DOM parsing and text/role checks | P3 |
| `apps/api/test/dashboard-input-patterns.test.ts` | every legacy `pattern` attribute compiles under the `v` flag | a field never silently loses its validation | render each React form that sets `pattern` and assert the browser enforces it (`validity.patternMismatch`) | P4c |
| `apps/api/test/mcp-servers-dashboard-ui.test.ts` (card markup) | `<code class="mono">`, `data-copy` URL | gateway card and copy chip | copy button writes the endpoint; text visible; keep `expectCspSafe` | P4 |

`dashboard-app-mount` as a whole stays: its HTTP and version cases are class
(a) and it **gains** React-shell cases in P1 (manifest mode, canary, fallback
allowlist). Only the two source-text assertions above are rewritten as HTTP
tests; nothing is removed without a replacement.

### 9.1 Class (b) suites to port to Playwright

| Suite (`apps/api/test/`) | Phase | Note |
| --- | --- | --- |
| `dashboard-activity` | P3/P4 | |
| `dashboard-agents` | P3 | |
| `dashboard-agent-series` | P3 | |
| `dashboard-analytics` | P3 | |
| `dashboard-automation` | P4 | |
| `dashboard-runtime` | P3 | |
| `dashboard-lifecycle-settings` | P3 | Input parsing can stay a plain unit test |
| `dashboard-oauth-settings` | P3 | |
| `dashboard-models-spend` | P4 | USD arithmetic stays a unit test |
| `dashboard-models-wizard` | P4 | Wizard rules stay unit tests; combobox moves to Playwright |
| `dashboard-resource-page` | P2/P3 | |
| `dashboard-ui-behavior` | P2–P4 | Modals, palette, theme, backdrop, GitHub callback, escaping |
| `dashboard-skills-ui` | P3 | |
| `dashboard-terminal` | P4 | Byte helpers and the protocol controller stay unit tests |
| `dashboard-typesafe` | P4 | Its (a) part stays |
| `dashboard-git` | P4 | Git parsers (a) stay |
| `dashboard-cockpit` | P3 | |
| `dashboard-inbox-ui` | P4c | Link and label helpers can stay unit tests |
| `dashboard-traces-ui` | P4c | Query and formatting helpers can stay unit tests |
| `dashboard-automations-ui` | P4c | Rule input parsing can stay a unit test |
| `dashboard-policies-ui` | P4c | Form-to-document mapping can stay a unit test |
| `dashboard-multi-repository` | P4c | Its BFF part stays (a) |
| `dashboard-skill-run-approval` | P4c | |

Fake-DOM harnesses: `apps/api/test/dashboard-test-dom.ts` (used by several
legacy suites) and `apps/api/test/dashboard-tree-dom.ts` (imported by
`dashboard-models-spend.test.ts` and `dashboard-models-wizard.test.ts`). Both
are removed with the legacy suites in P6, not earlier.

### 9.2 Class (a) suites that stay unchanged through P1–P5

`dashboard-router`, `dashboard-session`, `dashboard-mcp-gateway-api`,
`dashboard-models-router`, `dashboard-terminal-router`, `dashboard-packages`,
`dashboard-privilege-grants`, `dashboard-response-totality`,
`dashboard-github-error-message`, `dashboard-audit-gaps`,
`dashboard-skills-mapper`, `dashboard-overview` (projection part),
`dashboard-inbox-router`, `dashboard-traces-router`,
`dashboard-automations-router`, `dashboard-automation-bff`,
`dashboard-policies-router`,
`access-auth`, `mcp-oauth`, `knowledge-api`, `runner-client-internal` (all in
`apps/api/test/`), `apps/api-key-gateway/test/gateway.test.ts`,
`test/upgrade-nginx-routes.test.ts`, the dashboard integration suites in
`test/integration/`, `apps/runner/test/dashboard-control-service.test.ts` and
the contract tests in `packages/contracts/test/`. `dashboard-app-mount` stays
and grows (see above).

There is no browser test for the Dashboard today (`test/e2e/` holds Docker
tests only). P1 sets up Playwright and axe, and every replacement above runs
there.

## 10. Known legacy defects

Found by reading code, not confirmed in a browser. React must not copy them.
A defect that should be fixed on the legacy shell before cutover gets its own
issue instead of widening an epic PR.

| ID | Severity | Defect | Owner | React handling | Separate legacy issue? |
| --- | --- | --- | --- | --- | --- |
| R4 | high | Launch-workspace dialog: it opens and previews skill sets, but submit and cancel have no handler; the form has no `method`/`action`, so a submit may become a GET with the fields in the query string | `index.html` `open-workspace-form`, launch wiring in `dashboard.js` | implement on `POST /workspaces` (idem) | yes: fix or hide the button, after a browser check |
| R1 | medium-high | Workspace filter navigates to `/dashboard?q=` (Overview) and ignores `q`/`status`; `#clear-filters` does the same | `#workspace-filter` submit, `loadIndex` | filters are search params of `/dashboard/workspaces` | yes |
| R5 | medium | Idempotency key regenerated per submit (agent message, session) | agent message and open-session handlers | key per intent, kept across retries | optional |
| R7 | medium | Skill import poller not stopped on navigation; unhandled rejections | `createImportPollingController` | query-owned poller | optional |
| R8 | medium | Orphan PTY on dispose during open | `createTerminalSession.open` | close immediately when disposed | optional |
| R2 | low-medium | Refresh tears down the terminal view | `#refresh`, `load` | app-level terminal | no |
| R9 | low-medium | Import cancel sends a hard-coded `expectedGeneration` | import cancel handler | read the generation from the job | optional |
| R10 | low-medium | No dirty-form guard; "Load current server version" discards the knowledge draft in one click | knowledge editor and conflict dialog | block navigation on dirty forms (not for secret forms: they keep no drafts) | no |
| R6 | low | MCP dialog keeps typed values after close; header value not masked | `openMcpDialog` | reset on close; masked input | optional |
| R11 | low | Stacked `once` listeners on the file-conflict dialog | `openFileConflict` | Radix Dialog | no |
| R12 | low | Git checkout/merge/rebase and the `start` action have no confirm | advanced git action handler | add a confirm | no |
| R13 | low | Stale approvals badge | `refreshApprovalsBadge` | query invalidation | no |
| R14 | info | Global DOM monkey-patch for the terminal CSP adapter | `dashboard-terminal.js` | no monkey-patch | no |
| R15 | info | Dead code: `skill-import-dialog`, `createKnowledgeLink`/`deleteKnowledgeLink`, client redirect table | `dashboard-render.js`, `dashboard-api.js`, `dashboard-pages.js` | do not port | no |
| R16 | info | MCP detail tab, Runtime sub-views and Skills tabs are not in the URL | `loadMcpServerDetail`, skills tabs | search params | no |

BFF findings (outside UI scope; file separately when needed):

| ID | Severity | Finding | Owner |
| --- | --- | --- | --- |
| F1 | medium | Fixed in #490: about 40 handlers spread the body after path params, so a body id won over the path id (still within the principal). Path ids are now authoritative and a conflicting body id is `400 path_id_mismatch`; regression table in `apps/api/test/dashboard-path-id-authority.test.ts`. | router, control router ("Override" column in section 4) |
| F2 | low-medium | Malformed JSON returns 500 instead of 400 and is not logged | router error handler |
| F3 | low | Workspace artifact and activity projections truncate silently | router workspace artifacts and activity handlers |
| F4 | low | Artifact download buffers the whole file in memory | control router download handler |
| F5 | low | Fan-out routes cost one runner call per workspace | `listAgentsAcrossWorkspaces` in router |
| F6 | low | Polling shares the per-principal budget | `principalRequestLimits` |
| F7 | info | Unmapped responses reach the browser raw (settings, OAuth settings, `model_*`, `toolkits_*`); a control-router comment says otherwise | `mapDashboardData` in response |
| F10 | info | `GET /session` mints a new session each call without revoking older ones; one shared LRU | session |
| F11 | info | HEAD runs the OAuth callback and consumes the one-time `state` | gateway router callback |

## 11. Server-side changes React needs (P1)

Details live in the
[P1 draft](../plans/261020-1224-dashboard-2-react-dewee/child-issues/p1-scaffold-build-canary.md).
Touch points:

- assets: the fixed allowlist and the single-segment
  `/assets/:version/:asset` route must also serve the manifest-derived set;
  reject `..` and dotfiles. Keep reading the legacy `index.html` at module
  load: the legacy shell stays the default and the rollback target.
- assets: validate the manifest at startup whenever the React shell is
  selectable. With flag `react`, absent or invalid fails API startup (never a
  silent legacy fallback). Canary-only: canary disabled, reason logged, legacy
  keeps serving. One startup log line names the active shell and canary state.
- assets: add the allowlist SPA fallback after the API and asset routes, with
  `no-store`.
- assets: hashed files keep `Cache-Control: private, max-age=31536000,
  immutable` (same as the current versioned route).
- security: add only `font-src 'self'`.
- `docker/api.Dockerfile`: copy `apps/dashboard/dist` **in addition to**
  `apps/api/dashboard/`. Removing the legacy copy is a P6 follow-up.
- Flag `CLOUD_HARNESS_DASHBOARD_UI=legacy|react` and the HTTP-only `?ui=react`
  canary cookie select the shell. Rollback is `legacy` plus an `api` restart.
- SPA chunk-load failure: one guarded full reload of the shell, then an error
  state. Keeping previous-release assets is out of scope.
- nginx (`deploy/nginx/cloud-harness-mcp.conf`) and
  `deploy/scripts/upgrade-nginx-dashboard.sh` need no change while the
  `/dashboard/` prefix stays.

## 12. Tracking

| Phase | Matrix rows | Reviewer |
| --- | --- | --- |
| P1 | sections 1 and 11; P1 rows in section 9 | owner |
| P2 | D1, D11; sections 2.2, 5 (global keys), 6 (T7, T11–T13); P2 rows in section 9 | owner |
| P3 | P3 rows in sections 2, 3, 4, 6, 9; section 4.13 decisions for P3 routes | owner |
| P4 | P4 rows in sections 2, 3, 4, 6, 7, 8, 9; section 4.13 decisions for P4 routes | owner plus security review |
| P5 | Dewee (see ADR 0005); F1 fixed before or within P5 | owner plus security review |
| P4c | P4c rows in sections 2, 4.14, 6, 8 and 9 (#551) | owner plus security review |
| P6 | delete the legacy shell, the fake-DOM harnesses, replaced (b)/(c) suites and this matrix; needs P4c done | owner |

### 12.1 P3 status

P3 ([#483](https://github.com/bestagentkits/cloud-harness-mcp/issues/483))
moved these pages to `apps/dashboard/src/features/<page>/` on the same BFF
endpoints. Each page's Playwright spec in `apps/dashboard/e2e/` owns its
request count, states, axe and console checks;
`apps/dashboard/e2e/polling-budget.spec.ts` checks that no migrated page reads
an endpoint twice on load or polls at rest, and
`apps/dashboard/e2e/visual.spec.ts` holds the light and dark screenshots at
1280, 768 and 375 px.

| Page | Status | Notes |
| --- | --- | --- |
| Overview | done | One read per tile source, as legacy. The Cost tile keeps the legacy currency format; the static endpoint row is dropped. |
| Workspaces list | done | R1 fixed: filters are search params of `/dashboard/workspaces`. The header's launch action is the D5 wizard since P4b (section 12.3). |
| Workspace cockpit | partial | Typed tab registry in `features/workspace-cockpit/cockpit-tab-registry.ts`. Summary, Agents, Runtime and Activity are live; Terminal, Files, Git, Automation, Deploy and Artifacts were registry placeholders until P4b; all are live since (section 12.3). |
| Agents (list, detail) | done | Follow is off by default (legacy makes two reads). The detail polls only while Follow is on and the agent is live: one owner for the detail and one for the log tail. Follow-up keeps one idempotency key per intent (R5). |
| Activity, approvals summary | done | When both approvals reads fail the summary says "Approvals could not be checked"; when one fails the headline is "Some approvals could not be checked", never "No approvals are waiting". The sidebar Approvals badge is kept: it shares the summary's queries (`src/lib/approvals-summary.ts`), reads on Overview, Activity and Approvals like `refreshApprovalsBadge`, refetches on window focus and after `invalidateApprovals`, and shows "!" (or "N+") on a partial failure. Approve and reject stay P4a, which calls `invalidateApprovals` after a decision. |
| Audit | done | `cursor` paging as a search param. |
| Projects, environments | done | Every write sends its generation; a 409 shows "This changed elsewhere" and refetches. Environment secrets stay a link to `/secrets` (P4a), so the detail drops the legacy per-environment secret reads. |
| Knowledge | done | R10 fixed, D8 conflict review re-hosted with base, server and draft panes. Non-secret drafts survive a reload in `sessionStorage` (ADR 0005). Workspace-scope create gains the `workspaceId` field the runner requires. |
| Skills | done | R7, R15 and R16 fixed. R9 is unchanged: the BFF import-job projection carries no `generation`, so cancel still sends 1 (the page reads a generation if the projection ever adds one); tracked in #497. Tabs and filters are search params. Adding a revision now sends the skill's real generation instead of 0. Bulk Enable added (same endpoint, reversible). The registry's primary action is "Upload skill"; "New skill" is a section button. |
| Profile | done | Shares the shell's profile read; no extra request. |
| Settings | done | Lifecycle, network profile, readiness check and OAuth sessions are live. TypeSafe shows status only; the key write stays on the classic page (P4). |

Section 4.13 decisions for P3 routes:

| Route | Decision | Reason |
| --- | --- | --- |
| `GET /workspaces/:id/tasks/:taskId` | re-host | Runtime task output, deep-linked by `?task=`, with "Next slice" paging |
| `GET /skills/:skillId` | re-host | Opens a `?skill=` deep link that is outside the list window |
| `GET /skills/:skillId/revisions/:revisionId` | drop | Returns the same fields as a revision-list row and no content |
| `PATCH /skills/:skillId` | re-host | "Edit details" (name, description, tags); nothing else can set the tags the filter uses |
| `POST /skills/:skillId/archive` | re-host | Archive in the skill drawer, confirmed with the skill's name |
| `GET`, `PATCH`, `DELETE /skill-sets/:skillSetId` | re-host | The Sets tab lists, renames and deletes sets; delete is confirmed |
| `GET /toolkits`, `POST /toolkits/preview` | defer to P4 | Belong to the launch dialog (D5) |
| `POST`, `DELETE /knowledge/links` | drop | Links come from `[[kn_…]]` wikilinks in the content; the entry page shows outgoing links and backlinks read-only, and legacy had only dead helpers (R15) |

The workspace task graph (`GET /workspaces/:id/tasks/graph`) is deferred to
P4b with the Automation tab; Runtime shows each task's dependencies as a
column. T1 (skill import) is a query-owned poller that stops on a terminal
state, an error, the legacy read limit or unmount. T15 (approvals summary)
refreshes with the Activity page's reads.

### 12.2 P4a status

| Area | Rows | Status | React owner and evidence |
| --- | --- | --- | --- |
| Secrets | route `/dashboard/secrets`, D4, create-global-secret dialog, section 4.5 global rows | done (P4, #484) | `apps/dashboard/src/features/secrets/`; `e2e/write-paths.spec.ts` (body, `expectedGeneration`, 409) |
| API access | route `/dashboard/api-keys`, D3, section 8 API key row | done (P4, #484) | `features/api-keys/`; `e2e/one-time-reveal.spec.ts` (dismiss, navigation, reload, session end) |
| MCP servers | route `/dashboard/mcp-servers[/:id]`, D10, R6, R16 (detail tab in `?tab=`), section 4.11 | done (P4, #484) | `features/mcp-servers/`; `e2e/write-paths.spec.ts` (enabled fence, 409); classic edit bug filed as #492 |
| Integrations and GitHub App | route `/dashboard/integrations[/github]`, section 4.9 GitHub rows, section 8 callback rows | done (P4, #484) | `features/github/`; the callback is handled natively, no `?ui=legacy` hand-off |
| Approvals | route `/dashboard/approvals` (approve and reject), R13 | done (P4, #484) | `features/approvals/`; decisions invalidate the reads, no nav badge |
| Models & Budgets | route `/dashboard/models`, D6, D7, section 4.6 | done (P4, #484) | `features/models/`; `e2e/write-paths.spec.ts` (credential body, wizard restore without the key); fence fallback filed as #493 |
| Write security | section 1 CSRF, Origin and session rows for P4 writes | done (P4, #484) | `e2e/bff-write-security.spec.ts` against the real in-process BFF |
| Layout and a11y | P4 pages at 1280, 768 and 375 px, light and dark | done (P4, #484) | `e2e/security-pages.spec.ts` (axe, no page-level horizontal scroll, screenshots attached) |

The classic suites named in section 9 for these pages stay until P6.

### 12.3 P4b status

P4b ([#484](https://github.com/bestagentkits/cloud-harness-mcp/issues/484),
Complex and Wizards) finishes the cockpit tabs and the launch flows. Every tab
declares its own `validateSearch` in
`apps/dashboard/src/features/workspace-cockpit/cockpit-tab-registry.ts`; the
registry placeholders and the classic hand-off dialog for these tabs are gone.

| Area | Rows | Status | React owner and evidence |
| --- | --- | --- | --- |
| Terminal | cockpit Terminal tab, route `/dashboard/terminals`, sections 4.12 and 7 | done (P4b, #484) | `features/terminal/` (lazy xterm chunk); `e2e/terminal.spec.ts`, `terminal-protocol.test.ts`. The PTY session survives route changes inside the shell |
| Files | cockpit route `?path=`, `?file=`; D2; section 4.2 file rows | done (P4b, #484) | `features/workspace-cockpit/tabs/files-tab.tsx`, `files-model.ts`; `e2e/workspace-tabs.spec.ts` (deep link, `expectedSha256` fence, 409 keeps the edit, delete confirm). R11 fixed: one conflict dialog owned by React state |
| Git | cockpit route `?staged=`; section 4.2 git and worktree rows | done (P4b, #484) | `tabs/git-tab.tsx`, `git-model.ts`; checkout, merge, rebase and worktree remove confirm; fetch, pull and branch do not |
| Automation | section 4.2 skills and hooks rows | done (P4b, #484) | `tabs/automation-tab.tsx`, `automation-model.ts`. Skill run sends `{script, expectedContentSha256}`; hook run sends `{name, event, expectedManifestSha256}` (or the hook's `expectedSha256`), which `hooks_run` requires; legacy sent only `{event}`, which the schema refuses. The Dashboard cannot complete the skill privilege grant yet (#511) |
| Deploy | section 4.2 deployments rows; deploy wizard | done (P4b, #484) | `tabs/deploy-tab.tsx`: choose a target, review, confirm. The target and step survive a reload (`ch-dashboard-restore:deploy:<id>`); run output is component state only |
| Workspace artifacts | cockpit Artifacts tab | done (P4b, #484) | `tabs/artifacts-tab.tsx`, read-only with native download links under `/dashboard/api/v1/artifacts/` |
| Task graph | `GET /workspaces/:id/tasks/graph` | done (P4b, #484) | `task-graph.tsx`, lazy above the Runtime task list; one read, no poller, re-read by Refresh |
| Cockpit header | section 4.2 renew, finalize, recover, close rows; finalize dialog | done (P4b, #484) | `workspace-cockpit.tsx`, `finalize-dialog.tsx`. Finalize now sends an `idempotencyKey` kept across retries of one intent; recover sends `{mode: 'resume'}`; close sends `{expectedGeneration}` and confirms |
| Open workspace (D5) | D5, R4, section 4.7 skill-set preview and toolkit rows | done (P4b, #484) | `features/workspaces/open-workspace-*.ts(x)`; `e2e/complex-pages.spec.ts`. `POST /workspaces` with one `idempotencyKey` per intent, kept across retries and a reload; skill sets with `expectedGeneration`, conflict overrides, owner-scope toolkits (licensed kits only when ready). Draft restore drops a URL with user info, a query or a fragment |
| Artifacts page | route `/dashboard/artifacts`, section 4.8 | done (P4b, #484) | `features/artifacts/`; `?cursor=` paging, snapshot create (`expectedGeneration: 0`), delete with `{expectedGeneration}` confirm |
| Packages page | route `/dashboard/packages`, section 4.9 package rows | done (P4b, #484) | `features/packages/`; roll back and uninstall confirm with the binding generation. Plan approval (`planDigest`) stays on the Approvals page (P4a) |
| Agent spawn | dashboard agent spawn | defer (#393) | No BFF route spawns an agent; the Agents page keeps follow-up only |
| Write security | section 1 CSRF and Origin rows for P4b writes | done (P4b, #484) | `e2e/complex-write-security.spec.ts` against the real in-process BFF, one pair per area |
| Layout and a11y | P4b tabs and pages at 1280, 768 and 375 px, light and dark | done (P4b, #484) | axe in `e2e/workspace-tabs.spec.ts` and `e2e/complex-pages.spec.ts`; `e2e/visual.spec.ts` adds Files, Git, Automation, Deploy, Artifacts and Packages baselines |

Section 4.13 decisions for P4b routes:

| Route | Decision | Reason |
| --- | --- | --- |
| `POST /workspaces` | re-host | The open-workspace wizard (D5, R4 fixed) |
| `GET /toolkits`, `POST /toolkits/preview` | re-host | Toolkit step and the review check of the wizard |
| `POST /workspaces/:id/hooks/{activate,deactivate}` | drop | Hook state comes from the repository manifest; the tab shows it read-only, as legacy did |
| `GET /artifacts/:artifactId` | drop | The list row carries every field the page shows; download is the native link |
| `POST /artifacts/:artifactId/restore` | defer (#512) | Restoring writes into a workspace and needs a target-path design |

### 12.4 P5b status

P5b ([#485](https://github.com/bestagentkits/cloud-harness-mcp/issues/485))
embeds the Dewee assistant on the P5a BFF.

| Area | Status | React owner and evidence |
| --- | --- | --- |
| Widget mount | done | `features/assistant/dewee-webchat.tsx`, lazy (`lazyHeavy` budget) and mounted from the top-bar Assistant button; `widget-host-setup.ts` adopts its styles under the CSP, sends the in-memory CSRF header and keeps its visitor token out of storage |
| Page actions | done | `lib/page-actions.ts` (zod-free registry, `usePageActions` hook) and `features/assistant/page-action-catalog.ts`: navigate, read page state, set filters, open the page's create flow, and prepared mutations for P3 and P4a pages (projects, environments, agent cancel, API key revoke, secret delete, MCP server enable, lease renew) |
| Confirmation | done | `features/assistant/assistant-controller.ts`; the dialog shows the exact method, path and body and sends only on the owner's click; `e2e/dewee-assistant.spec.ts` (blocked until confirm, denial sends nothing, CSRF, no secret in page context or results, axe) |
| Command palette | done | pages, recent workspaces (`lib/recent-workspaces.ts`, ids only), the page's primary action, cockpit tabs and registered actions; keyboard-only and axe checked in `e2e/dewee-assistant.spec.ts` |
| Cockpit tab actions | hook only | P4b tabs register their own actions with `usePageActions('workspace.<tab>', …)` while mounted |

No page context exposes runner `mcpt_` ids, so the BFF's public-id list is
unchanged.

### 12.5 P4c: dev-only legacy pages

`dev` built these surfaces in the legacy shell while `main` built the React
app. They were not in this matrix until the #541 merge joined the two lines
(#548). Umbrella issue: [#551](https://github.com/bestagentkits/cloud-harness-mcp/issues/551).
No row is dropped: each one has a port issue, and P6 (#486) waits for all of
them.

| Area | Rows | Status | Port issue |
| --- | --- | --- | --- |
| Inbox and notification preferences | route `/dashboard/inbox`, section 4.14 inbox rows, T17 | open | [#557](https://github.com/bestagentkits/cloud-harness-mcp/issues/557) |
| Traces | route `/dashboard/traces[/:trc_id]`, the agent detail Traces panel, section 4.14 trace rows, T16 | open | [#560](https://github.com/bestagentkits/cloud-harness-mcp/issues/560) |
| Automations | route `/dashboard/automations[/…]`, section 4.14 automation rows, section 8 signing secret row | open | [#561](https://github.com/bestagentkits/cloud-harness-mcp/issues/561) |
| Agent policies | routes `/dashboard/settings/agent-policies`, `/dashboard/projects/:prj_id/agent-policies`, section 4.14 policy rows | open | [#562](https://github.com/bestagentkits/cloud-harness-mcp/issues/562) |
| Repository scope | cockpit `?repository=`, section 4.14 repository rows | open | [#563](https://github.com/bestagentkits/cloud-harness-mcp/issues/563) |
| Skill run privilege grant | cockpit Automation, section 4.14 skill run row | open | [#565](https://github.com/bestagentkits/cloud-harness-mcp/issues/565) |

`apps/api/test/dashboard-pages.test.ts` fails when a legacy page id has no
row in section 2, so a new legacy page cannot skip this matrix again.
