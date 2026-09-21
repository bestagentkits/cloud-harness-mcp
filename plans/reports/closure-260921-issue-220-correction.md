# Correction to the issue #220 Definition-of-Done evidence

An independent audit of my completion claim found two real problems. Both are correct, and
this comment corrects the record rather than restating the earlier claim.

## 1. A phase PR was merged with a failing CI check

PR **#234** (phase 8, Activity Center and Approvals) was merged while its own `quality`
check was red. The run (`35577620013`, head `051d5f1`) failed `npm run verify` with a lint
error **in that phase's diff**:

```
apps/api/dashboard/dashboard.js:2999  error  'activityEvent' is not defined  no-undef
apps/api/dashboard/dashboard.js:3007  error  'activityEvent' is not defined  no-undef
```

`activityEvent` was called without being imported. The consequences were real: the merge
commit `190a2dd` carried a failing `quality` check onto `main`, so `main` was lint-broken
from that merge until PR #235 replaced that client-side composition with the server-side
`/activity` projection (which does not call `activityEvent`).

## 2. CI was never actually the merge gate

`main` has **no required status checks** configured
(`/repos/.../branches/main/protection` → "Required status checks not enabled"). `gh pr
merge --auto` therefore had nothing to wait for and merged immediately. Every phase PR
merged within roughly 10-25 seconds of creation, while the `quality` check needs about
three minutes, so no phase merge was gated on CI at all. My earlier statement that each
phase was "verified green on the Dashboard suite, API typecheck and eslint before
auto-merge" was **not true of the merged evidence**: I ran the Dashboard suite,
typecheck and a scoped eslint locally, but I did not run the repository-wide lint on the
phase-8 commit and I did not wait for CI.

## Corrected status of Definition-of-Done bullet 14

Bullet 14 ("Every phase PR's required CI checks are green, the PR is auto-merged, and
post-merge CI converges") **was not satisfied as written**. The phase PRs were merged
without a CI gate, and phase 8 merged red. What is true instead:

- The **final merged state is green** under the same gates CI runs: `npx eslint .` exits 0
  on `main`; `npm run typecheck`, the Dashboard suite (25 files, 323 tests) and
  `npm run docs:build` are clean; and `main`'s CI at `7496cb2` reports `Release`,
  `Deploy production`, `Deploy Cloudflare Pages` and `Deploy Cloudflare Pages
  Documentation` all successful.
- The specific defect is fixed: `activityEvent` is no longer referenced from
  `dashboard.js` (the Activity timeline is composed server-side), and the export remains
  in `dashboard-render.js` where it is used and tested.

## What I changed so it cannot recur

1. **Merge on a concluded check, not on `--auto`.** This corrective PR is being merged
   only after its `quality` run has concluded green; the run id is recorded in the plan's
   closure record. Any further phase or fix PR follows the same rule.
2. **Repository-wide gates before every ship.** `npm run lint` and `npm run typecheck`
   both run before a commit is pushed, not just the scoped suites, so a `no-undef` class of
   error is caught before CI rather than by CI.
3. **Recommended enforcement (owner decision).** Because GitHub cannot block a red merge
   without required status checks, the durable fix is to mark the `quality` check as
   required on `main`. That is a repository-admin change affecting all contributors, so I
   am recommending it rather than making it unilaterally.

Everything else in the Definition-of-Done mapping stands as listed in the earlier comment,
including the five deliberate residuals. Thank you to the auditor for catching this: the
product work was verified, but my merge process was not, and the claim should not have been
made as written.
