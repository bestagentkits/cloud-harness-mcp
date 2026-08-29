# Phase 2: Runner Artifact Primitives & Restore

## Context Links
- [`apps/runner/src/artifact-store.ts`](../../apps/runner/src/artifact-store.ts)
- [`apps/runner/src/artifact-storage-paths.ts`](../../apps/runner/src/artifact-storage-paths.ts)
- [`apps/runner/src/workspace-service.ts`](../../apps/runner/src/workspace-service.ts)
- [`apps/runner/src/dashboard-control-service.ts`](../../apps/runner/src/dashboard-control-service.ts)
- [`apps/runner/src/bounded-workspace-file-reader.ts`](../../apps/runner/src/bounded-workspace-file-reader.ts)

## Requirements
1. **ArtifactStore Extensions:**
   - Add `read(principalId: string, input: { artifactId: string; offset?: number; limit?: number; now?: number })`:
     - Looks up artifact row by owner and non-expired.
     - Resolves canonical object path in `ArtifactStoragePaths`.
     - Validates safe existing file.
     - Reads bounded slice (`offset`, `limit` up to max bound).
     - Returns `{ artifactId, logicalName, offset, bytesReturned, totalBytes, sha256, eof, content }`.
   - Add `readPayload(principalId: string, artifactId: string, now?: number)`:
     - Returns full payload buffer after verifying owner, expiry, and sha256.
2. **WorkspaceService & Restore Primitives:**
   - Implement `restoreArtifact(principal: PrincipalSelector | string, input: { artifactId: string; workspaceId?: string; path: string; overwrite?: boolean; expectedSha256?: string })`:
     - Resolves principal ownerId.
     - Resolves and verifies target workspace is active and owned by caller.
     - Resolves artifact from `ArtifactStore` under same ownerId.
     - Checks `expectedSha256` if provided.
     - Validates destination path inside workspace repository root (no traversal / symlink escapes).
     - If destination exists and `overwrite !== true`, rejects with `CONFLICT`.
     - Atomically writes payload into destination path in workspace.
     - Records `artifact.restored` audit event.
     - Returns `{ artifactId, workspaceId, path, sizeBytes, sha256 }`.
   - Pass `artifacts: ArtifactStore` into `WorkspaceService` constructor so it can service public MCP artifact operations (`artifacts_snapshot`, `artifacts_list`, `artifacts_read`, `artifacts_restore`, `artifacts_delete`).
   - Implement handlers in `WorkspaceService.execute()` for all 5 public artifact operations.
3. **DashboardControlService:**
   - Implement `artifact_read` and `artifact_restore` handlers delegating to `ArtifactStore` and `WorkspaceService.restoreArtifact()`.

## Validation
- `apps/runner/test/artifact-store.test.ts`
- `apps/runner/test/dashboard-control-service.test.ts`
- `apps/runner/test/workspace-service.test.ts`
