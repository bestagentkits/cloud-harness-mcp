# Canonical Cloud Harness MCP tool inventory

`packages/contracts/src/runner-api.ts` owns operation names.
`packages/contracts/src/tool-schemas.ts` owns input fields and bounds.
`packages/contracts/src/mcp-results.ts` owns result envelopes. This list is
checked against the runtime registration and must be changed with the contract.

<!-- cloudharness-tool-inventory:start -->
`workspace_open` `workspace_list` `workspace_status` `workspace_close`
`files_list` `files_read` `files_write` `files_apply_patch` `files_delete` `files_move` `files_mkdir` `grep_search`
`symbols_search` `symbols_references`
`exec_run` `shell_open` `shell_io` `shell_close`
`sessions_list` `sessions_open` `sessions_io` `sessions_close`
`tasks_list` `tasks_run` `tasks_status` `tasks_cancel` `tasks_graph`
`git_status` `git_diff` `git_log` `git_branch` `git_checkout` `git_add` `git_commit` `git_fetch` `git_pull` `git_push` `git_merge` `git_rebase`
`worktrees_list` `worktrees_create` `worktrees_remove`
`skills_list` `skills_read` `skills_run`
`hooks_list` `hooks_run`
`memories_list` `memories_read` `memories_write`
`deployments_list` `deployments_run`
<!-- cloudharness-tool-inventory:end -->
