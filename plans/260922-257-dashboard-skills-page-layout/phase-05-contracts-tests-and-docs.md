---
phase: 5
title: "Pin the new structure in tests and bring the documentation in step"
status: completed
priority: P1
effort: "2-3h"
dependencies: [4]
---

# Phase 5: Contracts, tests, and documentation

## Goal

The four load-bearing layout decisions fail the build if they regress, the page's state logic is
covered, and both the internal design guidelines and the user guide describe the page that exists.

## Tasks

1. Extend the `renders every skills selector the UI contract names` case in
   `apps/api/test/dashboard-ui-contract.test.ts:143` with the new ids: `skills-library-empty`,
   `skills-library-empty-message`, `skills-library-empty-action`, `skill-detail-title`,
   `skill-detail-close`, `skill-editor-title`.
2. Add one contract case pinning the four structural decisions that the old code got wrong:
   - `#skills-library-cards` has a base `display: none` rule and a mobile-breakpoint `display: grid`
     rule, so the library cannot render twice on desktop again;
   - `.skills-tabs` styles the active tab through `[aria-selected="true"]`;
   - `.skills-toolbar` declares its own grid, so it does not inherit the global form flex rule;
   - `#skill-detail[hidden]` and `.skills-panel[hidden]` resolve to `display: none`, so an author
     `display` rule cannot defeat the `hidden` attribute.
3. Extend `apps/api/test/dashboard-skills-ui.test.ts` with the state logic: an empty library hides the
   table and cards and shows the empty block; a library whose rows are all filtered out shows the
   no-match message and the clear-filters action; a populated library leaves the block hidden. Keep the
   existing `renderSkillsLibraryRows([])` and `renderSkillsLibraryCards([])` assertions untouched.
4. Extend `apps/api/test/dashboard-ui-behavior.test.ts` for the close control and the two empty-state
   actions.
5. Update `docs/design-guidelines.md` under Components: state the Skills page's own layout rules — the
   labelled filter grid, the tab strip keyed on `aria-selected`, the in-flow drawer with a heading and a
   close control — and correct the table/card paragraph, which currently claims the pairing works when
   the hiding rule was missing.
6. Update `docs-site/dashboard/skills.md`: the library's empty and no-match states, and the detail
   panel's heading and close control. Also correct the stale sentence claiming the import wizard's
   submit is "deliberately not wired": `dashboard.js:1367-1390` wires `#skill-import-submit` to a real
   `POST /skill-imports` with polling, so the guide understates what the page does.
7. Run the full gate.

## Success criteria

- `npm run verify` passes: plugin check, lint, typecheck, full vitest, build.
- The contract test fails if any of the four structural decisions in step 2 regress.
- The two documents describe the page that shipped, and no longer assert behavior the code does not have.

## Verification

```bash
npx vitest run apps/api/test/dashboard-skills-ui.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts apps/api/test/dashboard-design-tokens.test.ts
npm run verify
```
