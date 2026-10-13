# Phase 2: Durable Task Lifecycle, File Log Spooling & Boot Reconciliation

**Status:** completed
**Priority:** High  
**Dependencies:** Phase 1

## Requirements
- Introduce ephemeral `runner_boot_id` generated on each Runner process startup.
- Transform `OperationManager` in `apps/runner/src/operation-manager.ts` to persist task records into SQLite `durable_tasks` and stream log outputs directly to `/job/.chm/tasks/<task_id>.log` (runner-owned 0700 dir, 0600 file).
- Support deterministic cursor-based pagination for `tasks_status` reading directly from chunked file offsets without loading entire logs into RAM.
- Implement startup crash reconciliation in `WorkspaceService`: reconcile running tasks from prior boot IDs BEFORE restarting containers or closing missing workspaces, marking dead tasks as `FAILED` (`error_code: "RUNNER_RESTARTED"`).
- Ensure `tasks_run` with an existing `idempotencyKey` returns the recorded task without duplicate execution, rejecting fingerprint mismatches with `CONFLICT`.

## Files to Modify / Create
- `apps/runner/src/operation-manager.ts` (Modify: SQLite-backed task store integration, file log writer, cursor pagination)
- `apps/runner/src/workspace-service.ts` (Modify: Reconcile tasks on startup before container restart, pass boot ID)
- `apps/runner/test/durable-tasks.test.ts` (Create: Unit tests for task durability, cursor pagination, restart reconciliation, idempotency)

## Implementation Steps
1. Update `OperationManager` to accept SQLite `DatabaseSync` and initialize prepared statements for task state transitions (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`).
2. Write task output chunk stream directly to `/job/.chm/tasks/<id>.log` with file lock safety, while maintaining active tail in memory for real-time streaming.
3. Implement `reconcileRunningTasks(bootId)` in `WorkspaceService` startup: inspect DB tasks and mark previous boot ID tasks as `FAILED` (`RUNNER_RESTARTED`).
4. Implement `tasks_status` cursor reading: read file byte slices from requested `cursor` offset up to 64KB with `truncated` flag, handling UTF-8 boundary safety.
5. Write unit tests simulating runner restart, crash, and cursor progression.

## Tests and Validation
- `npm run test:unit apps/runner/test/durable-tasks.test.ts`
