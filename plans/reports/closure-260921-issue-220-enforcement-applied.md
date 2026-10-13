## Follow-up: CI enforcement is now enabled

The correction above recorded the enforcement gap as a recommendation. It is now applied,
with the owner's approval:

- `main` branch protection now **requires the `quality` status check**
  (`contexts: ["quality"]`). Verified with
  `GET /repos/bestagentkits/cloud-harness-mcp/branches/main/protection/required_status_checks`
  → `{"strict": false, "contexts": ["quality"], "checks": [{"context": "quality", "app_id": 15368}]}`.
- Every other protection toggle was preserved in the same change (`enforce_admins`,
  `required_linear_history`, `allow_force_deletes`, `allow_deletions`, `block_creations`,
  `required_conversation_resolution`, `lock_branch`, `allow_fork_syncing` all unchanged;
  no review requirement was added or removed).
- Effect in practice: the corrective PR for this record (#239) reports
  `mergeStateStatus = BLOCKED` while its `quality` run is pending, and GitHub will refuse the
  merge until that run concludes successfully. That is the gate whose absence let phase 8
  merge red.

One consequence worth stating: because the check is now required, **any** pull request
targeting `main` — not just this epic's — is blocked while `quality` is red, pending, or
failing to start. That is the intended behaviour of requiring it, but it does mean a flaky
or queued CI run now blocks every merge until it is resolved.
