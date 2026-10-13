---
phase: 1
title: "Contracts & Tool Schemas"
status: pending
priority: P1
effort: "1h"
dependencies: []
---

# Phase 1: Contracts & Tool Schemas

## Overview
Update `@cloud-harness/contracts` to define the complete schema and tool specifications for `workspace_recover` (with modes `resume`, `status`, `patch`, `export`, defaulting to `resume`), `workspace_lease_renew` (with optional `extensionSeconds`), and the `availableActions` metadata field in workspace status and public records.

## Requirements
- Functional:
  - `workspace_recover` input schema supports optional `workspaceId`, `mode` (`resume` | `status` | `patch` | `export`), defaulting to `'resume'`, and optional `targetBranch` for export mode.
  - `workspace_lease_renew` input schema supports optional `workspaceId` and optional `extensionSeconds` (min 60, max 86,400).
  - Tool specifications define appropriate titles, descriptions, and annotation hints (`readOnly`, `destructive`, `idempotent`, `openWorld`).
  - `availableActions` string array added to workspace record types and documentation.
- Non-functional:
  - Strict input validation via Zod schemas.
  - Backward compatibility with existing tool callers.

## Architecture
- `packages/contracts/src/tool-schemas.ts`: update `schemas.workspace_recover` to include `resume` in enum and default to `resume`.
- `packages/contracts/src/tool-schemas.ts`: update `titles`, `descriptions`, `readOnly`, `destructive`, `idempotent`, and `openWorld` sets.
- `packages/contracts/test/contracts.test.ts`: test schema parsing and defaults for all recovery modes and lease renewal parameters.

## Related Code Files
- Modify: `packages/contracts/src/tool-schemas.ts`
- Modify: `packages/contracts/src/runner-api.ts`
- Modify: `packages/contracts/test/contracts.test.ts`

## Implementation Steps
1. In `packages/contracts/src/tool-schemas.ts`, update `schemas.workspace_recover` to `z.object({ ...workspace, mode: z.enum(['resume', 'status', 'patch', 'export']).default('resume'), targetBranch: gitArgument.optional() })`.
2. Ensure `workspace_lease_renew` schema handles `extensionSeconds` properly.
3. Update descriptions for `workspace_recover` and `workspace_lease_renew` to clearly explain recovery to active state and lease extensions.
4. Update `packages/contracts/test/contracts.test.ts` to assert valid parsing of `workspace_recover` with default `'resume'` mode, explicit modes, and `workspace_lease_renew`.
5. Run contract tests with `npm test -w @cloud-harness/contracts`.

## Success Criteria
- [ ] `TOOL_SCHEMA_BY_NAME.workspace_recover.parse({})` defaults to `{ mode: 'resume' }`.
- [ ] `TOOL_SCHEMA_BY_NAME.workspace_recover.parse({ mode: 'resume' })` parses successfully.
- [ ] `TOOL_SCHEMA_BY_NAME.workspace_lease_renew.parse({ extensionSeconds: 1800 })` parses successfully.
- [ ] Contract tests pass without errors.

## Risk Assessment
- Risk: Changing `workspace_recover` default mode from `status` to `resume` might affect callers expecting status-only inspection.
- Mitigation: `status` mode remains explicitly callable via `mode: 'status'`. The issue explicitly requested `workspace_recover({ workspaceId })` to restore to active state, matching agent expectations.
