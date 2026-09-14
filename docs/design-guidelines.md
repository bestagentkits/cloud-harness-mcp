# Dashboard design guidelines

Design system for the Cloud Harness operator dashboard. This document owns the
**why**; [`apps/api/dashboard/dashboard.css`](../apps/api/dashboard/dashboard.css)
owns the **what** (every token and rule). The static UI contract is enforced by
[`apps/api/test/dashboard-ui-contract.test.ts`](../apps/api/test/dashboard-ui-contract.test.ts).

## Direction

- **Register:** product (a tool an operator must trust), not marketing. Bar is
  earned familiarity and legibility, not novelty.
- **Voice:** industrial / utilitarian "mission control" console. Calm, dense,
  instrument-grade.
- **Dials:** variance 3, motion 2, density 7. State-conveying motion only
  (150-250ms); no page-load choreography.
- **Memorable element:** amber corner-bracket frames on the framed surfaces
  (metric tiles, command toolbar), echoed by the amber active-rail on the
  navigation.

## Hard constraints (do not violate)

- **CSP `default-src 'none'`** with no `font-src`: no web fonts, no self-hosted
  fonts, no external assets, no inline `style=` attributes, no
  storage/telemetry. All styling lives in `dashboard.css`; behavior in the
  dashboard JS.
- **OKLCH only.** No hex colors and no `gradient()` anywhere (the UI contract
  test rejects both).
- **DOM is a contract.** Preserve the landmarks, single `<h1>`, dialogs, nav
  labels, and required CSS tokens/rules the contract test asserts.

## Typography (native stack, stated exception)

The industrial reference uses Barlow Condensed and IBM Plex, which are web
fonts the CSP forbids. We carry the same voice with a native stack instead:

- `--font-sans` system UI stack for body and headings.
- **Uppercase + letter-spacing** on the wordmark, page `h1`, nav groups, table
  headers, status pills, metric labels, and buttons - this is what reads
  "utilitarian", not a specific typeface.
- `--font-mono` (`ui-monospace` stack) for all data: IDs, timestamps, counts,
  metric values, code. `font-variant-numeric: tabular-nums` on every figure.
- Fixed `rem` type scale (dense UI). Body 14px desktop, 16px on mobile (avoids
  input zoom). One family in multiple weights - no second display face.

## Color

- **Strategy:** restrained. Cool blue-tinted concrete-gray neutral ramp plus one
  safety-amber accent used only for the primary action, active nav, selection,
  focus, and the corner brackets. Accent stays under ~10% of any surface.
- **Amber is never body text on a light surface** (poor contrast). Links use ink
  with an amber underline and shift to `--accent-strong` on hover; primary
  buttons use amber fill with dark `--on-accent` text.
- **Semantic hues are separated from the accent:** success green (H155), warning
  yellow (H100, deliberately yellower than the amber accent H62), danger red
  (H27). Status is a pill with a leading dot.
- **One gray family**, brand-tinted toward the console's cool blue.

### Adaptive dark theme

The default follows `prefers-color-scheme`. A single **icon control** in the top
bar cycles system → light → dark; `system` is represented by an absent
`html[data-theme]`, so the media query governs again. The control is deliberately
**not** `aria-pressed` — that attribute describes two states and this control has
three, so the accessible name states the current state and the next action
instead. Client storage is forbidden, so the choice persists **server-side, not
in the browser**: `PUT /api/v1/preferences` (CSRF-guarded) sets an HttpOnly
`ch-dashboard-theme` cookie, and the shell handler injects `html[data-theme]` on
first paint so a forced theme never flashes. The client only reads that DOM
attribute. Owners: the cycle state machine in `dashboard.js` and the injection in
[`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts).

Dark is a tinted graphite, not black: surfaces **elevate by lightening**
(`--canvas` -> `--surface` -> `--surface-raised`), the amber accent is
**brightened** so it stays legible, and shadows deepen. Both themes are verified
at WCAG AA: body text and muted text >= 4.5:1, primary-button text and status
pills pass against their actual backgrounds, and the focus ring is >= 3:1
against its surface.

### Operator display name

The Profile page edits a cosmetic **display name** shown in the top-bar chip.
Client storage is forbidden, so it follows the theme's server-side pattern: the
same CSRF-guarded `PUT /api/v1/preferences` writes an HttpOnly
`ch-dashboard-display-name` cookie and `GET /api/v1/profile` returns it as
`preferences.displayName`. The value is a presentation-only override: it never
replaces the verified assertion, never authorizes anything, is validated against
a bounded pattern on write, is re-validated on read (a tampered cookie is ignored
rather than trusted), and is escaped like any other attacker-influenceable
value. Owner: [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts).

## Depth, shape, motion

- **One depth strategy:** hairline borders (`--line`, `--line-strong`). Floating
  layers only (dialogs, mobile drawer, toasts) carry a tinted shadow. No
  ghost-card border+shadow combos.
- **One radius scale:** `--radius-sm/-md/-lg`; tight, never over-rounded.
- **Motion:** transition only `color`, `background-color`, `border-color`,
  `transform`, `box-shadow`; never `transition: all`; every animation has a
  `prefers-reduced-motion` off-ramp. Skeletons over spinners.

## Components

- **Top bar:** sticky header carrying the wordmark + `MCP Control Plane` tag, a
  search trigger (`aria-keyshortcuts="Meta+K Control+K"`), the theme icon, the
  profile chip, and Sign out. The chip is a link to the Profile page showing the
  operator **display name** (or the verified sign-on name/email until one is
  set); Sign out is an icon-only Cloudflare Access logout at
  `/cdn-cgi/access/logout` with an accessible name and title, so the header
  carries identity rather than an account menu.
- **Command palette:** opened by the search trigger or `CMD+K` / `CTRL+K`. It
  indexes page commands plus an allowlisted projection from seven existing
  resource list endpoints, fetched in batches of at most three so it cannot
  exhaust the dashboard's per-principal concurrency budget, and bounded to 200
  entries per source and 50 rendered matches. It covers only the first page of
  each paginated resource, which the dialog states outright. Secret values,
  secret descriptions, and knowledge content are never indexed — `GET
  /api/v1/knowledge` returns full item content, so Knowledge keeps its own
  page-level search. Combobox/listbox semantics with `aria-activedescendant`;
  focus never leaves the input. Owners: `renderPaletteResults` in
  `dashboard-render.js`, and the index build, ranking, and batching in
  `dashboard.js`. `Escape`, the visible search trigger, and a tap or click on
  the backdrop all dismiss it (`dismissOnBackdrop` also ignores a drag that
  starts inside the dialog).
- **Navigation:** left icon+label rail, grouped by concern (Runtime,
  Configuration, Observability, Account) with an Overview home. Active item gets
  the amber rail + soft fill. The rail is **fixed to the viewport below the top
  bar and scrolls internally**, so a long navigation list never pushes the page
  or hides entries; the rail foot carries the running **server version** outside
  that scroll and hides it when the rail collapses to icons. A chevron control
  collapses the rail to icons on desktop (toggling `.app-shell.nav-collapsed`);
  it also collapses to icons on tablet and to a drawer on mobile. The version is
  labelled "Server version" rather than "Release" because production runs the
  pre-version-bump commit, so the readout legitimately lags the newest tag by one
  release. Owners: [`apps/api/src/version.ts`](../apps/api/src/version.ts) for the
  value, [`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts)
  for the injection.
- **Overview:** monospace metric tiles (corner-bracketed) capped at four above
  the fold, a recent-activity feed, an Access panel, and a Server panel. Tiles
  and feed aggregate client-side from allowlisted endpoints; the Server panel
  reads `GET /api/v1/server`, a read-only projection of config and status that
  exposes no owner ID, runner URL, token, or secret.
- **Tables:** rounded hairline container, uppercase column headers, row hover,
  tabular numerals, `nowrap` timestamps; collapse to stacked cards on mobile.
- **MCP Servers:** the section lists a principal's downstream MCP servers with
  transport, status, cached tool count, last connected, and enabled state, and
  offers add, edit, enable/disable, Test, Refresh tools, delete, and a detail
  view with Overview / Tools / Permissions / Logs. Its gateway card shows the one
  copyable `/mcp-gateway` endpoint, names the credential lane the endpoint
  actually accepts (owner bearer or Access session), states that the managed
  API-key lane is not yet available, and lists the two hard limitations an
  operator hits first: HTTP redirects are refused, and `stdio` downstream
  servers are unsupported. Owners: `renderMcpGatewayCard` and
  `renderMcpServersIndex` in `dashboard-render.js`, and the MCP server routes in
  [`apps/api/src/dashboard-gateway-router.ts`](../apps/api/src/dashboard-gateway-router.ts).
- **Interaction states:** every control ships default / hover / `:focus-visible`
  / active / disabled; touch targets >= 44px (small controls expand their hit
  area via `::before`); inputs >= 16px.
- **Footer:** the shell ends every route with one global footer crediting
  AgentKit (`https://agentkit.best`). It is authored once in the shell rather
  than per page, so a new view inherits it automatically.

## Security in the UI

Never render runner tokens, owner IDs, container names, workspace paths,
provider credentials, or secret values. Secret references are write-only. API
keys are shown once and never persisted in the DOM or storage. Escape every
attacker-influenceable value.

## Changing the design

Edit `dashboard.css` (and the dashboard JS/render only when structure must
change). Keep the contract tokens and rules the UI test asserts, run
`npx vitest run apps/api/test/dashboard-*.test.ts`, then `npm run verify`, and
re-check both light and dark themes plus 375px in a browser before shipping.
