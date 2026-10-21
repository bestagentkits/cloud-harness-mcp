# Backend report: dynamic repositories, scope "all" search, artifact repository selection

Issue #408, backend part. Branch `worktree-agent-a886aca789748cc7f`, based on
`feat/408-dynamic-repositories` (the worktree started on `main` and was reset
to that branch while still clean).

## Delivered

- `workspace_repo_add` and `workspace_repo_remove` are registered in the contracts
  (`RunnerOperationSchema`, `TOOL_SPECS`, and the annotation sets), the runner,
  and the local backend, which refuses them. The API MCP server registers every
  `TOOL_SPECS` entry, so it needed no per-tool change.
- `scope: "all"` and a `cursor` were added to `grep_search`, `symbols_search` and
  `symbols_references`. The scope is mutually exclusive with `repositoryId`.
- `artifacts_snapshot` and `artifacts_restore` accept `repositoryId`. Artifact
  rows gain additive `repository_id` and `repository_alias` columns.
- Docs updated: `docs/mcp-api.md`, `docs/security-model.md`, ADR 0005 (adding
  and removing repositories moved to decided), docs-site concepts and
  troubleshooting (new section 34), the regenerated `docs-site/reference/tools.md`
  and `llms.txt`, and the skill references. The plugin copy was synced.

## Decisions

- **Fencing.**
  - Both tools hold the mutation lease.
  - The registry row and the idempotency replay are written in one
    `BEGIN IMMEDIATE` transaction, fenced on the workspace generation and
    ACTIVE status. A lost fence returns `EXPIRED`.
  - An in-process guard serializes changes per workspace. A concurrent change
    gets a retryable `CONFLICT`.
- **Idempotency.**
  - The `idempotencyKey` is required.
  - The fingerprint for add is url, alias, ref and access; for remove it is the
    selector.
  - The replay is checked before every other check. Only successes are
    recorded, so a failed add can be retried with the same key.
  - Replays are stored in the new `workspace_repository_changes` table.
- **Add.**
  - It reuses the open-time policy, duplicate checks, the
    `MAX_WORKSPACE_REPOSITORIES` limit, the brokered clone helper, and the
    default history.
  - An existing `repos/<alias>` is refused and left untouched.
  - After the clone, the checkout is verified as a real directory and the size
    bounds are checked. A violation is `LIMIT_EXCEEDED` and removes only the new
    checkout; the workspace stays open.
  - Rollback acts only when `repos/` is still the real directory. A swapped
    link is unlinked rather than followed, and directories go through
    `safeRemovePath` with the verified path.
- **Remove.**
  - Unsaved work is checked with the auto-close `close_check` (uncommitted,
    untracked, stash, unpushed) plus a host-side count of `.git/worktrees`,
    because the auto-close check counts clean linked worktrees as nothing.
  - "In use" means a queued, running or blocked task, or a running shell,
    session, terminal or operation, whose tree-relative cwd is inside the
    checkout. Any active agent also counts, because agents record no
    repository. Generic operations now record a cwd for this.
  - The registry row is deleted before the directory. If the directory cannot
    be deleted, the result reports `checkoutRemoved: false`, and the leftover
    still blocks auto-close.
  - Removing the primary promotes the next repository in open order and moves
    the workspace row's URL and ref to it.
- **Search paths.**
  - Line results become `{repositoryId, alias, match|reference}` with the path
    relative to the checkout.
  - Symbols keep their checkout-relative `path` and gain the two fields.
  - The cursor is the `repo_` id of the next repository. A repository cut short
    by the budget is reported as truncated and is not resumed.
  - A single per-repository failure is reported beside the other results. The
    call fails only if no checkout could be searched.
  - Without the scope the worker input is byte-identical; the stray `cursor`
    the schema used to strip is dropped in the runner.
- **Restore** never defaults to the recorded repository, because the
  destination may be another workspace.

## Tests

New tests:
- `apps/runner/test/dynamic-repositories.test.ts` (30 tests) covers:
  - add: success, replay, fingerprint conflict, single-repository refusal,
    limit, duplicate alias and URL, policy, clone-failure rollback, fence loss,
    symlink swap, existing path
  - remove: each dirty kind, linked worktree, failed check, in-use operation
    including a sibling-prefix case, agent, last and single refusal, primary
    promotion, fence loss, missing directory
  - scope "all": annotation, pagination cursor, stale cursor, per-repository
    error, mutual exclusion, unchanged default, single-repository attribution
  - artifacts: provenance on snapshot, list and read; scoped and unscoped
    restore
- `packages/contracts/test/multi-repository-contracts.test.ts` has 3 new tests.
- `apps/api/test/local/local-workspace-backend.test.ts` has 1 new test for the
  local refusal.

The mock in `multi-repository-workspaces.test.ts` split the clone `--volume`
argument on the first colon, which broke on Windows drive paths. It now splits
on `:/job`.

Results on this Windows host:
- `npm run typecheck` and `npm run lint` pass.
- `npm run test:unit`: the new and changed suites pass. The remaining failures
  are platform failures that also fail with the base sources checked out:
  - package-builder, skill-extension-workspace, skill-extension-service,
    terminal-dispatch, packages-dispatch, tree-digest, worker-close-check,
    model-config-status, dashboard-app-mount, and multi-local exec
  - the model-gateway suite
  - `multi-repository-workspaces` "clones each repository…" expects the order
    of two parallel clones; it is nondeterministic here and untouched by this
    change.
- `npm run test:integration`: 66 pass. The 8 failures need `openssl` or a POSIX
  local stdio mode.
- Docker and e2e suites were not run.
