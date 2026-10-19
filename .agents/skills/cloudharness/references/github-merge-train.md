# GitHub merge train

Use this reference when an automated routine coordinates pull requests into a
protected branch: it takes a lock, checks review and CI state, triggers CI,
and merges or reports. The routine coordinates GitHub's own CI; it never needs
to run the test suite inside the workspace. Tool contracts for `git_push`,
`github_read`, and `github_action` live in [Git and worktrees](git-and-worktrees.md).

Check `workspace_capabilities` first: `operations.refCreateIfAbsent`,
`refCompareAndSwap`, `refDeleteIfMatch`, `commitStatusRead`,
`commitStatusCreate`, `checkRunList`, `workflowRunRead`, `workflowDispatch`,
`workflowRunRerun`, and `pullRequestReviewList`. Statuses, checks, and Actions
need the matching GitHub App permissions; GitHub refuses a missing one with
`FORBIDDEN` (`permission_not_granted`).

## Atomic branch locks

`git_push` leases are checked by GitHub's receiving server, so two routines
cannot both win. GitHub's REST ref endpoints have no compare-and-swap, so the
lock is a branch pushed with a lease:

| Operation | `git_push` input | `CONFLICT` when |
| --- | --- | --- |
| Acquire (create only) | `refspec: "merge-lock-holder:merge-lock"`, `forceWithLease: true`, `expectedAbsent: true` | the branch exists, even at your commit |
| Hand over (compare-and-swap) | `refspec: "merge-lock-holder:merge-lock"`, `forceWithLease: true`, `expectedRemoteOid: <oid>` | the branch moved |
| Release (delete if match) | `refspec: "merge-lock"`, `delete: true`, `forceWithLease: true`, `expectedRemoteOid: <oid>` | the branch moved |

- Push a commit unique to this holder, never a shared `HEAD`. With `exec_run`:
  `git branch -f merge-lock-holder "$(git commit-tree 'HEAD^{tree}' -p HEAD -m 'merge-lock <routine> <run id>')"`.
- Pass an `idempotencyKey` on every lock push. After `UNKNOWN_REMOTE_STATE`,
  retry with the same key: an acquire whose lock holds your holder commit, or
  a release whose branch is absent (whoever removed it), returns
  `alreadyFinalized: true`; any other value returns `CONFLICT` with
  `currentRemoteOid`.
- Read the holder with `github_read` `ref_get` (`exists: false` when free).
- `[remote rejected]` and `GH0xx` refusals (branch protection, rulesets, hooks) return
  non-retryable `FORBIDDEN`. A fast-forward to a protected branch such as `dev`
  succeeds only when its required checks already pass on that commit and no
  pull-request rule applies to the App; otherwise merge with `pr_merge`.
- A lease push to another collaborator's same-repository branch needs only
  Contents write, unless that branch is protected against force pushes.
  Commits that change `.github/workflows` need the App's Workflows permission
  (`GITHUB_PERMISSION_MISSING` otherwise).

## Reads

All on `github_read` (no approval prompts):

- `pr_reviews`: required `prNumber`. Returns every review plus
  `latestByReviewer` (login → latest `APPROVED`, `CHANGES_REQUESTED`, or
  `DISMISSED`; `COMMENTED` when the reviewer only commented),
  `changesRequestedBy`, and `approvedBy`. A later comment does not clear an
  earlier verdict.
- `ref_get`: required `ref` (`refs/heads/...` or `refs/tags/...`). Returns
  `{ ref, oid, objectType, exists: true }` or `{ ref, exists: false }`.
- `commit_status_get`: required `sha` (branch, tag, or commit); optional
  `limit` (default 100). Returns the combined `state` and each context's
  latest status.
- `check_runs_list`: required `sha`; optional `checkName`, `limit` (default
  100). Returns the latest check runs with `status`, `conclusion`, and the
  `externalId` set at creation.
- `workflow_runs_list`: optional `workflow` (numeric ID or file name such as
  `ci.yml`), `headSha`, `branch`, `event`, `status`, `limit` (default 20,
  max 100).
- `workflow_run_view`: required `runId`; optional job `limit` (default 100).
  Returns the run, its latest jobs, and each job's `failedSteps`.

<!-- cloudharness-example:github_read
{"workspaceId":"ws_abcdefghijklmnopqrstuvwxyz012345","action":"workflow_runs_list","workflow":"ci.yml","headSha":"0123456789abcdef0123456789abcdef01234567","event":"workflow_dispatch"}
-->

## Writes

On `github_action`; each except `check_run_update` accepts an `idempotencyKey`
that replays the cached result for 24 hours and rejects a changed payload with
`CONFLICT`.

- `commit_status_create`: required `sha` (full lowercase commit ID), `state`
  (`error` | `failure` | `pending` | `success`), `context` (max 255); optional
  `description` (max 140), `targetUrl` (https). Needs Commit statuses write.
- `check_run_create`: required `sha` (full lowercase commit ID), `name` (max
  255, single line); optional `status` (`queued` | `in_progress` default |
  `completed`), `conclusion` (`success` | `failure` | `neutral` | `cancelled`
  | `skipped` | `timed_out`; only with `status: completed`, which requires
  one), `externalId`, and `title` with `summary` (set together; summary at
  most 65,535 UTF-8 bytes). Returns the check run `id`; keep it. Needs Checks
  write; without it the call fails `GITHUB_PERMISSION_MISSING` or `FORBIDDEN`.
- `check_run_update`: required `checkRunId` and at least one of `status`,
  `conclusion`, or `title` with `summary`, under the same rules. Not
  idempotency-keyed: re-read with `check_runs_list` before retrying an unknown
  outcome. Needs Checks write.
- `workflow_dispatch`: required `workflow` (numeric ID or file name), `ref`
  (branch or tag, not a SHA); optional `inputs` (string map, max 25 entries,
  65,535 bytes serialized). The
  workflow must declare `on: workflow_dispatch`. GitHub returns no run ID, so
  the result carries the ref's `headSha` and a `runLookup`; poll
  `workflow_runs_list` with it for a few seconds until the run appears. Needs
  Actions write.
- `workflow_run_rerun_failed`: required `runId`. Re-runs only the failed jobs
  and returns the new `runAttempt` with `rerunRequested: true` (only `id` when
  the follow-up read fails; the rerun still started). Needs Actions write.

<!-- cloudharness-example:github_action
{"workspaceId":"ws_abcdefghijklmnopqrstuvwxyz012345","action":"commit_status_create","sha":"0123456789abcdef0123456789abcdef01234567","state":"pending","context":"merge-train","description":"Queued at position 2","idempotencyKey":"train-7-status-pending"}
-->

<!-- cloudharness-example:github_action
{"workspaceId":"ws_abcdefghijklmnopqrstuvwxyz012345","action":"check_run_create","sha":"0123456789abcdef0123456789abcdef01234567","name":"merge-train","status":"in_progress","title":"Queued","summary":"Position 2 in the merge train.","idempotencyKey":"train-7-check-start"}
-->

## Train loop

1. Create the holder commit, then acquire the lock (create only). On
   `CONFLICT`, wait and read `ref_get`.
2. For each candidate PR: `pr_view` (`headRefOid`, `mergeStateStatus`),
   `pr_reviews` (skip any with `changesRequestedBy`), `commit_status_get` and
   `check_runs_list` on the head SHA.
3. `commit_status_create` `pending` on the head, then `workflow_dispatch` and
   poll `workflow_runs_list` / `workflow_run_view`.
4. Re-run a failed job at most once with `workflow_run_rerun_failed`; a second
   failure is real.
5. `pr_merge` with `matchHeadCommit`, or `commit_status_create` `failure` with
   the run URL as `targetUrl`.
6. Release the lock (delete if match), also on failure.

## Long routines

`workspace_lease_renew` extends only the idle lease and never passes the
wall-clock deadline that `WORKSPACE_WALL_TTL_SECONDS` sets (shipped default 15
minutes); a capped renewal returns `leaseCapped: true`. A train that keeps one
workspace for about an hour needs that value at 3600 or more; otherwise open a fresh workspace for each phase and keep state
in GitHub (the lock branch, statuses, comments). A `fetchDepth: 1` checkout is
enough, because brokered GitHub calls do not read local history.
