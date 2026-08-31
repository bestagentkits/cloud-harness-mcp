---
title: Sessions and Task DAGs
description: Interactive PTY terminal sessions and directed acyclic task graph workflows.
---

# Sessions and Task DAGs

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/reference/sessions-and-tasks.md</code>.
</div>

## Persistent PTY Sessions

For commands requiring user interaction, REPLs, or live monitoring:
- `shell_open`: Spawns a persistent pseudoterminal (PTY) session inside the workspace.
- `shell_io`: Sends input (keystrokes, text) and reads streaming output.
- `shell_close`: Gracefully signals or terminates the process.

## Task Graphs (DAGs) & Durable Task Engine

For detached builds, test suites, and multi-stage workflows:
- `tasks_run`: Submits a dependency-aware task graph (`dependsOn`). Task metadata, status, and bounded log outputs are persisted in SQLite.
- `tasks_status`: Polls execution status, progress, and bounded log outputs.
- `tasks_list`: Lists all tasks associated with the workspace.
- `tasks_cancel`: Cancels running or pending task stages.
- `tasks_graph`: Inspects dependency topology for diagnosing blocked tasks.

### Durability & Restart Reconciliation

- **Durable State:** Unlike interactive PTY sessions (which live in volatile memory only and are lost on runner restart), task records, dependency DAGs, and on-disk logs persist across runner restarts.
- **Crash Reconciliation:** In-flight tasks from a prior runner epoch transition to `RUNNER_RESTARTED` upon restart and can be inspected via `tasks_status`/`tasks_list`.
- **Artifact Spooling:** When a workspace closes or expires, task log outputs are automatically spooled into retained artifact storage.

The official Model Context Protocol specification ([Tasks Extension Overview](https://modelcontextprotocol.io/extensions/tasks/overview), 2026-07-28 revision) defines task management as an optional protocol extension (`io.modelcontextprotocol/tasks`) with `tasks/get`, `tasks/update`, `tasks/cancel`, and progress notifications.

| Host / Client | Extension Support Status | Capability Handshake | Decision |
| :--- | :--- | :--- | :--- |
| **Claude Desktop** | Absent from official matrix | Not verified | Maintain canonical `tasks_*` tools |
| **Cursor** | Absent from official matrix | Not verified | Maintain canonical `tasks_*` tools |
| **Codex** | Absent from official matrix | Not verified | Maintain canonical `tasks_*` tools |
| **ChatGPT Web** | Absent from official matrix | Not verified | Maintain canonical `tasks_*` tools |
| **Generic Streamable HTTP** | Absent from official matrix | Not verified | Maintain canonical `tasks_*` tools |

*Reference: [Official Extension Client Matrix](https://modelcontextprotocol.io/extensions/client-matrix).*

**Decision:** Cloud Harness MCP keeps its stable, verified tool contracts (`tasks_run`, `tasks_status`, `tasks_list`, `tasks_cancel`, `tasks_graph`) as canonical. Standard MCP Tasks facade integration remains evaluated and **default-off** to prevent protocol drift until official client host runtime support is verified across the ecosystem matrix.
