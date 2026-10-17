---
title: Agents
description: The agent control center — hierarchy, budgets, logs, and control.
---

# Agents

`/dashboard/agents` is the agent control center. The workspace cockpit's **Agents**
tab renders the same view scoped to one workspace, so a filter and a fact mean the same
thing in both places.

## Run Pi agent

**Run Pi agent** is the primary action on the Agents page, on a workspace's
**Agents** tab (which preselects that workspace), and on an agent's detail page. It
starts one bounded run through the same `agent_spawn` contract MCP clients use.

1. **Workspace.** Only an active workspace opened with the **No network** profile can
   run an agent. Other workspaces are listed but disabled with the reason; open a
   workspace with Network profile **No network** if none qualifies.
2. **Model profile.** Only **Active** profiles can run. Disabled, unsynced, or failed
   profiles are listed but disabled; manage them on [Models & Budgets](/dashboard/models).
3. **Task.** The prompt, up to 128 KiB.
4. **Allowed tools.** The run starts **Read only**. **Code changes** adds the file
   write tools; every preset and checkbox is narrowed to what the profile allows.
5. **Limits and repository guidance.** Time limit, cost cap, and input and output
   token caps default to the MCP defaults and can only be lowered below the profile's
   limits. Repository guidance chooses which instruction files go before the task.

Before you start, the preview shows exactly what the run may do: the model and API
mode, the pinned profile revision, whether the model gateway is synced, the isolation
(its own container with no network; provider keys never enter it), the tools (with
the ones that can change files called out), and the cost cap with an estimate of what
the token caps could cost at the profile's prices.

These checks only mirror the runner: it refuses the same workspace, profile, tool,
or budget whatever the browser sends. A retry of the same request after a lost
response replays the first spawn instead of starting a second one. On success the
agent's detail page opens.

A run is **bounded**: it ends when the task completes, its time limit or a cap is
reached, or you cancel it. No session survives it, so to continue the work start a
new run.

## The list and the hierarchy

Agents are shown twice on purpose: as a nested list built from `parentAgentId` (so a
screen reader gets real nesting and a child appears under the agent that spawned it) and
as a flat table that names each parent. An agent whose parent is not on the page is
attached to the root instead of disappearing.

Each row carries the agent's status, workspace, model profile, age, TTL, token use,
cost, and cost-budget utilisation. A limit the runner never reported reads as **Not
reported** rather than `0%`, and an over-spend clamps at 100%.

The per-agent token use and cost are the agent's own estimate, reported by the agent
runtime from the profile's prices. They are not provider billing, and they are not what
aggregate spend policies count: the runner's spend ledger counts each run's whole cost
cap while it runs, then the model gateway's own accounting once it ends. A spawn that
would take a spend policy over its limit is refused with `LIMIT_EXCEEDED` and never
appears in this list.

## One agent

Opening an agent shows four sections:

- **Overview** — status, run type, the pinned profile revision, parent, start and terminal times, expiry, terminal
  reason, whether the outcome is unknown, and the proxy operations the agent may use.
- **Usage** — input and output tokens, cost, output bytes, tool time, wall time, and
  event count, each against its limit where a limit exists.
- **Logs** — a bounded, redacted tail. An oversized event is truncated with an explicit
  marker rather than silently dropped.
- **Messages** — steer a running agent or queue a follow-up. Each message carries a
  client-generated idempotency key, so a retry cannot double-deliver. The form appears
  only while the agent is **Running**; once a run ends it keeps no session, so the page
  says so instead. **Cancel** is offered until the agent stops, cascades to every child
  agent, and asks for confirmation first.

While an agent has not ended, its page refreshes every few seconds for a bounded time.
A refresh never replaces a message you are writing.

## Filters

Status, workspace, parent agent, profile, and attention state. Filters are reflected in
the URL, so a filtered view can be shared or reloaded.
