# Phase 5: Pagination, Context & Implicit Workspace

## Context & Objectives
Deliver seamless single-workspace ergonomics and standardized cursor pagination:
- Automatic single active workspace resolution when `workspaceId` is omitted.
- Ambiguity error (`CONFLICT`) when >1 active workspaces exist.
- New tools: `workspace_context`, `workspace_set_active`, `git_identity_status`, `git_identity_set`.
- Pagination standardisation: `readAll`, `cursor`, `nextCursor`, `truncated`, `bytesReturned`, `totalBytes`, `eof`.
- Enhance `git_diff`, `files_read`, `grep_search`, `git_log` with standard pagination metadata.

## Affected Files
- `apps/runner/src/workspace-service.ts`
- `worker/harness-worker.mjs`
- `apps/api/src/mcp-server.ts`
- `apps/api/src/runner-client.ts`

## Implementation Steps
1. In `apps/runner/src/workspace-service.ts`:
   - Intercept requests with missing `workspaceId` and resolve active workspace.
   - Implement `workspace_context`, `workspace_set_active`, `git_identity_status`, `git_identity_set`.
   - Update `git_diff`, `files_read`, `grep_search`, `git_log` output formats to include standard cursor pagination metadata.
2. In `worker/harness-worker.mjs`:
   - Add cursor pagination to `git_diff` and `git_log`.
   - Support `readAll` mode up to max output threshold.
3. In `apps/api/src/mcp-server.ts`:
   - Verify all tool specs pass schema validation and properly handle optional parameters.
