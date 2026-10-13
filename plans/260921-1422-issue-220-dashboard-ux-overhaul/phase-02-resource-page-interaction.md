---
phase: 2
title: "Common resource-page layout and CRUD interaction model (issue Phase 1)"
status: completed
priority: P1
effort: "1-1.5d"
dependencies: [1]
---

# Phase 2: Common resource-page layout and CRUD interaction model

Issue phase: **Phase 1**.

**Status: completed.** Shipped in PR #227 with its follow-up fix in PR #228.
Verification: `npx vitest run dashboard` 17 files / 254 tests green, eslint clean,
new `dashboard-resource-page.test.ts` layout contract, browser QA of the action
slot, dialog focus, invoker restore and copy affordances. Browser QA caught a
wiring defect in the merged PR (the primary action opened nothing because openers
were bound inside the content container); the fix delegates dialog opening on the
document and adds a regression guard. Evidence:
`plans/reports/vibe-260921-1452-issue-220-phase-2-resource-pages.md`.

## Goal

Every global resource page opens with the same shape — page title, one primary
action, a short contextual description, filter/search controls, then the resource
list — and create/edit flows move into dialogs or drawers built from the helpers
that already exist in the shell. Operators stop scrolling past permanent create
forms to reach the list they came for.

## Target surfaces

`Projects`, `Global Secrets`, `Artifacts`, `API Access` (`/dashboard/api-keys`),
`Integrations`, and `Models & Budgets` (`/dashboard/models`).

## Reused machinery (do not rebuild)

- `announce(message)` and `toast(message, kind)` — `apps/api/dashboard/dashboard.js:928-933`.
- `confirmAction({title, description, target, label, pendingLabel, action}, invoker)`
  — destructive confirmation with invoker focus restore.
- Existing `<dialog>` + `showModal()` flows (provider credential dialog
  `dashboard.js:1647`, profile dialog `1730`) and `submitForm(form, pendingLabel, action, onSuccess)`.
- `requestBody(...)` / `api(path, options)` for CSRF-guarded mutations.
- Renderers in `apps/api/dashboard/dashboard-render.js` (`renderProjectIndex`,
  `renderGlobalSecrets`, `renderArtifactIndex`, `renderApiKeyIndex`,
  `renderModelsPage`).
- Server routes: `apps/api/src/dashboard-control-router.ts` (`project_*`,
  `global_secret_*`, `artifact_*`, `model_*`, `github_*`, `mcp` operations).

## Tasks

1. **Shared page shell.** Add one renderer (`renderResourcePage({title, help,
   primaryAction, filters, body})` in `dashboard-render.js`) and use it on all six
   pages. Keep `#page-title` / `#page-help` owned by the registry (Phase 1).
2. **Primary action.** Each page exposes exactly one visually dominant action;
   opening it renders a dialog form. Lists no longer contain permanent create
   forms below the rows.
3. **Dialogs and drawers.** Move Projects (create/rename), Global Secrets
   (create/rotate/description), Artifacts, API Access (create/revoke), Models &
   Budgets (credential + profile), and Integrations (connect/disconnect) into
   dialogs or drawers. Reuse the existing focus-management pattern: focus the
   first field on open, restore focus to the invoker on close, `Esc` closes, and
   the dialog is `aria-labelledby` its heading.
4. **Danger separation.** Destructive actions keep `confirmAction(...)`, stay
   visually separated from the primary action, and keep their pending labels.
5. **Feedback.** Every mutation announces through `announce(...)` (live region)
   and shows a toast; failures render the server message without leaking
   internals (`dashboard-response.ts` message map).
6. **IDs are secondary metadata.** Hashes, generations and IDs render as
   copy-affordance chips rather than primary labels on Projects, Secrets,
   Artifacts and API Access.
7. **Empty states.** Each list explains the next useful action instead of an
   empty table.
8. **URL-representable filters** for the pages that have filters (search query
   and tab), so back/forward and link sharing work.

## Acceptance criteria

- All six pages share the layout and the single-primary-action rule.
- No page renders a permanent creation form under its list.
- Keyboard-only flow: reach the primary action, open the dialog, complete it,
  `Esc` closes, and focus returns to the invoker.
- Screen-reader labels exist for every new control; `aria-live` feedback fires on
  every mutation outcome.
- No secret value, credential or token is rendered or retained in the DOM after a
  mutation (`announce` copy stays accurate).

## Verification

```bash
npx vitest run dashboard
npm run verify
```

New/updated tests in `apps/api/test/dashboard-ui-behavior.test.ts` (dialog focus
cycle, escape, invoker restore, single primary action per page, mutation live
region) and `apps/api/test/dashboard-ui-contract.test.ts` (layout contract;
absence of permanent create forms). Browser QA evidence at desktop, tablet and
~375px in both themes plus reduced motion.

## Risks

| Risk | Mitigation |
|---|---|
| Large `dashboard.js` touched by every page | Introduce the shared shell first, migrate one page per commit |
| Existing tests assert markup inside the current forms | Update assertions per page in the same commit as the migration |
| Dialog focus behaviour regresses for screen readers | Reuse the proven helper pattern; add explicit focus-cycle tests |
