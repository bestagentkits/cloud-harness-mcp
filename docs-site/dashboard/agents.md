---
title: Agents
description: The agent control center — hierarchy, budgets, logs, and control.
---

# Agents

`/dashboard/agents` is the agent control center. The workspace cockpit's **Agents**
tab renders the same view scoped to one workspace, so a filter and a fact mean the same
thing in both places.

## The list and the hierarchy

Agents are shown twice on purpose: as a nested list built from `parentAgentId` (so a
screen reader gets real nesting and a child appears under the agent that spawned it) and
as a flat table that names each parent. An agent whose parent is not on the page is
attached to the root instead of disappearing.

Each row carries the agent's status, workspace, model profile, age, TTL, token use,
cost, and cost-budget utilisation. A limit the runner never reported reads as **Not
reported** rather than `0%`, and an over-spend clamps at 100%.

## One agent

Opening an agent shows four sections:

- **Overview** — status, profile, parent, start and terminal times, expiry, terminal
  reason, whether the outcome is unknown, and the proxy operations the agent may use.
- **Usage** — input and output tokens, cost, output bytes, tool time, wall time, and
  event count, each against its limit where a limit exists.
- **Logs** — a bounded, redacted tail. An oversized event is truncated with an explicit
  marker rather than silently dropped.
- **Messages** — steer a running agent or queue a follow-up. Each message carries a
  client-generated idempotency key, so a retry cannot double-deliver. **Cancel** cascades
  to every child agent and asks for confirmation first.

## Filters

Status, workspace, parent agent, profile, and attention state. Filters are reflected in
the URL, so a filtered view can be shared or reloaded.
