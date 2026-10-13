---
phase: 1
title: "Library renders each row once, and its empty states are honest"
status: completed
priority: P1
effort: "2-3h"
dependencies: []
---

# Phase 1: Library visibility and states

## Goal

The library renders each skill exactly once at every breakpoint, and the page distinguishes "the
library is empty" from "your filters match nothing" instead of printing one sentence twice.

## Evidence

- `renderSkillsSkeleton()` ships both a table and a card list for the same rows
  (`apps/api/dashboard/dashboard-render.js:905-906`).
- Only `.desktop-table` is hidden at the mobile breakpoint (`apps/api/dashboard/dashboard.css:600`);
  `.card-grid` is `display: grid` at every width and has no hiding rule anywhere.
- Every other table/card pair in the dashboard pairs its table with `<ul class="mobile-list">`, whose
  base rule is `display: none` (`dashboard.css:329`) —
  `dashboard-render.js:87, 1756, 1823, 1872`.
- The production screenshot shows "No skills yet. Import one from Discover, or create a custom skill."
  twice, which is the table row and the card list item rendering side by side.

## Tasks

1. Add one empty block to `renderSkillsSkeleton()` after the table and the card list:
   `<div id="skills-library-empty" class="empty" hidden>` containing
   `<p id="skills-library-empty-message">` and
   `<button type="button" id="skills-library-empty-action">`.
2. Leave `renderSkillsLibraryRows([])` and `renderSkillsLibraryCards([])` unchanged. Their empty
   strings are asserted by `apps/api/test/dashboard-skills-ui.test.ts:44-56`, and they remain the honest
   fallback if the block is ever bypassed.
3. In `loadSkills().paintLibrary()`, toggle from the data after computing `visible`:
   - `rows.length === 0` → hide table and cards, show the block with
     "No skills yet. Import one from Discover, or create a custom skill." and the action
     `Discover skills`.
   - `rows.length > 0 && visible.length === 0` → hide table and cards, show the block with
     "No skills match the current filters." and the action `Clear filters`.
   - otherwise → show table and cards per breakpoint, hide the block.
4. Wire the two actions once, beside the existing tab wiring: `Discover skills` calls
   `tabController.select('discover')`. `Clear filters` resets `query`, `providerFilter`, `stateFilter`,
   `tagFilter`, and `sortKey` together with the four control values, then repaints.
5. In `dashboard.css`, add the base/mobile pair beside the existing `.mobile-list` rule:
   `#skills-library-cards { display: none; }` at base and
   `#skills-library-cards { display: grid; }` inside `@media (max-width: 47.9375rem)`.

## Constraints

- Repainting must never dispatch an event, or repopulating the controls would re-enter the filter
  handlers and discard the operator's filter. Set `value` directly; `Clear filters` is the only path
  that resets filter state on purpose.
- Do not introduce a `mobile-list` class on the card list. Its `li` rule adds a second border, and the
  cards already use `li.panel`. The id-scoped rule is the smaller, more explicit change.

## Success criteria

- On a desktop viewport each skill appears once, and an empty library shows one sentence.
- On a phone the table is hidden and the cards carry the rows.
- A filter matching nothing says so, and `Clear filters` restores the full list.

## Verification

```bash
npx vitest run apps/api/test/dashboard-skills-ui.test.ts apps/api/test/dashboard-ui-behavior.test.ts
```

Plus a new contract assertion that `#skills-library-cards` has a base `display: none` rule and a
mobile-breakpoint `display: grid` rule.
