---
title: Protocol Limits & Bounds
description: Safety boundaries, truncation limits, pagination sizes, and timeouts.
---

# Protocol Limits & Bounds

To prevent unbounded memory growth and buffer overflow attacks, Cloud Harness MCP enforces deterministic bounds across all operations:

## Resource Bounds

| Surface | Limit | Configurable Env Var |
|---|---|---|
| **Max File Read Size** | 1 MiB per call (default 64 KB; the dashboard reads at most 256 KB) | `files_read.limit`, `files_read.readAll` |
| **Max Command Exec Output** | 1 MB | `exec_run` and `bash` buffer |
| **Max Artifact Size** | 16 MB | `MAX_ARTIFACT_BYTES` |
| **Total Principal Artifacts** | 128 MB | `MAX_PRINCIPAL_ARTIFACT_BYTES` |
| **Workspace Wall TTL** | 900s (15 min) | `WORKSPACE_WALL_TTL_SECONDS` |
| **Workspace Idle TTL** | 300s (5 min) | `WORKSPACE_IDLE_TTL_SECONDS` |
| **Recoverable Grace** | 3600s (60 min) | `WORKSPACE_RECOVERABLE_GRACE_SECONDS` |
| **Active Workspaces** | 3 per principal | `MAX_ACTIVE_WORKSPACES_PER_OWNER` |
| **Repositories per Workspace** | 5 (at most 20) | `MAX_WORKSPACE_REPOSITORIES` |
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
| **Active Subagents** | 4 per workspace, 8 per principal, 16 per instance | `AGENT_WORKSPACE_ACTIVE`, `AGENT_PRINCIPAL_ACTIVE`, `AGENT_GLOBAL_ACTIVE` |
| **Subagent Records per Workspace** | 1000 spawns and messages over the workspace's life | `AGENT_WORKSPACE_LIFETIME_RECORDS` |
| **Subagent Record Retention** | 7 days after a closed workspace's last agent ended, then compacted | `AGENT_RETENTION_SECONDS` |
| **Compacted Subagent Lookup** | 30 days after the agent ended, then purged | `AGENT_LOOKUP_HORIZON_SECONDS` |

The workspace TTLs, recoverable grace, and active-workspace quota can also be overridden instance-wide in Dashboard → [Settings](/dashboard/settings#workspace-limits-lifecycle), which takes precedence over the runner variable. TTL and grace changes apply only to workspaces opened afterwards.

The subagent limits are runner variables only. The full set, with the retained row and byte caps, is listed in [Environment Variables](/reference/environment-variables).

## Agent model budgets

Every `agent_spawn` model request goes through the Model Gateway. Before sending a request, the gateway reserves the worst case the request can cost from the agent's token and cost caps:

- **Input** is reserved per request byte. Each image, audio, video, or file part also adds a fixed surcharge, because a small image can cost more tokens than its bytes.
- **Output** is reserved at the output cap the gateway sends upstream. The cap is lowered to what the remaining cost budget can pay for. Reasoning tokens count as output.
- When the response ends, the gateway charges the usage the provider reported, including cache reads, cache writes, reasoning, and long-context price tiers. It never charges less than a cost the provider reports. Unused reservation is refunded. A request that fails, is cancelled, or reports no usage is charged its full reservation.

A request that the remaining budget cannot cover is refused with `429 model_budget_exhausted`. The error envelope also carries the refusal code `budget_exceeded`, in `type` and at the start of the message, so agent logs and traces report the refusal as a `budget` error rather than as provider rate limiting (`rate_limit`). A streamed response whose reported output passes the reserved output cap is cut off: the gateway forwards the usage event that crossed the cap, then ends the stream with an SSE `error` event carrying `model_bound_exceeded`, so the agent run ends `LIMIT_EXCEEDED` instead of reporting a dropped connection. All figures are gateway estimates, not a provider invoice. The exact reservation rules, surcharge, and pricing are owned by [`apps/model-gateway/src/budget.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/apps/model-gateway/src/budget.ts).
