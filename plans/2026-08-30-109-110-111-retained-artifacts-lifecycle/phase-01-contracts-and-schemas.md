# Phase 1: Contracts and Schemas

## Context Links
- [`packages/contracts/src/runner-api.ts`](../../packages/contracts/src/runner-api.ts)
- [`packages/contracts/src/tool-schemas.ts`](../../packages/contracts/src/tool-schemas.ts)
- [`packages/contracts/src/internal-runner-api.ts`](../../packages/contracts/src/internal-runner-api.ts)

## Requirements
1. Update `RunnerOperationSchema` in `runner-api.ts` to include the 5 public MCP tools:
   - `artifacts_snapshot`
   - `artifacts_list`
   - `artifacts_read`
   - `artifacts_restore`
   - `artifacts_delete`
2. Define input schemas and ToolSpec definitions in `tool-schemas.ts`:
   - `artifacts_snapshot`: `{ workspaceId?: string, path: string, logicalName: string, retentionSeconds?: number }`
   - `artifacts_list`: `{ cursor?: string, limit?: number }`
   - `artifacts_read`: `{ artifactId: string, offset?: number, limit?: number }`
   - `artifacts_restore`: `{ artifactId: string, workspaceId?: string, path: string, overwrite?: boolean, expectedSha256?: string }`
   - `artifacts_delete`: `{ artifactId: string, expectedGeneration?: number }` (or `generation` / default 1 if omitted)
   - Tool titles, descriptions, and annotations:
     - `artifacts_list`: readOnly: true, destructive: false, idempotent: true, openWorld: false
     - `artifacts_read`: readOnly: true, destructive: false, idempotent: true, openWorld: false
     - `artifacts_snapshot`: readOnly: false, destructive: false, idempotent: false, openWorld: false
     - `artifacts_restore`: readOnly: false, destructive: true, idempotent: false, openWorld: false
     - `artifacts_delete`: readOnly: false, destructive: true, idempotent: false, openWorld: false
3. Update `internal-runner-api.ts`:
   - Extend `MetadataRunnerOperationSchema` with `artifact_read` and `artifact_restore`.
   - Define metadata input schemas for `artifact_read` and `artifact_restore`.

## Validation
- `npm run typecheck`
- `packages/contracts/test/tool-schemas.test.ts`
