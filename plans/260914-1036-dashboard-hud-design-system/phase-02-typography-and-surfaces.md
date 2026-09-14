---
phase: 2
title: "Typography and surface language"
status: completed
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: Typography and surface language

## Goal

The dashboard's type treatment, hairlines, corner brackets, elevation, and
radius scale read as the marketing HUD: uppercase mono labels, tight display
headings, hairline borders with no border-plus-shadow cards, and cyan brackets.

## Files to Create / Modify

- Modify: `apps/api/dashboard/dashboard.css` (the base element rules, the
  `/* Shell */`, `/* Top header */`, `/* Corner-bracket framed surfaces */`,
  `/* Toolbar */`, `/* Overview */`, `/* Tables */`, `/* Panels & records */`
  sections)

## Background the executor needs

Phase 1 has landed the token layer. This phase changes **only** rules below the
token blocks. Read `site/index.html` lines 100-400 to see the marketing
treatment you are matching: hairline `1px solid var(--border-soft)` separators,
uppercase mono labels with wide tracking, display headings with tight tracking,
and small radii.

Two marketing techniques are **not portable** and must not be added:

- The grid and radial-glow page backdrop is built from `linear-gradient` and
  `radial-gradient`. The UI contract test rejects `gradient(`. Do not add any
  gradient.
- The marketing faces (JetBrains Mono, Plus Jakarta Sans) are web fonts. The
  dashboard CSP is `default-src 'none'` with no `font-src`. Keep the native
  `--font-sans` and `--font-mono` stacks and carry the *treatment* instead.

Marketing radii measured from `site/index.html`: 4px is dominant, then 8px, 6px,
and 3px. The `--radius-*` scale from Phase 1 already matches; use it and do not
introduce one-off `px` radii.

## Tasks & Steps

### Task 2.1 — Base element and document typography

- **Goal:** Body, headings, links, and inline code carry the HUD voice.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the `html`,
  `body`, `p`, `a`, `h1, h2, h3`, and `pre`/`code` rules.
- **Steps:**
  1. In `html`, set `color-scheme` from the theme blocks only; do not restate it
     here. Keep `background: var(--canvas)`, `color: var(--ink)`,
     `font-family: var(--font-sans)`, `font-size: var(--text-14)`,
     `line-height: 1.5`, and `scrollbar-gutter: stable`.
  2. Add a shared display treatment to `h1, h2, h3`: keep
     `font-family: var(--font-display)`, and add
     `font-weight: 700; line-height: 1.1; letter-spacing: -.01em;`. Keep
     `text-wrap: balance`.
  3. Change the inline `code` treatment so unclassed `code` uses
     `font-family: var(--font-mono)`, `font-variant-numeric: tabular-nums`, and
     `background: var(--code-bg); color: var(--code-ink); border-radius: var(--radius-sm); padding: .0625rem var(--space-1);`.
  4. Confirm the link rule already uses `text-decoration-color: var(--accent-line)`
     and `a:hover { color: var(--accent-strong) }`. Leave the shape, do not add a
     gradient or background.
- **Success criteria:** `h1, h2, h3` carry weight 700 and the new letter-spacing;
  unclassed `code` is mono on `--code-bg`.
- **Verify:** `grep -n 'font-weight: 700; line-height: 1.1; letter-spacing: -.01em' apps/api/dashboard/dashboard.css`
  prints one line.

### Task 2.2 — Hairline surface language and bracket hue

- **Goal:** Every framed surface uses one hairline border, one radius scale, and
  cyan corner brackets; floating layers are the only ones with a shadow.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `/* Corner-bracket framed surfaces */`, `.metric`, `.panel`,
  `.command-surface`, `.desktop-table`, `dialog`, `.toast` rules.
- **Steps:**
  1. In the corner-bracket rule, keep the geometry
     (`width: .6875rem; height: .6875rem; border: 2px solid var(--accent-line)`)
     and keep `--accent-line`, which Phase 1 aliased to cyan. Do not hardcode a
     colour.
  2. Audit every rule that sets both a `border` and a `box-shadow` on the same
     non-floating element. Remove the `box-shadow` from the non-floating one.
     The only elements allowed `--shadow-overlay` are `dialog`, `.toast`, and the
     mobile `.sidebar`/`.detail` overlays, which are already correct; leave them.
  3. Replace the one-off shadow on `.graph-controls` (`var(--shadow-raise)`) with
     a `border: 1px solid var(--line-strong)` and no shadow, because it sits
     inside a panel and is not a floating layer. Keep its positioning.
  4. Change `.knowledge-graph-container` background from `var(--canvas)` to
     `var(--surface-raised)` so a panel interior does not drop to the page
     canvas. Keep the border and radius.
  5. Change every `border-radius: var(--radius-pill)` on a rectangular control to
     `var(--radius-sm)`. Do this for `.knowledge-tab-btn`, `.mcp-tab-btn`, and
     `.relevance-badge`.
     Keep `--radius-pill` only on `.avatar`, `.status::before`, and
     `.sidebar nav a[aria-current]::before`, which are circular or a rail. Phase 4
     later moves `.lifecycle li::before` from `border-radius: 50%` onto
     `var(--radius-pill)` as well, which is why the final count is five and not
     four; the point of the assertion is that no **rectangular** control carries a
     pill radius.
  6. `.metric` and `.command-surface` already use `--radius-md`; confirm
     `.panel`, `.desktop-table`, `.empty`, `pre`, `.mobile-list li`, and
     `.file-list`/`.runtime-list` all use `--radius-md` and
     `1px solid var(--line-strong)`. Fix any that use `--radius-lg` on a
     non-dialog surface to `--radius-md`.
- **Success criteria:** no non-floating rule pairs a border with a shadow; tab
  buttons are `--radius-sm`; the graph container uses a raised surface.
- **Verify:** `grep -c 'radius-pill' apps/api/dashboard/dashboard.css` prints
  exactly `5`: the `:root` declaration plus the four legitimately circular or rail
  uses (`.sidebar nav a[aria-current]::before`, `.avatar`, `.status::before`, and
  the `.lifecycle li::before` dot that Phase 4 moves off `border-radius: 50%`).
  Rectangular controls must not appear in that list.

### Task 2.3 — Consolidate the duplicated mobile media query

- **Goal:** One `@media (max-width: 47.9375rem)` block instead of two.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the two
  `@media (max-width: 47.9375rem)` blocks.
- **Steps:**
  1. Merge the two blocks into a single block placed after the tablet block.
     Keep every declaration from both.
  2. Preserve the existing exact substring
     `.drawer-close { display: block; margin-inline-start: auto; margin-block-end: var(--space-4); }`
     and the exact substring
     `@media (max-width: 47.9375rem)`; the contract test asserts both.
  3. Preserve `.command-surface[hidden], .form-row[hidden] { display: none; }`
     exactly; the contract test asserts that substring.
- **Success criteria:** the file contains exactly one
  `@media (max-width: 47.9375rem)` block.
- **Verify:** `grep -c '@media (max-width: 47.9375rem)' apps/api/dashboard/dashboard.css`
  prints `1`, and `npx vitest run apps/api/test/dashboard-ui-contract.test.ts`
  exits 0.

### Task 2.4 — Table and data typography

- **Goal:** Tables and figures use the HUD mono/tabular treatment.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `/* Tables */` and `/* Status pills */` sections.
- **Steps:**
  1. Keep `thead th` at `text-transform: uppercase`, `letter-spacing: .07em`,
     and add `font-family: var(--font-mono)` and `font-size: var(--text-11)`.
  2. Keep `table { font-variant-numeric: tabular-nums }`.
  3. Keep `caption` mono + uppercase.
  4. In `.status`, keep the `1px solid` border, `--radius-sm`, the leading dot,
     and the mono uppercase label. Confirm the `active`, `reaping`, `expired`,
     and `failed` variants consume `--success`/`--warning`/`--danger` and their
     `-soft`/`-line` partners, which Phase 1 re-pointed at the HUD hues.
  5. Add a new `.status.info` variant that mirrors the `.status.active` shape but
     uses `--info-soft`, `--info`, and `--info-line`.
  6. Make `.status.info` **reachable**, or do not add it. Today nothing emits an
     `info` class, so the rule would be dead on arrival in the same change that
     deletes `.sticky-actions` and `--text-20` for being dead. The real defect is
     in the MCP status map: `dashboard-render.js:648-656` maps connection states
     through `MCP_STATUS`, and `:650` currently reads
     `connecting: { label: 'Connecting', className: 'reaping' },`, which paints a
     neutral in-progress state with the amber **warning** palette. Change it to
     `connecting: { label: 'Connecting', className: 'info' },`.
     This is the only behaviour-adjacent change authorised in this plan: a status
     class swap with no payload, route, or `data-*` change. It is safe because
     `apps/api/test/mcp-servers-dashboard-ui.test.ts:97` asserts only
     `mcpStatusLabel('connecting')` is `'Connecting'`, and no test anywhere
     asserts `status reaping` — confirm with
     `grep -rn 'reaping' apps/api/test/`, which must print nothing.
  7. Do not add a `.toast.info` rule. Phase 3 records why, and adding one here
     would reintroduce the dead-rule problem.
- **Success criteria:** `thead th` is mono; a `.status.info` rule exists;
  `MCP_STATUS.connecting.className` is `'info'`.
- **Verify:** `grep -c '.status.info' apps/api/dashboard/dashboard.css` prints at
  least `1`, `grep -c "className: 'info'" apps/api/dashboard/dashboard-render.js`
  prints `1`, and `npx vitest run dashboard` exits 0.

## Verification

- `npx vitest run dashboard` exits 0. That glob covers all five dashboard UI
  suites, including `dashboard-ui-behavior.test.ts` and the two
  `*-dashboard-ui.test.ts` files that a `dashboard-*.test.ts` pattern misses.
- `grep -c 'gradient(' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -cE '#[0-9a-f]{3,8}' apps/api/dashboard/dashboard.css` prints `0`.
- `npm run lint` exits 0.

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
