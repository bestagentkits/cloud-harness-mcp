---
phase: 5
title: "Documentation and verification"
status: completed
priority: P2
effort: "3h"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Documentation and verification

## Goal

`docs/design-guidelines.md` and the official docs site describe the HUD design
system and its intentional deviations, and the full repository gate passes.

## Files to Create / Modify

- Modify: `docs/design-guidelines.md`
- Modify: `docs-site/dashboard/index.md` (only if it makes a visual claim that is
  now wrong)
- Modify: any `docs-site/dashboard/*.md` file that shows or describes dashboard
  chrome changed by this work

## Background the executor needs

`AGENTS.md` requires that user- or operator-visible changes update **both**
`docs/` and `docs-site/`. The design-guidelines document owns the *why* and
`apps/api/dashboard/dashboard.css` owns the *what*, so the document must not copy
token values or rule inventories. Point at the executable owners instead.

The document currently says the register is "product, not marketing" and the
accent is "safety-amber". Both statements are now wrong and must be replaced, not
quietly left. This is the highest-value part of the phase: a design document that
contradicts the stylesheet is worse than no document.

## Tasks & Steps

### Task 5.1 — Rewrite the design-guidelines direction and color sections

- **Goal:** The document describes the HUD system accurately and explains why it
  deviates from the marketing source where it does.
- **Target files and symbols:** `docs/design-guidelines.md`, the `## Direction`,
  `## Color`, and `### Adaptive dark theme` sections.
- **Steps:**
  1. Rewrite `## Direction` so it states that the dashboard now **shares the
     marketing site's design system** (`site/index.html`, `site/haas.html`) rather
     than deliberately diverging from it. Keep the industrial "mission control"
     register and the density dial, but drop the "not marketing" contrast, which
     no longer holds. Record the source of truth as the two marketing pages and
     name `site/styles.css` as explicitly out of scope.
  2. Rewrite `## Color` to describe: a dark-first HUD ramp, cyan as the single
     accent, green/amber/purple/red as hue-separated semantics, and the `--info`
     tier added in this work. Delete the "safety-amber" description and the
     "amber is never body text on a light surface" rule, which no longer applies.
     State the accent budget (under ~10% of any surface) and that brackets and the
     active rail are cyan.
  3. Rewrite the `### Adaptive dark theme` section to say dark is the authoring
     base and light is the companion, with the two light paths
     (`:root[data-theme="light"]` and `@media (prefers-color-scheme: light)`) kept
     byte-identical and asserted by
     `apps/api/test/dashboard-design-tokens.test.ts`. Keep the existing
     server-side cookie explanation unchanged.
  4. Do not paste token values, hex codes, or OKLCH numbers into the document.
     Describe the strategy and point at `dashboard.css`.
- **Success criteria:** no sentence in the document still calls the accent amber
  or positions the dashboard against the marketing register.
- **Verify:** `grep -in 'amber\|not marketing' docs/design-guidelines.md` returns
  only the intentional `--warning` mention, if any, and no claim that the accent
  is amber.

### Task 5.2 — Document the constraints and deviations

- **Goal:** The four things the dashboard cannot copy from marketing, and why,
  are recorded where the next maintainer will look.
- **Target files and symbols:** `docs/design-guidelines.md`, the
  `## Hard constraints (do not violate)` and `## Typography` sections, plus a new
  `## Deviations from the marketing source` section.
- **Steps:**
  1. Extend `## Hard constraints` with the two constraints that actually shape
     this work, stated as what is enforced rather than as an aspiration:
     - **No external assets, no web fonts, no inline styles.** Enforced by
       `apps/api/test/dashboard-ui-contract.test.ts` after Phase 1 Task 1.6 adds
       the `@font-face` / `@import` / `url(` / `style=` assertions, and by the CSP
       delivered on the dashboard document. The CSP header is set by
       `dashboardSecurity` in `apps/api/src/dashboard-router.ts`, which runs first
       on the router mounted at `/dashboard`, so it covers the document and the
       CSS/JS assets even though `createDashboardAssetsRouter()` itself sets only
       `Cache-Control`. Phase 1 Task 1.6 pins that with a header assertion.
     - **OKLCH only.** Enforced by the existing hex and `gradient(` assertions in
       the same test file.
  2. Add a `## Deviations from the marketing source` section listing exactly these
     four items, each with a one-line reason and no token values:
     - **No grid or glow backdrop.** Marketing builds it from gradients; the UI
       contract test rejects `gradient(`. The HUD reads through hairlines, corner
       brackets, and mono type instead.
     - **No web fonts.** Marketing uses JetBrains Mono and Plus Jakarta Sans; the
       CSP forbids `font-src`. The native `--font-sans` / `--font-mono` stacks
       carry the same weight, case, and tracking treatment.
     - **Light-theme accent and status values differ.** The marketing light hexes
       fail WCAG AA as pill and button text. The dashboard uses the same hues,
       darkened and chroma-clamped, and the numbers are asserted by
       `apps/api/test/dashboard-design-tokens.test.ts`.
     - **Light surfaces keep a three-step ramp.** Marketing uses flat white for
       panel and card; dense tables need a visible header and hover surface.
  3. In `## Typography`, keep the existing "native stack, stated exception"
     framing and add that the marketing display weight is 600-800 with tight
     tracking on headings and wide tracking on uppercase labels.
- **Success criteria:** the four deviations are each documented with a reason and
  no raw colour values.
- **Verify:** `grep -c 'Deviations from the marketing source' docs/design-guidelines.md`
  prints `1`, and `grep -cE '#[0-9a-f]{3,8}' docs/design-guidelines.md` prints
  `0`.

### Task 5.3 — Update the "Changing the design" instructions

- **Goal:** The change procedure names the new gates.
- **Target files and symbols:** `docs/design-guidelines.md`, the
  `## Changing the design` section.
- **Steps:**
  1. Keep the existing instruction to edit `dashboard.css` and run the dashboard
     tests plus `npm run verify`.
  2. Add that a colour change must be re-verified by
     `apps/api/test/dashboard-design-tokens.test.ts`, and that a spacing change
     must keep every `--space-*` step on the 4px rhythm asserted by
     `apps/api/test/dashboard-ui-contract.test.ts`.
  3. Add that both light blocks must be updated together.
- **Success criteria:** the section names both new tests.
- **Verify:** `grep -c 'dashboard-design-tokens' docs/design-guidelines.md` prints
  at least `1`.

### Task 5.4 — Check the official docs site for stale visual claims

- **Goal:** `docs-site/dashboard/` does not describe chrome that no longer exists.
- **Target files and symbols:** `docs-site/dashboard/*.md`.
- **Steps:**
  1. Read every file under `docs-site/dashboard/`.
  2. Search the whole `docs-site/` tree for descriptions of dashboard colours,
     the word "amber", theme behaviour, or screenshots that show the old palette.
  3. The already-identified stale claims are:
     - `docs-site/dashboard/profile.md:38` — "**Light:** High-contrast cool
       concrete industrial theme." The light companion is no longer a concrete
       industrial theme; it is the HUD light companion.
     - `docs-site/dashboard/profile.md:39` — "**Dark:** Tinted graphite console
       theme." Dark is now a near-black HUD ramp, not tinted graphite.
     - `docs-site/dashboard/profile.md:34-42` — the whole `## Theme & Appearance`
       block describes the three modes. Keep the three modes and the server-side
       cookie explanation, which are still accurate, and correct only the two
       colour descriptions. State that dark is the default when the OS expresses
       no preference, so an operator is not surprised by the change.
     - `docs-site/dashboard/index.md:21` — mentions the theme control cycling
       System, Light, and Dark and persisting server-side. This remains true;
       change nothing.
  4. There are no screenshots checked into `docs-site/public/`, so there is no
     image to regenerate. If your search finds an image reference, follow it and
     report it before changing anything.
  5. If a page is accurate, change nothing. Do not invent content, add design
     documentation to the user guide, or duplicate `docs/design-guidelines.md`.
- **Success criteria:** no `docs-site/` page states a colour, theme default, or
  accent that contradicts the implemented CSS.
- **Verify:**

  ```bash
  grep -rin 'amber\|safety-amber' docs-site/ ; echo "exit=$?"
  ```

  Every hit is either corrected or is a genuine reference to the `--warning`
  semantic hue, and you can state which for each hit.

### Task 5.5 — Run the full verification gate

- **Goal:** The repository gate passes on the final tree.
- **Target files and symbols:** no source changes; this is the gate.
- **Steps:**
  1. Run the narrow dashboard suites first.
  2. Run `npm run verify`.
  3. Run `npm run docs:build` as well. `npm run verify` is
     `plugin:check && lint && typecheck && test && build` and contains **no docs
     step**, so a broken `docs-site/dashboard/*.md` edit merges green locally and
     fails only in CI, where the docs gates run as separate steps. This phase
     edits `docs/` and `docs-site/`, so run the docs build here.
  4. If the change touched only CSS, tests, and docs,
     `npm run verify:compose` is not required; do not run it unless a Compose file
     or network boundary changed.
  5. Do not weaken any assertion, timeout, or cleanup check to make a gate pass.
     If a gate fails for a pre-existing or environmental reason, record the exact
     failure and report it rather than editing around it.
- **Success criteria:** the gate exits 0, or the only failures are documented as
  pre-existing and unrelated with the exact error text.
- **Verify:** `npx vitest run dashboard` exits 0, then `npm run verify` exits 0,
  then `npm run docs:build` exits 0.

## Verification

- `npx vitest run dashboard` exits 0, covering all five dashboard UI suites:
  `dashboard-ui-contract.test.ts`, `dashboard-ui-behavior.test.ts`,
  `dashboard-design-tokens.test.ts`, `knowledge-dashboard-ui.test.ts`, and
  `mcp-servers-dashboard-ui.test.ts`.
- `npm run verify` exits 0.
- `grep -rn 'safety-amber' docs/ docs-site/` prints nothing.
- `git diff --stat` shows only `apps/api/dashboard/dashboard.css`,
  `apps/api/test/dashboard-*.test.ts`, `docs/design-guidelines.md`, and any
  corrected `docs-site/` page.

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
