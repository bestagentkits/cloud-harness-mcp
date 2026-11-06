# feat(dashboard): P6 performance budgets, QA, canary and production cutover (#458)

Parent: #458 · Depends on P1–P5

## Scope
- Measure against the legacy baseline: bundle weight, query counts, memory growth over a 30-minute session, nav visual response p95 (< 100 ms), perceived loading.
- Browser/device QA: desktop, tablet, 375 px; System/Light/Dark; text size and density extremes; loading/error/dialog/terminal flows.
- Staged canary on production via `?ui=react`, then instance flag `react` (owner-authorized merge + cutover).
- Rehearse one-step rollback (`CLOUD_HARNESS_DASHBOARD_UI=legacy` + restart `api` only) and record sanitized evidence.
- Post-deploy smoke checks; evidence comment on #458.
- Follow-up issue (not this PR): remove legacy shell, its assets and markup-coupled tests after the rollback window, once every matrix row is verified.

## Gates
- Every parity matrix row marked verified with a linked test or evidence; any blocking non-parity item keeps #458 open.
- `npm run verify`, dashboard E2E, security suites green on the cutover commit.
- Owner approval recorded before flipping the instance flag.

## Dependencies
P1–P5.

## Rollback
Flip flag to `legacy`, restart `api`. No DB/runner/MCP rollback.
