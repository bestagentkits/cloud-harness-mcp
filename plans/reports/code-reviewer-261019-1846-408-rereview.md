# Re-review: feat/408-dynamic-repositories (fix commit dbc63093)

## Scope
- Commit `dbc63093`, mainly `apps/runner/src/workspace-service.ts` (+255/-?), `apps/runner/test/dynamic-repositories.test.ts`, docs. I also skimmed the rest of the branch (`git diff origin/dev...HEAD`, plans/ excluded), including `1ea1ed11` (dashboard finalize selector).
- Checks run:
  - `npx vitest run --exclude ".claude/**" apps/runner/test/dynamic-repositories.test.ts`: 39/39 pass.
  - `npx tsc --noEmit -p apps/runner/tsconfig.json`: clean.

## Verdict on the prior findings

| Finding | Status | Evidence |
| --- | --- | --- |
| H1, host `rm` racing the executor | Fixed | Remove and the add rollback delete only inside `withFrozenWorkspaceTree` (`workspace-service.ts:2210`). Inside the freeze: `verifiedCheckoutPath`, then a dev/ino check (`removeVerifiedCheckout`), then `safeRemovePath`. Clone retries now delete only under `<workspacePath>/repository-add-*`, which the executor does not mount (it mounts only `repo/`, `:1082`). |
| M1, remove losing unsaved work | Fixed | `linkedWorktreeBlocker`, the read-only `close_check` helper, `assertCheckoutUnused`, the identity recheck, the registry write and the delete all run inside the paused window (`:2691-2718`). |
| M2, grep truncation | Fixed | `budget + 1` (`:2791`). The worker does not re-validate `maxResults`, so 501 is accepted. rg `--max-count` is per file and the worker slices to `budget+1`, so `items.length > budget` now detects the cut. Only the scope-"all" path changed. |
| L1, rollback deleting foreign content | Fixed | `placeStagedCheckout` re-asserts the path is free and renames inside the freeze. The rollback is bound to the staged dev/ino. |
| L2, lock comment | Fixed | `:396-403`. |

## Regression checks (verified, no defect)
- **Unpause on action errors:** `withPausedExecutor` catches the action error, always unpauses, then rethrows. A test asserts the last verb is `unpause` on refusal (`dynamic-repositories.test.ts:527`). The failure paths are covered under Medium below.
- **Deadlock or nesting with the Git transfer pause:** none.
  - The Git path (`remoteFetch` `:2383`, `stage-push` `:2953`) and the freeze each issue their own `docker pause`. A second `pause` on an already-paused container fails, so whichever loses gets a retryable error.
  - When the loser's `pause` fails, it never reaches `unpause`, so neither side can unpause the other's freeze.
  - A Git helper claimed after the freeze began gets CONFLICT from `claimTreeWriter`, and its own wrapper unpauses its own pause.
  - Nothing waits on a lock, so there is no deadlock.
- **TOCTOU between the claim, `docker ps` and pause:** none found.
  - `frozenTrees.add` and the `treeWriters` check are synchronous. `docker ps` runs after the pause.
  - Every helper that mounts the tree read-write while an executor exists is claimed: privileged exec at `:3197` (this includes `skills_run`), and the Git transfer at `:2124`.
  - The remaining labelled helpers that start without a claim mount the tree read-only: size `:880`, gh `:3377`, and the recovery helper in its `ro` mode.
  - Other cases are not reachable during a freeze. The `rw` recovery helper runs only without an executor, and a freeze then refuses. The chown and clone helpers run only during open or this same add, and the add is serialised by `repositoryChanges`.
  - Agent containers mount nothing (`agent-launcher.ts:86-101`).
  - Shells, terminals and `exec_run` are `docker exec` processes inside the paused cgroup.
- **EXDEV:** not reachable. `workspacePath/repo` is a plain directory under `jobsRoot` (`workspace-repositories.ts:69`). No per-workspace mount or quota filesystem exists in the runner, Compose or deploy. The staging directory and `repo/repos/<alias>` are on the same filesystem.
- **Staging cleanup safety:** `safeRemovePath(stagingRoot)` runs in `finally`. It is jobs-root confined and realpath-checked. The executor cannot reach that directory, and the clone helper that writes it has finished and been removed.
- **Exposure of the read-only helper (`runRecoveryWorker` with `executorPaused`, `:2068`):** low.
  - It runs with `--network none`, `--read-only`, uid 10001 and a read-only mount of `repo/` only. It gets no token and no job root.
  - It is the same helper the existing no-executor close check already uses.
  - It runs as the same uid as the executor, so file readability is unchanged.
- **Single-repository behaviour:** unchanged.
  - Single-repository workspaces are refused before any freeze (`changeRepositories` `:2504`), and `frozenTrees` is only ever set there.
  - `claimTreeWriter` throws only when the tree is frozen, so privileged exec and Git transfers behave as before.
  - `clone()` without `destination` uses the old path.
  - The default `withPausedExecutor` messages are unchanged.
- **Grep cursor and summary:** correct. The checkout that hits the budget is marked `truncated`, the next entry becomes `cursor`, and `truncated` is true at the top level. When the truncated checkout is last, `truncated: true` is set with no cursor, as documented.

## Critical
None.

## High
None.

## Medium

### M-1. A pause timeout or a failed unpause leaves the executor paused indefinitely, and a committed change is reported as a failure without an audit row
- `apps/runner/src/workspace-service.ts:2188-2197`, reached by the new callers at `:2580` and `:2691`.
- **Cause:** `runDocker` rejects with `TIMEOUT` after 30 s and kills only the CLI (`docker-engine.ts:43`).
  - **Path 1:** `docker pause` hangs past 30 s on a busy daemon, and the daemon then completes it. `withPausedExecutor` throws before its unpause, and nothing ever unpauses.
  - **Path 2:** the `unpause` call fails or times out. The code throws `UNAVAILABLE` with no retry.
  - No code path ever unpauses later. `ensureActiveExecutor` treats a paused container as `Running`, and only a runner restart (`docker restart`) or a close clears it.
- **Failure scenario (remove):**
  1. The registry row is already removed (`:2706`) and the checkout deleted.
  2. Unpause fails, and the caller gets a retryable `UNAVAILABLE: executor could not be resumed after a repository change`.
  3. `auditWorkspaceMutation` (`:2719`) is skipped, so a committed removal has no audit event.
  4. A retry with the same key replays success. Every later `exec_run`, shell, dashboard terminal, file tool, Git transfer and repository change fails against the paused container until the owner closes the workspace.
  5. `docs-site/troubleshooting.md:418` only describes the "could not be paused, so nothing was changed" case. The "could not be resumed" case is undocumented, and in it something did change.
- **Why it matters now:** this was latent in the Git-transfer pause. The new windows are longer: a 60 s helper run plus a host-side `rm` of a whole checkout. They are also on a user-facing remove and add path.
- **Fix:**
  1. If `pause` throws or exits non-zero, issue a best-effort `unpause` before rethrowing.
  2. Retry `unpause` a few times with backoff.
  3. Keep the action's outcome when only the resume fails: audit the committed change and return its result. Mark the workspace degraded, or surface the resume failure as a warning, instead of throwing over a committed change.
  4. Optionally, `ensureActiveExecutor` and startup should unpause a container whose `State.Paused` is true.
  5. Add a test where `unpause` returns non-zero after a successful commit.

## Low

### L-1. The docs overstate staging isolation
- `docs/security-model.md:512` and the comment at `workspace-service.ts:2556` say the staging directory is "outside every container mount".
- The clone helper (`:959`), the Git-transfer helper (`:2134`) and the read-only size helper (`:880`) all mount `workspacePath`, so they can see the staging directory. All three are trusted harness helpers, and the transfer helper hardens Git config (`git-transfer-helper.sh:38`), so the property that matters holds. What holds is "outside the executor's and the privileged helpers' mounts".
- **Fix:** reword it to name the executor and the privileged or skill helpers.

### L-2. A runner crash mid-add leaks the staging directory into the active workspace
- `workspace-service.ts:2558`. `reconcileJobDirectories` cleans only inactive workspace roots, so `repository-add-*` stays until the workspace closes and counts toward `resourceViolation`. Leftover `git-transfer-*` directories have the same problem, which predates this branch.
- **Fix:** sweep `repository-add-*` and `git-transfer-*` entries of active workspaces at startup, after `reconcileContainers`.

## Branch-wide re-scan
No new high or critical issue. The `1ea1ed11` finalize selector escapes the alias in both the value and the label, and still posts through the existing CSRF and session router. The prior review's verified non-issues still hold for the unchanged code.

## Metrics
- Tests: 39/39 in `dynamic-repositories.test.ts`. Runner typecheck clean. Lint not run.
- Coverage gaps: no test for a pause timeout, a failed unpause, or a resume failure after a commit.

## Unresolved questions
- Does `docker restart` at startup (`:672`) succeed on a paused executor in the deployed Docker version? If it does not, a runner crash during a freeze makes startup throw `executor restart reconciliation failed`. I did not verify this here because Docker is not available on this host.

Status: DONE_WITH_CONCERNS
Summary: All five prior findings (H1, M1, M2, L1, L2) are fixed and verified, and I found no new high or critical issue. One medium remains: a pause timeout or failed unpause leaves the executor paused indefinitely and reports a committed change as failed without an audit row. There are also two low doc and cleanup items.

## Fixes applied

- **M-1.** `withPausedExecutor` now wraps `runWithPausedExecutor` in `apps/runner/src/workspace-service.ts`.
  - A pause that fails or times out is followed by an unpause before the `UNAVAILABLE` refusal. A "not paused" reply counts as resumed.
  - The unpause is retried with a short bounded backoff (0, 250 and 1000 ms).
  - The runner holds at most one pause per workspace (`pausedExecutors`). A second pause is refused without unpausing the first, so a loser can no longer resume the winner's freeze.
  - Repository add and remove keep a committed change when only the resume fails. They record the audit event, return the committed result with `executorResumed: false` and a message, and log a warning. The stored replay stays the committed result. The Git-transfer path still fails with `UNAVAILABLE` on a failed resume.
  - `ensureActiveExecutor` (reached by `workspace_recover` mode `resume`) and the startup restart unpause a paused executor. They do this only when its labels name this instance and workspace as managed, and never while the runner holds the pause. If the unpause fails, `ensureActiveExecutor` rebuilds the executor.
  - This also answers the open question: startup now unpauses before `docker restart`, so a paused executor no longer depends on how the deployed Docker version restarts one.
- **L-1.** The comment and `docs/security-model.md` now say "outside the executor's and the privileged and skill helpers' mounts", and they name the trusted helpers that do mount the workspace root.
- **L-2.** At startup, `reconcileJobDirectories` sweeps retained workspaces through `removeLeftoverStaging`. It runs after `reconcileContainers` and only when the record's workspace path is the canonical one. It removes only direct children that are real directories (`lstat`, not links) with the exact names `repository-add-<24 hex>` or `git-transfer-<24 hex>`, using `safeRemovePath`. A failed sweep is logged and does not block startup.
- **Docs.** The paused-executor outcome and recovery step are now described in `docs/mcp-api.md`, `docs-site/troubleshooting.md` (section 34) and the cloudharness skill reference, which was synced to the plugin.
- **Tests** (`apps/runner/test/dynamic-repositories.test.ts`, "executor pause and resume"):
  - A failed resume after a remove returns a committed result, records the audit and replays it, and a later recover unpauses the executor.
  - The same holds for an add.
  - A pause timeout is followed by an unpause and changes nothing.
  - Nested pauses and a recover made during a freeze are refused without an extra unpause.
  - A foreign-labelled paused container is left alone.
  - Startup unpauses before the restart and sweeps only matching staging directories, leaving a junction, a file and a non-matching name in place.
- **Checks:**
  - `dynamic-repositories` passes 44/44. The other related runner suites pass.
  - `npm run typecheck`, eslint and `npm run docs:check` are clean.
  - Pre-existing and unrelated: the clone-order assertion in `multi-repository-workspaces.test.ts` fails intermittently, and also fails without these changes. `test/git-transfer-helper-lease.test.ts` times out on this Windows host.
