# Implementation Plan: Durable Repository, Task, and Artifact State

**Target:** [Issue #14: P2: Make repository, task, and artifact state durable](https://github.com/bestagentkits/cloud-harness-mcp/issues/14)  
**Status:** In Progress (Advisory Incorporated)  
**Dependencies:** Issue #11 (Tool Contract), Issue #13 (Principal Ownership), Issue #109/#110/#111 (Artifact Store)

## Outcome
Add owner-scoped repository records, bounded artifact retention, and recoverable task metadata without weakening checkout or credential isolation.

## Architecture Blueprint (Hardened State Schema v4 & Dual-Tier Engine)
1. **Schema Layer**: `schema_meta` migration v3 -> v4 in `apps/runner/src/state-store.ts` (owned directly where `OperationManager`, `WorkspaceService`, and `ArtifactStore` access `StateStore.database`).
   - Tables: `repo_caches`, `durable_tasks`, `task_dependencies`, and `git_operation_idempotency` with strict `principal_id` foreign keys, request fingerprints, generation fencing, and downgrade support.
   - Error taxonomy additions in `packages/contracts/src/mcp-results.ts` (`UNKNOWN_REMOTE_STATE`, `STALE_HEAD`).
   - Configuration in `packages/contracts/src/config.ts` (`enableRepoCache: false` default-off, `repoCacheRoot`).
2. **Task Durability & Process-Boot Reconciliation**:
   - Ephemeral `runner_boot_id` generated on process start.
   - `OperationManager` writes task metadata to SQLite `durable_tasks` and streams logs to `/job/.chm/tasks/<id>.log` (runner-owned 0700/0600) to eliminate SQLite WAL write contention.
   - Reconcile tasks on startup BEFORE executor restart or workspace deletion: any non-terminal task from a previous `runner_boot_id` transitions to `FAILED` (`error_code: "RUNNER_RESTARTED"`, `finished_at: Date.now()`).
   - Deterministic cursor pagination with byte offset slicing.
3. **Owner-Scoped Repository Cache (Benchmark-Gated)**:
   - Default disabled (`enableRepoCache = false`).
   - Dedicated `RepositoryCacheManager` managing bare mirror clones in `${repoCacheRoot}/${ownerId}/${hash}.git` (`chmod 0700`).
   - Mount exact owner path read-only (`:ro`) and clone with `git clone --reference-if-able <cache_path> --dissociate` ensuring workspace object database becomes 100% independent.
   - Benchmark measurement protocol evaluating cold/warm clone wall-time and disk pressure with automatic safe fallback to blobless independent clone.
4. **Hardened Remote-Git Semantics & Unified Ledger**:
   - `git_operation_idempotency` unified ledger replacing/superseding `finalize_idempotency` and covering `git_push`, `git_commit`, `workspace_finalize` with request fingerprints.
   - Preserves existing CAS `--force-with-lease` in `worker/git-transfer-helper.sh`.
   - Structured error classification: `CONFLICT` (409) vs `UNKNOWN_REMOTE_STATE` (504/409) with actionable `resumeAction: "reconcile_push"`.
   - Unknown-outcome recovery: probe remote ref via `git ls-remote` before re-pushing.
   - `expectedHeadOid` verification for `git_commit`.
5. **Artifact Retention Coordination & MCP Tasks Capability Gate**:
   - Spool task logs to `ArtifactStore` on task settlement or workspace close/reap BEFORE directory deletion.
   - Unified reaper in `WorkspaceService.reapExpired()` coordinating workspace TTL, expired artifacts (`ArtifactStore.reapExpired()`), stale task logs, and unused repo caches (removing redundant timer in `index.ts`).
   - MCP Tasks Compatibility Evaluation: document extension capability matrix (2026-07-28 extension specification) while keeping existing `tasks_run/status/list/cancel/graph` canonical and 100% functional.

## Phases
1. **Phase 1: State Schema Migration v4, Contracts & Configuration** -> [`phase-01-schema-migration-and-contracts.md`](phase-01-schema-migration-and-contracts.md)
   - SQLite migration v3 -> v4 in `state-store.ts` (`durable_tasks`, `task_dependencies`, `repo_caches`, `git_operation_idempotency`)
   - Error taxonomy in `packages/contracts/src/mcp-results.ts`
   - Config schema in `packages/contracts/src/config.ts` and `apps/runner/src/config.ts`
   - Tests: `apps/runner/test/state-schema-v4.test.ts`
2. **Phase 2: Durable Task Lifecycle, File Log Spooling & Boot Reconciliation** -> [`phase-02-durable-task-lifecycle-and-reconciliation.md`](phase-02-durable-task-lifecycle-and-reconciliation.md)
   - `runner_boot_id` per process start
   - SQLite-persisted task records in `OperationManager` with file log streaming
   - Runner startup reconciliation for orphaned/restarted tasks before executor restart/cleanup
   - Cursor-based log reading across restarts
   - Tests: `apps/runner/test/durable-tasks.test.ts`
3. **Phase 3: Owner-Scoped Repository Cache and Benchmark Gate** -> [`phase-03-owner-scoped-repository-cache-and-benchmark.md`](phase-03-owner-scoped-repository-cache-and-benchmark.md)
   - `RepositoryCacheManager` with owner isolation, `:ro` mount and `--dissociate`
   - Benchmark measurement suite with auto-fallback to blobless clone
   - Tests: `apps/runner/test/repository-cache.test.ts`
4. **Phase 4: Remote-Git Unified Idempotency, CAS & Error Taxonomy** -> [`phase-04-remote-git-idempotency-and-error-classification.md`](phase-04-remote-git-idempotency-and-error-classification.md)
   - `git_operation_idempotency` persistence and deduplication with request fingerprint
   - `UNKNOWN_REMOTE_STATE` and `CONFLICT` structured error payload with `resumeAction`
   - Pre-push remote OID probe and recovery
   - `expectedHeadOid` verification on `git_commit`
   - Tests: `apps/runner/test/git-push-durability.test.ts`
5. **Phase 5: Unified Artifact GC, Teardown Safety & MCP Tasks Compatibility** -> [`phase-05-artifact-retention-gc-and-mcp-tasks-facade.md`](phase-05-artifact-retention-gc-and-mcp-tasks-facade.md)
   - Task output spooling to `ArtifactStore` before workspace directory deletion
   - Unified reaper sweep for expired artifacts, tasks, and stale repo caches (removing timer in `index.ts`)
   - MCP Tasks compatibility evaluation report and capability adapter
   - Documentation & architecture updates in `docs/` and `docs-site/`
   - Tests: `apps/runner/test/artifact-retention-integration.test.ts`

## Acceptance Criteria
- [ ] Task metadata and completed outputs survive runner restart; in-flight tasks from prior boot IDs transition to `FAILED` with `error_code: "RUNNER_RESTARTED"`.
- [ ] Retries with same idempotency key cannot silently duplicate a commit or push; mismatched fingerprints reject with `CONFLICT`.
- [ ] Owner repository cache isolates principals (exact owner path `:ro` + `--dissociate`, zero cross-principal access) and falls back safely to independent clone.
- [ ] Unknown-outcome push network errors return structured `UNKNOWN_REMOTE_STATE` with actionable `resumeAction: "reconcile_push"`.
- [ ] State migration v3 -> v4 executes cleanly in atomic transactions with foreign keys enabled.
- [ ] Private credentials never enter executor environment, checkout, artifact, result, or logs.
