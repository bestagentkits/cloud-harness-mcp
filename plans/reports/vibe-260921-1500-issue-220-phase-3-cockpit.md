# Phase 3 (issue #220, Phase 2): Workspace Cockpit and bounded lifecycle adapters

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-3`
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-03-workspace-cockpit.md`

## Summary

Workspace detail is now a cockpit. The header carries repository, status, ref,
network profile, lease posture and an attention count, with `Renew lease` as the
single accented action, `Finalize workspace` beside it, and recover/close behind
`More actions`. A contextual tab row covers Summary, Agents, Runtime, Files, Git,
Automation, Deploy, Artifacts and Activity. Summary reports only observable state,
and the four workspace lifecycle operations now have bounded Dashboard adapters.

Phase 3 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — `workspace_context`, `workspace_lease_renew`,
  `workspace_recover` and `workspace_finalize` join the response union with
  projections: the context document is reduced to the workspace record, branch, git
  identity name, boolean capabilities and manifest counts; a finalize result is
  reduced to commit/push facts. Job paths, container names, the identity email and
  file contents never cross the boundary.
- `apps/api/src/dashboard-router.ts` — four principal-scoped routes
  (`GET /context`, `POST /lease-renew`, `POST /recover`, `POST /finalize`) that
  validate through the runner contract schemas and return mapped payloads. They
  inherit the existing session/CSRF middleware for non-GET methods.
- `apps/api/src/dashboard-assets.ts` — the nine workspace tab routes are served as
  shell paths, and the page registry still resolves them to the Workspaces entry.
- `apps/api/dashboard/dashboard-render.js` — `WORKSPACE_TABS`,
  `workspaceLeaseState`, `workspaceAttention`, `renderWorkspaceCockpitHeader`,
  `renderWorkspaceTabs`, `renderWorkspaceAttentionPanel`, `renderWorkspaceSummary`,
  `renderWorkspaceTabPlaceholder`, `renderFinalizeDialog`.
- `apps/api/dashboard/dashboard.js` — the workspace route dispatches by tab; the
  cockpit loads status plus context (a missing context degrades the Summary instead
  of hiding the header), wires Renew/Recover/Finalize/Close with pending state and
  live-region feedback, and reuses the phase-2 dialog machinery for finalize.
- `docs/design-guidelines.md` — the cockpit contract, including why tabs that have
  not shipped name their owning phase.

## Verification

- `npx vitest run dashboard apps/api/test/dashboard-cockpit.test.ts` — 18 files,
  264 tests, all passing.
- `apps/api/test/dashboard-router.test.ts` — 29 tests including three new cases:
  the context projection drops `internal-owner`, `/host/jobs`, `executor-secret`,
  the identity email and file contents while keeping branch, identity name,
  boolean capabilities and manifest counts; the lifecycle routes pass the
  principal scope and the parsed workspace id; finalize without a commit message is
  rejected by the contract before the runner is called, and its result is mapped.
- Browser QA against the real shell with a stubbed BFF:
  `title="example/project | Cloud Harness"`, 9 tabs with exactly one
  `aria-current="page"` (Summary), one attention item
  ("Lease expires soon — 4 min left"), header facts Ref/Network/Lease/Attention,
  Summary facts `Status=Active`, `Branch=feature/cockpit`,
  `Repository context=12 attributable item(s) (truncated)`,
  `Capabilities=tasks, sessions`, `Cost used=Not reported for workspaces yet`, all
  three lifecycle actions present, and the finalize dialog opening with focus on
  `finalize-commit-message`.
  Screenshot: `~/.pi/browser-artifacts/phase-3-workspace-cockpit-summary.png`.

## Deliberate scope boundary

The task contract also names adapters for agents, tasks, sessions, Git, worktrees,
skills, hooks and deployments. Those ship with the phases that own their surfaces
(Agent Control Center, Runtime operations, Git and Finalize, Automation and
Deploy, Activity and Approvals — goal tasks 4 to 8), because each needs its own
redaction mapper and UI state. This PR delivers the cockpit shell, the Summary, the
attention reasons the dashboard can currently observe (lease expiry, workspace
failure, network quarantine, dirty Git when known), and the four lifecycle
adapters. The agent, task and integration attention reasons therefore land with
tasks 4, 5 and 8; the Summary states "Not reported" rather than inventing values
for them today.
