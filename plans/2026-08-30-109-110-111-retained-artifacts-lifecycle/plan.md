# Retained Artifact Lifecycle: Bounded Read, Workspace Restore, and Public MCP Tools (Issues #109, #110, #111)

Status: Completed
Mode: Official Stable (`--ship`)
Route: Feature
Issues: #109, #110, #111
Branch: `mrgoonie/Fix-109-110-111`

## Goal

Provide a complete, secure, principal-isolated, and bounded lifecycle for retained artifact snapshots across Cloud Harness MCP:
1. **Issue #109:** Bounded artifact read and dashboard download support (`artifact_read`, `GET /api/v1/artifacts/:artifactId/download`, `ArtifactStore.read()`, safe byte slicing, sha256 verification).
2. **Issue #110:** Runner-mediated artifact restore into active workspaces (`artifact_restore`, path confinement, overwrite protection, hash verification, quota enforcement, immutable source provenance, `artifact.restored` audit event).
3. **Issue #111:** Public MCP tools for artifacts (`artifacts_snapshot`, `artifacts_list`, `artifacts_read`, `artifacts_restore`, `artifacts_delete`), tool annotations, schema validation, skill reference update, and docs synchronization.

## Architecture & Security Boundaries

- **Principal Isolation:** All artifact lookups, listings, reads, restores, and deletions enforce principal ownership. Nonexistent, expired, and cross-principal artifacts return indistinguishable `NOT_FOUND` errors without information leakage.
- **Path Confinement & Containment:** Artifact storage paths stay runner-confined and are never mounted directly into workspace executors. Restoring an artifact into a workspace uses runner-mediated file writing within the canonical repository root with strict symlink and path traversal escape checks.
- **Overwrite & Quota Guards:** Restoring requires explicit `overwrite: true` if the destination path already exists. Writes remain bounded by workspace storage quotas.
- **Provenance Immutability:** Restoring an artifact into another workspace does not mutate original artifact metadata (`projectId`, `environmentId`, `workspaceId`). A distinct `artifact.restored` audit event is emitted.
- **Bounded MCP Operations:** MCP tool reads default to 64 KiB chunks with continuation cursors and max read limits. Public responses never expose internal host storage paths.

## Phases

- [Phase 1: Contracts and Schemas](phase-01-contracts-and-schemas.md) - Define MCP tool schemas, internal runner requests/responses, annotations, and contracts.
- [Phase 2: Runner Artifact Primitives & Restore](phase-02-runner-artifact-primitives-and-restore.md) - Implement bounded payload reads, workspace restore with path confinement and overwrite protection, and audit events in `ArtifactStore` and `WorkspaceService`.
- [Phase 3: API MCP Server & Dashboard UI](phase-03-api-mcp-tools-and-dashboard.md) - Expose public MCP tools in `mcp-server.ts`, register dashboard API endpoints (`artifact_read`, `artifact_restore`, artifact download), and add UI Download action.
- [Phase 4: Tests and Verification](phase-04-tests-and-verification.md) - Comprehensive unit, contract, runner, API, and integration test coverage.
- [Phase 5: Documentation and Sync](phase-05-documentation-and-sync.md) - Update MCP API docs, docs-site reference, installable Cloud Harness skill, and run sync scripts.

## Acceptance Criteria

- [x] Unexpired owned artifacts can be read in bounded chunks with offset, limit, totalBytes, bytesReturned, sha256, eof, and content.
- [x] Dashboard users can download retained artifacts with safe `Content-Disposition`.
- [x] Unexpired owned artifacts can be restored into active owned workspaces.
- [x] Restoring checks path confinement and fails on symlink/directory traversal escapes.
- [x] Restoring refuses to overwrite existing files unless `overwrite: true` is set.
- [x] Restoring validates `expectedSha256` if provided.
- [x] Original artifact provenance remains immutable, and `artifact.restored` is recorded in audit logs.
- [x] 5 public MCP tools (`artifacts_snapshot`, `artifacts_list`, `artifacts_read`, `artifacts_restore`, `artifacts_delete`) are exposed with accurate tool annotations.
- [x] Cross-principal operations fail with constant `NOT_FOUND` without leaking presence.
- [x] Internal host filesystem paths are never exposed in public tool responses or API payloads.
- [x] All tests pass via `npm run verify`, `npm run verify:compose`, `npm run docs:check`.
- [x] Skill files and documentation are fully synchronized and validated.
