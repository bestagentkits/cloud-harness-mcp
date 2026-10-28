# Cloud Harness tool reference index

Cloud Harness exposes the following public operations. Every operation accepts
JSON input and returns the common structured result envelope described in
[workspace lifecycle and results](workspace-lifecycle-and-results.md).

## Workspace lifecycle

See [workspace lifecycle and results](workspace-lifecycle-and-results.md).

`workspace_open` `workspace_list` `workspace_status` `workspace_capabilities`
`workspace_close` `workspace_lease_renew` `workspace_recover`
`workspace_context` `workspace_set_active` `workspace_repos_list`
`workspace_repo_status` `workspace_repo_add` `workspace_repo_remove`
`workspace_show_ui` (see [MCP Apps explorer](#mcp-apps-explorer))

Several repositories in one workspace: see
[multi-repository workspaces](multi-repository-workspaces.md).

## Files and code search

See [files and search](files-and-search.md).

`files_list` `files_read` `files_write` `files_write_batch` `files_apply_patch`
`files_delete` `files_move` `files_mkdir` `grep_search` `symbols_search`
`symbols_references`

## Execution and managed processes

See [execution and tasks](execution-and-tasks.md).

`exec_run` `bash` `shell_open` `shell_io` `shell_close` `sessions_list`
`sessions_open` `sessions_io` `sessions_close` `tasks_list` `tasks_run`
`tasks_status` `tasks_cancel` `tasks_graph` `operation_status`
`operation_cancel` `operation_wait`

Coding agents: `agent_spawn` `agent_status` `agent_logs` `agent_message`
`agent_cancel` `agent_list`.

## Agent traces

See [agent traces](agent-traces.md).

`agent_traces_list` `agent_trace_get` `agent_trace_spans` `agent_trace_export`

## Managed toolbox packages

See [managed packages](managed-packages.md).

`packages_plan` `packages_apply` `packages_status` `packages_list`
`packages_rollback` `packages_remove`

## Git and worktrees

See [Git and worktrees](git-and-worktrees.md).

`git_status` `git_diff` `git_log` `git_branch` `git_checkout` `git_add`
`git_commit` `git_identity_status` `git_identity_set` `workspace_finalize`
`git_fetch` `git_pull` `git_push` `git_merge` `git_rebase` `worktrees_list`
`worktrees_create` `worktrees_remove` `github_action` `github_read`

## Repository automation and memory

See [repository automation](repository-automation.md).

`skills_list` `skills_read` `skills_run` `hooks_list` `hooks_run`
`hooks_activate` `hooks_deactivate` `memories_list` `memories_read`
`memories_write` `memories_search` `memories_delete`
`knowledge_create` `knowledge_read` `knowledge_update` `knowledge_delete`
`knowledge_list` `knowledge_search` `knowledge_link` `knowledge_unlink` `knowledge_graph`
`deployments_list` `deployments_run`

Not tools: `skills/list`, `skills/get`, and `resources/read` belong to the
MCP Skills extension; see [native MCP skills](../SKILL.md#native-mcp-skills).

## Models and spend

See [models and spend](models-and-spend.md).

`model_provider_list` `model_catalog_search` `model_connection_verify`
`model_profile_list` `model_profile_validate` `model_profile_create`
`model_profile_update` `model_spend_summary`

Profiles created here arrive disabled; keys, activation, deletion, and spend
policies stay with the owner on the Dashboard.

## Webhook automations

See [webhook automations](webhook-automations.md). Remote HTTP endpoint only;
these take no `workspaceId`.

`automation_rules_list` `automation_rule_create` `automation_rule_disable`
`automation_runs_list` `automation_run_get` `automation_run_cancel`

Rules created here arrive disabled; enabling, deletion, and connections stay
with the owner on the Dashboard.

## Retained artifacts

See [retained artifacts](artifacts.md).

`artifacts_snapshot` `artifacts_list` `artifacts_read` `artifacts_restore`
`artifacts_delete`

## Shared input rules

- `workspaceId`, `shellId`, `sessionId`, `taskId`, and `operationId` are opaque
  handles. Copy them exactly from results; never derive them from names or paths.
- Paths are workspace-relative, at most 1,024 characters, and cannot be
  absolute, contain NUL, use a Windows drive prefix, or include `..` segments.
- `repositoryId` (a `repo_` id or alias) selects one checkout of a
  multi-repository workspace; Git-bound tools require it there.
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

## MCP Apps explorer

<!-- cloudharness-tool:workspace_show_ui -->
### `workspace_show_ui`

Open the read-only workspace explorer in hosts that render MCP Apps (ChatGPT,
Claude, and other `io.modelcontextprotocol/ui` clients).

- Required: `workspaceId`. Returns the same record as `workspace_status`, so a
  text-only client still gets a usable summary; an expired lease is an error.
- The host renders `ui://cloud-harness/workspace-explorer-v1.html`, which reads
  only through `workspace_status`, `files_list`, `files_read`, `git_status`,
  `git_diff`, `tasks_list`, `tasks_status`, and `tasks_graph`, always bound to
  this `workspaceId`. It cannot run commands, write, push, or change tasks.
- Use it when a person wants to browse the tree, review a diff, or watch task
  states; keep using the tools directly for anything you need in your context.
- Read-only and safe to repeat.

<!-- cloudharness-example:workspace_show_ui
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa"}
-->
