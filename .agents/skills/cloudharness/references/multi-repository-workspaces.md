# Multi-repository workspaces

One workspace can hold several independent Git checkouts that share one
executor, lease, owner, and trust domain. Use it when one change spans
repositories (a service and its client, an API and its schema package) or a
build needs both trees side by side. For unrelated work, open separate
workspaces instead.

## Open

Pass `repositories` instead of `repositoryUrl` (never both, and no top-level
`ref`):

- Each entry: `url` (credential-free HTTPS), `alias`, optional `ref`, and
  `access` (`read-write` by default, or `read-only`).
- `alias` is 1–40 lowercase letters, digits, or inner hyphens. Aliases and URLs
  must be unique.
- `primaryRepositoryAlias` is optional and defaults to the first entry. Workspace
  records report the primary repository's capabilities at the top level.
- The instance caps the set size; a larger set returns `LIMIT_EXCEEDED` before
  anything is cloned. A clone failure fails the whole open and its message
  starts with `repository <alias>:`.
- Add or remove checkouts later with `workspace_repo_add` and
  `workspace_repo_remove` (below). A single-repository workspace cannot gain
  siblings; open a multi-repository one instead.

<!-- cloudharness-example:workspace_open
{"repositories":[{"url":"https://github.com/acme/api","alias":"api","ref":"main"},{"url":"https://github.com/acme/web","alias":"web","access":"read-only"}],"primaryRepositoryAlias":"api","idempotencyKey":"open-api-web-20261017"}
-->

## Layout and selector

The executor's `/workspace` is the tree root and each checkout lives at
`repos/<alias>/`. Call `workspace_repos_list` first, then pass `repositoryId`
(the `alias` or the `repo_` id) to address one checkout.

| Tool family | Without `repositoryId` | With `repositoryId` |
| --- | --- | --- |
| `git_*` (except identity), `worktrees_*`, `workspace_finalize`, `github_read`, `github_action`, `workspace_recover` `export` | `INVALID_INPUT` listing the aliases (a one-entry set needs none) | Acts on that checkout |
| `files_*`, `grep_search`, `symbols_*` | Paths start at the tree root (`repos/api/src/...`) | Paths start at the checkout; `..` and symlinks cannot leave it |
| `exec_run`, `bash`, `shell_open`, `sessions_open`, `tasks_run` | `cwd` is relative to the tree root | `cwd` is relative to the checkout |
| `workspace_capabilities` | Primary repository | That repository |
| `workspace_recover` `status`/`patch`, `workspace_repo_status` | Every checkout, one entry each | That checkout |
| `workspace_context` | Tree root | That checkout |

A command started in a checkout can still `cd` to a sibling: the selector sets
where it starts, not what it can reach. `git_identity_*`, `shell_io`, and other
handle-based calls take no selector.

<!-- cloudharness-example:git_status
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","repositoryId":"api"}
-->

<!-- cloudharness-example:exec_run
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","repositoryId":"web","command":"npm test","cwd":"."}
-->

## Change the set

Both tools need an `idempotencyKey`, apply only to a multi-repository
workspace, and replay the first result for a repeated key. A close, expiry, or
recovery during the change returns `EXPIRED` and changes nothing; another
change in flight returns a retryable `CONFLICT`. Each change briefly pauses
the executor, so a running command stalls for a moment; it is a retryable
`CONFLICT` while a privileged command or helper container uses the tree.

<!-- cloudharness-tool:workspace_repo_add -->
### `workspace_repo_add`

Clone one more repository into `repos/<alias>/` of the active workspace.

- Required: `url`, `alias`, `idempotencyKey`. Optional: `workspaceId`, `ref`,
  `access`. The entry follows the `workspace_open` `repositories` rules,
  including the instance limit (`LIMIT_EXCEEDED`).
- The checkout is registered only after its clone succeeds. A failure starts
  with `repository <alias>:`, removes only the new checkout, and can be retried
  with the same key. An existing `repos/<alias>` path is a `CONFLICT` and is
  left alone.
- The clone uses the default history; deepen it with `git_fetch`. Returns the
  new entry and the updated `repositories` list.

<!-- cloudharness-example:workspace_repo_add
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","url":"https://github.com/acme/docs","alias":"docs","ref":"main","idempotencyKey":"add-docs-20261019"}
-->

<!-- cloudharness-tool:workspace_repo_remove -->
### `workspace_repo_remove`

Remove one checkout and its directory.

- Required: `repositoryId`, `idempotencyKey`. Optional: `workspaceId`.
- Refused with `CONFLICT` while the checkout has uncommitted or untracked
  paths, stashes, linked worktrees, or commits on no remote; push or discard
  them first. Also refused (retryable) while a task, shell, session, terminal,
  or operation runs inside it, or any agent runs in the workspace.
- The last checkout cannot be removed; use `workspace_close`. Removing the
  primary promotes the next repository.
- `checkoutRemoved: false` means the directory could not be deleted; it then
  blocks auto-close like other unsaved files.
- `executorResumed: false` (add or remove) means the change committed but the
  executor stayed paused; call `workspace_recover` with `mode: "resume"`
  before running more commands.

<!-- cloudharness-example:workspace_repo_remove
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","repositoryId":"docs","idempotencyKey":"remove-docs-20261019"}
-->

## Search every checkout

`grep_search`, `symbols_search`, and `symbols_references` take `scope: "all"`
(never together with `repositoryId`). Results carry `repositoryId` and `alias`,
paths are relative to that checkout, and `data.repositories` reports each
checkout's count, `truncated`, or `error`. When `truncated` and a top-level
`cursor` is set, repeat the call with that `cursor` to search the remaining
repositories. A checkout cut short is not resumed: search it again with its
`repositoryId` and a narrower `path`.

<!-- cloudharness-example:grep_search
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","pattern":"createClient","scope":"all","maxResults":50}
-->

## Read-only repositories

`access: "read-only"` refuses brokered writes for that repository: `git_push`,
`workspace_finalize` with push, `workspace_recover` `export`, and GitHub write
actions return non-retryable `FORBIDDEN` with `error.repository` naming the
alias. `workspace_capabilities` with that `repositoryId` reports
`repositoryAccess: "read-only"` and every write capability `false`; check it
before planning writes.

It is not isolation. Commands in the workspace can still edit files, commit
locally, or reach the network in every checkout. Do not rely on it to protect a
repository, and never try to work around it.

## Single-repository workspaces

A workspace opened with `repositoryUrl` behaves exactly as before.
`workspace_repos_list` reports its one checkout at path `.`, and passing that
`repositoryId` changes nothing, so selector-aware code works for both shapes.

## Finish and recover

- Finalize, push, and open pull requests per repository, each with its own
  `repositoryId` and idempotency key.
- Before `workspace_close`, call `workspace_repo_status` and confirm every
  checkout is clean or pushed.
- Auto-close defers while any checkout has unsaved work, and also when files
  sit beside the checkouts or under `repos/` without being a registered
  checkout (an extra clone, a scratch file), because no remote holds them.
  Keep scratch files inside a checkout or remove them.

## Local servers

Local stdio and local multi-workspace servers do not support this:
`repositoryId`, `scope: "all"`, `workspace_repos_list`, `workspace_repo_status`,
`workspace_repo_add`, and `workspace_repo_remove` return `INVALID_INPUT`. See
[workspace lifecycle](workspace-lifecycle-and-results.md#local-workspaces).
