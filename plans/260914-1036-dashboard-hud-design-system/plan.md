---
title: "Dashboard HUD design system: marketing parity + UI/UX repair"
description: "Retokenize the operator dashboard onto the marketing site's live HUD design system (dark-first, cyan accent) and repair the spacing, input, border, focus, and state defects the audit finds."
status: completed
priority: P1
effort: 2d
issue: 193
tags: [frontend, refactor, feature]
blockedBy: []
blocks: []
created: 2026-09-14
branch: mrgoonie/update-dashboard-ui
---

# Dashboard HUD design system: marketing parity + UI/UX repair

## Outcome

The operator dashboard at `apps/api/dashboard/` renders in the same visual
language as the live marketing site (`site/index.html` and `site/haas.html`).
Dark is the base rendering theme with a light companion, cyan is the single
accent, and status semantics map onto the marketing green / amber / purple /
red. In the same pass, the UI/UX audit defects listed in Phase 4 are repaired:
spacing rhythm, input sizing, border and radius consistency, focus visibility,
target sizes, and missing interaction states.

## Source of truth

The **live** marketing pages are `site/index.html` and `site/haas.html`. Both are
self-contained and share one token set: their `:root` blocks declare the same
fourteen colour tokens, differing only in that `site/haas.html` adds
`--purple-dim`, which the dashboard does not need. `site/styles.css` is **not**
the marketing system: only
`privacy.html`, `terms.html`, and `support.html` link it, and the prior plan
`plans/260914-1342-landing-light-theme-toggle/plan.md` records it as "not linked
by the live pages". Nothing from `site/styles.css` is used.

## How it works

1. `:root` in `apps/api/dashboard/dashboard.css` becomes the dark HUD palette:
   the marketing ramp is declared once as the raw source layer (`--void`,
   `--panel`, `--card`, `--hud-cyan`, ...) converted from the marketing hexes to
   OKLCH, and the existing semantic names the UI contract test asserts
   (`--canvas`, `--surface`, `--ink`, `--accent`, `--space-4`, `--motion-state`)
   alias onto it. No component rule is rewritten to a new token name.
2. The light companion is declared twice - as `:root[data-theme="light"]` for the
   forced choice and as `@media (prefers-color-scheme: light) :root:not([data-theme])`
   for `system` - exactly the two-path shape the shell already supports.
   The four resolution cases must all be correct: no attribute on a dark-OS
   machine renders the base dark palette; no attribute on a light-OS machine
   renders the light companion through the media query; `data-theme="light"`
   renders light even on a dark-OS machine; `data-theme="dark"` renders dark even
   on a light-OS machine, because the media query is scoped to
   `:root:not([data-theme])`. `apps/api/src/dashboard-assets.ts` is unchanged:
   `system` keeps meaning "no `data-theme` attribute", so the operator still gets
   a working system / light / dark cycle persisted by the existing server-side
   cookie.
3. Component rules consume only the semantic layer, so surfaces, borders,
   typography, and the corner brackets reskin without DOM changes. The DOM
   contract in `apps/api/test/dashboard-ui-contract.test.ts` (landmarks, single
   `<h1>`, dialogs, nav labels, `role="search"` count) is untouched.

## Hard constraints

These are non-negotiable and are asserted by
`apps/api/test/dashboard-ui-contract.test.ts`:

- **No web fonts, no external assets, no inline styles.** Enforced by
  `apps/api/test/dashboard-ui-contract.test.ts` after Phase 1 Task 1.6 adds the
  `@font-face` / `@import` / `url(` / `style=` assertions, so the marketing fonts
  (JetBrains Mono, Plus Jakarta Sans) cannot ship. One limit on the CSP claim:
  the header is set by `dashboardSecurity` in
  `apps/api/src/dashboard-router.ts`, which is registered on the router mounted at
  `/dashboard`, but that router sits **after** `accessAssertionAuth` in
  `apps/api/src/app.ts:76-78`. An authenticated dashboard document therefore
  receives the CSP, while an unauthenticated 401 from the same path is emitted
  before the middleware runs and carries no CSP or `X-Frame-Options`. Asserting
  the header needs a forged Cloudflare Access JWT, which is out of proportion for
  a CSS reskin, so that assertion is deferred and the gap recorded as a follow-up
  rather than assumed away.
- **OKLCH only.** The contract test rejects `#rrggbb` and rejects `gradient(`.
  Every marketing hex is converted; the landing page's grid/glow backdrop is not
  portable and is deliberately dropped.
- **DOM is a contract.** Preserve landmarks, the single `<h1>`, dialogs, nav
  labels, and the required CSS tokens/rules.

## Design decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Marketing HUD palette is the source; values are converted to OKLCH | Hex is contract-banned. The conversion is verified by round-tripping each value back to its source hex. |
| D2 | Dark is the authoring base in `:root`; light is the companion override | Matches `site/index.html` (`<html data-theme="dark">`, dark base, `[data-theme="light"]` override) and keeps the 3-state toggle meaningful. `system` still honours the OS, exactly as the marketing boot script does: on a light-preference machine an operator with no stored choice gets the light companion, while a forced `dark` always wins because the media query is scoped to `:root:not([data-theme])`. |
| D3 | Cyan is the single accent; amber survives only as `--warning` | 1:1 with the marketing token set. The amber mission-control corner brackets become cyan. |
| D4 | The marketing grid/glow backdrop is **not** ported | It is built from `linear-gradient`, which the contract test bans. The HUD reads through hairlines, brackets, and mono type instead. |
| D5 | Marketing typefaces are carried by the native stacks | CSP forbids `font-src`. Same treatment (700/800 display weight, tight tracking, uppercase labels), different face. |
| D6 | Light-theme accent and status values are darkened and chroma-clamped | The marketing light hexes fail WCAG AA as pill text (measured: green 3.06:1, red 4.01:1, amber 4.27:1, white-on-cyan 4.09:1). Solved values below hold >= 4.5:1. |
| D7 | Light surfaces keep a three-step ramp instead of marketing's flat white | Dense tables need a visible `thead`/hover surface. Marketing's white-on-white works for a landing page, not a data grid. |
| D8 | `-line` tokens stay **opaque**; only `-soft` tokens are translucent | Marketing draws borders with translucent tints (`--border-soft`, `--border-hud`). Compositing `oklch(0.870 0.148 202.9 / .20)` over the HUD canvas measures **1.47:1**, because CSS composites alpha in encoded sRGB, which would make the corner brackets, the detail-pane border, and every link underline effectively disappear. The `-line` family keeps today's opaque lightness with the marketing hue, so border visibility never regresses, and `--accent-line` is darkened in light mode to clear the 3.0 floor. |

## Verified color math

Every value below was computed with an sRGB <-> OKLCH implementation and checked
for WCAG 2.x contrast, gamut, and hex round-trip. The dark column uses the
marketing alphas (`cyan .12/.20`, semantic `.12`).

| Pair | Dark (base) | Light (companion) | Min | Result |
| --- | --- | --- | --- | --- |
| ink on canvas | 20.06 | 15.89 | 4.5 | pass |
| ink on surface | 19.27 | 17.84 | 4.5 | pass |
| ink-muted on canvas | 8.20 | 6.74 | 4.5 | pass |
| ink-muted on surface | 7.88 | 7.56 | 4.5 | pass |
| on-accent on accent | 14.32 | 5.02 | 4.5 | pass |
| success on success-soft | 6.95 | 4.50 | 4.5 | pass |
| warning on warning-soft | 8.08 | 4.50 | 4.5 | pass |
| danger on danger-soft | 4.91 | 4.52 | 4.5 | pass |
| info on info-soft | 4.64 | 4.51 | 4.5 | pass |
| accent vs canvas | 14.90 | 4.47 | 3.0 | pass |
| accent-line vs canvas | 4.58 | 3.20 | 3.0 | pass |
| focus vs surface | 14.32 | 5.02 | 3.0 | pass |
| ink on accent-soft | 15.73 | 15.33 | 4.5 | pass |

Read each column against its own background: the dark column is measured on the
dark canvas and the light column on the light canvas, using the values the Phase
1 token block declares, not the raw marketing hexes. The light accent reaches
4.47:1 on the light canvas and 5.02:1 against white, which is why it can carry
white button text and still clear the 3.0 non-text floor.

Light-theme solved values: `--accent: oklch(0.539 0.128 242)`,
`--success: oklch(0.513 0.129 154.1)`, `--warning: oklch(0.541 0.145 49)`,
`--danger: oklch(0.542 0.221 27.3)`, `--info: oklch(0.558 0.271 293)`.

These numbers become a real regression test in Phase 1; they are not prose.

**Pre-existing defects found while measuring.** Both are fixed by this work, so
the reskin is also an accessibility repair, not only a hue change:

1. `.wikilink:hover` uses the bare `--accent` as **text**, which at today's amber
   values measures **2.83:1** on `--surface` and **2.99:1** on `--accent-soft`,
   against a 4.5 requirement. Every other text pair in the stylesheet already
   passes, including the status pills. Phase 1 Task 1.2 routes that hover onto
   `--accent-strong`, and the new test asserts the stylesheet contains no
   `color: var(--accent);` at all, which makes the fill/text split mechanical
   rather than a convention.
2. Today's light `--accent-line` measures **2.28:1** against the light canvas and
   **2.56:1** against the light surface, below the 3.0 non-text floor, so the
   light-theme corner brackets, detail border, and link underlines are already
   under-contrast. The light `--accent-line` value above clears it.

The semantic `-line` tokens are deliberately **not** held to 3.0. They only draw
a status-pill border, and the pill carries its state in its text label and
leading dot, so the border is not the information required to identify the state.
They keep today's lightness, and Phase 1 documents that so a later maintainer
does not "fix" them by distorting the palette.

## Goals

| # | Goal | Priority |
| --- | ------ | ---------- |
| 1 | The dashboard palette, typography, surfaces, and borders derive from the live marketing HUD design system | P1 |
| 2 | Dark is the base theme; `system` / `light` / `dark` all render the HUD correctly with no flash | P1 |
| 3 | Every text, status-pill, control, and focus-ring pair meets WCAG AA in both themes, asserted by a test | P1 |
| 4 | The Phase 4 UI/UX defect list is repaired (spacing, inputs, borders, radius, focus, targets, states) | P1 |
| 5 | `docs/design-guidelines.md` and `docs-site/dashboard/` describe the new system; `npm run verify` passes | P2 |

## Phases

| # | Phase | Status |
| --- | ------- | -------- |
| 1 | [Phase 1: Token foundation and contrast gate](./phase-01-token-foundation.md) | Pending |
| 2 | [Phase 2: Typography and surface language](./phase-02-typography-and-surfaces.md) | Pending |
| 3 | [Phase 3: Component reskin](./phase-03-component-reskin.md) | Pending |
| 4 | [Phase 4: UI/UX audit and repair](./phase-04-ux-audit-repair.md) | Pending |
| 5 | [Phase 5: Documentation and verification](./phase-05-docs-and-verification.md) | Pending |

## Success Criteria

- [ ] `apps/api/dashboard/dashboard.css` declares the marketing HUD ramp in
      OKLCH, with a source comment naming `site/index.html` / `site/haas.html`.
- [ ] `:root` renders the dark HUD palette; both the `:root[data-theme="light"]`
      block and the `@media (prefers-color-scheme: light)` block render the light
      companion.
- [ ] `--accent` is cyan (hue ~203 dark, ~242 light); the corner brackets and
      active nav rail are cyan; `--warning` is the only surviving amber.
- [ ] A new contrast test proves AA for the pairs in the table above in both
      themes, and fails if any value regresses.
- [ ] `apps/api/test/dashboard-ui-contract.test.ts` passes unmodified except for
      additive assertions.
- [ ] Every Phase 4 defect has a before/after note and a passing check.
- [ ] No `#rrggbb`, no `gradient(`, no `url(` / `@font-face` / `@import`, no
      inline `style=` — each asserted by the contract test.
- [ ] `npx vitest run dashboard` (all five dashboard UI suites), `npm run lint`,
      `npm run typecheck`, and `npm run verify` pass.
- [ ] `docs/design-guidelines.md` describes the HUD system and its deviations;
      `docs-site/dashboard/` is checked for stale visual claims.

## Non-goals

- Restructuring the shell DOM, adding new pages, or changing any BFF route,
  API call, or authorization behavior.
- Adding the marketing telemetry bar, marquee, or animated diagrams.
- Touching `site/` (marketing), `docs-site/` theme CSS, or `site/styles.css`.
- Changing the theme persistence mechanism, cookie name, or `PUT /api/v1/preferences`.
- Introducing a build step, CSS preprocessor, or design-token pipeline.

## Risks

| Risk | Mitigation |
| --- | --- |
| Removing the amber accent breaks the "mission-control" identity the guidelines describe | The bracket and rail grammar is preserved; only the hue changes. `docs/design-guidelines.md` is updated in Phase 5 so the doc and the CSS never disagree. |
| Contract test has brittle substring assertions | All changes are additive to the token layer; the existing token names are kept as aliases. Phase 1 runs the contract test as its first gate. |
| Cyan-on-near-black is high contrast but can read as "neon" in a dense table | Cyan is capped to primary action, active nav, focus, selection, and brackets; semantic status stays green/amber/red/purple. |
| Dark-first changes what existing operators see on load | It is the requested behavior (D2). `system` still follows the OS, and the cookie path is untouched, so a light preference persists. |
| A component reskin silently breaks a render template | Found during verification: `apps/api/test/dashboard-ui-behavior.test.ts:500`, `:501`, and `:725` assert exact `class="..."` strings, and `apps/api/test/mcp-servers-dashboard-ui.test.ts:140-147` asserts `data-mcp-*` hooks. Phase 4 Task 4.5 now forbids renaming or removing any class, and every phase verifies with the broad `npx vitest run dashboard` glob instead of a `dashboard-*.test.ts` pattern that would miss two of the five suites. |
| Assuming the current light accent already passes | Measured at 2.83-2.99:1 as text and 2.28:1 as a border line. Phase 1's values fix both and the new test asserts the floors. |
| Marketing's translucent borders vanish over the HUD canvas | Measured `oklch(... / .20)` at **1.47:1** over the canvas, so the corner brackets, the detail border, and every link underline would disappear. Decision D8 keeps the whole `-line` family opaque, and the Phase 1 test asserts that every `-line` token carries no alpha component. |
| An unauthenticated dashboard 401 carries no security headers | Found while writing the header assertion: `dashboardSecurity` runs after `accessAssertionAuth` (`apps/api/src/app.ts:76-78`), so a 401 emitted before it has no CSP or `X-Frame-Options`. Pre-existing and out of scope for a CSS reskin. Recorded as a follow-up rather than fixed or hidden; the plan no longer claims the header is verified. |
| Deleting the positional submit rule demotes unmarked submits | Found by the red team: roughly twenty `<button type="submit">` controls carry no class, so removing `button[type="submit"]:not(.danger)` would have made privileged confirmations look identical to their adjacent Cancel button. Phase 3 Task 3.1 now **keeps** that rule, adds `.accent-btn` alongside it for `type="button"` and anchors, and marks the two privilege-relevant submits explicitly. |
| A new semantic tier ships with no consumer | Found by the red team: nothing emitted an `info` class, and `MCP_STATUS.connecting` was painted with the amber warning palette. Phase 2 Task 2.4 now maps `connecting` to `info`, which fixes a wrong status colour and gives `--info` a real consumer. `.toast.info` was dropped because no caller passes a toast kind. |
| The artifact Download control is dead | Found during review: the anchor at `dashboard-render.js:56` points at `/api/v1/artifacts/.../download`, but the route lives under the `/dashboard` mount, there is no `/api/v1` mount and no ingress rewrite, so it 404s. Phase 3 Task 3.1 fixes the href while styling that same control. |

## Validation Log

### Verification Results

- Claims checked: 20
- Verified: 19 | Failed: 1 (partial) | Unverified: 0
- Tier: Full — an independent fact-check pass plus three hostile lenses
  (Security Adversary, Assumption Destroyer, Failure Mode Analyst), each in a
  fresh read-only context, plus the author's own measurement pass.
- **Corrected by the fact-check pass:** the claim that `site/index.html` and
  `site/haas.html` have identical `:root` blocks is false — `site/haas.html`
  alone declares `--purple-dim`. Fixed in **Source of truth**. The light
  `accent vs canvas` figure was measuring the raw marketing hex rather than the
  declared token (3.64 → 4.47).
- **Corrected by the author's measurement pass:** the light-theme blocks were
  referenced by two different selectors (`html[…]` vs `:root[…]`), now
  standardized on `:root[data-theme="light"]`; `--space-5` (20px) is a 4px
  multiple and was misdescribed as off-grid rather than absent from the named
  marketing step list; several file and line ranges had drifted; and one planned
  verify command used GNU-only `\|` alternation, which prints `0` under BSD
  `grep` and would have produced a spurious gate failure.

### Whole-Plan Consistency Sweep

Re-read after the accepted findings were applied. Every changed decision is
reflected in all four places that carried it: the token block, the Phase 1 test
steps, the token table in this file, and the tasks that consume the tokens.
Specifically: `-line` is opaque in the token block, asserted opaque in Task 1.1
step 9, described as opaque in D8 and the risk table, and left untouched in
Phase 2. The `.wikilink:hover` fix is in Phase 1 Task 1.2 and asserted in Task 1.1
step 7. The positional submit rule is preserved in Phase 3 Task 3.1 and no longer
referenced anywhere as deleted. `--info` is wired to `MCP_STATUS.connecting` in
Phase 2 Task 2.4, and no phase adds `.toast.info`. No unresolved contradictions
remain.

## Red Team Review

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | HIGH | Task 1.1's "fail first for exactly these reasons" gate was unsatisfiable: it required extracting two light blocks that do not exist today, and the stated red-state failures did not match the measurements. | **Accepted.** Task 1.1 now asserts the two light blocks as an explicit precondition that fails, uses a non-throwing extractor that returns an empty Map, and names the four real pre-state failures. |
| 2 | HIGH | Two different selectors were used for the same light block, so the test's extraction key and the CSS the executor is told to write could not both be satisfied. Same seam: Task 3.4 told the executor to nest `dialog::backdrop` inside the token blocks, which a `\{([^}]*)\}` extractor would truncate. | **Accepted.** Standardized on `:root[data-theme="light"]` across all files, the test now asserts both blocks were found and are non-empty, and Task 3.4 emits the backdrops as separate top-level rules. |
| 3 | HIGH | The light `--accent` ships as 14px text as low as 4.25:1 while the plan's 3.0 assertion blessed the failing pair, and the plan's claim that "every text pair already passes" was false. | **Accepted and strengthened.** `.wikilink:hover` moves to `--accent-strong`; the test now asserts `--accent-strong` at 4.5 against five backgrounds and asserts the stylesheet contains no `color: var(--accent);` at all; and the false claim is replaced with the measured 2.83-2.99:1 defect. |
| 4 | HIGH | Deleting `button[type="submit"]:not(.danger)` would silently demote roughly twenty unclassed submit buttons, including two privilege-relevant confirmations, and no gate would notice. | **Rejected the deletion, accepted the fix.** Task 3.1 keeps the positional rule as the default primary and adds `.accent-btn` alongside it as the explicit override for `type="button"` and anchors, plus explicit `accent-btn` on `#submit-bulk-import` and `Save permissions`. |
| 5 | HIGH | The corner brackets, detail border, and link underlines consume `--accent-line`, not `--accent`, so asserting `--accent` at 3.0 was vacuous — and the marketing 20% alpha yields 1.47:1, making them nearly invisible. | **Accepted.** Decision D8 keeps every `-line` token opaque with measured values; the test asserts `--accent-line` at 3.0 and asserts the whole `-line` family has no alpha component. |
| 6 | MEDIUM | Phase 1 → Phase 2 atomicity: flipping `:root` to dark turns `.knowledge-graph-container`'s `background: var(--canvas)` inside a `.panel` into a pure-black box until Phase 2 fixes it. | **Accepted.** The one-line background fix moves into Phase 1's scope via the token-layer task ordering, and Phase 2 still verifies it. |
| 7 | MEDIUM | `--info` and `.status.info` would have shipped with no consumer, in the same change that deletes `.sticky-actions` and `--text-20` for being dead. `MCP_STATUS.connecting` was painted with the warning palette. | **Accepted.** Phase 2 Task 2.4 maps `connecting` to `info`. `.toast.info` was dropped after confirming no caller passes a toast kind. |
| 8 | MEDIUM | Task 4.5's target-file list still named `index.html`, `dashboard-render.js`, and `dashboard.js` while its own steps forbade changing them. | **Accepted.** Target list narrowed to `dashboard.css` and the contract test, with the DOM-contract files explicitly out of scope. |
| 9 | MEDIUM | `--space-5` was described as off-grid when 20px is a 4px multiple; only set equality catches it. | **Accepted.** X1 restated as "absent from the marketing step list", and Task 4.6 notes that the whole-number check alone would still pass. |
| 10 | CRITICAL (contested) | The Security Adversary claimed the plan's load-bearing CSP premise is false because `createDashboardAssetsRouter()` sets no CSP. | **Partially accepted, framing rejected.** The premise holds: `dashboardSecurity` is registered first on the same `/dashboard` mount (`apps/api/src/dashboard-router.ts:67`) and calls `setHeader` before `next()`, so the document and assets do receive the CSP. The reviewer reasoned about which router serves the response and missed the header-setting middleware chain. The valid part — that **no test asserts it** and fonts/inline styles are unasserted — is accepted: Task 1.6 adds both, and the constraint wording no longer implies enforcement that does not exist yet. |
| 11 | P2 | `npm run verify` contains no docs step, so a broken `docs-site/` edit passes locally and fails only in CI. | **Accepted.** Phase 5 Task 5.5 now runs `npm run docs:build`. |
| 12 | P2 (out of lens) | The artifact Download anchor's href lacks the `/dashboard` prefix and 404s. | **Accepted.** Independently confirmed against `app.ts:77`, `dashboard-control-router.ts:64`, `dashboard-api.js:10`, and the absence of any ingress rewrite. Phase 3 Task 3.1 fixes it. |

### Whole-Plan Consistency Sweep (red team)

No stale references remain: no phase still instructs deleting the positional submit
rule, adding `.toast.info`, asserting `--accent` at 3.0 as a bracket proxy,
nesting rules inside token blocks, or editing the DOM-contract files in Phase 4.
All accepted findings were propagated to every file that carried the original
claim.

## Open questions

None. The four blocking decisions (design source, default theme, accent mapping,
scope depth) were confirmed by the owner before planning.
