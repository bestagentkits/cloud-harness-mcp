# Phase 4: Tests and Verification

## Context Links
- [`apps/runner/test/artifact-store.test.ts`](../../apps/runner/test/artifact-store.test.ts)
- [`apps/runner/test/dashboard-control-service.test.ts`](../../apps/runner/test/dashboard-control-service.test.ts)
- [`apps/api/test/mcp-server.test.ts`](../../apps/api/test/mcp-server.test.ts)
- [`test/integration/`](../../test/integration/)

## Requirements
1. **Runner Unit Tests:**
   - Test `ArtifactStore.read()`:
     - Bounded offset and limit reads.
     - Reading past total size returns eof with 0 bytes.
     - SHA-256 and content matching.
     - Nonexistent and expired artifacts throw `NOT_FOUND`.
     - Cross-principal artifact reads throw `NOT_FOUND` without leaking existence.
   - Test `WorkspaceService` and `DashboardControlService` artifact restoration:
     - Restore into active workspace.
     - Reject restore into non-existent or expired workspace.
     - Reject cross-principal restore.
     - Path traversal (`../`, absolute paths, symlink escapes) rejected.
     - Overwrite prevention when destination file exists unless `overwrite: true`.
     - Hash mismatch when `expectedSha256` does not match artifact SHA-256.
     - Emits `artifact.restored` audit event.
     - Verifies original artifact provenance is unchanged.
2. **API & Contract Tests:**
   - Test all 5 public MCP artifact tools (`artifacts_snapshot`, `artifacts_list`, `artifacts_read`, `artifacts_restore`, `artifacts_delete`).
   - Test tool annotations (readOnly, destructive, idempotent).
   - Test dashboard download endpoint headers (`Content-Disposition`, `Content-Type`).
3. **Repository Gates:**
   - `npm run verify`
   - `npm run verify:compose`
   - `npm run docs:check`

## Validation
- Complete test suite passes with zero failures.
