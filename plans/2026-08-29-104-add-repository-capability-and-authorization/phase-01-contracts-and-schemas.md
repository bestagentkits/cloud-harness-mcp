# Phase 1: Contracts and Schemas

## Objectives
1. Add `REPOSITORY_OPERATION_NOT_AUTHORIZED` to `ErrorCodeSchema` in `packages/contracts/src/mcp-results.ts`.
2. Extend `ToolResultSchema.error` with optional fields:
   - `operation?: string`
   - `repository?: string`
   - `requiredCapability?: string`
3. Update `HarnessError` to optionally accept structured error details (`operation`, `repository`, `requiredCapability`).
4. Add `'workspace_capabilities'` to `RunnerOperationSchema` in `packages/contracts/src/runner-api.ts`.
5. Add `workspace_capabilities` schema to `TOOL_SCHEMA_BY_NAME` in `packages/contracts/src/tool-schemas.ts`:
   - `workspace_capabilities: z.object(workspace)`
6. Add capability Zod schemas and TypeScript types in `@cloud-harness/contracts`:
   - `RepositoryCapabilitiesSchema` / `RepositoryCapabilities`
   - `WorkspaceCapabilitiesSchema` / `WorkspaceCapabilities`
   - `RepositoryPermissionsSchema` / `RepositoryPermissions`
   - `RepositoryOperationsSchema` / `RepositoryOperations`
   - `WorkspaceCapabilityResultSchema` / `WorkspaceCapabilityResult`
7. Update `TOOL_SPECS`, titles, descriptions, `readOnly` set, and `idempotent` set to include `workspace_capabilities`.
8. Update contract unit tests in `packages/contracts/test/contracts.test.ts`.

## Verification
- `npm test -w @cloud-harness/contracts`
