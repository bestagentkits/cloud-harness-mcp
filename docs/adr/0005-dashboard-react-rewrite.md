# ADR 0005: Dashboard 2.0 on React, Served Same-Origin by the Existing BFF

- **Status:** Accepted
- **Date:** 2026-10-20
- **Related Issues:** Issue #458 (this epic). It supersedes only the frontend
  technology constraint of Issue #220 ("no framework rewrite") and the design
  rules that followed from it. It does not relax
  [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md),
  [ADR 0002](0002-inbound-oauth-grant-provider.md) or
  [ADR 0003](0003-terminal-bash-and-managed-toolbox.md).

## Context

The operator Dashboard is about 11,000 lines of hand-written browser modules
under `apps/api/dashboard/`. Every page is an imperative renderer that writes
HTML strings into one content node, and navigation runs through a serialized
per-page load queue in `dashboard.js`. The page loaders differ: some paint a
skeleton before their fan-out, others wait for the API first. That is why the
header and sidebar can already show page B while page A's body stays on screen
for a second or two. Loading, empty, error and refresh states differ per page,
dialogs follow per-dialog rules, and there is no shared component layer to fix
these once.

Issue #220 delivered the current information architecture under an explicit
"no framework rewrite" decision, and `docs/design-guidelines.md` turned the
strict CSP into product rules: no framework dependency, no web fonts, no
browser storage. The CSP and the security rules behind it stay valid. The
framework and storage rules were a choice for that redesign, not a security
boundary, and they now cost more than they save.

Everything below the browser is sound and stays: the `/dashboard/api/v1` BFF
in `apps/api/src/dashboard-router.ts` and its sibling routers, the
principal-scoped and redacted projections in
`apps/api/src/dashboard-response.ts`, the HTTP-only session and CSRF token in
`apps/api/src/dashboard-session.ts`, the Host/Origin checks and CSP in
`apps/api/src/dashboard-security.ts`, Cloudflare Access in front of
`/dashboard`, and the exact `/dashboard/mcp-oauth/callback` handling in
`deploy/nginx/cloud-harness-mcp.conf`.

## Decision

### Stack

The new Dashboard lives in `apps/dashboard` as a browser-only workspace
package:

| Concern | Choice |
| --- | --- |
| UI runtime | React 19, TypeScript `strict` |
| Build | Vite, production build with hashed file names and `manifest.json` |
| Routing | TanStack Router with file-based routes, typed search params |
| Server state | TanStack Query v5 (cache, staleness, cancellation, invalidation) |
| Styling | Tailwind CSS v4 compiled to a static stylesheet, semantic tokens as CSS variables |
| Primitives | shadcn/ui components on Radix primitives, copied into the repo |
| Forms | React Hook Form with Zod schemas |
| Motion | Motion, for dialogs and toasts only |
| Terminal | The existing pinned `@xterm/xterm` and fit addon, unchanged transport |
| Tests | Vitest + Testing Library for units, Playwright with axe for E2E and accessibility |

Further dependencies need a real use case and a line in the budget below.
TanStack Table and Virtual are pre-approved for the large tables (Activity,
Audit, Files) when a page needs them.

**Radix over Base UI.** shadcn/ui supports both. Radix is the mature default
of shadcn's Vite registry. Its Dialog, Popover, DropdownMenu and Tooltip
already implement the focus trap, Escape, outside-click and invoker
focus-restore rules this epic requires, and they have years of production
accessibility fixes. Base UI is younger and its shadcn variants are newer, so
we would carry more first-party fixes for the same behaviour. Either choice
fits the CSP; Radix carries less migration risk.

### Rejected: Next.js or any SSR server

A Vercel-inspired look does not need Vercel's framework. Next.js (or any
SSR/RSC server) would add a second Node server between Nginx and the API. That
server would have to take part in Cloudflare Access verification, the session
cookie, CSRF and the CSP, or proxy all of them, and would widen what can reach
the runner. Server rendering also brings inline hydration scripts, which fight
the no-`unsafe-inline` policy and would need per-response nonces on every
page. The Dashboard is an authenticated single-owner tool with no SEO need, so
SSR buys nothing here. The BFF keeps rendering the only HTML document.

### Delivery: same-origin hashed assets served by Express

- `vite build` writes `apps/dashboard/dist/` with content-hashed JS, CSS and
  font files plus `.vite/manifest.json`.
- `apps/api/src/dashboard-assets.ts` stays the only asset owner. At startup it
  reads the manifest and builds a fixed allowlist of the files the manifest
  names. A request path is looked up in that map and never reaches the
  filesystem. The manifest is validated at startup whenever the React shell
  is selectable: the flag is `react`, or the canary is allowed.
  - With `CLOUD_HARNESS_DASHBOARD_UI=react`, an absent or invalid manifest
    **fails API startup**. The API never silently serves the legacy shell in
    place of the selected one.
  - In canary-only mode (flag `legacy`, canary allowed), an absent or invalid
    manifest disables the canary and logs the reason; the legacy shell keeps
    serving.
  - The selected shell is observable: the API logs one startup line naming
    the active shell and whether the canary is enabled.
- Hashed assets keep the current versioned-asset header,
  `Cache-Control: private, max-age=31536000, immutable`. They sit behind
  Access like every Dashboard response, so they are never `public`. The HTML
  shell stays `no-store`, so a fresh navigation never pairs a new shell with
  old chunks.
- Keeping the previous release's hashed files in the image is out of scope.
  A tab still open on an old shell can fail to lazy-load a chunk after a
  deploy. On a chunk-load failure the SPA performs one guarded full reload of
  the shell (a per-tab marker prevents a reload loop) and shows an error
  state if the reload fails too. This path has its own test.
- The SPA fallback is an allowlist: it answers only HTML navigations to known
  Dashboard route prefixes, and unknown `/dashboard/*` paths still 404. It
  never answers `/dashboard/api/v1/*`, `/dashboard/mcp-oauth/callback`, asset
  paths, `/mcp*` or terminal output routes. Those keep their own handlers and
  their 404/JSON errors.
- The API image contains the React build **in addition to**
  `apps/api/dashboard/`. The legacy shell is read at module load, so removing
  it would break the `legacy` rollback. It is removed only by the P6 follow-up
  that deletes the legacy shell.
- The browser keeps calling the BFF with the session cookie and the CSRF
  header. It imports no server module. Shared browser-safe DTO types may come
  from `packages/contracts` or a dedicated `packages/dashboard-types`; nothing
  that holds runner tokens or server internals enters the bundle.

### CSP stays strict

The policy in `dashboardSecurity` keeps `default-src 'none'`, `script-src
'self'`, `style-src 'self'`, `connect-src 'self'`, `base-uri 'none'`,
`frame-ancestors 'none'` and `form-action 'self'`. The React build allows
exactly these changes, each tested:

- `font-src 'self'` for the self-hosted Geist Sans and Geist Mono files
  (SIL Open Font License 1.1, license file shipped next to the fonts). No
  remote font host, no `data:` fonts.
- No `unsafe-inline` and no `unsafe-eval` in any directive. No CDN.
- Inline `style=` attributes in markup stay forbidden. Styles set through the
  CSSOM by React, Radix or Motion (`element.style.x = …`) are not governed by
  `style-src` and are allowed, the same way the xterm adapter works today.
- A library that injects a `<style>` element at runtime (for example Radix
  scroll lock through `react-remove-scroll`, or some toast libraries) would be
  blocked. P1 must prove a clean console: either pick primitives and CSS that
  avoid injected style elements, or add a per-response style nonce rendered
  by the shell handler. A nonce is the only acceptable widening, and it needs
  its own test and an update to the security model.
- Any `img-src` need (for example avatars) is added as `img-src 'self'` only,
  with a test, when a page needs it.

### Rollout and one-step UI-only rollback

- `CLOUD_HARNESS_DASHBOARD_UI=legacy|react` selects the shell the API serves
  for `/dashboard` HTML navigations. The default stays `legacy` until the
  cutover is approved.
- A per-session canary `/dashboard?ui=react` (or `?ui=legacy`) sets an
  HTTP-only, `Secure`, `SameSite=Strict`, path `/dashboard` cookie that
  overrides the instance flag for that browser. The value is validated on
  every read. It changes only which static shell is served, never what the
  BFF allows.
- Both shells call the same BFF, so they can run side by side. Rollback is
  setting the flag to `legacy` and restarting the `api` service. It needs no
  database, runner or MCP change and loses no user data. The legacy bundle is
  removed only after a stable cutover and a verified rollback window.

### Browser storage and preferences

The old rule "no browser storage" is superseded **only** for these uses:

- Non-secret display preferences: text size, density and similar. The theme
  keeps its server-side HTTP-only cookie and first-paint injection, because
  that is what prevents a theme flash; `localStorage` may mirror it.
- Non-secret UI state restore: URL state is the primary owner (filters, tabs,
  selection, pagination). `sessionStorage` or `localStorage` may also hold
  wizard step, scroll position and non-secret form drafts.

Everything else stays forbidden. Secrets, API keys, OAuth codes or tokens,
secret-reference values, terminal output, owner IDs, runner tokens and Access
assertions never enter browser storage, TanStack Query persistence, logs,
telemetry or error messages. The query cache is in memory only. A one-time
reveal (a new API key, a GitHub App manifest result) lives in component state
and is cleared on navigation, dismiss and session end, with an E2E test for
each path. Drafts of forms that take secret values are never stored, read as
follows: a multi-step wizard that has a secret field (the model profile
wizard's provider key) may store its draft, but only through an allowlist that
excludes every secret field and drops any other field that could carry one,
such as a URL with user info, a query or a fragment. Single-dialog forms that
take secret values keep no draft.

### Dialog rules

Dismissible dialogs close on backdrop click and Escape and return focus to
the invoker. A dirty form asks before discarding. A one-time reveal needs an
explicit acknowledgement. While a destructive mutation is in flight, outside
dismissal is disabled. Navigation never aborts an acknowledged mutation: only
read queries are cancelled when their route changes.

### Embedded Dewee webchat and page actions

- The Dewee webchat widget is bundled from its npm package into the Dashboard
  build. No CDN script and no iframe to another origin.
- The browser talks only to a BFF handler under `/dashboard/api/v1/dewee/*`.
  It runs behind Access, the dashboard session, the CSRF check and the
  per-principal rate limit. The Dewee gateway token stays on the server and
  never reaches the browser, the bundle or logs.
- The agent can act on the page through a typed dashboard action registry
  (navigate, read visible non-secret state, set filters, open a wizard,
  prepare a mutation). Reads return the same redacted projections the page
  already shows. A sensitive or destructive mutation needs an explicit user
  click in the Dashboard. The agent never receives secret values or API keys.
- The registry builds every request body itself from a typed schema per
  action. It never forwards a raw agent payload to the BFF. The confirmation
  dialog renders exactly the body that will be sent, and nothing else is
  sent after the click.
- `getPageContext` returns only non-secret summary state (route, filters,
  selection, counts, statuses). It does not return file contents, terminal
  output, diffs or log bodies.
- Prerequisite: before or within P5, fix the BFF routes where a body
  `workspaceId` or other id overrides the path id (finding F1 in the parity
  matrix, for example the workspace lease/recover/finalize handlers in
  `apps/api/src/dashboard-router.ts` and the secret handlers in
  `apps/api/src/dashboard-control-router.ts`). Agent-built actions must not be
  able to name a different resource than the URL.

### The Dewee agent on Cloud Harness MCP (owner opt-in)

The owner decided on 2026-10-20 to attach the Dewee agent to Cloud Harness MCP
through the existing API-key lane with a managed key. Managed keys carry no
scopes, so this key is the principal's full static-client authority, including
the MCP gateway (see the security model). Actions the agent takes over MCP do
not pass through the Dashboard confirmation step. This is an accepted owner
risk, not a default. The control is key revocation or rotation on the API Keys
page. The key is created by the owner and stored only in the Dewee agent
configuration, never in this repository, the browser or logs.

The opt-in also accepts a data-flow risk. Whatever the agent can see on the
page or read over MCP (file contents, terminal output, diffs, logs) can flow to
the Dewee gateway and its LLM provider. That content is untrusted, so it can
carry prompt injection that steers the agent's MCP calls. The page context
limit above and the click confirmation for page actions reduce the risk on the
Dashboard side. They do not cover the agent's MCP calls. The security model
must record this opt-in, the data flow and the prompt-injection risk when the
integration ships.

### Complexity budget

- Initial route JS (entry plus the Overview route, gzip): at most **180 KB**.
  Each other route chunk: at most **60 KB** gzip. The terminal (xterm) and the
  Dewee widget load lazily and are budgeted on their own: at most **150 KB**
  gzip each.
- The CSS file: at most **40 KB** gzip. Fonts: at most four WOFF2 files
  (Geist Sans and Mono, regular and medium/semibold variable where possible).
- Runtime dependencies allowed without a new decision: `react`, `react-dom`,
  `@tanstack/react-router`, `@tanstack/react-query`, Radix packages used by
  copied shadcn components, `class-variance-authority`, `clsx`,
  `tailwind-merge`, `lucide-react`, `react-hook-form`, `@hookform/resolvers`,
  `zod`, `motion`, `@tanstack/react-table`, `@tanstack/react-virtual`,
  `@xterm/xterm`, `@xterm/addon-fit`, and the Dewee webchat package. A chart
  library, a date library or a state manager needs its own justification in
  the PR that adds it.
- CI checks the budget against the Vite manifest. A breach fails the build
  instead of raising the number silently.

## Evidence

The old→new inventory is the
[Dashboard parity matrix](../dashboard-parity-matrix.md). Each phase PR of
Issue #458 links its tests. The gates that make this decision safe are:
the BFF, session and Access suites (`dashboard-router`, `dashboard-session`,
`access-auth`, `mcp-oauth` and the other class-(a) suites the matrix lists)
stay green unchanged; `dashboard-app-mount` stays and gains React-shell cases
(manifest mode, canary, fallback allowlist) with nothing removed; CSP and
asset-allowlist tests cover the manifest mode; Playwright
covers A→B, A→B→C, Back/Forward and out-of-order responses with zero route
mismatches; and a canary plus rollback rehearsal runs before cutover.

## Consequences

- `docs/design-guidelines.md` no longer forbids a framework, self-hosted
  fonts or non-secret browser storage. Every security rule in it stays.
- The build gains a frontend toolchain and a `dist/` artefact the API image
  must contain. The API image stays the only server for the Dashboard.
- During migration both shells exist and the legacy markup tests keep running
  against the legacy shell. Markup-coupled tests are replaced with behavioural
  tests when a page moves; none is deleted without its replacement.
- Interactive work moves from string templates to typed components, so a new
  page reuses shared loading, empty, error and dialog states instead of
  re-implementing them.
- The Dewee integration adds a new BFF route family and a full-scope MCP key
  under owner control. Both are recorded in the security model when they ship.
