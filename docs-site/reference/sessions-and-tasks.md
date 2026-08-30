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

## Task Graphs (DAGs)

For complex multi-stage builds or benchmarks:
- `tasks_run`: Submits a parallel dependency graph of tasks.
- `tasks_status`: Polls execution status and outputs of tasks.
- `tasks_cancel`: Cancels running or pending graph stages.
- `tasks_graph`: Inspects dependency topology.
## MCP Tasks Extension Compatibility Matrix (2026-07-28 Revision)

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
