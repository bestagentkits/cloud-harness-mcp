---
title: Security Audit Trail
description: Inspecting immutable security logs and tool execution records.
---

# Security Audit Trail

::: info Audit is now a filter
This page remains at `/dashboard/audit` and in the command palette for anyone who wants
only the retained record. In the navigation, audit history is the **Audit** filter of the
[Activity Center](/dashboard/activity), which puts it on one timeline beside live runtime
data while keeping it visibly distinct from it.
:::

Cloud Harness MCP records an immutable audit log of all tool invocations and lifecycle operations in SQLite.

## Recorded Events

- Workspace lifecycle (`workspace_open`, `workspace_close`, TTL terminations).
- Command executions (`exec_run`, `shell_open`, shell exits).
- File mutations (`files_write`, `files_delete`, `files_apply_patch`).
- Git operations (`git_push`, branch switches, commits).
- Security events (authentication failures, permission denials, rate limits).

Logs record timestamps, authenticated principal ID, target repository, and exit status.
