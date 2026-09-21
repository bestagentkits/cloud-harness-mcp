# Dashboard design guidelines

Design system for the Cloud Harness operator dashboard. This document owns the
**why**; [`apps/api/dashboard/dashboard.css`](../apps/api/dashboard/dashboard.css)
owns the **what** (every token and rule). The static UI contract is enforced by
[`apps/api/test/dashboard-ui-contract.test.ts`](../apps/api/test/dashboard-ui-contract.test.ts).

## Direction

The dashboard shares the **marketing site's design system**: the
"Cyber-Engineering HUD" declared by `site/index.html` and `site/haas.html`. Those
two pages are the palette source of truth. `site/styles.css` is **not** part of
it — only the policy pages link it — and nothing here derives from it.

- **Register:** product (a tool an operator must trust), rendered in the HUD's
  visual language. Bar is earned familiarity and legibility, not novelty.
- **Voice:** industrial / utilitarian "mission control" console. Calm, dense,
  instrument-grade.
- **Dials:** variance 3, motion 2, density 7. State-conveying motion only
  (150-250ms); no page-load choreography.
- **Memorable element:** cyan corner-bracket frames on the framed surfaces
  (metric tiles, command toolbar), echoed by the cyan active-rail on the
  navigation. The brackets were amber before this became a HUD system; only the
  hue changed, not the grammar.

## Deviations from the marketing source

The HUD is shared, but four things cannot be copied literally. Each is a
constraint, not a preference:

- **No grid or glow backdrop.** The landing page builds its grid and radial glow
  from `linear-gradient` / `radial-gradient`, and the UI contract test rejects
  `gradient(`. The HUD reads instead through hairlines, cyan corner brackets, and
  monospace type.
- **No web fonts.** Marketing uses JetBrains Mono and Plus Jakarta Sans; the CSP
  has no `font-src`. The native `--font-sans` and `--font-mono` stacks carry the
  same treatment: 700-800 display weight with tight tracking on headings, and wide
  tracking with uppercase on labels, table headers, and status pills.
- **Light-theme accent and semantic values are darker than the marketing hexes.**
  The marketing light accents fail AA as pill and button text (measured: green
  3.06:1, red 4.01:1, amber 4.27:1, white-on-cyan 4.09:1). The dashboard keeps the
  same hues, darkened and chroma-clamped into the sRGB gamut, and the numbers are
  asserted by the contrast test.
- **Light surfaces keep a three-step ramp** (white / near-white / muted) rather
  than marketing's flat white for both panel and card, because dense tables need a
  visible header and hover surface.

One more consequence worth stating: the `-line` family is opaque here, while
marketing tints its borders. See the `-soft` / `-line` split under Color.

## Hard constraints (do not violate)

- **No web fonts, no external assets, no inline styles.** The dashboard document
  is served under a strict CSP set by `dashboardSecurity` in
  `apps/api/src/dashboard-router.ts`: no `font-src`, so no self-hosted or web
  fonts, and no external assets, `style=` attributes, or storage. All styling
  lives in `dashboard.css`; behavior in the dashboard JS. The contract test
  asserts the absence of `@font-face`, `@import`, `url(`, and `style=`. One limit
  worth knowing: that middleware runs on the router mounted at `/dashboard`, which
  sits after `accessAssertionAuth` in `apps/api/src/app.ts`, so an unauthenticated
  401 from a dashboard path carries no CSP or `X-Frame-Options`.
- **OKLCH only.** No hex colors and no `gradient()` anywhere (the UI contract
  test rejects both). Note that CSS composites alpha on the encoded channel
  values, so a translucent tint over a near-black canvas is far darker than it
  looks on paper.
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

- **Strategy:** dark-first HUD. The `:root` base is the marketing ramp — a
  near-black canvas, a blue-tinted panel and card ramp, and the HUD accent. The
  accent is used only for the primary action, active nav, selection, focus, and
  the corner brackets, and stays under ~10% of any surface.
- **Cyan is the single accent.** `--accent` is the **fill** token: button and tab
  backgrounds, brackets, borders, the focus ring. `--accent-strong` is the
  **text** token for links and emphasis. The bare `--accent` must never be used as
  a `color`, because as text it cannot reach AA on the light surfaces; the
  contrast test asserts that no `color: var(--accent)` exists at all.
- **Semantic hues are separated from the accent:** success green, warning amber,
  danger red, and an **info** tier (violet) for neutral in-progress states.
  Status is a pill with a leading dot. Amber survives only as `--warning`; it is
  no longer the accent.
- **`-soft` is a translucent fill; `-line` is an opaque border.** This split is
  load-bearing. `-soft` tints sit behind text and always pair with an opaque text
  colour or border. `-line` draws brackets, borders, and underlines, and must stay
  opaque: a translucent cyan line measures about 1.5:1 over the canvas and the
  brackets would effectively disappear. The contrast test asserts the whole
  `-line` family has no alpha component.
- **One gray family**, brand-tinted toward the console's cool blue.

### Adaptive dark theme

Dark is the **authoring base**: `:root` holds the dark HUD palette, mirroring
`site/index.html`'s `<html data-theme="dark">` foundation. Light is a companion
declared **twice**, because CSS cannot share one token set across a media query:
`:root[data-theme="light"]` for the forced choice and
`@media (prefers-color-scheme: light) { :root:not([data-theme]) { ... } }` for
`system`. Both blocks must be edited together, and
[`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts)
asserts that their declaration sets are identical.

A single **icon control** in the top bar cycles system → light → dark; `system`
is represented by an absent `html[data-theme]`, so the media query governs again.
The four cases therefore all resolve: no attribute on a dark-preference machine
renders the base; no attribute on a light-preference machine renders the light
companion; and a forced `light` or `dark` always wins, because the media query is
scoped to `:root:not([data-theme])`. The control is deliberately **not**
`aria-pressed` — that attribute describes two states and this control has three,
so the accessible name states the current state and the next action instead.
Client storage is forbidden, so the choice persists **server-side, not in the
browser**: `PUT /api/v1/preferences` (CSRF-guarded) sets an HttpOnly
`ch-dashboard-theme` cookie, and the shell handler injects `html[data-theme]` on
first paint so a forced theme never flashes. The client only reads that DOM
attribute. Owners: the cycle state machine in `dashboard.js` and the injection in
[`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts).

Both themes are verified at WCAG AA by
[`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts):
body and muted text >= 4.5:1, primary-button text and every status pill pass
against their actual composited backgrounds, accent emphasis text passes on every
surface it lands on, and the accent line and focus ring clear 3:1. The light
accent and semantic values are deliberately darker and chroma-clamped relative to
the raw marketing light hexes, because those fail AA as pill and button text.

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

- **Data tables:** a dense table is paired with a card list of the same rows, and
the table carries `desktop-table`, which the mobile breakpoint hides. The Skills
library follows this rule: its five columns cannot fit 375px, and a table that
overflows the viewport is worse than a list that does not. Both renderings carry
the same controls and both are wired, so the visible one is never the only
working one.
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
- **Navigation:** left icon+label rail, grouped by operator intent — **Home**
  (Overview), **Operate** (Workspaces, Audit), **Configure** (Projects, Secrets,
  Models & Budgets, Skills, Integrations), **Data** (Knowledge, Artifacts), and
  **Admin** (API Access, Settings). Active item gets the cyan rail + soft fill.
  `Audit` keeps a rail slot only until the Activity Center owns an Audit tab;
  `Agents`, `Activity`, and `Approvals` join **Operate** when those pages ship.
  Profile deliberately has **no** rail slot: the top-bar profile chip and the
  command palette are its entry points. GitHub and MCP Servers are not rail
  entries either — they are tabs of the single **Integrations** page at
  `/dashboard/integrations`, with `/dashboard/github` and `/dashboard/mcp-servers`
  kept as redirects and `/dashboard/mcp-servers/:serverId` still serving a
  server's detail view. The rail is **fixed to the viewport below the top
  bar and scrolls internally**, so a long navigation list never pushes the page
  or hides entries; the rail foot carries the running **server version** outside
  that scroll and hides it when the rail collapses to icons. A chevron control
  collapses the rail to icons on desktop (toggling `.app-shell.nav-collapsed`);
  it also collapses to icons on tablet and to a drawer on mobile. The version is
  labelled "Server version" rather than "Release" because production runs the
  pre-version-bump commit, so the readout legitimately lags the newest tag by one
  release. Owners:
  [`apps/api/dashboard/dashboard-pages.js`](../apps/api/dashboard/dashboard-pages.js)
  owns page identity, route, label, group, heading, help, icon and palette
  membership, and the sidebar is rendered from it rather than authored in
  `index.html`; [`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts)
  owns the shell path allowlist, the legacy redirects and the version injection,
  and `apps/api/test/dashboard-pages.test.ts` asserts the two lists stay in
  parity.
- **Overview and route ownership:** `/dashboard` **is** the Overview, and the
  workspace index lives at `/dashboard/workspaces`; `/dashboard/overview`
  redirects to `/dashboard`. Every other page keeps its existing path so links
  and bookmarks survive the reorganisation. Client route matching resolves
  through the page registry, and detail routes (`/dashboard/workspaces/:id`,
  `/dashboard/projects/:id`, `/dashboard/knowledge/:id`,
  `/dashboard/mcp-servers/:id`) stay owned by the page whose rail entry must
  remain current.
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
`npx vitest run dashboard`, then `npm run verify`, and re-check both light and
dark themes plus 375px in a browser before shipping.

Three extra gates apply to specific kinds of change:

- **A colour change** must be re-verified by
  [`apps/api/test/dashboard-design-tokens.test.ts`](../apps/api/test/dashboard-design-tokens.test.ts),
  which asserts every text, pill, emphasis, accent-line, and focus pair in both
  themes. If you touch a `-line` token, keep it opaque; if you touch a `-soft`
  token, keep it translucent.
- **A spacing change** must keep every `--space-*` step a member of the marketing
  scale, which the contract test asserts.
- **A light-theme change** must be applied to **both** light blocks. They are
  duplicated because CSS cannot share a token set across a media query, and the
  contrast test fails if they diverge.
