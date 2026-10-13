---
phase: 2
title: "A readable tab strip and a labelled filter grid"
status: completed
priority: P1
effort: "2-3h"
dependencies: [1]
---

# Phase 2: Tab strip and filter bar

## Goal

The four tabs read as a tab strip with an unmistakable active tab, and the library filters read as
labelled fields on a shared grid instead of a single crammed baseline row.

## Evidence

- `form { display: flex; align-items: end; flex-wrap: wrap; gap: var(--space-3); }`
  (`apps/api/dashboard/dashboard.css:294`) is the global form rule. `.skills-toolbar` is a `<form>`, so
  every label and control becomes a sibling on one wrapping, end-aligned row. This is the mechanism
  behind the screenshot line reading `Search [input] Provider [Any] State [Any] Tag [input] Sort [Name]`.
- `.skills-tabs` has zero rules in `dashboard.css`, so `role="tablist"` renders as adjacent buttons with
  no active state.
- The tab controller already maintains `aria-selected` and `tabindex`
  (`apps/api/dashboard/dashboard.js:477-480`), so the state CSS needs is already in the DOM and no JS
  change is required for the active style.

## Tasks

1. Wrap each label+control pair in the library filter form in `<div class="skills-field">`, so the pair
   is one grid cell. Preserve every id: `skills-library-search`, `skills-library-provider`,
   `skills-library-state`, `skills-library-tag`, `skills-library-sort`. Keep `role="search"` and
   `aria-label="Filter skills"`.
2. Add `.skills-tabs` rules: a horizontal wrapping strip with a hairline bottom rule; a tab that reads
   as a control rather than a filled button; an active state keyed on `[aria-selected="true"]` using
   `--accent` for the underline and `--accent-strong` for the text; a hover state that leaves the focus
   ring intact.
3. Add `.skills-panel` rules: top spacing and a consistent vertical rhythm, plus a `[hidden]` guard so
   an author `display` rule cannot defeat the `hidden` attribute. This is the same failure the codebase
   already documents for `.command-surface[hidden]` at `dashboard.css:289-293`.
4. Add `.skills-toolbar` rules: `display: grid` with
   `grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr))`, labels above controls, and
   `.skills-field { display: grid; gap: var(--space-1); }`. Give the search field the widest share so
   the field order reads search-first.
5. Add `.skills-bulk-bar` rules: a bounded strip carrying the count and the two actions in a row, using
   the translucent accent-soft selection language rather than a new one.

## Constraints

- `--accent` is the fill token and must never be used as a `color`; `--accent-strong` is the text token.
  The contrast test in `apps/api/test/dashboard-design-tokens.test.ts` asserts no
  `color: var(--accent)` exists.
- No hex, no `gradient(`, no `@font-face`, no `url(`. The UI contract test rejects all four.
- Every new spacing value must be an existing `--space-*` token; the contract test asserts the scale is
  exactly `1,2,3,4,6,8` on the 4px rhythm.

## Success criteria

- One aligned row of labelled fields at wide widths, two columns at tablet width, one column on a phone.
- The active tab is visually unmistakable, and the strip keeps its focus ring.
- A panel with `hidden` stays hidden, and the tab strip never shows a scrollbar for four tabs.

## Verification

```bash
npx vitest run apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-design-tokens.test.ts
npm run lint
```

Plus new contract assertions pinning `.skills-tabs` (active state keyed on `aria-selected`) and
`.skills-toolbar` being a grid rather than the inherited form flex.
