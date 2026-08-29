---
phase: 2
title: "Recovery, Lease Renewal & Executor Reactivation"
status: pending
priority: P1
effort: "2h"
dependencies: [1]
---

# Phase 2: Recovery, Lease Renewal & Executor Reactivation

## Overview
Implement full recovery and lease renewal logic in `WorkspaceService` (`apps/runner/src/workspace-service.ts`) and `LocalWorkspaceBackend` (`apps/api/src/local/local-workspace-backend.ts`). Reactivate `EXPIRED_RECOVERABLE` workspaces back to `ACTIVE` with refreshed lease times, automatically recreate and start the Docker executor container when needed, and include `availableActions` metadata in `publicRecord`.

## Requirements
- Functional:
  - `workspace_recover` in `resume` mode (and default):
    - Validates workspace state (allows `EXPIRED_RECOVERABLE` and `ACTIVE`).
    - Throws structured `EXPIRED` error if workspace is `CLOSED`, `FAILED`, or past `hardExpiresAt`.
    - If executor container is missing or not running (e.g. reaped), creates and starts a new executor container with the workspace repository mounted, preserving all files and git state.
    - Updates workspace status to `ACTIVE`, refreshes `lastActivityAt` and `expiresAt` (up to `hardExpiresAt`), and stores the new `containerName`.
    - Returns `{ ok: true, message: 'Workspace recovered to active state', data: publicRecord(updated), truncated: false }`.
  - `workspace_recover` in `status`, `patch`, and `export` modes:
    - Retains existing worker helper functionality for non-destructive inspection, patch retrieval, and git export.
  - `workspace_lease_renew`:
    - Validates workspace state (`ACTIVE` or `EXPIRED_RECOVERABLE`).
    - Throws structured `EXPIRED` error if workspace is `CLOSED`, `FAILED`, or past `hardExpiresAt`.
    - Extends `expiresAt` by `extensionSeconds` (defaulting to configured `idleTtlSeconds`) up to `hardExpiresAt`.
    - If workspace was `EXPIRED_RECOVERABLE`, reactivates it to `ACTIVE` and recreates executor container if missing.
    - Returns `{ ok: true, message: 'Workspace lease renewed', data: publicRecord(updated), truncated: false }`.
  - `availableActions` metadata:
    - Included in `publicRecord` and `workspace_status` response.
    - `ACTIVE`: `['workspace_lease_renew', 'workspace_close', 'workspace_context', 'workspace_finalize']` (when can renew) or without renew when near hard deadline.
    - `EXPIRED_RECOVERABLE`: `['workspace_recover', 'workspace_lease_renew', 'workspace_close']`.
    - `CREATING` / `REAPING`: `['workspace_status']`.
    - `CLOSED` / `FAILED`: `['workspace_open']`.
  - Local stdio backend (`LocalWorkspaceBackend`):
    - `workspace_recover` and `workspace_lease_renew` handled gracefully with `getPublicRecord()`.
    - `availableActions` included in local status response.
- Non-functional:
  - Fenced atomic state updates in SQLite `StateStore`.
  - No data loss, re-cloning, or git reset during recovery.
  - Clear error handling with standard HTTP/MCP error status codes.

## Architecture
- `WorkspaceService`:
  - Helper `ensureExecutor(record: WorkspaceRecord): Promise<WorkspaceRecord>`: checks if `record.containerName` is valid and running via Docker inspect; if not, calls `this.createExecutor(record, join(record.workspacePath, 'repository'))` and updates `record.containerName` in `store`.
  - `availableLifecycleActions(status, canRenewLease)` helper function calculating valid operations.
  - Updated `publicRecord(record)` incorporating `availableActions`.
  - Updated `workspace_recover` handling `mode === 'resume'` before delegating to recovery worker helpers.
  - Updated `workspace_lease_renew` ensuring executor container is recreated if workspace was in `EXPIRED_RECOVERABLE`.
- `LocalWorkspaceBackend`:
  - Added handlers for `workspace_recover` and `workspace_lease_renew`.
  - Updated `getPublicRecord()` to include `availableActions`.

## Related Code Files
- Modify: `apps/runner/src/workspace-service.ts`
- Modify: `apps/api/src/local/local-workspace-backend.ts`

## Implementation Steps
1. Add `availableLifecycleActions(status, canRenewLease)` in `apps/runner/src/workspace-service.ts`.
2. Add `availableActions: availableLifecycleActions(...)` to `publicRecord(record)`.
3. Implement `ensureActiveExecutor(record)` in `WorkspaceService` to provision directories and create/start container if missing or stopped.
4. Update `workspace_recover` in `WorkspaceService`:
   - If `mode === 'resume'`, verify not past hard deadline, call `ensureActiveExecutor`, update status to `ACTIVE`, and return refreshed `publicRecord`.
   - Ensure `status`, `patch`, and `export` modes continue to operate cleanly on both active and recoverable workspaces.
5. Update `workspace_lease_renew` in `WorkspaceService`:
   - Ensure active executor container is provisioned if transitioning from `EXPIRED_RECOVERABLE` to `ACTIVE`.
   - Update expiration correctly bounded by `hardExpiresAt`.
6. Update `LocalWorkspaceBackend` in `apps/api/src/local/local-workspace-backend.ts`:
   - Return `{ ok: true, message: 'Local workspace lease is active', data: this.getPublicRecord() }` for `workspace_lease_renew`.
   - Handle `workspace_recover` modes in local mode.
   - Include `availableActions` in `getPublicRecord()`.

## Success Criteria
- [ ] Calling `workspace_recover` on an `EXPIRED_RECOVERABLE` workspace transitions status to `ACTIVE`.
- [ ] Calling `workspace_lease_renew` on an `EXPIRED_RECOVERABLE` workspace transitions status to `ACTIVE`.
- [ ] Executor container is recreated and subsequent `files_write`/`exec_run`/`git_status` succeed on recovered workspace.
- [ ] `availableActions` array is present in all `workspace_status` responses.
- [ ] Calling recovery on a `CLOSED` workspace returns structured `EXPIRED` error.

## Risk Assessment
- Risk: Race conditions between concurrent reap sweeps and recovery calls.
- Mitigation: Use SQLite fenced generation updates (`updateFenced`) and recoverable mutation locks (`acquireRecoverableMutationLease`).
