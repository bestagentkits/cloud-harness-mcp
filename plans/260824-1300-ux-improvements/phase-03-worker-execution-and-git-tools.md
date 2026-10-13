# Phase 3: Worker Execution, Batch Writes & Finalize

## Context & Objectives
Implement atomic batch file writes and transactional workspace finalization:
- Add `files_write_batch` handler in `worker/harness-worker.mjs`:
  - Path safety checks.
  - Expected SHA256 pre-validation across all files before touching disk.
  - Parent directory creation when `createParents: true`.
  - Atomic write via temporary files + rollbacks on failure.
- Add `workspace_finalize` in `workspace-service.ts` / `harness-worker.mjs`:
  - Preflight checks (whitespace / diff checks).
  - Stage changes (specified paths or all).
  - Commit changes with default or explicit Git author.
  - Push branch to remote with brokered GitHub App write token if `push: true`.
  - Structured response with commit SHA, branch, push status, and resumption instructions on failure.

## Affected Files
- `worker/harness-worker.mjs`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/test/bounded-workspace-file-reader.test.ts`
- `apps/runner/test/workspace-audit.test.ts`

## Implementation Steps
1. Add `files_write_batch` to `worker/harness-worker.mjs`.
2. Add `workspace_finalize` logic in `workspace-service.ts`:
   - Run preflights.
   - Run worker git operations to stage & commit.
   - Perform remote push if requested.
   - Return clean summary and idempotency-safe outcome.
3. Unit test batch writes with parent directories, SHA conflicts, and error rollbacks.
4. Unit test `workspace_finalize` under normal, no-change, and push-error conditions.
