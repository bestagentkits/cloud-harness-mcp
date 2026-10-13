---
phase: 4
title: "Agent Control Center: global list, hierarchy, detail (issue Phase 3)"
status: pending
priority: P1
effort: "2-3d"
dependencies: [1, 3]
---

# Phase 4: Agent Control Center

Issue phase: **Phase 3**. The single largest missing UI capability.

## Goal

Agents become first-class: an operator can see every agent, its owner workspace,
its parent, its profile, what it costs, how close it is to a limit, why it
stopped, and can steer, follow up, or cancel it — from a global
`/dashboard/agents` page and from the workspace Agents tab.

## Tasks

1. **Agent list** (global and workspace-scoped) with filters for status,
   workspace, model profile, parent agent, and attention state. Columns:
   identity, workspace, parent relation, profile, status, age/runtime, TTL,
   tokens, cost, budget utilization.
2. **Agent hierarchy** from `parentAgentId`: an accessible tree that exposes
   `running / succeeded / failed` as text and semantic classes, with a
   non-graph fallback (nested list) for screen readers and reduced layouts.
3. **Agent detail** with Overview, Logs, Usage, Messages:
   - Overview: status, profile, parent, creation/start/terminal times, expiry,
     terminal reason, `outcomeUnknown`, allowed proxy operations.
   - Logs: bounded, redacted tail with a clear bound indicator.
   - Usage: input tokens/max, output tokens/max, cost/max cost, output bytes/max,
     tool time, wall time, event count — each with its scope labelled.
   - Messages: bounded message history plus follow-up and steer inputs.
4. **Actions**: send follow-up, steer, cancel — each with confirmation where
   destructive, live-region feedback, and pending state.
5. **Budget edge cases** handled explicitly: zero budget, unlimited budget,
   exhausted budget, and missing usage (render "not reported", never `0` or
   `NaN`).

## Acceptance criteria

- Filters compose and are reflected in the URL where useful.
- Hierarchy is keyboard navigable; every node exposes its state as text.
- Detail renders all four sections for a terminal agent and for a running agent.
- Cancel/steer/follow-up work end to end against the adapter layer and announce
  their outcome.
- No raw credentials, model-gateway secrets, or unbounded logs are rendered.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: agent response mapping/redaction, hierarchy rendering (including a node
whose parent is missing), budget percentage edge cases, terminal-reason and
`outcomeUnknown` rendering. Browser QA of hierarchy keyboard navigation at
desktop and ~375px.

## Risks

| Risk | Mitigation |
|---|---|
| Agent state shape varies by terminal reason | Render from an explicit field map with fallbacks; test each terminal state |
| Hierarchy rendering explodes for deep trees | Cap depth with an explicit "expand" control; keep the flat fallback |
| Logs view becomes an unbounded stream | Bounded tail only; the bound is visible in the UI |
