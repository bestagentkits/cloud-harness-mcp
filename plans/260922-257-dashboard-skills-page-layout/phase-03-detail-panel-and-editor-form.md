---
phase: 3
title: "A detail panel that names the open skill and closes, and an editor that reads as a form"
status: completed
priority: P1
effort: "3-4h"
dependencies: [2]
---

# Phase 3: Detail panel and editor form

## Goal

Opening a skill shows a framed panel that names that skill and can be dismissed, and the create/edit
form presents its fields as a form rather than as a line of collisions.

## Evidence

- `#skill-detail` carries `class="drawer"`, which has no rule in `dashboard.css`.
- `openSkillDetail()` sets `drawer.hidden = false` (`apps/api/dashboard/dashboard.js:1225-1228`), and
  the skeleton places `#skill-detail` inside the library panel between the card list and the editor
  form. With no rule it is a bare block in the page flow, carrying four unlabelled containers.
- Nothing renders a `.drawer-close` element, although the rule is declared
  (`dashboard.css:476`) and pinned by the contract test. The panel therefore has no close control.
- `#skill-editor` is a `<form>`, so the global flex rule at `dashboard.css:294` puts
  `Create a custom skill`, `Slug`, `Display name`, and `Instructions` on one baseline row while
  `textarea { width: 100%; min-height: 12rem }` (`dashboard.css:415`) makes the textarea full-bleed.
  That is the second crammed line in the screenshot.

## Tasks

1. Give `#skill-detail` a heading and a close control: add `<h3 id="skill-detail-title">` and
   `<button type="button" id="skill-detail-close" class="drawer-close">Close</button>` to the skeleton,
   and turn the four containers into labelled sections (`Instructions`, `Files`, `Revisions`, `Usage`)
   with `<h4>` headings. Keep `#skill-detail-instructions`, `#skill-detail-files`,
   `#skill-detail-revisions`, `#skill-detail-usage`, and `#skill-detail-edit` intact.
2. In `openSkillDetail()`, set `#skill-detail-title` from the resolved skill in `rows`, so the panel
   names what is open. Use the display name with the slug as the mono secondary line.
3. Wire `#skill-detail-close` to set `drawer.hidden = true` and clear `editingSkillId`, returning the
   editor to create mode. This is the missing counterpart to `drawer.hidden = false`.
4. Add the `.drawer` rules: a framed in-flow surface (hairline border, `--radius-md`, `--space-4`
   padding, `--surface`), with a header row that keeps the close control at the end and a `[hidden]`
   guard.
5. Restructure `#skill-editor`: keep the `<h3>`, wrap the slug and display-name pairs in
   `<div class="skills-form-row">` as a two-column grid, leave the instructions textarea full width on
   its own row, and put the submit button and `#skill-editor-status` in
   `<div class="skills-form-actions">`. Add `#skill-editor { display: grid; gap: var(--space-3); }` so
   the global flex rule no longer applies, with labels above controls.
6. Make the form title state its mode honestly: `Creating a custom skill` by default, and
   `Add a revision to <slug>` when the panel is editing. Update it wherever `editingSkillId` is set:
   in the `#skill-detail-edit` handler and in `openSkillDetail()`, plus the reset on close.

## Constraints

- No shadow on `.drawer`. `docs/design-guidelines.md` reserves shadows for floating layers, and this
  panel is in the flow.
- `#skill-editor` must not become a second primary action. The base rule
  `button[type="submit"]:not(.danger)` already styles exactly one primary per view, and the editor
  submit is that primary. Do not add `.accent-btn` to it.

## Success criteria

- Clicking a skill name opens a framed panel that names the skill; `Close` hides it and the editor
  returns to create mode.
- The editor shows slug and display name side by side with instructions beneath, and no label shares a
  row with an unrelated control.
- The submit button and the status line sit in one footer row.

## Verification

```bash
npx vitest run apps/api/test/dashboard-skills-ui.test.ts apps/api/test/dashboard-ui-contract.test.ts apps/api/test/dashboard-ui-behavior.test.ts
```

Plus new assertions for `#skill-detail-title`, `#skill-detail-close`, `#skill-editor-title`, and the
`.drawer` / `#skill-editor` rules.
