---
phase: 2
title: "Runner CAS, Cache Manager & State Schema Migration"
status: pending
priority: P1
effort: "2.5d"
dependencies: ["phase-01-contracts-schemas-and-secret-purpose.md"]
---

# Phase 2: Runner CAS, Cache Manager & State Schema Migration

## Overview
Implement the runner-side Content-Addressed Storage (CAS) engine, configure the durable runner `TOOLKIT_CACHE_ROOT` volume and configuration contracts (analogous to `REPO_CACHE_ROOT`), execute transactional SQLite state store migrations in `apps/runner/src/principal-store.ts` (Schema v5 $\rightarrow$ v6) with downgrade rollback support, and establish durable fsync-ordered CAS publication.

<!-- red-team-applied: Findings 1, 4, 5, 8, 9, 10, 11, 13, 14, 18, 19 -->

## Requirements
- Functional:
  - Add `toolkitCacheRoot` (default: `/var/lib/cloud-harness/cache/toolkits`) and `toolkitNetworkPolicy` (`'cache-only' | 'runner-fetch'`, default: `'cache-only'`) to `packages/contracts/src/config.ts` and `apps/runner/src/config.ts`.
  - Add host and container volume mappings for `TOOLKIT_CACHE_ROOT` in `compose.yaml`, `compose.production.yaml`, and `.env.example`.
  - In `apps/runner/src/principal-store.ts`, implement transactional migration from Schema v5 to v6:
    - Add `request_fingerprint TEXT` column to `workspaces`.
    - Create `toolkit_cache_entries` table with `owner_id REFERENCES principals(id)` and status machine (`INITIALIZING`, `READY`, `FAILED`).
    - Create `workspace_toolkits` table with composite foreign key `(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE`.
    - Implement `downgradeStateSchemaToV5(database, allowDataLoss)`.
  - Implement `ToolkitCacheManager` in `apps/runner/src/toolkit-cache-manager.ts`:
    - Storage root: `config.toolkitCacheRoot` (runner-owned persistent volume).
    - Compute deterministic cache keys from `(ownerId, sourceIdentity, resolvedRevision, adapterVersion, configDigest)`.
    - Concurrency & lock ordering: acquire key-level lock before database query, avoiding deadlocks.
    - Staged bundle validation: size limits, file counts, directory traversal checks, symlink escapes.
    - Durable publication: fsync individual files $\rightarrow$ fsync manifest $\rightarrow$ fsync staging dir $\rightarrow$ atomic rename $\rightarrow$ fsync parent dir $\rightarrow$ commit SQLite `READY` status.
    - Mark-and-sweep garbage collection: query live `workspace_toolkits` references directly from SQLite; never rely on mutable in-memory refcounts.
- Non-functional:
  - Cache operations are crash-safe: startup reconciliation scans for uncommitted staging directories and reconciles expired `INITIALIZING` rows.
  - Proprietary and private toolkit entries are partitioned by `ownerId` (no cross-tenant leakage).

## Architecture
```text
Durable Host / Runner Volume Contract
  ├── REPO_CACHE_ROOT:    /var/lib/cloud-harness/cache/repos
  └── TOOLKIT_CACHE_ROOT: /var/lib/cloud-harness/cache/toolkits
        ├── staging/<tempId>/                     (Write, Scan & Fsync)
        └── <ownerId>/<bundleSha256>/             (Immutable Published CAS)

StateStore (Transactional v5 -> v6 in principal-store.ts)
  ├── Alter: workspaces (add request_fingerprint)
  ├── Table: toolkit_cache_entries (cache_key PK, owner_id FK, source, revision, bundle_sha256, status, bytes)
  └── Table: workspace_toolkits (workspace_id, ordinal, owner_id FK, toolkit_id, scope, requested_json, resolved_json, bundle_sha256)
```

## Related Code Files
- Modify: `packages/contracts/src/config.ts` (add `toolkitCacheRoot`, `toolkitNetworkPolicy`)
- Modify: `apps/runner/src/config.ts` (add `toolkitCacheRoot`, `toolkitNetworkPolicy`)
- Modify: `.env.example` (add `TOOLKIT_CACHE_ROOT` and `HOST_TOOLKIT_CACHE_ROOT`)
- Modify: `compose.yaml` and `compose.production.yaml` (add runner volume mount)
- Modify: `apps/runner/src/principal-store.ts` (implement v5 $\rightarrow$ v6 migration & v6 $\rightarrow$ v5 downgrade)
- Modify: `apps/runner/src/state-store.ts` (add toolkit persistence methods)
- Create: `apps/runner/src/toolkit-cache-manager.ts`
- Create: `apps/runner/test/toolkit-cache-manager.test.ts`
- Create: `apps/runner/test/state-schema-v6.test.ts`

## Implementation Steps
1. Add configuration schema in `packages/contracts/src/config.ts` and `apps/runner/src/config.ts`:
   ```typescript
   toolkitCacheRoot: z.string().default('/var/lib/cloud-harness/cache/toolkits'),
   toolkitNetworkPolicy: z.enum(['cache-only', 'runner-fetch']).default('cache-only'),
   ```
2. Update `.env.example`, `compose.yaml`, and `compose.production.yaml` with `TOOLKIT_CACHE_ROOT`.
3. In `apps/runner/src/principal-store.ts`, implement v5 $\rightarrow$ v6 migration:
   ```sql
   ALTER TABLE workspaces ADD COLUMN request_fingerprint TEXT;

   CREATE TABLE IF NOT EXISTS toolkit_cache_entries (
     cache_key TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
     source_identity TEXT NOT NULL,
     resolved_revision TEXT NOT NULL,
     adapter_version INTEGER NOT NULL,
     bundle_sha256 TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('INITIALIZING', 'READY', 'FAILED')),
     byte_count INTEGER NOT NULL,
     file_count INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL,
     error_summary TEXT
   );
   CREATE INDEX IF NOT EXISTS toolkit_cache_owner_lookup ON toolkit_cache_entries(owner_id, bundle_sha256);

   CREATE TABLE IF NOT EXISTS workspace_toolkits (
     workspace_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
     toolkit_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     requested_json TEXT NOT NULL,
     resolved_json TEXT NOT NULL,
     bundle_sha256 TEXT NOT NULL,
     PRIMARY KEY(workspace_id, ordinal),
     FOREIGN KEY(owner_id, workspace_id) REFERENCES workspaces(owner_id, id) ON DELETE CASCADE
   );
   CREATE INDEX IF NOT EXISTS ws_toolkits_owner_ws ON workspace_toolkits(owner_id, workspace_id);
   ```
4. Implement `downgradeStateSchemaToV5()` in `apps/runner/src/principal-store.ts`.
5. Implement `ToolkitCacheManager` in `apps/runner/src/toolkit-cache-manager.ts`:
   - `getOrAcquire(ownerId, spec, acquireFn): Promise<CachedToolkitBundle>`
   - `publishBundle(stagingDir, ownerId, metadata): Promise<string>` with full fsync ordering.
   - `reconcileStartup()`: cleans orphaned staging directories and resets stale `INITIALIZING` records to `FAILED`.
   - `garbageCollect(ownerId, maxBytesQuota)`: performs mark-and-sweep using SQL subquery checking active workspaces.
6. Write test suite in `apps/runner/test/toolkit-cache-manager.test.ts` and `apps/runner/test/state-schema-v6.test.ts`:
   - Test transactional migration and rollback v6 $\leftrightarrow$ v5.
   - Test concurrent acquisition single-flight locking.
   - Test durable fsync publication and crash recovery reconciliation.
   - Test mark-and-sweep GC does not delete bundles referenced by active workspaces.

## Success Criteria
- [ ] Schema v6 migration and v6 $\rightarrow$ v5 downgrade pass test suite.
- [ ] `ToolkitCacheManager` passes concurrency, fsync durability, and GC tests.
- [ ] Compose boundary verification passes (`npm run verify:compose`).

## Risk Assessment
- *Risk:* Crash occurs between staging rename and SQLite commit.
  - *Mitigation:* Startup reconciliation validates directory digests against `READY` rows and removes unindexed/corrupt directories.
