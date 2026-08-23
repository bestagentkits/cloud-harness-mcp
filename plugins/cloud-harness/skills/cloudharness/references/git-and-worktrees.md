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

- Required: `workspaceId`, `message` (1–10,000 characters), `authorName`
  (1–200), and valid `authorEmail`; `all` defaults to `false`.
- `all: true` runs an all-path staging step and includes untracked files as well
  as tracked modifications/deletions. Inspect status for secrets and unrelated
  files first. The tool creates a local commit and does not sign or push it.

## Origin transfer and history integration

The trusted runner brokers repository credentials when configured. Credentials
must remain outside the checkout, command inputs, environment, logs, and remote
URL. Network access for these tools is separate from executor egress.

<!-- cloudharness-tool:git_fetch -->
### `git_fetch`

- Required: `workspaceId`; `remote` is fixed to `origin`; optional `refspec`
  is a source ref only and cannot contain a destination (`:`).
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
  `refspec`; `forceWithLease` defaults to `false`.
- A refspec source is `HEAD` or a branch-like ref; an optional destination must
  be `refs/heads/...`. Deletion, tags, option injection, ranges, and reflog
  syntax are rejected.
- Force-with-lease requires `expectedRemoteOid`, a lowercase 40- or 64-hex
  object ID. With a refspec it also requires an explicit destination branch.
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

<!-- cloudharness-tool:github_action -->
### `github_action`

- Required: `workspaceId`, `action` (`pr_list`, `pr_view`, `pr_create`, `issue_list`, `issue_view`, or `issue_create`).
- Uses trusted GitHub App broker tokens passed via stdin to an ephemeral helper container. Tokens are never exposed to workspace files.
- `pr_list` / `issue_list`: optional `limit` (default 20, max 100), `state` (`open`, `closed`, or `all`).
- `pr_view`: required `prNumber`.
- `pr_create`: required `title`, `head`; optional `body`, `base` (default `main`).
- `issue_view`: required `issueNumber`.
- `issue_create`: required `title`; optional `body`.

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
