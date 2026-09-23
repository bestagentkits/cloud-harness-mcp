---
phase: 4
title: "Dashboard surfacing"
status: completed
priority: P2
effort: "2-3h"
dependencies: [3]
---

# Phase 04 — Dashboard surfacing

## Owners

`apps/api/dashboard/dashboard-render.js`, `dashboard.js`, `dashboard.css`,
pinned by `apps/api/test/dashboard-ui-contract.test.ts`.

## Steps

1. Library table: add a Version column showing the current revision's version,
   rendering an explicit empty state when it is absent. Reuse the existing table
   and status-chip conventions — do not invent a parallel style.
2. Revision list in the detail drawer: show each revision's version beside its
   origin and timestamp.
3. Editor: when the entered document carries a `metadata.version` that does not
   bump the current revision, show the advisory warning inline. It is a warning,
   never a blocker, so the save control stays enabled.
4. Keep the creation/edit flow inside the existing `#skill-editor-dialog`
   established for this page; do not reintroduce a permanent form.
5. Follow `docs/design-guidelines.md` for any new class, and check the new
   markup against the existing structural assertions (ids, ARIA references,
   `label for` targets) rather than assuming they still hold.

## Verification

- Contract test pins the Version column and the revision-list version, and
  asserts the empty state renders without a version.
- The drift warning is present for a non-bump and absent for a bump.
- The save control remains enabled while the warning is shown.
- Existing dashboard contract and behaviour tests still pass unchanged.
