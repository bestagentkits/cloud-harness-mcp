---
phase: 10
title: "Analytics charts and decision visualizations (issue Phase 9)"
status: pending
priority: P2
effort: "2d"
dependencies: [9]
---

# Phase 10: Analytics charts

Issue phase: **Phase 9**.

## Goal

Add only the visualizations that answer an operator question, built as internal
SVG from bounded aggregated data, accessible by keyboard and screen reader, and
respecting the existing design-system constraints.

## Charts and the question each answers

| Chart | Question |
|---|---|
| Execution health timeline | Is execution health degrading? |
| Cost trend (from `usage.costMicros`) | Is spend increasing unexpectedly? |
| Model-profile tokens/cost by `profileId` | Which profile drives usage? |
| Budget burn for running agents | Which agent is about to be stopped by limits? |
| MCP reliability from gateway traces | Which downstream server is slow or unreliable? |
| Workspace expiry distribution | Which workspaces need action soon? |
| Task DAG | What is blocked and why? (shipped in Phase 5) |
| Agent hierarchy | Which child introduced failure or cost? (shipped in Phase 4) |

## Tasks

1. **Chart primitives** in a new module `apps/api/dashboard/components/charts.js`
   (bar, line, stacked bar, sparkline, buckets) producing SVG strings through the
   same escaping path as other renderers. No external dependency, no CSS
   gradient, no inline style attribute.
2. **Accessibility contract per chart**: a text/table fallback rendered with the
   chart, keyboard-focusable data points where interactive, focusable tooltip
   content exposed as text, non-colour-only state, and an accessible name and
   description.
3. **Bounded data**: charts consume the aggregate projections from Phase 9 and
   never raw logs; each chart states its window and scope.
4. **Reduced motion**: no animated chart transitions; if any transition exists it
   collapses under `prefers-reduced-motion`.
5. **Empty/degenerate data**: zero data, single point, and all-equal values render
   a labelled empty or flat state rather than a broken chart.

## Acceptance criteria

- Every chart has a text equivalent; a screen reader can read the same numbers.
- No chart introduces a new asset origin, font, gradient or inline style; the CSP
  and design-token tests stay green.
- Data scope is visible in the chart caption.
- Charts are responsive at ~375px without horizontal page scroll.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: chart fallback text, degenerate data, contrast/token compliance, escaping
of labels, reduced-motion behaviour. Browser QA in both themes at desktop and
~375px.

## Risks

| Risk | Mitigation |
|---|---|
| Chart sprawl beyond decision usefulness | The table above is the allowlist; a chart without a question does not ship |
| SVG labels are attacker-influenced | All values escape through the existing render-escape path |
