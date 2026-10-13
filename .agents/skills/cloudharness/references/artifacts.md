# Retained artifacts

Use retained artifacts to preserve selected workspace files beyond ephemeral
workspace lifetimes, list and read bounded chunks of retained outputs, and restore
snapshots into active workspaces for cross-session and cross-agent handoffs.

Artifacts are principal-owned, TTL-retained snapshots. They are not Git history,
not volatile task/session buffers, and not generic object storage.

## Tools

<!-- cloudharness-tool:artifacts_snapshot -->
### `artifacts_snapshot`

Preserve one workspace file as a principal-owned, TTL-retained artifact snapshot.

- Required: `path` (workspace-relative), `logicalName` (1–128 ASCII alphanumeric, `_`, `.`, `-`).
- Optional: `workspaceId`, `retentionSeconds` (60..2,592,000; defaults to server retention).
- Returns: `{ artifactId, logicalName, sha256, sizeBytes, projectId, environmentId, workspaceId, createdAt, updatedAt, expiresAt, retentionMs, generation }`.

<!-- cloudharness-example:artifacts_snapshot
{
  "workspaceId": "ws_123456789012345678901234",
  "path": "dist/bundle.js",
  "logicalName": "bundle.js",
  "retentionSeconds": 86400
}
-->

<!-- cloudharness-tool:artifacts_list -->
### `artifacts_list`

List principal-owned retained artifact snapshots with bounded cursor pagination.

- Optional: `cursor`, `limit` (1..100; defaults to 50).
- Returns: `{ artifacts: ArtifactMetadata[] }` and optional continuation `cursor`.

<!-- cloudharness-example:artifacts_list
{
  "limit": 20
}
-->

<!-- cloudharness-tool:artifacts_read -->
### `artifacts_read`

Read a bounded chunk of base64-encoded bytes from an unexpired principal-owned artifact.

- Required: `artifactId` (opaque `art_...` handle).
- Optional: `offset` (defaults to 0), `limit` (1..1,048,576; defaults to 65,536).
- Returns: `{ artifactId, logicalName, offset, bytesReturned, totalBytes, sha256, eof, content }`.
- `content` is base64-encoded to preserve binary file integrity.

<!-- cloudharness-example:artifacts_read
{
  "artifactId": "art_12345678901234567890123456789012",
  "offset": 0,
  "limit": 65536
}
-->

<!-- cloudharness-tool:artifacts_restore -->
### `artifacts_restore`

Restore an unexpired principal-owned artifact into an active workspace file.

- Required: `artifactId`, `path` (destination workspace-relative path).
- Optional: `workspaceId`, `overwrite` (defaults to false), `expectedSha256` (64-hex SHA-256).
- Rejects overwrite with `CONFLICT` unless `overwrite: true` is explicitly passed.
- Returns: `{ artifactId, workspaceId, path, sizeBytes, sha256 }`.

<!-- cloudharness-example:artifacts_restore
{
  "workspaceId": "ws_123456789012345678901234",
  "artifactId": "art_12345678901234567890123456789012",
  "path": "context/bundle.js",
  "overwrite": true
}
-->

<!-- cloudharness-tool:artifacts_delete -->
### `artifacts_delete`

Delete an unexpired principal-owned retained artifact before its retention expiry.

- Required: `artifactId`.
- Optional: `expectedGeneration` (defaults to 1).
- Returns: deleted `ArtifactMetadata`.

<!-- cloudharness-example:artifacts_delete
{
  "artifactId": "art_12345678901234567890123456789012",
  "expectedGeneration": 1
}
-->

## Cross-session handoff workflow

```text
Session A (Workspace A)
  -> write output to output/summary.json
  -> artifacts_snapshot(path: "output/summary.json", logicalName: "summary.json")
  -> workspace_close

Session B (Workspace B)
  -> artifacts_list()
  -> artifacts_restore(artifactId: "art_...", path: "context/summary.json")
  -> continue work with context/summary.json
```
