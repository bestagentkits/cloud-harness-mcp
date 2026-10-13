# Phase 1: Contracts & Tool Schemas

## Context & Objectives
Define the new and extended tool schemas and types in `@cloud-harness/contracts`:
- Add `workspace_lease_renew`, `workspace_recover`, `workspace_finalize`, `files_write_batch`, `operation_status`, `operation_cancel`, `operation_wait`, `workspace_context`, `workspace_set_active`, `git_identity_status`, `git_identity_set`.
- Extend `github_action` discriminated union with issue comment, label, and update actions.
- Make `workspaceId` optional across workspace tool schemas to support implicit active workspace resolution.
- Make `authorName` and `authorEmail` optional on `git_commit` and `workspace_finalize`.
- Add cursor and `readAll` pagination parameters to `git_diff`, `git_log`, `grep_search`, `files_read`.

## Affected Files
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/src/runner-api.ts`
- `packages/contracts/src/mcp-results.ts`
- `packages/contracts/test/contracts.test.ts`

## Implementation Steps
1. Update `packages/contracts/src/runner-api.ts`:
   - Add new operation names to `RunnerOperationSchema`.
2. Update `packages/contracts/src/tool-schemas.ts`:
   - Define schemas for all new operations.
   - Adjust existing schemas: optional `workspaceId`, optional author fields, pagination flags (`readAll`, cursor).
   - Update `TOOL_SPECS`, titles, descriptions, and annotation sets (readOnly, destructive, idempotent, openWorld).
3. Update `packages/contracts/test/contracts.test.ts` to test every new tool schema, optional fields, and validation boundaries.
4. Run `npm test -w @cloud-harness/contracts` and verify clean build.
