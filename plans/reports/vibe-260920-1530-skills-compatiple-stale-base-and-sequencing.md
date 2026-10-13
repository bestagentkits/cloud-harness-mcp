# Vibe run status — skills.sh/SkillX plan blocked on a stale base

Date: 2026-09-20 15:30 (Asia/Saigon)
Branch: `mrgoonie/skills-compatiple` (isolated worktree `D:/orca/cloud-harness-mcp/skills-compatiple`)
Plan: `plans/260901-1255-skills-sh-and-skillx-compatibility/plan.md`
Issue: [#218](https://github.com/bestagentkits/cloud-harness-mcp/issues/218)
Mode: `--ship` (stable) with advisory supervision

## Outcome

The pipeline ran its intake, gate, and first-increment stages, then stopped at a
finding that invalidates the plan's base rather than at a coding difficulty. The
branch was built 77 commits behind `origin/main`, and the plan's phase 1 target
schema version is already taken on `main`. The branch is now rebased, the phase 1
contract layer is implemented and green, and the remaining work needs a delivery
-shape decision before it starts.

## What the advisory checkpoint found, and what was verified

| Claim | Verification |
|---|---|
| Branch is 77 commits behind `origin/main` | Confirmed by `git rev-list --count HEAD..origin/main` |
| Old base `2506618` = v0.38.1; `origin/main` `cbb18d1` = v0.48.0 | Confirmed by `git log` |
| `origin/dev` is not the ship target | Confirmed: heads 2026-08-18, 228 commits behind `HEAD` |
| Schema version 10 is already taken on `main` | Confirmed: `principal-store.ts:756` sets it, `:760` guards it, `:763` is `downgradeStateSchemaToV9`, and `state-schema-v10.test.ts` exists |
| About 31 of the plan's named paths changed on `main` | Partially confirmed: `tool-schemas.ts` +134, `workspace-service.ts` +409, `internal-runner-api.ts` gained `settings_get`/`settings_update`, the dashboard gained `/dashboard/knowledge` |
| Worker and executor-image facts still hold | Confirmed for `worker/harness-worker.mjs` and `docker/executor.Dockerfile` |
| Rebase is conflict-free | Confirmed: both commits replayed onto `cbb18d1` with no conflicts |

## Work completed and verified

- Plan and journals committed and pushed, resolving the "plan directory is
  untracked" risk that two earlier reviews had flagged.
- Issue #218 created with the outcome, mechanism, architecture, scope lock,
  acceptance criteria, and pipeline state.
- Phase 1 contract layer implemented with tests first:
  `ToolkitSelectionSchema` gained a `registry` arm for `skills-sh` and `skillx`,
  `workspace_open` gained bounded `skillSets` (16) and `skillOverrides` (128)
  with a duplicate-set guard, and skill source/revision/set/import-job
  identifiers were added. 16 new tests.
- Fingerprint sort keys in `toolkit-service.ts` and `workspace-service.ts` were
  updated for the third union arm; without this, `npm run typecheck` fails.
- Gates after the rebase: `packages/contracts` 109/109 green, `npm run typecheck`
  green across every workspace, eslint clean on the touched files.
- Plan corrected for four grounded findings, including the retarget from schema
  version 10 to version 11 with a paired `downgradeStateSchemaToV10`.

## Pre-existing issues, not introduced here

`apps/runner/src/workspace-service.ts` has six `JSON.parse` calls without
`try/catch` (L1520-L3199) that the lens reports. `git diff --numstat` shows this
branch changes 2 lines in that file, both in `computeWorkspaceOpenFingerprint`,
so these are pre-existing and out of scope for this change.

## Not started

Phases 2 through 9 are untouched, and the remainder of phase 1 (skill table DDL
at version 11, the paired downgrade, the seeded migration test, the `StateStore`
CRUD helpers, and the internal-runner-api operations) is not written. The plan's
`status` stays `pending`.

## Why it stopped here

Starting a 135h, nine-phase implementation on a base that was 77 commits stale
would have produced code verified against the wrong repository state. The plan's
own open question 4 schedules a re-estimate after phase 1, and its open question
2 has a stop point inside phase 6; neither is honourable inside a single
non-stop run. The advisory checkpoint therefore recommended dependency-ordered
increments with one reviewed PR each, which is a decision for the operator.
