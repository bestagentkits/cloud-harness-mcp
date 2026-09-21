---
phase: 11
title: "State-conveying micro-interactions within reduced-motion limits (issue Phase 10)"
status: pending
priority: P3
effort: "1d"
dependencies: [10]
---

# Phase 11: Micro-interactions and state feedback

Issue phase: **Phase 10**.

## Goal

The Dashboard feels responsive without decorative motion: every animation
conveys a state change, nothing loops, and `prefers-reduced-motion` collapses all
of it.

## Tasks

1. Normalize the following, each driven by a state change rather than a timer:
   - state update crossfade (row/panel content replacement),
   - row highlight after a successful mutation,
   - copy → check feedback,
   - optimistic enable/disable only where rollback is safe (guarded by the
     mutation's own confirmation),
   - active-nav rail transition,
   - drawer slide/fade,
   - `Saving…` → `Saved` state,
   - dirty editor indicator,
   - TTL emphasis thresholds (approaching expiry),
   - chart tooltip/focus state,
   - task/agent node state transitions,
   - tree expand/collapse preserving spatial context.
2. **Motion budget**: 150-250ms, no infinite or decorative animation, no page-load
   choreography, no motion on scroll.
3. **Reduced motion**: every transition above collapses under
   `@media (prefers-reduced-motion: reduce)` — verified in `dashboard.css` and by
   test.
4. **No inline styles**: all motion lives in `dashboard.css`; the UI contract test
   continues to assert the absence of `style=`.

## Acceptance criteria

- Each interaction lists the state it conveys; none is purely decorative.
- `prefers-reduced-motion: reduce` removes all transitions and animations
  (asserted by test).
- No CSP violation, no inline style, no gradient, no external asset.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: reduced-motion coverage for every animated selector, absence of
`animation-iteration-count: infinite`, presence of the state classes. Browser QA
with reduced motion emulated, plus normal motion at desktop and ~375px.

## Risks

| Risk | Mitigation |
|---|---|
| Motion accumulates into noise | The list above is the allowlist; new motion needs a stated state |
| Reduced-motion regressions across themes | One shared media-query block plus a test enumerating animated selectors |
