---
title: Agents
description: The agent control center — run a Pi agent, then watch its hierarchy, budgets, logs, and control.
---

# Agents

`/dashboard/agents` is the agent control center. The workspace cockpit's **Agents**
tab renders the same view scoped to one workspace, so a filter and a fact mean the same
thing in both places.

## Run a Pi agent

**Run Pi agent** (the page action on `/dashboard/agents`, and a button on a workspace's
**Agents** tab) starts one bounded agent run from a form, without writing an
`agent_spawn` payload by hand. The form asks for:

- **Workspace** — only an active, unexpired workspace with network access off
  (`network-none`) can host an agent; any other workspace is listed but disabled with
  the reason. From a workspace's tab the workspace is fixed.
- **Model profile** — a searchable list of your Models & Budgets profiles. Only an
  `ACTIVE` profile with an active revision can be chosen; disabled, sync-pending,
  sync-failed, and revision-less profiles stay visible but disabled with their state.
  The summary names the model, API mode, base prices, ceilings, and the **revision that
  will be pinned**. An unverified or failed connection check, or a model gateway that
  is out of sync, is a warning rather than a block: the runner reconciles the gateway
  before the run starts and fails without spending if it cannot.
- **Task** — the prompt, up to 128 KiB.
- **Permissions** — the *Read only* and *Code editing* presets, or a custom set of
  proxy operations. A preset the profile's ceiling does not cover is disabled.
- **Limits** — time limit, input and output tokens, cost cap, and retained output,
  prefilled from the profile's ceilings. A value past a ceiling is refused in the form,
  and the runner refuses it again rather than clamping it.

Before you submit, **Before you spawn** states the isolation (own container, no network
except the model gateway, provider keys never reach the agent), whether the agent can
change files, the hard cost cap reserved against your spend policies, the base-price
worst case for the token limits, and that the run is bounded.

Each distinct request carries one idempotency key, so resending the same form after a
failure replays the first spawn instead of starting a second run; editing the form gets
a new key. On success the page opens the new agent.

A Dashboard run is a **bounded run**, not a persistent session: the agent works on its
one task until it finishes, fails, hits a budget, or its time limit ends, and then its
process exits. To continue the work after that, start a new run. Use a workspace
terminal for an interactive shell.

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

Opening an agent shows four sections. While the run is live (spawning, running, or
cancelling) the page refreshes every few seconds: status and usage update, and new log
events are appended from the runner's log cursor. Only those sections refresh, so a
message you are typing stays put while the run is live. Refreshing stops when the run
ends or you leave the page.

- **Overview** — status, the profile, model, API mode and pinned revision the run is
  bound to (a static runner profile says so, and a deleted profile reads as **Deleted
  profile**), parent, start and terminal times, expiry, terminal reason, whether the
  outcome is unknown, and the proxy operations the agent may use.
- **Usage** — input and output tokens, estimated cost and remaining cost budget, output
  bytes, tool time, wall time, and event count, each against its limit where a limit
  exists. Cost is estimated from reported tokens and the pinned revision's prices, not a
  provider bill.
- **Logs** — a bounded, redacted tail. An oversized event is truncated with an explicit
  marker rather than silently dropped.
- **Messages** — *steer* redirects a running agent after its current tool call; a
  *follow-up* waits until it finishes its current work. Each message carries a
  client-generated idempotency key, so a retry cannot double-deliver. The page reports
  the delivery state honestly: delivered, queued, refused because the queue is full, or
  **not confirmed** when the agent's channel was unavailable (for example after the run
  ended). **Cancel** cascades to every child agent and asks for confirmation first. Once
  the run has ended, both controls are disabled.

## Filters

Status, workspace, parent agent, profile, and attention state. The profile filter matches
the saved profile name as well as the pinned revision ID. Filters are reflected in
the URL, so a filtered view can be shared or reloaded.
