---
title: Security Audit Trail
description: Inspecting immutable security logs and tool execution records.
---

# Security Audit Trail

Cloud Harness MCP records an immutable audit log of all tool invocations and lifecycle operations in SQLite.

## Recorded Events

- Workspace lifecycle (`workspace_open`, `workspace_close`, TTL terminations).
- Command executions (`exec_run`, `shell_open`, shell exits).
- File mutations (`files_write`, `files_delete`, `files_apply_patch`).
- Git operations (`git_push`, branch switches, commits).
- Security events (authentication failures, permission denials, rate limits).

Logs record timestamps, authenticated principal ID, target repository, and exit status.
