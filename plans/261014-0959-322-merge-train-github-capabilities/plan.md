# Issue #322: GitHub capabilities for an automated merge train

Status: in progress. Branch: `claude/determined-gates-o9v4tc` (based on `dev`).

## Outcome
A merge-train routine can drive `dev` landing through CloudHarness alone:
commit statuses, check runs, Actions dispatch/runs/re-run, per-reviewer review
state, atomic ref locks, and documented `git_push` constraints and session fit.

## Decisions
- New `github_read`/`github_action` actions, each with its own least-privilege
  GitHub App scope: `statuses` (commit_status_get/create), `checks`
  (check_runs_list), `actions` (workflow_runs_list, workflow_run_view,
  workflow_dispatch, workflow_run_rerun_failed), `pull_requests` (pr_reviews),
  `contents` (ref_get).
- Atomic refs use the Git protocol lease, not REST: GitHub's REST ref update and
  delete have no compare-and-swap. `git_push` gains `expectedAbsent` (create-only)
  and `delete` (delete-if-match); the existing `expectedRemoteOid` lease stays the
  CAS update. The receive-pack old-OID check is atomic per ref.
- A `[remote rejected]` push (protected branch, ruleset, missing `workflows`
  permission) becomes a non-retryable `CONFLICT`-class rejection instead of an
  `UNKNOWN_REMOTE_STATE` that invites a pointless retry.
- Installation permission levels are only recorded for issues and pull requests,
  so the new operations are advertised when a GitHub credential is bound; GitHub
  decides at call time and a missing grant returns `GITHUB_PERMISSION_MISSING`.

## Non-goals
Running tests inside CloudHarness; REST ref writes; changing deployment TTLs.

## Acceptance
- Actions exposed with idempotency keys for writes and listed in
  `workspace_capabilities`.
- Tests: create-only collision, CAS mismatch, delete-if-match, status
  create/read round-trip, dispatch then run lookup by `head_sha`.
- Docs list the `git_push` refspec policy, permissions, and session-fit answers.
