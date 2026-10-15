# Git and worktrees

Cloud Harness Git tools operate only inside the workspace checkout and constrain
remote transfer to `origin`. Inspect status and diff before mutations. Never
place credentials in a remote URL, ref, commit message, author field, or output.

## Inspect repository state

<!-- cloudharness-tool:git_status -->
### `git_status`

Read branch, index, and working-tree status for `workspaceId`.

<!-- cloudharness-tool:git_diff -->
### `git_diff`

- Required: `workspaceId`; `staged` defaults to `false`; optional workspace-
  relative `path` narrows the diff.
- Output can be truncated. Narrow the path rather than assuming omitted changes
  are absent.

<!-- cloudharness-tool:git_log -->
### `git_log`

- Required: `workspaceId`; `limit` defaults to 20 and permits 1–100.
- Returns bounded recent commit metadata without modifying the repository.

## Local branches and index

<!-- cloudharness-tool:git_branch -->
### `git_branch`

- Required: `workspaceId`, `action` (`list`, `create`, or `delete`).
- `name` is required for create/delete; optional `startPoint` selects the
  creation base; `force` defaults to `false`.
- Names/start points are 1–255 characters, cannot start with `-`, and contain no
  NUL. Forced deletion can discard an unmerged branch; inspect it first.

<!-- cloudharness-tool:git_checkout -->
### `git_checkout`

- Required: `workspaceId`, `ref`; `create` defaults to `false`.
- Checkout can overwrite index/worktree state when Git permits it. Use a
  worktree for isolated parallel branches.

<!-- cloudharness-tool:git_add -->
### `git_add`

- Required: `workspaceId` and exactly one mode: `all: true`, or 1–200
  workspace-relative `paths` with `all: false`.
- Staging is repeatable but changes the proposed commit. Review the staged diff.

<!-- cloudharness-tool:git_commit -->
### `git_commit`

- Required: `workspaceId`, `message` (1–10,000 characters); `all` defaults to
  `false`. `authorName`/`authorEmail` are optional and fall back to the
  configured or default Git identity.
- Optional `expectedHeadOid` is a compare-and-set guard: the commit is rejected
  with `STALE_HEAD` if the current HEAD no longer matches. Optional
  `idempotencyKey` makes a lost-response retry safe; a same-key replay does not
  create a second commit.
- `all: true` runs an all-path staging step and includes untracked files as well
  as tracked modifications/deletions. Inspect status for secrets and unrelated
  files first. The tool creates a local commit and does not sign or push it.

<!-- cloudharness-tool:git_identity_status -->
### `git_identity_status`

Read configured or default Git author identity for the workspace.

- Optional: `workspaceId`.
- Returns author name, email, and source (`workspace`, `principal`, or `default`).

<!-- cloudharness-example:git_identity_status
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa"}
-->

<!-- cloudharness-tool:git_identity_set -->
### `git_identity_set`

Configure default Git author name and email for commits.

- Required: `name`, `email`. Optional: `workspaceId`.
- Returns updated Git author identity settings.

<!-- cloudharness-example:git_identity_set
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","name":"Agent Developer","email":"agent@example.com"}
-->

<!-- cloudharness-tool:workspace_finalize -->
### `workspace_finalize`

Transactionally stage changes, run preflights, commit, and push to origin in one call.

- Required: `commitMessage` (1–10,000 characters).
- Optional: `workspaceId`, `paths`, `all` (default true), `branch`, `push` (default true), `authorName`, `authorEmail`, `preflight`, `idempotencyKey`.
- Returns commit SHA, target branch, push result, and final workspace status.
- Provide `idempotencyKey` before the first call. Finalize is crash-durable: a
  commit may exist even when the push outcome is unknown. On a same-key retry
  after `UNKNOWN_REMOTE_STATE`, the service reconciles against the destination
  ref and returns `alreadyFinalized: true` instead of pushing again.

<!-- cloudharness-example:workspace_finalize
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","commitMessage":"feat(core): implement feature","push":true}
-->

## Origin transfer and history integration

The trusted runner brokers repository credentials when configured. Credentials
must remain outside the checkout, command inputs, environment, logs, and remote
URL. Network access for these tools is separate from executor egress.

<!-- cloudharness-tool:git_fetch -->
### `git_fetch`

- Required: `workspaceId`; `remote` is fixed to `origin`; optional `refspec`
  is a source ref only and cannot contain a destination (`:`).
- Optional, mutually exclusive history controls: `depth` (1–100000), `unshallow`
  (fetch complete history), `shallowSince` (ISO date/datetime). Use these to
  deepen a shallow clone when `git_log` needs more history than the workspace
  currently has. They only deepen a shallow checkout and never truncate a
  complete one; a `shallowSince` date with no newer commits fails the fetch.
- Contacts the repository host and updates remote-tracking refs.

<!-- cloudharness-tool:git_pull -->
### `git_pull`

- Required: `workspaceId`; `remote` is fixed to `origin`; optional `branch`;
  `strategy` defaults to `ff-only` and also permits `merge` or `rebase`.
- Pull contacts origin and can change files/history. Prefer `ff-only` unless the
  requested integration strategy is explicit.

<!-- cloudharness-tool:git_push -->
### `git_push`

- Required: `workspaceId`; `remote` is fixed to `origin`; optional branch-only
  `refspec`; `forceWithLease`, `expectedAbsent`, and `delete` default to `false`.
- A refspec source is `HEAD` or a branch-like ref; an optional destination is a
  branch name or `refs/heads/...`. `:`-prefixed deletion, `+` force, tags,
  notes, option injection, ranges, and reflog syntax are rejected.
- Force-with-lease requires exactly one of `expectedRemoteOid` (a lowercase 40-
  or 64-hex object ID) or `expectedAbsent: true`. With a refspec it also
  requires an explicit destination branch.
- `expectedAbsent` creates a branch only if it is absent, and `delete: true`
  (refspec names only the branch) deletes it only if it still matches
  `expectedRemoteOid`. A lost lease, or a create onto a branch already at the pushed commit, is `CONFLICT`, not retryable. Using a branch
  as a lock: [GitHub merge train](github-merge-train.md#atomic-branch-locks).
- A push GitHub refuses by policy (`[remote rejected]`: branch protection,
  ruleset, or hook) returns `FORBIDDEN`; a commit that changes
  `.github/workflows` without the App's Workflows permission returns
  `GITHUB_PERMISSION_MISSING`. Neither is retryable. A fast-forward to a
  protected branch succeeds only when its required checks already pass on the
  commit and no pull-request rule applies to the App.
- Supply `idempotencyKey` on the initial push, not only after a failure. If the
  network drops mid-push the result is `UNKNOWN_REMOTE_STATE` with
  `resumeAction: "reconcile_push"`; retry the identical request with the same
  key. The service checks the destination ref's remote OID before deciding
  whether another push is needed, returning `alreadyFinalized: true` when the
  earlier push had already landed. For a create-only lease it succeeds only when
  the branch holds this workspace's `HEAD`; for a delete, when the branch is
  gone. Any other value returns `CONFLICT` with `currentRemoteOid`.
- Push changes an external repository. Verify the target ref and inspect the
  returned result; a local commit is not evidence of a successful push.

<!-- cloudharness-example:git_push
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","remote":"origin","refspec":"HEAD:refs/heads/feature/cloud-harness","forceWithLease":false}
-->

<!-- cloudharness-tool:git_merge -->
### `git_merge`

- Required: `workspaceId`, `ref`; `fastForward` defaults to `allow` and permits
  `only` or `never`; optional `message` permits 1–10,000 characters.
- Merge can stop on conflicts. Inspect status and resolve deliberately; do not
  repeat an unknown merge blindly.

<!-- cloudharness-tool:git_rebase -->
### `git_rebase`

- Required: `workspaceId`, `action` (`start`, `continue`, or `abort`).
- `upstream` is required only for `start` and forbidden for the other actions.
- Rebase rewrites local history. On conflict, inspect status before continue or
  abort; never push rewritten history without an explicit owner decision.

## Managed worktrees

<!-- cloudharness-tool:worktrees_list -->
### `worktrees_list`

List managed worktrees and their branch/HEAD state for `workspaceId`.

<!-- cloudharness-tool:worktrees_create -->
### `worktrees_create`

- Required: `workspaceId`, `name`, `ref`; `createBranch` defaults to `false`.
- `name` permits ASCII letters, digits, `.`, `_`, and `-`, length 1–80. The
  managed directory is `.worktrees/<name>`.
- With `createBranch: true`, the name is also used for the new branch. Check for
  existing branches/worktrees first.

<!-- cloudharness-tool:worktrees_remove -->
### `worktrees_remove`

- Required: `workspaceId`, managed `name`; `force` defaults to `false`.
- Normal removal refuses dirty state. Forced removal can discard uncommitted
  files in that worktree; inspect it and preserve results first.

## Brokered GitHub operations

Prefer `github_read` for any read-only GitHub call. `github_action` is
annotated destructive as a whole tool (there is no per-action server approval
gate), so MCP clients may prompt for approval on every call, including reads;
`github_read` is annotated read-only/idempotent/non-destructive instead.

<!-- cloudharness-tool:github_read -->
### `github_read`

Read-only GitHub access with no approval prompts, sharing `github_action`'s broker and helper.

- Required: `workspaceId`, `action` — one of `pr_list`, `pr_view`,
  `pr_review_threads`, `pr_reviews`, `issue_list`, `issue_view`, `commit_list`, `compare`, `release_list`, `tag_list`,
  `ref_get`, `commit_status_get`, `check_runs_list`, `workflow_runs_list`, `workflow_run_view`. Mutating
  actions are rejected.
- `pr_list` / `issue_list`: optional `limit` (default 20, max 100), `state`
  (`open`, `closed`, or `all`).
- `pr_view`: required `prNumber`. `pr_review_threads`: required `prNumber`, optional `limit` (default 50, max 100). `issue_view`: required `issueNumber`.
- `commit_list`: optional `limit` (default 30, max 100), `sha` (branch, tag, or
  commit), `path` (workspace-relative), `since`/`until` (ISO date or datetime).
- `compare`: required `base`, `head` (branch, tag, or commit; no range syntax);
  optional `limit` (default 100, max 250). Returns commits and a changed-file
  summary between the two revisions.
- `release_list` / `tag_list`: optional `limit` (default 20/30, max 100).
- `pr_reviews`, `ref_get`, `commit_status_get`, `check_runs_list`,
  `workflow_runs_list`, `workflow_run_view`: inputs and results in
  [GitHub merge train](github-merge-train.md#reads).
- History and ref reads mint a `contents: read`-scoped token; other reads mint
  the narrowest scope their action needs, via the same broker as `github_action`.
  Tokens are never exposed to workspace files.

<!-- cloudharness-example:github_read
{"workspaceId":"ws_abcdefghijklmnopqrstuvwxyz012345","action":"commit_list","limit":10}
-->

<!-- cloudharness-tool:github_action -->
### `github_action`

- Required: `workspaceId`, `action`.
- Uses trusted GitHub App broker tokens passed via stdin to an ephemeral helper container. Tokens are never exposed to workspace files.
- When no GitHub App repository token can be minted, the runner falls back to an operator-supplied credential: `GH_TOKEN` then `GITHUB_TOKEN` from the runner environment (owner-bearer mode only), then the requesting principal's global runtime secret of the same name. The credential still travels over stdin only and never enters a result, log, or audit payload.
- Read actions (also available on `github_read`, which avoids approval prompts):
  - `pr_list` / `issue_list`: optional `limit` (default 20, max 100), `state` (`open`, `closed`, or `all`).
  - `pr_view`: required `prNumber`; also returns `isDraft`, `reviewDecision`, `reviewRequests`, `mergeable`, `mergeStateStatus`, `headRefOid`, and `autoMergeRequest`.
  - `pr_review_threads`: required `prNumber`; optional `limit` (default 50, max 100). Returns each thread's `id` (the `threadId` for the thread actions), `isResolved`, `isOutdated`, `path`, `line`, and its comments.
  - `issue_view`: required `issueNumber`.
  - `commit_list`, `compare`, `release_list`, `tag_list`: same inputs as documented under `github_read`.
- PR mutations:
  - `pr_create`: required `title`, `head`; optional `body`, `base` (default `main`), `draft` (default false), `labels` array (max 50).
  - `pr_update`: required `prNumber`; optional `title`, `body`, `base`, `state` (`open` | `closed`).
  - `pr_comment`: required `prNumber`, `body`; optional `idempotencyKey`. This is a conversation comment, not a review.
  - `pr_review`: required `prNumber`, `event` (`COMMENT` | `APPROVE` | `REQUEST_CHANGES`); `body` is required except for `APPROVE`; optional `idempotencyKey`. GitHub rejects approving or requesting changes on your own PR (`GITHUB_REVIEW_NOT_ALLOWED`).
  - `pr_review_comment`: required `prNumber`, `body`, `path`, `line`; optional `startLine` (a range ending at `line`), `side` (`RIGHT` default | `LEFT`), `startSide`, `commitId` (full SHA; defaults to the PR head), `idempotencyKey`. A line outside the diff returns `GITHUB_REVIEW_COMMENT_INVALID`.
  - `pr_review_reply`: required `threadId`, `body`; optional `idempotencyKey`. `pr_review_thread_resolve` / `pr_review_thread_unresolve`: required `threadId`. Get the `threadId` from `pr_review_threads`.
  - `pr_reviewers_request` / `pr_reviewers_remove`: required `prNumber` and at least one of `reviewers` (logins) or `teamReviewers` (team slugs in the repository's organization); `pr_reviewers_request` accepts `idempotencyKey`. Failures return `GITHUB_REVIEWER_UNASSIGNABLE`.
  - `pr_ready` / `pr_convert_to_draft`: required `prNumber`.
  - A failure that matches no known rule returns `GITHUB_ACTION_FAILED`. When the operator enabled the Decision Plane, it may carry an advisory `data.diagnosis` (`failureType`, `confidence`, `retryLikelyToSucceed`, `credentialRefreshNeeded`, `workspaceRecreateNeeded`, `agentNeeded`, `humanNeeded`, `priorFailures`). Use it to choose between retrying, recreating the workspace, or asking the owner, but `code` and `retryable` stay authoritative, and a missing diagnosis means nothing.
  - `pr_merge`: required `prNumber`, `method` (`merge` | `squash` | `rebase`); optional `commitTitle`, `commitBody` (not for `rebase`), `matchHeadCommit` (full SHA; refuses to merge if the head moved), `idempotencyKey`. Needs `contents: write` as well as `pull_requests: write`. Blocked merges return `GITHUB_MERGE_BLOCKED` (checks, approvals, branch protection) or `GITHUB_MERGE_CONFLICT`; inspect `pr_view` (`mergeStateStatus`, `reviewDecision`) first.
  - `pr_auto_merge_enable`: same `prNumber`, `method`, `commitTitle`, `commitBody`, `idempotencyKey` as `pr_merge`; `pr_auto_merge_disable`: required `prNumber`. A repository that disallows auto-merge, or a PR already in clean status (merge it with `pr_merge`), returns `GITHUB_AUTO_MERGE_UNAVAILABLE`; the helper never merges immediately on this action. Merging a PR that edits `.github/workflows/**` with an App token needs the App's **Workflows** permission and otherwise returns `GITHUB_PERMISSION_MISSING`.
  - Review workflow: `pr_view` → `pr_review` `REQUEST_CHANGES` → author pushes fixes → `pr_view` → `pr_review` `APPROVE` → `pr_merge` `squash`. Check `workspace_capabilities` (`operations.pullRequestReview`, `pullRequestMerge`, and `githubActions`) before relying on an action.
- Merge-train mutations `commit_status_create`, `workflow_dispatch`, and
  `workflow_run_rerun_failed`: see [GitHub merge train](github-merge-train.md#writes).
- Issue and label mutations:
  - `issue_create`: required `title`; optional `body`, `labels` array (max 50), `assignees` array (max 10).
  - `issue_update`: required `issueNumber`; optional `title`, `body`, `state` (`open` | `closed`), `stateReason` (`completed` | `not_planned` | `reopened`).
  - `issue_comment`: required `issueNumber`, `body`; optional `idempotencyKey`.
  - `issue_comment_update`: required `commentId`, `body`.
  - `issue_labels_add`: required `issueNumber`, `labels` array (1–50); optional `createMissing` (default true), `idempotencyKey`.
  - `issue_labels_remove`: required `issueNumber`, `label`.
  - `label_create`: required `name`; optional `color` (6-hex), `description`.
  - `issue_publish`: required `issueNumber`; optional `comment`, `addLabels` array (max 50), `removeLabels` array (max 50), `createMissingLabels` (default true), `idempotencyKey`.
- Idempotency and replay: with `idempotencyKey`, the mutation actions `pr_comment`, `issue_comment`, `issue_labels_add`, `issue_publish`, `pr_review`, `pr_review_comment`, `pr_review_reply`, `pr_reviewers_request`, `pr_merge`, `pr_auto_merge_enable`, `commit_status_create`, `workflow_dispatch`, and `workflow_run_rerun_failed` cache their successful result and replay it on a same-key retry with identical payload within a 24-hour retention window; reusing the key with a different request payload is rejected with `CONFLICT`. After 24 hours the record expires and the request executes anew.
<!-- cloudharness-example:github_action
{
  "workspaceId": "ws_abcdefghijklmnopqrstuvwxyz012345",
  "action": "pr_list",
  "limit": 10,
  "state": "open"
}
-->

## Recommended sequence

1. `git_status` and unstaged/staged `git_diff`.
2. Fetch only when current remote state is required.
3. Make the local branch/worktree change.
4. Re-run status, diff, tests, and log.
5. Commit only the intended files.
6. Push only with explicit target authorization and current evidence.
