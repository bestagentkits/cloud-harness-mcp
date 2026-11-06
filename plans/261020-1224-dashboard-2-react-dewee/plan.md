# Dashboard 2.0 (#458) — plan index

Brief: [brief.md](brief.md) · Decision: [ADR 0005](../../docs/adr/0005-dashboard-react-rewrite.md) · Inventory: [parity matrix](../../docs/dashboard-parity-matrix.md)

| Phase | Status | Child issue draft | Depends on |
| --- | --- | --- | --- |
| P0 ADR + parity matrix + docs | in review | (this PR) | — |
| P1 scaffold, build, manifest, canary | pending | [p1](child-issues/p1-scaffold-build-canary.md) | P0 |
| P2 router, shell, query, primitives | pending | [p2](child-issues/p2-router-shell-query-primitives.md) | P1 |
| P3 core pages | pending | [p3](child-issues/p3-core-pages-migration.md) | P2 |
| P4 sensitive + complex flows | pending | [p4](child-issues/p4-sensitive-and-complex-flows.md) | P2, P3 shared components |
| P5 CX/AX, palette, Dewee | pending | [p5](child-issues/p5-cx-ax-dewee.md) | P3, P4, dewee-webchat release |
| P6 perf, QA, canary, cutover | pending | [p6](child-issues/p6-perf-canary-cutover.md) | P1–P5 |

Acceptance: brief "Done means" 1–13. Rollback for every phase: `CLOUD_HARNESS_DASHBOARD_UI=legacy` + restart `api`.
