---
title: Protocol Limits & Bounds
description: Safety boundaries, truncation limits, pagination sizes, and timeouts.
---

# Protocol Limits & Bounds

To prevent unbounded memory growth and buffer overflow attacks, Cloud Harness MCP enforces deterministic bounds across all operations:

## Resource Bounds

| Surface | Limit | Configurable Env Var |
|---|---|---|
| **Max File Read Size** | 256 KB (default 64 KB) | `files_read.limit` |
| **Max Command Exec Output** | 1 MB | `exec_run` and `bash` buffer |
| **Max Artifact Size** | 16 MB | `MAX_ARTIFACT_BYTES` |
| **Total Principal Artifacts** | 128 MB | `MAX_PRINCIPAL_ARTIFACT_BYTES` |
| **Workspace Wall TTL** | 900s (15 min) | `WORKSPACE_WALL_TTL_SECONDS` |
| **Workspace Idle TTL** | 300s (5 min) | `WORKSPACE_IDLE_TTL_SECONDS` |
| **Recoverable Grace** | 3600s (60 min) | `WORKSPACE_RECOVERABLE_GRACE_SECONDS` |
| **Active Workspaces** | 3 per principal | `MAX_ACTIVE_WORKSPACES_PER_OWNER` |
| **Max File List Entries** | 500 entries / page | `files_list.limit` |
| **Max Active API Keys** | 10 per identity | Hard bound |
| **Managed Package Release Size** | 512 MiB per release | `PACKAGES_MAX_RELEASE_BYTES` |
| **Managed Package Storage** | 4 GiB per owner | `PACKAGES_MAX_OWNER_BYTES` |
| **Managed Package Bindings** | 32 per owner | `PACKAGES_MAX_BINDINGS` |
| **Managed Package Build Time** | 600s per plan or apply | `PACKAGES_BUILD_TIMEOUT_MS` |
| **Managed Package Builds** | 2 concurrent, plans expire after 30 min | Hard bound |
| **Managed Package Plan Wait** | 20s inline, then poll `packages_status` with the `resolutionId` | Hard bound; keep `REQUEST_TIMEOUT_MS` above it |
| **Skill Size (Skills over MCP, ZIP import)** | 512 files and 16 MiB per skill | Hard bound |
| **`skills/list` Page Size** | 100 skills / page | Hard bound |
| **Skills over MCP Cache Hint** | `ttlMs: 30000`, `cacheScope: private` | Hard bound |

The workspace TTLs, recoverable grace, and active-workspace quota can also be overridden instance-wide in Dashboard → [Settings](/dashboard/settings#workspace-limits-lifecycle), which takes precedence over the runner variable. TTL and grace changes apply only to workspaces opened afterwards.
