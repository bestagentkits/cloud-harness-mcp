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
- The set is fixed for the workspace's life. To add a repository or change its
  access, open a new workspace.

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
`repositoryId`, `workspace_repos_list`, and `workspace_repo_status` return
`INVALID_INPUT`. See
[workspace lifecycle](workspace-lifecycle-and-results.md#local-workspaces).
