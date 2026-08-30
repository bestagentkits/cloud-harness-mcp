# Phase 3: Owner-Scoped Repository Cache and Benchmark Gate

**Status:** completed
**Priority:** High  
**Dependencies:** Phase 1

## Requirements
- Implement `RepositoryCacheManager` in `apps/runner/src/repository-cache-manager.ts` providing owner-scoped bare mirror repository caching (`${repoCacheRoot}/${ownerId}/${hash}.git`).
- Default-off via `enableRepoCache = false` in `packages/contracts/src/config.ts`.
- Ensure strict tenant isolation: permissions `chmod 0700`, exact owner path isolation per principal, mount exact cache directory as `:ro` and clone with `git clone --reference-if-able <cache_path> --dissociate`.
- The `--dissociate` flag guarantees the workspace repository object database becomes completely independent after clone, leaving zero alternates links.
- Implement an offline benchmark measurement protocol evaluating clone latency and disk pressure, automatically falling back to blobless independent clone (`--filter=blob:none --depth 1`) if the cache fails or is disabled.
- Integrate cache management into `WorkspaceService.open()` behind `enableRepoCache` check.

## Files to Modify / Create
- `apps/runner/src/repository-cache-manager.ts` (Create: Bare mirror cache manager, `--dissociate` clone helper, benchmark logic)
- `apps/runner/src/workspace-service.ts` (Modify: Integrate repository cache into workspace provisioning behind flag)
- `apps/runner/test/repository-cache.test.ts` (Create: Tests for cache creation, dissociation, zero cross-principal leak, fallback)

## Implementation Steps
1. Create `RepositoryCacheManager` managing bare mirror clones in `${repoCacheRoot}/${ownerId}/${sha256(url)}.git`.
2. Implement safe lock mechanism (`flock` or file lock) to prevent concurrent cache updates for the same owner and URL.
3. Update `initWorkspaceRepo` or `clone-helper.sh` to use `--reference-if-able` and `--dissociate` when cache path is provided.
4. Add benchmark comparison utility measuring wall-clock clone time and disk usage across 3 scenarios: fresh blobless clone, reference-dissociate clone, and cached clone.
5. Add rigorous unit tests verifying that Principal B cannot access or modify Principal A's cache.

## Tests and Validation
- `npm run test:unit apps/runner/test/repository-cache.test.ts`
