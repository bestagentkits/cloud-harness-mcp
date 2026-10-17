# Isolated review: workspace lifecycle settings

The reviewer ran in an isolated subagent context against commits 00c73eb and c1a8d2a.

It found no data-loss, concurrency, migration, or security-boundary defects. Each finding below shows what was done about it.

| Finding | Severity | Disposition |
| --- | --- | --- |
| A commit pushed by `git_push` from the bare transfer repository still counted as "not on any remote", so most workspaces were never auto-closed. | High | Fixed. After a successful push, the runner moves `refs/remotes/origin/<branch>` in the checkout through the worker's `track_push` mode, and removes it when the branch is deleted. A worker test reproduces the push through a bare transfer repository, and a runner test asserts the call. |
| A workspace cloned from a tag (`--no-tags`, no remote-tracking ref) was deferred forever. | Medium | Fixed. `close_check` receives the clone ref and excludes the commit that ref resolves to. |
| The auto-close batch had no limit and could stall the reaper. | Medium | Fixed. `listAutoCloseDue` now takes at most 10 per pass, oldest first. |
| Unpushed branches were missed when HEAD is unborn. | Low | Fixed. `--branches` is always counted, and HEAD is added only when it resolves. |
| Stderr output was mixed into the counts. | Low | Fixed. The counting commands now capture stdout only, and truncated output is treated as a failure. |
| Commits reachable only from a tag, and ignored files, are not checked. | Low | Stays as is. A tag clone's history would otherwise count as unsaved. The UI and docs now say that Git-ignored files are not checked. |
| The reaper's lease bumps `last_activity_at`. | Low | Stays as is. The close window comes from `recoverable_until`. For legacy rows the bump only postpones the close, which is the safe direction. |
| The zero-grace acknowledgement was hidden for `00` or `0.0`. | Low | Fixed. Visibility now uses the numeric value. |
| A failed audit write after a committed lifecycle save reported an error. | Low | Fixed. The lifecycle audit is now best-effort. |
| A lowered runner wall TTL blocks saves until the idle value is fixed. | Info | Intended. The idle ≤ wall rule is enforced on effective values. |
