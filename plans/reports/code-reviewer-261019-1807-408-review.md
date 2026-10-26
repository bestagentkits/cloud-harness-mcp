# Code Review: feat/408-dynamic-repositories vs origin/dev

## Scope
- Diff: `git diff origin/dev...HEAD` (plans/ excluded), 43 files, +2367/-152
- Focus: runner add/remove/search/artifacts (`apps/runner/src/workspace-service.ts`, `state-store.ts`, `operation-manager.ts`, `artifact-store*.ts`), contracts, dashboard routes and UI, docs and skill mirror
- Verification run: 7 focused suites (dynamic-repositories, multi-repository-workspaces, dashboard-multi-repository, dashboard-ui-contract, multi-repository-contracts, local-workspace-backend, cloudharness-skill-contract), 161/161 passed. `tsc --noEmit` for runner and api is clean. `.agents/skills/cloudharness` and `plugins/cloud-harness/skills/cloudharness` are byte-identical.
- Scout targets: the host-side recursive delete while the executor is still running, the unsaved-work check racing the delete, how the worker reports truncation, the fence and lease ordering, dashboard escaping and CSRF.

## Overall Assessment
The registry transaction, generation fence, replay table and selector plumbing hold up. Escaping on the dashboard and the public contract for single-repository workspaces are unchanged and correct. The main defect is new: this is the first time the privileged runner deletes, host-side, a directory that a live executor can write to. The existing path checks are separate from the delete, so a racing process can bypass them. I found one high and two medium issues.

## Critical Issues
None.

## High Priority

### H1. Host-side `rm -rf` of an executor-writable checkout while the executor is running (symlink TOCTOU)
- `apps/runner/src/workspace-service.ts:2587` (remove), `:2537` (add rollback), `:953` / `:959` (clone retry inside `clone()`, now reached from add with no verification at all), `:5434` (`safeRemovePath` → `rm(target, { recursive: true })`)
- **Why it is new:** close and failed-open delete the tree only after the executor and its processes are stopped (`closeRecord` → `operations.stopWorkspace` first; on open the executor does not exist yet). `workspace_repo_remove` and the add rollback delete `repo/repos/<alias>` while the executor container keeps running. That container has `/workspace` mounted read-write and runs arbitrary repository-controlled code. The runner runs as root (no `USER` in `docker/runner.Dockerfile`) and holds the state DB, artifact root and Docker socket mounts.
- **Why the checks don't help:** `verifiedCheckoutPath` and `safeRemovePath` both check with `lstat`/`realpath`, then hand the unresolved path string to `fs.promises.rm`. Node 24's promises `rm` uses the JS rimraf: `lstat`, then `rmdir`, then `readdir(path)` and recursion over `join(path, child)`. Every step resolves the path again, so intermediate symlinks are followed.
- **Failure scenario:** a process in the executor loops on `mv repos/docs/src x; ln -s /var/lib/cloud-harness/state repos/docs/src`. You could also swap `repos` itself after the check. When the owner calls `workspace_repo_remove docs` while the checkout is clean, the runner's recursive delete descends through the link and unlinks files in the runner's namespace, such as the SQLite state, artifacts, or other workspaces' jobs. The jobs-root `realpath` guard in `safeRemovePath` runs before the race and does not stop it. The same applies to the clone-retry `safeRemovePath(repositoryPath)` during add: that path goes through the executor-controlled `repos/` with no prior verification. This breaks the AGENTS.md invariant "scope cleanup by the verified workspace identity, canonical job path".
- **Fix (pick one):**
  - (a) Pause or freeze the executor for the whole verify-and-delete window (`docker pause <container>`, unpausing in a `finally`). Also refuse when any process is attached.
  - (b) Never delete executor-writable trees from the runner. First `rename()` the checkout into a quarantine directory under `workspacePath` that is outside the executor's `/workspace` mount. Then check that the moved entry's `dev`/`ino` match the `lstat` taken during verification. Then delete it inside a disposable `--network none --user 10001:10001 --read-only` helper with only that quarantine directory mounted, so links resolve inside the helper's mount namespace.

  Apply the same treatment to the add rollback and to the two clone-retry removals. For those, use `verifiedCheckoutPath` plus the quarantine-and-delete step, or skip the cleanup and let the outer rollback do it.
- **Tests:** none cover a swap between verification and deletion. Add a test that replaces a subdirectory with a symlink pointing outside the jobs root after `verifiedCheckoutPath` resolves (for example a spy on `realpath` that swaps), then asserts the target outside survives.

## Medium Priority

### M1. Remove can delete unsaved work: the "in use" test only looks at cwd, and the unsaved-work check is not atomic with the delete
- `apps/runner/src/workspace-service.ts:2553-2587`, `apps/runner/src/operation-manager.ts:1128,1132` (`insideTreePath(record.cwd, subpath)`)
- **Failure scenario:** a dashboard terminal, `shell_open` or `exec_run` started at the tree root (cwd `.`), or any background process left by an earlier command, is not counted as a user of `repos/docs`. `checkoutCloseBlocker` reports clean. During the gap (two awaits plus the registry write), that shell writes `repos/docs/notes.md` or commits locally, and `safeRemovePath` then deletes it. The tool returns `ok`. This contradicts `docs/security-model.md:509` ("so it cannot discard work the owner did not save") and the matching `docs/mcp-api.md` text.
- **Fix:** the H1(b) quarantine rename closes the gap. Run the close check against the renamed directory. If it is not clean, rename it back and refuse. Alternatively, pause the executor across check-and-delete (H1(a)). Short of that, soften both docs to say that only operations started inside the checkout are detected.

### M2. Cross-repository `grep_search` under-reports truncation, so results are lost silently
- `apps/runner/src/workspace-service.ts:2677` (`items.length > budget`), `worker/harness-worker.mjs:1149`
- **Cause:** the worker's `grep_search` slices to `maxResults` and sets `truncated` only when rg output hits the 256 KiB byte cap. So `items.length > budget` can never be true, and `response.truncated` stays false when matches were cut. `symbols_search` and `symbols_references` do report this correctly.
- **Failure scenario:** `grep_search {scope:"all", maxResults:100}`. Checkout `api` has 400 matches and is last in the order, or the cursor already points at it. The worker returns 100 and `truncated:false`. The response says `truncated:false`, has no cursor, and the summary shows `api {results:100, truncated:false}`. The caller treats 100 of 400 as the full set. When `api` is not last, the cursor skips past it while its summary still says `truncated:false`. So the documented rule "a checkout cut short ... narrow it with repositoryId" is never triggered.
- **Fix:** have the worker report `truncated: result.truncated || lines.length > maxResults`, as `symbols_references` does. Or have the runner treat `items.length >= budget` as truncated for `grep_search`. Add a test using the real worker semantics: more lines than the budget, worker returns `truncated:false`.

## Low Priority

### L1. A "failed add removes only the directory it created" is not strictly true
- `apps/runner/src/workspace-service.ts:2502-2527`. `assertCheckoutPathFree` and the clone are separate steps. If the executor (or an agent's shell) creates `repos/<alias>/` with content in between, the clone fails on a non-empty directory and the rollback recursively deletes the executor-created data. The impact is small (data written in the race window), but the docs claim this rollback cannot happen. To fix: record the `dev`/`ino` of the directory the clone created, and roll back only when it matches. Or treat a clone failure caused by a non-empty target as a conflict with no cleanup.

### L2. The comment contradicts the behaviour
- `apps/runner/src/workspace-service.ts` field `repositoryChanges`: the comment says "a second change waits for the first", but the code returns a retryable `CONFLICT` immediately. The docs describe the actual behaviour. Fix the comment.

## Edge Cases Found by Scout (verified non-issues)
- Two concurrent adds: serialized in-process by `repositoryChanges`, and the registry transaction rechecks alias, URL and limit under `BEGIN IMMEDIATE`. Correct for the single-runner deployment.
- Add during close or recover: fenced by the mutation lease and `status='ACTIVE' AND generation=?` in `inRepositoryChangeTransaction`; the rollback tolerates a removed `workspacePath`.
- Audit after commit cannot trigger a rollback: `auditWorkspaceMutation` swallows its errors, so a committed row never loses its checkout.
- Idempotency fingerprint: the defaulted `access` is included and the operation name is part of the fingerprint, so an add key reused for a remove is a `CONFLICT`. The replay happens before the multi-repository and in-flight checks.
- Single-repository contract: search without `scope` drops only the previously unsupported `cursor`, and the search path, artifacts and local backend all behave as before. `scope:"all"` does not collide with the memory or knowledge `scope` enums.
- Dashboard: every new interpolation is escaped or URI-encoded (`filesHref`, `workspaceTabHref`, `withRepository`, terminal `cwd`). The new `GET /repositories` route is read-only. The terminal POST is still behind the router's session, origin and CSRF checks, and its `cwd` is derived from the runner registry.
- Credential handling on add reuses `clone()` (token over stdin, credential-free URL). No new logging of the token.

## Recommended Actions
1. H1: quarantine the checkout, or pause the executor, before any host-side recursive delete in remove, the add rollback and the clone retry. Add a symlink-swap regression test.
2. M1: make the unsaved-work check atomic with the delete (it comes for free with H1(b)), or correct the security and API docs.
3. M2: fix how grep truncation is reported, and test it with realistic worker output.
4. L1 and L2 as time allows.

## Plan Follow-ups
Claimed items 1–5 are implemented and tested at the unit level. Item 1's safety claims (scoped, confined removal; never discards unsaved work) only partly hold until H1 and M1 are fixed. Item 2's truncated-results reporting fails for `grep_search` (M2).

## Metrics
- Tests: 161/161 focused tests pass. Typecheck clean for runner and api. Lint not run.
- Coverage: no test for a swap during deletion, for writes during removal from a shell at the tree root, or for grep truncation with real worker semantics.

## Unresolved Questions
- Is a single runner process per instance a guaranteed deployment invariant? The per-workspace serialization (`repositoryChanges`) is in memory only. The DB transaction still protects the registry, but two runners could race on the `repos/<alias>` directory.

## Fixes applied (commit dbc63093)
- **H1:** chose the pause approach (option a), with a staging directory for the add. `withFrozenWorkspaceTree` pauses the executor for the whole check-and-change window and unpauses even when the action fails. If the pause fails, the change is refused with `UNAVAILABLE`. Inside the window it also refuses (retryable `CONFLICT`) when a privileged-exec or Git-transfer helper is in flight, or when `docker ps` lists any other running container labelled with this workspace. Agent containers are excluded because they mount no tree. While the tree is frozen, `claimTreeWriter` stops new privileged or transfer helpers from starting. Remove and the add rollback both delete through `removeVerifiedCheckout`. It re-runs `verifiedCheckoutPath`, which requires `repos/` and `repos/<alias>` to be real directories and the realpath to match exactly, and it requires dev/ino to match the identity recorded earlier. The add now clones into `<workspacePath>/repository-add-<hex>/<alias>`, which is outside every container mount. Clone retries therefore never delete through `repos/`.
- **M1:** the unsaved-work check, the linked-worktree check, the in-use recheck, an identity recheck, the registry write and the delete all run inside the paused window. The close check runs in a read-only recovery helper, because a paused executor cannot take `docker exec`. The docs claim now holds.
- **L1:** the staged clone is renamed into `repos/<alias>` only while that path is still free, and only inside the frozen window. The rollback deletes only that dev/ino. A path that appears while the clone runs (a directory or a link) is `CONFLICT` and is left untouched. The test that previously expected a swapped-in link to be unlinked now expects the link to be left alone.
- **M2:** the runner asks each checkout for `budget + 1` results, so `items.length > budget` detects a silent cut. The worker is unchanged, and the default grep input and output are identical to before.
- **L2:** comment corrected. The unresolved question is answered in the same comment: there is one runner service per instance (Compose, SQLite state), and the in-memory locks rely on that.
- **Tests:** 11 new or updated tests in `apps/runner/test/dynamic-repositories.test.ts`. They cover pause ordering, pause failure, another container on the tree, the tree-writer guard in both directions, a checkout swapped for a link mid-check (the remove refuses and the outside target survives), an inner link (unlinked, not followed), an executor-created directory during the clone, an identity-guarded rollback, and grep truncation with real worker semantics. A race during `rm` itself cannot be reproduced deterministically in a unit test. What the tests show is that the freeze holds across the delete.
- **Docs:** `docs/security-model.md`, `docs/mcp-api.md`, `docs-site/troubleshooting.md`, the skill reference (synced). `docs:check` passes.
