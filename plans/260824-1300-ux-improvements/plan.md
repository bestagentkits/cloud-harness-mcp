# Plan: Cloud Harness MCP UX Improvements (Issues #88, #89, #90, #91, #92, #93, #94)

**Status:** COMPLETED
**Created:** 2026-08-24
**Branch:** mrgoonie/UX-Improvements
**Route:** Feature & UX Enhancement
**Mode:** Official Stable (--ship)

## Overview
Comprehensive upgrade to Cloud Harness MCP addressing critical friction points discovered during long-running agent workflows (#33):
1. **Issue #94 (P0):** Visible, renewable, and recoverable workspace leases with idle/hard expiry and non-expiring mutation windows.
2. **Issue #93 (P0):** Transactional `workspace_finalize` for atomic stage, preflight check, commit, and push.
3. **Issue #88 (P1):** Atomic `files_write_batch` with parent directory creation and all-or-nothing rollback.
4. **Issue #90 (P1):** Bounded operations with progress, hard timeouts, cancellation (`operation_cancel`), and reconnectable polling (`operation_status`, `operation_wait`).
5. **Issue #89 (P1):** Extended `github_action` covering issue comments, label management, issue updates, and idempotency.
6. **Issue #92 (P2):** Implicit active workspace resolution and default Git identity (`workspace_context`, `git_identity_status`, `git_identity_set`).
7. **Issue #91 (P2):** Consistent cursor pagination, `readAll` support, and deterministic stale cursor handling across diff, files, search, and logs.

## Phases
- [Phase 1: Contracts & Tool Schemas](./phase-01-contracts-and-tool-schemas.md)
- [Phase 2: Runner State, Leases, and Operation Management](./phase-02-runner-state-leases-operations.md)
- [Phase 3: Worker Execution, Batch Writes & Finalize](./phase-03-worker-execution-and-git-tools.md)
- [Phase 4: Brokered GitHub Actions Expansion](./phase-04-brokered-github-actions.md)
- [Phase 5: Pagination, Context & Implicit Workspace](./phase-05-pagination-and-workspace-context.md)
- [Phase 6: Verification, Test Suites & Documentation](./phase-06-verification-and-docs.md)
## Acceptance Criteria
- [x] Multi-file nested batch writes succeed in one call with parent directory creation and all-or-nothing rollback on validation failure (#88).
- [x] Extended GitHub operations (comment, update, label create/add/remove, issue view/edit) work reliably with idempotency (#89).
- [x] Long-running operations are cancellable, observable, and reconnectable with hard server deadlines (#90).
- [x] Large outputs (diff, read, search, log) support consistent cursor pagination and `readAll` convenience (#91).
- [x] Single active workspace is automatically resolved when `workspaceId` is omitted; multi-workspace ambiguity returns structured error (#92).
- [x] Git author identity defaults automatically from workspace/authenticated owner (#92).
- [x] Staging, committing, and pushing can be performed in one idempotent, transactional `workspace_finalize` call (#93).
- [x] Workspace leases distinguish idle and hard expiry, refresh on activity, hold during mutations, and offer `EXPIRED_RECOVERABLE` state with renewal/recovery tools (#94).
- [x] All existing and new unit, integration, and contract tests pass.
