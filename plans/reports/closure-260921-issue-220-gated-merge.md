## Gated merge and post-merge convergence (the corrected process, with evidence)

The corrective PR #239 was merged **only after its required check passed**, which is the
process the audit found was missing:

1. While `quality` was pending, the merge was refused by branch policy:
   `X Pull request #239 is not mergeable: the base branch policy prohibits the merge.`
   (`mergeStateStatus = BLOCKED`).
2. `quality` concluded **success in 3m1s** (run `35580248577`, head `00cbc28`).
3. The merge was then performed: squash-merged at `2026-09-21T08:57:21Z` as
   **`8134d52`**.
4. Post-merge, `main`'s CI run `35580603915` at `8134d52` reports
   **`quality: completed success`** — convergence on the merge commit itself.
   (`docker-integration` was still running at the time of writing and is not a required
   check, so it does not gate a merge.)

The corrective PR carried: the closure-record correction, the CI-enforcement record, the
phase-12 file reconciliation, and the phase-by-phase CI ledger.

## Statement on success criterion 14

Criterion 14 required every phase PR to be green before merge with post-merge CI
convergence. **That was not met historically**, and it cannot be retroactively satisfied:

- Phase #234 merged with a failing `quality` check (a real `no-undef` error in that
  diff), carrying the failure onto `main` until #235.
- No phase merge was gated on CI, because `main` had no required status checks. Per the
  published ledger, only #238's own post-merge run concluded green; #227-#237 were
  `cancelled` after being superseded, and #234 `failed`.

What is now true instead: the defect is fixed, the gate exists and was demonstrated on the
corrective PR (blocked → passed → merged → converged), and the whole per-phase record is
published above rather than summarised favourably.
