# Phase 11 (issue #220, Phase 10): state-conveying micro-interactions

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-11` (task-11 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-11-micro-interactions.md`

## Summary

Motion now marks state changes and nothing else, inside the 150-250ms band, and the
global reduced-motion block collapses all of it. The approvals badge finally has its
own styling, a mutation crossfades the region it re-rendered, a save moves from
`Saving…` to a `Saved` state, lease posture gains weight and a rule at its thresholds,
and chart bars, task nodes and agent rows gained visible focus treatment.

Phase 11 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/dashboard/dashboard.css` — the `.nav-badge` pill (pending approvals), the
  `.content-just-updated` mutation crossfade with its `state-crossfade` keyframe, the
  `data-save-state` save states, `.lease-soon` / `.lease-expired` threshold emphasis,
  focus-visible treatment for `.chart-bar` and `.task-node` (an **outline that replaces
  the indicator rather than removing it**), agent-tree and disclosure transitions, and a
  drawer transition on `#detail`.
- `apps/api/dashboard/dashboard.js` — `submitForm` sets `data-save-state` to `saving`
  then `saved` and calls the new `flashUpdated()`, which crossfades the region a
  mutation re-rendered (guarded for the test double, which has no `classList`).
- `docs/design-guidelines.md` — the motion contract: what animates, the one allowed
  endless animation (the loading skeleton), and why reduced motion is honoured by
  construction rather than per rule.
- `apps/api/test/dashboard-ui-contract.test.ts` — two new assertions: every state class
  exists, exactly one endless animation exists and it belongs to `.skeleton`, the
  reduced-motion block collapses animation and transition durations, durations come from
  the motion tokens, the stylesheet still contains no gradient, and the client exposes
  both save states plus the mutation cue.

## Verification

- `npx vitest run dashboard` — 25 files, 323 tests, all passing; API typecheck clean.
- The new contract test failed first on two real problems and both were fixed rather than
  relaxed: a second `infinite` occurrence (my own comment said "no infinite decorative
  motion" — reworded) and two `outline: none` rules caught by the repository's
  "never removes a focus indicator without a replacement" guard, now replaced with a
  visible accent outline.

## Residual

Optimistic enable/disable is not implemented, because the surfaces that toggle state
(API keys, MCP servers, skills) answer with a generation-fenced result that can conflict;
the UI keeps the server-confirmed flow and reports the outcome in the live region instead
of showing a state it may have to roll back.
