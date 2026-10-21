## Code Review Summary: commit 068045c7 (final review, #408)

### Scope
- Files: `apps/runner/src/workspace-service.ts`, `apps/runner/test/dynamic-repositories.test.ts`, `docs/mcp-api.md`, `docs/security-model.md`, `docs-site/troubleshooting.md`, the cloudharness skill reference and its plugin copy
- LOC: +286 / -25
- Focus: pause-holder bookkeeping, the Git-transfer path, startup unpause scope, the staging sweep's path safety, and whether the docs match the code

### Checks run
- `npx vitest run --exclude ".claude/**" apps/runner/test/git-transfer-leak.test.ts apps/runner/test/dynamic-repositories.test.ts apps/runner/test/workspace-recovery.test.ts`: 3 files and 66 tests pass.
- `npm run typecheck` is clean. `eslint` on the changed source and test files is clean.
- `.agents/skills/cloudharness` and `plugins/cloud-harness/skills/cloudharness` are byte-identical (`diff -r`).

### Verified clean
- **Pause-holder bookkeeping** (`workspace-service.ts:2232-2257`)
  - `pausedExecutors.add` happens right before the `try`, and `delete` is in its `finally`, so every exit path clears the holder: a pause failure, an action that throws, and a failed resume.
  - The pause call is wrapped in `.catch`. `resumeExecutor` cannot throw, because `runDocker` rejections are caught and `setTimeout` cannot fail. So nothing escapes between `add` and `try`.
  - There is no permanent-refusal state. A second pause is refused before `add`, so it never deletes the first holder's entry.
- **Git-transfer path** (`:2468`, `:3039`)
  - Both call sites still go through `withPausedExecutor`, which keeps the old contract: `UNAVAILABLE` on a failed pause or resume, and the action's error is rethrown after the resume.
  - Concurrent transfers in one workspace are refused through the holder set, where `docker pause` used to fail with "already paused". The refusal is the same retryable 503, and it no longer depends on the daemon's error text.
  - A paused executor left behind by a crash is now unpaused by the next transfer's failed-pause path before the refusal, so the next retry works.
- **Committed add and remove**
  - The audit runs after `withFrozenWorkspaceTree` returns, whatever the resume outcome.
  - The stored replay (`resultJson`) stays the committed result without `executorResumed: false`, matching `docs/mcp-api.md`.
- **Startup unpause** (`:682`, `resumeLeftoverPause` `:2270-2284`)
  - It acts only when `Config.Labels` has `cloud-harness.managed=true`, `cloud-harness.instance=<this instance>` and `cloud-harness.workspace=<record.id>`. These match the executor's creation labels (`:1111`).
  - At startup the holder set is empty, so the `CONFLICT` branch cannot fire. The HTTP server listens only after `service.start()` (`apps/runner/src/index.ts:84,119`).
- **Staging sweep** (`:762-788`)
  - The parent directory comes from a `jobsRoot` `Dirent` that must be a real directory named `ws_...`.
  - The sweep runs only when `resolve(record.workspacePath)` equals `jobsRoot/<id>`, which is how `workspacePath` is built (`:1243`).
  - Only direct children with the exact names `(repository-add|git-transfer)-[0-9a-f]{24}` are considered. They are checked with `lstat` (not followed) and must be a directory and not a link.
  - Removal goes through `safeRemovePath`, which checks that the path stays under the jobs root by both resolved and real path.
  - The sweep runs after `reconcileContainers` has removed every ephemeral helper. The restarted executor mounts only `repo/`, not the workspace root.
  - The test covers a junction, a file and a near-miss name. Nothing broader is touched.

### Medium

**M-1. A recover during a freeze rebuilds the executor on the shipped default network profile.** The "never while the runner holds the pause" claim does not hold for `dependency-access`.
- **Where:** `apps/runner/src/workspace-service.ts:1158-1160` (`mustRebuild` branch) and `:3894` (`workspace_recover` mode `resume` always calls `ensureActiveExecutor`). The doc claim is in `docs/security-model.md`: "Only a paused container carrying this workspace's managed labels is resumed, and never while the runner itself holds the pause."
- **Failure scenario:**
  1. In a `dependency-access` workspace (the shipped default), `workspace_repo_remove` holds the freeze and the pause.
  2. A concurrent `workspace_recover` mode `resume` (for example from a second agent of the same owner) takes the `mustRebuild` branch. It runs `removeContainer` on the paused executor and `createExecutor` builds a fresh, unpaused one with the same name, mounting `repo/` read-write. The holder check in `resumeLeftoverPause` is never reached.
  3. Commands can then run in the new executor and write into the checkout between the unsaved-work check and the directory removal. That work is deleted, which is exactly what the freeze exists to prevent.
  4. The add or remove's own unpause then hits the new, unpaused container. It gets "not paused" and counts that as resumed.
- **Status:** the rebuild during a freeze already existed before this commit. This commit adds the guard and the doc claim but covers only the `network-none` branch. The test fixture is `network-none` (`dynamic-repositories.test.ts:107`), so the default profile is untested.
- **Fix:** move the holder and freeze check to the top of `ensureActiveExecutor`, before the `mustRebuild` branch, for example:
  ```ts
  if (this.pausedExecutors.has(record.id) || this.frozenTrees.has(record.id)) {
    throw new HarnessError('CONFLICT', 'the executor is paused for a repository change or Git transfer; retry shortly', 409, true);
  }
  ```
  Also add a `dependency-access` variant of the "never resumes a pause it does not own" test.

### Low

**L-1. The docs say recover "resumes" the executor, but on `dependency-access` it always rebuilds it.**
- **Where:** `docs-site/troubleshooting.md` (step 6), `docs/mcp-api.md`, and the skill reference line "call `workspace_recover` with `mode: "resume"`".
- **Behaviour:** because of `mustRebuild` (`:1158`), on the default profile recover replaces the executor instead of unpausing it, so running shells and processes are lost. The end state is still usable, so the recovery advice is correct.
- **Fix:** add a clause such as "on `dependency-access` the executor is rebuilt (running processes end)".

**L-2. The startup path ignores a failed unpause.**
- **Where:** `workspace-service.ts:682`.
- **Behaviour:** `await this.resumeLeftoverPause(...)` returns `false` when every unpause attempt fails, and the code goes straight to `docker restart`. If the restart then fails on the still-paused container, the existing `UNAVAILABLE 'executor restart reconciliation failed'` aborts the whole runner startup. This is the same as before the commit, so it is not a regression.
- **Fix (optional):** when it returns `false`, fall through to `ensureActiveExecutor` or `removeContainer` and rebuild, instead of letting one workspace block startup.

**L-3. A pause that times out can still land after the undo (residual, informational).**
- **Where:** `:2240-2243`.
- **Behaviour:** `runDocker` kills the CLI on timeout, but the daemon may still finish the pause. The immediate unpause can see "is not paused" and report success, and then the pause takes effect. The executor ends up paused with no holder.
- **Mitigation:** recover or startup now heals this (subject to M-1 on `dependency-access`). No code change is needed beyond what exists. Worst case, the pause plus the resume retries can hold the freeze and repository-change lock for about 2 minutes (30 s + 3 x 30 s + 1.25 s).

### Edge cases found by scouting
- Every `ensureActiveExecutor` caller was checked: startup network-mismatch (`:670`), lease renew (`:3838`, recoverable only) and recover (`:3894`). Only recover can run during a freeze, which is M-1.
- An exception from `resumeLeftoverPause` (`CONFLICT`) inside `ensureActiveExecutor` propagates before any `docker start` or `remove`, which is correct for `network-none`.

### Recommended actions
1. Fix M-1: check the holder and freeze at the top of `ensureActiveExecutor`, and add a `dependency-access` test.
2. Fix L-1: correct the docs wording about recover on `dependency-access`.
3. Optionally fix L-2.

### Metrics
- Tests: 66/66 in the requested suites.
- Typecheck: clean. Lint: 0 issues in the changed files.

### Unresolved questions
- Should `workspace_recover` during a freeze be refused (as in the M-1 fix), or queued? Refusing matches the existing `CONFLICT` style.

Status: DONE_WITH_CONCERNS
Summary: The pause-holder bookkeeping, the Git-transfer path, the startup unpause scope and the staging sweep are correct and their tests pass. One Medium gap remains: on the default dependency-access profile, a workspace_recover during a freeze rebuilds the executor and bypasses the new "never while the runner holds the pause" guard that the docs now claim.
