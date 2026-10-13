---
phase: 3
title: "Dashboard uploads an archive and reports the per-item outcome"
status: pending
priority: P2
effort: "3-4h"
dependencies: [2]
---

# Phase 03 — Dashboard

## Deliverable

An upload control on the Skills page that submits an archive and reports the per-item outcome.

## Owners to inspect first

- `apps/api/dashboard/dashboard-render.js` — `renderSkillsSkeleton` and the library section, plus
  `renderPrimaryAction` for the page action slot.
- `apps/api/dashboard/dashboard.js` — `setPageActions`, the dialog machinery, and the library
  controller that reloads the table from the runner after a mutation.
- `apps/api/dashboard/dashboard.css` — the `.skills-*` rules.
- `docs/design-guidelines.md` — the Skills page section, which owns the interaction rules.

## Steps

1. Put the upload behind the page's existing action pattern rather than a permanent form under the
   list, consistent with how creating a single skill is reached.
2. Accept a `.zip` selection, submit it to the route, and keep the dialog open while the upload runs.
3. Report the per-item outcome: how many were created, and for each entry that was not, its reason.
   A per-item conflict is not a failed upload and must not read as one.
4. Reload the library from the runner on completion rather than patching rows locally, because the
   runner is authoritative about what was created.
5. State the caps in the control, so an operator with a large archive learns the limit before
   uploading rather than from a rejection.

## Acceptance

- An archive that creates skills closes the dialog, announces the outcome, and reloads the library.
- An archive with per-item conflicts reports them without discarding the created skills.
- A rejected archive keeps the dialog open and states why.
- The control is reachable without a permanent form occupying the library.

## Tests

Extend `apps/api/test/dashboard-ui-contract.test.ts` and `apps/api/test/dashboard-skills-ui.test.ts`
for the control, the outcome reporting, and the cap statement.
