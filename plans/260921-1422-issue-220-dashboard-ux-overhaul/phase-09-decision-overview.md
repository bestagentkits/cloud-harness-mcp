---
phase: 9
title: "Decision-oriented Overview and server-side aggregation (issue Phase 8)"
status: pending
priority: P1
effort: "2d"
dependencies: [4, 5, 8]
---

# Phase 9: Decision-oriented Overview

Issue phase: **Phase 8**.

## Goal

The Overview answers "what needs my attention, what is running, what is it
costing, what expires soon" above the fold, and every tile drills into a filtered
detail view. The browser stops fanning out to many endpoints: the server provides
read-only projections.

## Tasks

1. **Server-side projections** (read-only, principal-scoped, bounded):
   - `overview` — attention items, running counts, usage/cost summary, expiry
     buckets.
   - `metrics?window=…` — validated window parameter with an explicit allowlist;
     an unsupported window is rejected, not silently coerced.
   - `activity` — the Phase 8 timeline source in aggregated form.
   Keep route names under the existing `/dashboard/api/v1/*` convention and add
   each operation to `DASHBOARD_RESPONSE_OPERATIONS` with a whitelist mapper.
2. **Overview layout**: Needs attention → Running now → Cost/usage → Expiring
   soon, each tile linking to its filtered destination. Access and Server
   information move below the decision metrics.
3. **Scope honesty for cost**: label the cost tile by the scope actually retained
   (for example "active agents" or "retained window"). Do not label it "today"
   unless the backend can aggregate a true daily window — assert this in a test.
4. **Needs attention** reuses the Phase 3 reasons plus pending approvals and
   unhealthy MCP, each linking to the relevant filtered view.
5. **Loading/empty/error states** and a documented fallback when a projection is
   unavailable (partial data must be labelled, never rendered as zero).
6. Replace the client-side `renderOverview` aggregation with the projection;
   remove the parallel fetch fan-out it performed.

## Acceptance criteria

- Overview renders from the server projection in one bounded request per surface.
- Every tile navigates to a filtered view that shows the same numbers.
- Cost and usage tiles name their retention scope.
- `metrics` rejects an unsupported window with a validation error.
- No inventory-first KPI remains above the fold.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: projection aggregation correctness, window validation (accepted and
rejected), tile-to-view number parity, scope labelling, partial-data labelling,
and redaction for each new projection. Browser QA at desktop/tablet/~375px in
dark and light themes.

## Risks

| Risk | Mitigation |
|---|---|
| Aggregating in the API adds load to a request path | Bounded queries plus existing caching/`no-store` conventions; measure before adding indexes |
| Numbers in the tile and the filtered view diverge | Both read the same projection; parity test asserts equality |
