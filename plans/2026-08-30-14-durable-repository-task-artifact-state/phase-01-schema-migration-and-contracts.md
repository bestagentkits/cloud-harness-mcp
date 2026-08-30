# Phase 1: State Schema Migration v4, Contracts & Configuration

**Status:** Pending  
**Priority:** High  
**Dependencies:** None

## Requirements
- Add Migration v4 to `apps/runner/src/state-store.ts` inside atomic transaction (`BEGIN IMMEDIATE` ... `COMMIT`).
- Create `repo_caches` table for owner-scoped repository cache metadata.
- Create `durable_tasks` and `task_dependencies` tables for durable background task execution state with composite foreign keys.
- Create `git_operation_idempotency` table unifying `finalize_idempotency` and adding `push` / `commit` operation tracking with request fingerprints.
- Add error codes `UNKNOWN_REMOTE_STATE` and `STALE_HEAD` to `packages/contracts/src/mcp-results.ts` and `ErrorCodeSchema`.
- Add `enableRepoCache` (default `false`) and `repoCacheRoot` to `packages/contracts/src/config.ts` and `apps/runner/src/config.ts`.
- Expose contract types in `packages/contracts/src/` for repository caches, durable tasks, and git operation records.

## Files to Modify / Create
- `apps/runner/src/state-store.ts` (Modify: Add v4 schema migration, tables, queries)
- `packages/contracts/src/mcp-results.ts` (Modify: Add `UNKNOWN_REMOTE_STATE`, `STALE_HEAD` error codes)
- `packages/contracts/src/config.ts` (Modify: Add `enableRepoCache`, `repoCacheRoot` to `RunnerConfigSchema`)
- `apps/runner/src/config.ts` (Modify: Load repo cache options from env)
- `packages/contracts/src/tool-schemas.ts` (Modify: Schema validation updates)
- `apps/runner/test/state-schema-v4.test.ts` (Create: Unit tests for v4 migration, foreign keys, constraints, and indexes)

## Implementation Steps
1. Define table DDLs for `repo_caches`, `durable_tasks`, `task_dependencies`, `git_operation_idempotency` in `state-store.ts`.
2. Update `schema_meta` version check from v3 to v4.
3. Update error codes and config schemas in contracts.
4. Add comprehensive unit tests in `apps/runner/test/state-schema-v4.test.ts`.

## Tests and Validation
- `npm run test:unit apps/runner/test/state-schema-v4.test.ts`
