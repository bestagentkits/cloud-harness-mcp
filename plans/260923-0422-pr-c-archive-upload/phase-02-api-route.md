---
phase: 2
title: "Upload route accepts an archive under a hard body limit"
status: pending
priority: P1
effort: "2-3h"
dependencies: [1]
---

# Phase 02 — API route

## Deliverable

An upload route that accepts a `.zip` under a hard body limit and forwards it to the runner
operation, surfacing the per-item results unchanged.

## Owners to inspect first

- `apps/api/src/dashboard-control-router.ts` — the import routes at `/api/v1/skill-imports` are the
  closest existing shape.
- The route table that applies per-route body limits and authentication, so the new route inherits
  both rather than inventing them.

## Steps

1. Add the route, owned by the dashboard control surface and authenticated like its neighbours. It
   needs its own `express.raw` limit: the surrounding `express.json` parser cannot read a ZIP, and a
   JSON limit would reject the upload before the archive cap is checked.
2. Reject before reading the body when the declared `Content-Length` exceeds the archive cap, and
   enforce the same cap while streaming, so a missing or lying `Content-Length` cannot bypass it.
3. Reject a body that is not an archive the runner will accept, and forward the bytes to the runner
   operation as base64 inside the existing JSON envelope, the encoding the plan settled on.
4. Return the runner's per-item results without reshaping them, so the dashboard and the runner agree
   on one vocabulary for outcomes.
5. Confirm the route does not log the archive bytes or its decoded contents: a skill document is
   operator content and can carry text that must not reach the log.

## Acceptance

- A valid archive forwards and returns per-item results.
- A body above the cap is rejected with no forward call made.
- An oversized body with a small declared `Content-Length` is still rejected.
- The route requires the same authentication as its neighbours.

## Tests

Extend the dashboard control route tests with the cap rejection and the forwarding shape.
