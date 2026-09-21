# Phase 7 (issue #220, Phase 6): workspace Automation and Deploy

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-7` (task-7 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-07-automation-and-deploy.md`

## Summary

The cockpit's Automation tab shows the workspace's resolved skills and its lifecycle
hooks in one place, grouped by the event that runs them and beside an ordered
pipeline that states each stage as text. The Deploy tab lists repository-defined
deployment targets with their last reported result, duration and failure detail, and
confirms before running one.

Phase 7 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — `skills_list`, `skills_read`, `skills_run`,
  `hooks_list`, `hooks_run`, `hooks_activate`, `hooks_deactivate`, `deployments_list`
  and `deployments_run` join the response union with projections: skill identity and
  tier, hook name/events/active/description, deployment name and working directory,
  and mutation results bounded at 8 KB.
- `apps/api/src/dashboard-router.ts` — reads
  `GET /workspaces/:id/{skills,hooks,deployments}` and guarded mutations
  `POST /workspaces/:id/hooks/{run,activate,deactivate}`,
  `POST /workspaces/:id/skills/:name/run`, `POST /workspaces/:id/deployments/run`.
  Each mutation keeps the contract's own guarded schema (manifest hash for
  activation, event allowlist, named script) and the session/CSRF middleware.
- `apps/api/dashboard/dashboard-render.js` — `HOOK_LIFECYCLE`,
  `groupHooksByLifecycle`, `renderHookPipeline`, `renderHooks`,
  `renderWorkspaceSkills`, `renderDeployPanel`, `renderAutomationPanel`.
- `apps/api/dashboard/dashboard.js` — the Automation and Deploy tabs load their
  surfaces, hook and skill runs go through their guarded routes, and a deployment run
  confirms before executing.
- `docs/design-guidelines.md` — the automation/deploy contract, including why the
  pipeline is text-first and why a missing deployment result reads as "Not reported".

## Verification

- `npx vitest run dashboard apps/api/test/dashboard-automation.test.ts` — 22 files,
  296 tests, all passing; `npm run typecheck -w @cloud-harness/api` clean.
- `apps/api/test/dashboard-automation.test.ts` — lifecycle grouping (including a hook
  that predates the `events` array and carries a single `event`), pipeline order and
  counts asserted positionally, empty-stage text, active/inactive state, the guarded
  skill-run form (no bare run button), deployment risk labelling, last result,
  duration, failure detail, "Not reported" for missing data, and the composed panel.
- A test-fixture defect was caught before merge: a helper-injected default `events`
  array made a legacy hook count in the wrong stage. The fixture now models the legacy
  shape explicitly, which also proves the grouping handles both shapes.

## Residual

Hook activation stays behind the manifest hash the runner requires, so the page does
not offer a toggle the contract cannot honour; it runs what is already active. Skill
script execution requires the operator to name the skill and script, because the
contract validates verified bytes per script rather than per skill.
