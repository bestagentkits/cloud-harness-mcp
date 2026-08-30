# Phase 4: Scoped SQLite Memories, StateStore v5 & Atomic Audit

## Context Links
- Plan: `plans/260830-0700-15-provenance-aware-workspace-context-skills-memories-hooks/plan.md`
- Code: `apps/runner/src/state-store.ts`, `apps/runner/src/metadata-store.ts`, `apps/runner/src/principal-store.ts`, `apps/runner/src/workspace-service.ts`

## Requirements
- State Schema v5 Transactional Migration in `StateStore`:
  - Extend migration ladder to version 5 in `StateStore` (keeping metadata schema distinct)
  - Create table `memories`:
    - `id TEXT PRIMARY KEY`
    - `principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT`
    - `scope TEXT NOT NULL CHECK (scope IN ('owner','repository','workspace'))`
    - `repository_key TEXT` (derived from canonical repository URL hash)
    - `workspace_id TEXT`
    - `name TEXT NOT NULL`
    - `content TEXT NOT NULL`
    - `content_sha256 TEXT NOT NULL`
    - `generation INTEGER NOT NULL CHECK (generation > 0)`
    - `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`, `expires_at INTEGER NOT NULL`, `deleted_at INTEGER`
    - `provenance_json TEXT NOT NULL`
    - `CHECK ((scope='owner' AND repository_key IS NULL AND workspace_id IS NULL) OR (scope='repository' AND repository_key IS NOT NULL AND workspace_id IS NULL) OR (scope='workspace' AND workspace_id IS NOT NULL))`
  - Create table `memory_tags`:
    - `(principal_id, memory_id, tag)` PRIMARY KEY, foreign key to `memories(id)`
  - Create table `hook_activations`:
    - `(principal_id, workspace_id, event)` PRIMARY KEY, `manifest_sha256 TEXT NOT NULL`, `created_at INTEGER`, `expires_at INTEGER`
  - Create partial unique indexes for active memory names per scope
- Canonical Repository Key:
  - Derive stable `repository_key` using existing normalized repository URL hash utility (`apps/runner/src/repository-cache-manager.ts`)
- Scopes & Lifecycles:
  - `owner`: Principal-wide, persistent across all workspaces
  - `repository`: Scoped to `(principal_id, repository_key)`, persistent across workspaces for that repo
  - `workspace`: Scoped to `(principal_id, workspace_id)`, reaped upon workspace termination
- Optimistic Concurrency Control (CAS):
  - `expectedGeneration: 0`: Create only if absent (fails with `CONFLICT` if already exists)
  - `expectedGeneration > 0`: Update/delete exact generation (fails with `CONFLICT` if stale)
- Operations & Audit Baseline (#10):
  - `memories_write`: Writes memory and emits `memory.created`/`memory.updated` audit event in same transaction
  - `memories_read`: Read memory with opportunistic expiry check
  - `memories_list`: List active memories by scope and tags
  - `memories_search`: Literal token query search across name and content with tag filter
  - `memories_delete`: Delete with `expectedGeneration` and emit `memory.deleted` audit event
  - Audit payloads record IDs, scope, generation, hashes, and counts only—never raw memory text or secrets
- Retention & TTL:
  - Sweeper marks/purges expired rows
  - Workspace close reaps workspace-scoped records

## Files to Modify/Create
- `apps/runner/src/state-store.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/test/memories-scoped-store.test.ts` (new test file)
- `apps/runner/test/workspace-audit.test.ts`

## Implementation Steps
1. Add state schema v5 migration in `StateStore` (`state-store.ts`) creating `memories`, `memory_tags`, and `hook_activations`.
2. Implement memory CRUD, search, TTL reaping, and CAS methods in `StateStore`.
3. Wire `memories_list`, `memories_read`, `memories_write`, `memories_search`, `memories_delete` in `WorkspaceService`.
4. Integrate atomic audit event emission via `MetadataStore.recordAuditEvent`.
5. Add comprehensive unit tests for principal isolation, CAS concurrency, TTL expiration, and workspace cleanup.

## Tests & Validation
- `npm test apps/runner/test/memories-scoped-store.test.ts`
- `npm test apps/runner/test/workspace-audit.test.ts`
- Verify cross-principal isolation and CAS concurrency.
