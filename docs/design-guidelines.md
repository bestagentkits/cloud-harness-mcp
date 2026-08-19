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

The default follows `prefers-color-scheme`; a **system / light / dark** control
in the top bar lets an operator force a theme. Client storage is forbidden, so
the choice persists **server-side, not in the browser**: `PUT
/api/v1/preferences` (CSRF-guarded) sets an HttpOnly `ch-dashboard-theme`
cookie, and the shell handler injects `html[data-theme]` on first paint so a
forced theme never flashes. The client only reads that DOM attribute. Owners:
[`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts) and
[`apps/api/src/dashboard-assets.ts`](../apps/api/src/dashboard-assets.ts).

Dark is a tinted graphite, not black: surfaces **elevate by lightening**
(`--canvas` -> `--surface` -> `--surface-raised`), the amber accent is
**brightened** so it stays legible, and shadows deepen. Both themes are verified
at WCAG AA: body text and muted text >= 4.5:1, primary-button text and status
pills pass against their actual backgrounds, and the focus ring is >= 3:1
against its surface.

## Depth, shape, motion

- **One depth strategy:** hairline borders (`--line`, `--line-strong`). Floating
  layers only (dialogs, mobile drawer, toasts) carry a tinted shadow. No
  ghost-card border+shadow combos.
- **One radius scale:** `--radius-sm/-md/-lg`; tight, never over-rounded.
- **Motion:** transition only `color`, `background-color`, `border-color`,
  `transform`, `box-shadow`; never `transition: all`; every animation has a
  `prefers-reduced-motion` off-ramp. Skeletons over spinners.

## Components

- **Top bar:** sticky header carrying the wordmark + `MCP Control Plane` tag,
  the theme control, a profile chip (name, email, initials avatar), and Sign
  out (Cloudflare Access logout at `/cdn-cgi/access/logout`).
- **Navigation:** left icon+label rail, grouped by concern (Runtime,
  Configuration, Observability, Account) with an Overview home. Active item gets
  the amber rail + soft fill. A chevron control collapses the rail to icons on
  desktop (toggling `.app-shell.nav-collapsed`); it also collapses to icons on
  tablet and to a drawer on mobile.
- **Overview:** monospace metric tiles (corner-bracketed) capped at four above
  the fold, a recent-activity feed, an Access panel, and a Server panel. Tiles
  and feed aggregate client-side from allowlisted endpoints; the Server panel
  reads `GET /api/v1/server`, a read-only projection of config and status that
  exposes no owner ID, runner URL, token, or secret.
- **Tables:** rounded hairline container, uppercase column headers, row hover,
  tabular numerals, `nowrap` timestamps; collapse to stacked cards on mobile.
- **Interaction states:** every control ships default / hover / `:focus-visible`
  / active / disabled; touch targets >= 44px (small controls expand their hit
  area via `::before`); inputs >= 16px.

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
