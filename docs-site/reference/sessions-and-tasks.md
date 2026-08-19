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
