# Phase 2 (issue #220, Phase 1): shared resource-page layout and CRUD dialogs

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-2`
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-02-resource-page-interaction.md`

## Summary

Every global resource page now opens with the same shape: the page title and help
come from the page registry, exactly one primary action sits in the shell's action
slot beside the heading, an optional filter row follows, and then the resource
list. Creation flows moved off the page body into described dialogs, and
identifiers became copy affordances instead of labels.

Phase 1 of 12 for #220. This PR does not close the epic.

## What changed

- `renderResourcePage`, `renderPrimaryAction`, `renderSecondaryAction`,
  `renderFormDialog`, `renderCopyChip`, `renderModelsActions`, `renderGitHubActions`
  and `renderMcpActions` in `apps/api/dashboard/dashboard-render.js`.
- `#page-actions` slot in the shell header, cleared on every page change so a page
  cannot inherit the previous page's button.
- `setPageActions`, `bindDialogOpeners` (native `<dialog>` open/close with invoker
  focus restore) and `bindCopyAffordances` in `dashboard.js`, wired once per render.
- Projects, Global Secrets, Artifacts and API Access: the permanent create form
  under each list is gone; each page has a dialog with the effect description, a
  cancel affordance and a live status line. The form element ids are unchanged, so
  the existing bindings and contract tests stay the single description of each
  mutation.
- Global secret rotate/description forms collapse into a per-row disclosure
  instead of always-visible inline forms.
- Models & Budgets contributes `Add profile` (primary) and `Add credential`
  (secondary) to the action slot; MCP contributes `Add MCP server`; GitHub
  contributes `Reconcile installation` (plain action, since GitHub's own primary
  path is the setup form in the body).
- Identifiers, generations and hashes render as copy chips with live-region
  feedback.
- `dashboardNavigationPath` + `navigateTo` become the single navigation seam: a
  target outside `/dashboard` is refused, so a rendered value cannot become an
  off-site redirect. All 15 previous `location.href` assignments route through it.
- `docs/design-guidelines.md` documents the resource-page layout, the
  one-primary-action rule, the dialog rule and the navigation seam.

## Verification

- `npx vitest run dashboard` — 17 files, 253 tests, all passing.
- New `apps/api/test/dashboard-resource-page.test.ts` covers: one accented action
  per page, creation forms living inside their dialogs, dialog labelling and
  cancel affordance, copy-chip escaping, the navigation allowlist, and the empty
  states naming the next action.
- `npx eslint apps/api/dashboard apps/api/src/dashboard-assets.ts apps/api/test` — clean.
- Analyzer findings reported against `dashboard.js` (`innerHTML`, `JSON.parse`,
  `new URL`) are pre-existing and unchanged by this phase: `innerHTML` 5 in
  `origin/main` and 5 here, `JSON.parse` 1/1, `new URL` 10/10.

## Follow-up defect found by browser QA (fixed in the same phase)

Browser QA of the merged phase-2 PR caught a wiring defect that the unit tests
could not see: the primary action did not open its dialog. The openers were bound
with a query scoped to `#content`, while the primary action renders into the
shell's action slot (`#page-actions`) — outside that scope — so
`dialogOpenAfterClick` was `false` and focus stayed on `main`. The fix delegates
dialog opening once on the document (`openDialog` + a delegated click listener)
and keeps only dismissal bound per render, since the `close` event does not
bubble. Browser QA after the fix: `openAfterClick: true`, focus on `project-name`,
invoker recorded, cancel affordance present. A source-level regression guard now
asserts the delegation shape, and the copy-affordance binding covers the action
slot as well.

## Operator-visible result

- No page makes you scroll past a create form to reach the list.
- Each page states one next action, and dangerous actions stay separated with
  confirmation.
- Copying an id or hash is one click with feedback, and ids are no longer labels.
