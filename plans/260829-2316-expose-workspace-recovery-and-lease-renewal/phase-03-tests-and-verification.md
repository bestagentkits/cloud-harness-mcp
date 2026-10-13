---
phase: 3
title: "Integration Tests, Edge Cases & TDD Verification"
status: pending
priority: P1
effort: "1h"
dependencies: [1, 2]
---

# Phase 3: Integration Tests, Edge Cases & TDD Verification

## Overview
Develop and execute targeted unit, integration, and docker tests to rigorously verify all acceptance criteria from Issue #103: `workspace_recover` in `resume`, `status`, `patch`, and `export` modes, `workspace_lease_renew`, preservation of unpushed commits and working-tree changes, structured error responses for expired windows, and `availableActions` metadata.

## Requirements
- Functional:
  - Verify `workspace_recover` with default/resume mode restores an `EXPIRED_RECOVERABLE` workspace to `ACTIVE`.
  - Verify unpushed local commits, staged changes, and untracked files are preserved after recovery.
  - Verify local branches are preserved and no silent re-cloning happens.
  - Verify `workspace_lease_renew` extends the idle lease and reactivates recoverable workspaces.
  - Verify error handling when attempting recovery or renewal on closed workspaces or past hard deadline.
  - Verify `availableActions` matches lifecycle expectations for `ACTIVE`, `EXPIRED_RECOVERABLE`, and `CLOSED`.
  - Verify local stdio backend behavior for recovery and lease renewal.
- Non-functional:
  - 100% test pass rate across unit and integration test suites.
  - No flaky or timing-dependent assertions.

## Architecture
- `test/integration/workspace-recovery.test.ts` (new):
  - Unit/integration test suite covering recovery state transitions, executor restart, lease extensions, and error codes.
- `apps/api/test/local-backend.test.ts`:
  - Add tests for `workspace_recover`, `workspace_lease_renew`, and `availableActions` in local mode.
- `test/ux-improvements.test.ts`:
  - Update or extend existing recovery tests to cover `resume` mode and `availableActions`.

## Related Code Files
- Create: `test/integration/workspace-recovery.test.ts`
- Modify: `apps/api/test/local-backend.test.ts`
- Modify: `test/ux-improvements.test.ts`

## Implementation Steps
1. Create `test/integration/workspace-recovery.test.ts` testing:
   - Transition from `EXPIRED_RECOVERABLE` to `ACTIVE` via `workspace_recover` with `mode: 'resume'`.
   - Transition from `EXPIRED_RECOVERABLE` to `ACTIVE` via `workspace_lease_renew`.
   - Re-creation of container executor on recovery when `containerName` was null.
   - Working tree changes, staged changes, and local commits intact after recovery.
   - Error code `EXPIRED` when recovering closed workspace or past `hardExpiresAt`.
   - Presence and correctness of `availableActions` across states.
2. Update `apps/api/test/local-backend.test.ts` to assert `workspace_recover`, `workspace_lease_renew`, and `availableActions`.
3. Run `npm test` and ensure all test suites pass.

## Success Criteria
- [ ] All new recovery tests in `test/integration/workspace-recovery.test.ts` pass.
- [ ] All existing test suites pass without regression.
- [ ] Acceptance criteria from Issue #103 verified by automated tests.

## Risk Assessment
- Risk: Mock docker helper in tests may not simulate container recreation accurately.
- Mitigation: Verify with both unit mock fixtures and real integration scenarios.
