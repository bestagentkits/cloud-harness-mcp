---
phase: 5
title: "Actionable Runtime: tasks, sessions, and the task DAG (issue Phase 4)"
status: pending
priority: P1
effort: "1.5-2d"
dependencies: [3]
---

# Phase 5: Actionable Runtime operations

Issue phase: **Phase 4**.

## Goal

Runtime stops being a passive list. Tasks show what they depend on, what they
returned, and can be cancelled; `tasks_graph` becomes an accessible SVG DAG that
answers "what is blocked and why"; sessions can be listed, inspected within
bounds, and closed — without turning the Dashboard into an unrestricted terminal.

## Tasks

1. **Task list** per workspace: status, duration, exit code, dependencies,
   output/status detail, and cancel. Cancellation confirms, announces, and
   refreshes the row.
2. **Task DAG** from `tasks_graph`: internal SVG with node state conveyed by text
   and a semantic class (never colour alone), focusable nodes that reveal detail
   on focus/click, a visible legend, and a text/table fallback rendered alongside.
   Layout must not depend on external libraries.
3. **Sessions**: list, open, status, bounded IO view, close. The IO view is a
   bounded read of retained output with an explicit bound indicator; it is not an
   interactive shell, and it never streams unbounded output.
4. **State coverage**: loading skeleton, empty state ("no tasks yet — start a
   task from a workspace"), error state with the classified message from
   `dashboard-response.ts`, and a cancelled/terminal-task state.
5. **Reduce motion**: DAG transitions and node emphasis respect
   `prefers-reduced-motion`.

## Acceptance criteria

- A blocked task explains its blocking dependency in the row and in the DAG.
- The DAG is operable with the keyboard and readable by a screen reader through
  the fallback table.
- Cancel works end to end and cannot be triggered twice.
- Session IO never renders more than the configured bound and never renders
  secrets or tokens.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: DAG rendering for a blocked graph and for a single node, accessibility
fallback presence, cancel pending/idempotence, session IO bound, reduced-motion
class assertions. Browser QA of DAG focus behaviour at desktop and ~375px.

## Risks

| Risk | Mitigation |
|---|---|
| Hand-rolled DAG layout produces unreadable graphs | Below-threshold graphs fall back to the table; layout is layered by dependency depth |
| Bounded IO is mistaken for a terminal | Explicit "read-only, bounded" labelling in the panel |
