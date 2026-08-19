---
title: Protocol Limits & Bounds
description: Safety boundaries, truncation limits, pagination sizes, and timeouts.
---

# Protocol Limits & Bounds

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/reference/limits.md</code>.
</div>

To prevent unbounded memory growth and buffer overflow attacks, Cloud Harness MCP enforces deterministic bounds across all operations:

## Resource Bounds

| Surface | Limit | Configurable Env Var |
|---|---|---|
| **Max File Read Size** | 256 KB (default 64 KB) | `files_read.limit` |
| **Max Command Exec Output** | 1 MB | `exec_run` buffer |
| **Max Artifact Size** | 16 MB | `MAX_ARTIFACT_BYTES` |
| **Total Principal Artifacts** | 128 MB | `MAX_PRINCIPAL_ARTIFACT_BYTES` |
| **Workspace Wall TTL** | 900s (15 min) | `WORKSPACE_WALL_TTL_SECONDS` |
| **Workspace Idle TTL** | 300s (5 min) | `WORKSPACE_IDLE_TTL_SECONDS` |
| **Max File List Entries** | 500 entries / page | `files_list.limit` |
| **Max Active API Keys** | 10 per identity | Hard bound |
