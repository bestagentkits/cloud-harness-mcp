# Closure hardening for issue #220: the two missing charts, and per-bullet verification evidence

Date: 2026-09-21 · Branch: `fix/issue-220-charts-and-evidence` (delta over `main`)

## Why this exists

An independent audit rejected the previous completion request for two reasons I accept:

1. **Success criterion 14 was not met and cannot be retrofitted.** Phase #234 merged with a
   failing `quality` check (a real `no-undef` error in that diff) and no phase merge was
   CI-gated, because `main` had no required status checks. That is a historical property of
   the phase merges; the remediation below is prospective, and I state the shortfall rather
   than claiming it away.
2. **Criterion 11 lists eight charts and only five shipped.** The execution-health timeline
   and the cost trend were omitted. That gap *is* addressable, so this PR addresses it with
   data the harness actually retains.

## What this PR adds

- `buildOverviewProjection` now returns `agentOutcomes` and `costSeries` over the
  **retained agent window**: agents bucketed by start time, split into
  succeeded / failed-or-limit / cancelled / running, with each bucket summing
  `usage.costMicros`. A window narrower than a minute collapses to one bucket so a burst of
  agents cannot render eight empty ones, and with no agents on record both series are empty
  with the scope reported as `no agents on record` — no fabricated buckets.
- `renderStackedBars` draws a stacked series as internal SVG: one segment per category with
  a `segment-<category>` class, a legend, a focusable bar whose accessible name spells out
  every category count, and a per-bucket table fallback. Zero-height segments are skipped
  while the bucket and its labels remain.
- `renderAnalyticsSection` now carries all eight decision charts — retained-audit volume,
  **execution health over retained agents**, **cost over retained agents**, cost by model
  profile, budget burn, workspace expiry buckets and MCP reliability (plus the task DAG and
  agent hierarchy in their own surfaces) — and states the scope the two series measured.
- `dashboard.css` gains the segment fills and legend; the categories are still named in the
  legend and the table, so colour remains a convenience rather than the only signal.
- `docs/design-guidelines.md` documents the eight-chart inventory and why the series charts
  name the retained-agent window instead of implying a dated ledger.

## Verification

- `npx vitest run dashboard` — **26 files, 330 tests passing**.
- `npx eslint .` — exit 0 (repository-wide, not scoped).
- `npm run typecheck -w @cloud-harness/api` — clean.
- `apps/api/test/dashboard-agent-series.test.ts` — bucket splits and outcome grouping,
  cost summation, single-bucket collapse, empty-series behaviour, stacked-bar legend and
  per-category table, accessible names that include every category count, zero-height
  segment handling, no gradient or inline style, and that the composed section carries all
  eight chart titles with the scope text.

## On criterion 14 (unchanged, and documented rather than hidden)

The phase-by-phase CI record is published on issue #220: #234 merged red; #227–#237 runs
were `cancelled` after being superseded under the workflow's `cancel-in-progress`; only
#238's own post-merge run concluded green. The remediation already in place: the defect was
fixed by #235, `main` now **requires** the `quality` check (owner-approved, all other
protection toggles preserved), and that gate was demonstrated on the previous corrective PR
(refused while pending → passed in 3m1s → merged → post-merge `quality` success). This PR is
merged the same way.
