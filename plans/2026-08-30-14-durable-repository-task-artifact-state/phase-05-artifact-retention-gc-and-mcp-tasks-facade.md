# Phase 5: Unified Artifact GC, Teardown Safety & MCP Tasks Compatibility

**Status:** Pending  
**Priority:** Medium  
**Dependencies:** Phase 1, Phase 2, Phase 3, Phase 4

## Requirements
- Integrate task output archival with `ArtifactStore`: when task output exceeds 1MB, or when workspace is closed / reaped by TTL, support spooling output into `ArtifactStore` as a snapshot artifact (`task-output-<taskId>.log`) BEFORE workspace directory deletion.
- Coordinate periodic garbage collection: extend runner reaper cycle in `WorkspaceService.reapExpired()` to clean up expired artifacts (`ArtifactStore.reapExpired()`), prune ancient task records (>7 days after workspace close), and prune stale repository caches unused for >14 days. Remove separate redundant artifact timer in `apps/runner/src/index.ts`.
- MCP Tasks Compatibility Evaluation: document extension capability matrix (2026-07-28 extension specification) while keeping existing `tasks_run/status/list/cancel/graph` canonical and 100% functional.
- Maintain 100% backward compatibility for standard tool calls (`tasks_run`, `tasks_status`, `tasks_list`, `tasks_cancel`, `tasks_graph`).
- Update documentation: `docs/mcp-api.md`, `docs/system-architecture.md`, `docs-site/`.

## Files to Modify / Create
- `apps/runner/src/workspace-service.ts` (Modify: Spool task output to ArtifactStore on close/reap before teardown, unified reaper sweep)
- `apps/runner/src/index.ts` (Modify: Remove redundant standalone artifact reaper timer)
- `docs/mcp-api.md` (Modify: Document durable tasks, repo caches, and git semantics)
- `docs/system-architecture.md` (Modify: Update architecture diagram and durable state explanation)
- `apps/runner/test/artifact-retention-integration.test.ts` (Create: Tests for spooling, unified GC, and teardown safety)

## Implementation Steps
1. In `WorkspaceService.closeRecord()`, archive task logs to `ArtifactStore` prior to workspace directory removal.
2. In `reapExpired()`, trigger `artifactStore.reapExpired()` and clean up stale task logs and unreferenced repo caches.
3. Remove standalone reaper timer in `apps/runner/src/index.ts`.
4. Document MCP Tasks extension compatibility matrix.
5. Update developer documentation and official docs site.

## Tests and Validation
- `npm run test:unit`
- `npm run typecheck`
- `npm run lint`
