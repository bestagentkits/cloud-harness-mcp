# Phase 2: Runner State, Leases, and Operation Management

## Context & Objectives
Implement state tracking and lifecycle mechanisms in `apps/runner`:
- Add `EXPIRED_RECOVERABLE` status to `WorkspaceRecord`.
- Track `idleExpiresAt` and `hardExpiresAt` in `StateStore` and `WorkspaceService`.
- Implement lease renewal (`workspace_lease_renew`) and recovery (`workspace_recover`).
- Protect active mutations with temporary non-expiring mutation leases (`withMutationLease`).
- Add active workspace resolution and preferred active workspace storage in `StateStore`.
- Enhance `OperationManager` with hard deadlines, cancellation, status polling, and retained completed operation results for reconnectable queries.

## Affected Files
- `apps/runner/src/state-store.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/src/operation-manager.ts`
- `apps/runner/test/state-store.test.ts`
- `apps/runner/test/operation-retention.test.ts`

## Implementation Steps
1. In `state-store.ts`:
   - Extend `WorkspaceRecord['status']` to include `'EXPIRED_RECOVERABLE'`.
   - Add columns/fields for `hard_expires_at`, `active_preferred`, and git identity overrides.
   - Add methods to set/get preferred workspace and git identity.
   - Implement `resolveActiveWorkspace(ownerId: string, explicitId?: string): WorkspaceRecord`.
2. In `operation-manager.ts`:
   - Store operation metadata (id, workspaceId, status, progress, createdAt, deadline, result, exitCode, output buffer).
   - Implement `cancel(id: string)`: kill process group, mark status 'cancelled'.
   - Implement `status(id: string, cursor?: string)` and `wait(id: string, timeoutMs: number)`.
   - Retain finished operation results for 10 minutes in memory.
3. In `workspace-service.ts`:
   - Update `reapExpired` to transition expired workspaces to `EXPIRED_RECOVERABLE` before full reap.
   - Implement `workspace_lease_renew` and `workspace_recover`.
   - Implement `operation_status`, `operation_cancel`, `operation_wait`.
