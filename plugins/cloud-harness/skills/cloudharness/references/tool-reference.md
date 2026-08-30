# Cloud Harness tool reference index

Cloud Harness exposes the following public operations. Every operation accepts
JSON input and returns the common structured result envelope described in
[workspace lifecycle and results](workspace-lifecycle-and-results.md).

## Workspace lifecycle

See [workspace lifecycle and results](workspace-lifecycle-and-results.md).

`workspace_open` `workspace_list` `workspace_status` `workspace_capabilities`
`workspace_close` `workspace_lease_renew` `workspace_recover`
`workspace_context` `workspace_set_active`

## Files and code search

See [files and search](files-and-search.md).

`files_list` `files_read` `files_write` `files_write_batch` `files_apply_patch`
`files_delete` `files_move` `files_mkdir` `grep_search` `symbols_search`
`symbols_references`

## Execution and managed processes

See [execution and tasks](execution-and-tasks.md).

`exec_run` `shell_open` `shell_io` `shell_close` `sessions_list`
`sessions_open` `sessions_io` `sessions_close` `tasks_list` `tasks_run`
`tasks_status` `tasks_cancel` `tasks_graph` `operation_status`
`operation_cancel` `operation_wait`

## Git and worktrees

See [Git and worktrees](git-and-worktrees.md).

`git_status` `git_diff` `git_log` `git_branch` `git_checkout` `git_add`
`git_commit` `git_identity_status` `git_identity_set` `workspace_finalize`
`git_fetch` `git_pull` `git_push` `git_merge` `git_rebase` `worktrees_list`
`worktrees_create` `worktrees_remove` `github_action`

## Repository automation and memory

See [repository automation](repository-automation.md).

`skills_list` `skills_read` `skills_run` `hooks_list` `hooks_run`
`hooks_activate` `hooks_deactivate` `memories_list` `memories_read`
`memories_write` `memories_search` `memories_delete` `deployments_list`
`deployments_run`

## Retained artifacts

See [retained artifacts](artifacts.md).

`artifacts_snapshot` `artifacts_list` `artifacts_read` `artifacts_restore`
`artifacts_delete`

## Shared input rules

- `workspaceId`, `shellId`, `sessionId`, `taskId`, and `operationId` are opaque
  handles. Copy them exactly from results; never derive them from names or paths.
- Paths are workspace-relative, at most 1,024 characters, and cannot be
  absolute, contain NUL, use a Windows drive prefix, or include `..` segments.
- Entry paths for move/delete/mkdir must identify something below the workspace
  root; `.` is not an entry path.
- Pagination defaults to `limit: 100`, permits `1..500`, and accepts a cursor of
  at most 256 characters. A cursor belongs only to the operation/result that
  returned it.
- Timeout and output bounds are hard limits. Choose the smallest value that
  covers the expected operation; a larger bound is not a recovery strategy.

## Annotation meaning

Clients may show approval UI from these MCP annotations:

- `readOnlyHint`: the tool only retrieves state.
- `destructiveHint`: the tool can delete, overwrite, rewrite history, execute
  arbitrary code, or trigger an external action.
- `idempotentHint`: repeating the same call with the same input is expected to
  have the same effect. It does not make a lost mutation safe to retry unless
  the detailed reference says how to recover it.
- `openWorldHint`: the tool may contact or affect a system outside the executor.

Annotations are hints, not authorization. Inspect every operation and input.
