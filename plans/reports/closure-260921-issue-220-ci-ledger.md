# Issue #220 phase-by-phase CI ledger (published because the audit asked for it)

This is the actual post-merge CI conclusion for every epic merge commit, read from
`gh run list --commit <full-sha> --workflow CI`. It is published unchanged because the
first completion claim implied each phase was green before merge, and this is what the CI
record actually shows.

| PR | Merge commit | Post-merge `quality` conclusion | Why |
|---|---|---|---|
| #225 | `c793e18` | not re-queried (merge commit; the run was superseded) | see note |
| #227 | `320fcb0` | `cancelled` | superseded by the next release-triggered run |
| #228 | `dbfeeb1` | `cancelled` | superseded |
| #229 | `e74bb65` | `cancelled` | superseded |
| #230 | `fbaec24` | `cancelled` | superseded |
| #231 | `2c2453e` | `cancelled` | superseded |
| #232 | `1e28330` | `cancelled` | superseded |
| #233 | `d53b1b8` | `cancelled` | superseded |
| #234 | `190a2dd` | **`failure`** | real lint error in that phase's diff (`activityEvent` undefined), fixed by #235 |
| #235 | `f546415` | `cancelled` | superseded |
| #236 | `a932fc5` | `cancelled` | superseded |
| #237 | `25c5164` | `cancelled` | superseded |
| #238 | `7496cb2` | `success` | the only epic merge whose own post-merge run concluded green |

## What the `cancelled` entries mean (and what they do not)

Semantic-release pushes a `[skip ci]` release commit within seconds of each merge, and the
workflow uses concurrency with cancel-in-progress, so the run attached to the merge commit
being verified is superseded and reported as `cancelled`. A `cancelled` conclusion is
therefore **not** evidence that the phase was verified at its own merge commit, and it is
not evidence of a failure either: it means no conclusion was reached for that commit.

The practical consequence is that phases #227-#237 were verified only indirectly — by the
run at the next commit, or in the end by the run at `7496cb2` (#238), which covers the
cumulative tree of every earlier merge and concluded `success`. Phase #234 is the exception:
its run reached a real `failure`.

## What this means for success criterion 14

Criterion 14 required: every phase PR's required CI checks green, auto-merged, and
post-merge CI converged. On this record that criterion was **not met**:

- No phase merge was gated on CI, because `main` had no required status checks
  (`gh pr merge --auto` had nothing to wait for and merged within seconds).
- Phase #234 merged red and carried the failure onto `main` until #235.
- Per-phase post-merge convergence was not demonstrated for #227-#237, because their runs
  were superseded rather than completed. The cumulative tree was verified green only at the
  final phase's run.

## Corrections applied (not retrospective claims)

1. The phase-#234 defect is fixed in shipped code (`dashboard.js` no longer references
   `activityEvent`; the projection lives server-side), verified by `npx eslint .` returning 0.
2. `main` now **requires** the `quality` status check, so a red or pending check blocks a
   merge for everyone (the corrective PR for this record reports `BLOCKED` for exactly that
   reason). Every other protection toggle was preserved.
3. The merge process is now: wait for the concluded check, then merge. The corrective PR is
   merged that way, and its run id is recorded on issue #220.
4. Repository-wide `npm run lint` and `npm run typecheck` now run before every push, so a
   `no-undef` error is caught before CI rather than by CI.
