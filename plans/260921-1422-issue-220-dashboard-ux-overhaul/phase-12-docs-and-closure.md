---
phase: 12
title: "Docs sync, regression sweep, and issue closure evidence (issue Phase 11)"
status: completed
priority: P1
effort: "1d"
dependencies: [11]
---

# Phase 12: Docs sync, regression sweep, issue closure evidence

Issue phase: **Phase 11** (issue delivery item 11: documentation and tests
cleanup).

**Status: completed.** Shipped in PR #238. `docs/design-guidelines.md` gained a section per
shipped surface and the official docs site was resynced (new pages for Agents, Activity,
Approvals and Integrations, updated Overview/Workspaces/GitHub/Models/API Access/Audit pages
and a reordered sidebar); `npm run docs:build` is clean, and its dead-link check caught the
missing Integrations page, which was written rather than exempted. `npx vitest run dashboard`
reports 25 files / 323 tests passing. The browser sweep covers desktop, tablet and ~375px with
no horizontal overflow in dark, light and system themes, plus keyboard-only navigation;
reduced motion is verified at the CSS-contract level because the browser driver exposes no
media-feature emulation. Issue #220 carries the Definition-of-Done mapping and is closed, and
the five deliberate residuals are listed explicitly.

**Closure corrected after audit.** An independent completion audit found that this phase's
predecessor PR #234 had merged with a failing `quality` check (an undefined `activityEvent`
reference in that diff) and that `main` had no required status checks, so no phase merge was
gated on CI. The correction is recorded in the plan's closure record and in two comments on
issue #220; the merged state was re-verified with CI's own gates; and the `quality` check is
now required on `main` with the owner's approval.

## Goal

The documentation describes the shipped Dashboard, the full regression surface
passes, and issue #220 carries an evidence comment mapping every
Definition-of-Done bullet to its PR/commit and verification run.

## Tasks

1. **Internal docs**: `docs/design-guidelines.md` owns the shipped design
   contract (navigation groups, route ownership, cockpit structure, chart rules,
   motion rules). Update the repository/executor docs only if a Dashboard surface
   they describe changed (`docs/` navigation table in `AGENTS.md` stays accurate).
2. **Docs site**: update the affected `docs-site/dashboard/` pages so the official
   user guide matches the shipped IA and routes; run `npm run docs:reference`
   if a tool or contract surface changed, and `npm run plugin:sync` if the skill
   bundle is affected.
3. **Regression sweep**: run the full Dashboard suite list from the issue plus
   `npm run verify` on the merged branch, and record the result.
4. **Manual matrix**: dark, light and system themes; desktop, tablet and ~375px;
   keyboard-only navigation; reduced-motion mode; every new surface's
   loading/empty/error state.
5. **DoD evidence**: post a comment on issue #220 mapping each
   Definition-of-Done bullet to the phase PR, commit and verification run, list
   every deliberately deferred item with its reason, then close the issue.
6. **Cleanup**: remove the temporary Audit sidebar entry and any phase-scoped
   compatibility shim that is no longer needed (the `/dashboard/overview`
   redirect stays as a permanent compatibility route).

## Acceptance criteria

- No document describes the pre-overhaul IA (no Profile sidebar slot, no
  `Models`/`API keys` labels, no old `/dashboard` workspace mapping).
- The full test list from the issue passes, plus `npm run verify`.
- The manual matrix is recorded with evidence paths under `plans/reports/`.
- Issue #220 has the DoD mapping comment and is closed.

## Verification

```bash
npx vitest run dashboard
npm run verify
npm run docs:build
gh issue view 220 --json state,comments
```

## Risks

| Risk | Mitigation |
|---|---|
| Docs drift because phases merged over days | Each phase updates its own doc surface; this phase only reconciles |
| A DoD bullet is partially satisfied | Record it explicitly as residual with a follow-up issue rather than claiming done |
