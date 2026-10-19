# Review: #443 tolerate an unremovable leftover container at runner startup

Scope: apps/runner/src/workspace-service.ts (reconcileContainers), apps/runner/test/startup-executor-reconcile.test.ts, docs/troubleshooting.md. No REVIEW.md in repo.

## Verified (no finding)
- Cleanup scoping unchanged: still `docker ps` on managed=true + this instance label; removal by exact name; inventory failure still throws.
- No reuse/reattach of a skipped container: holdForRecovery leaves the record EXPIRED_RECOVERABLE with containerName null. Exec paths use record.containerName only. workspace_recover -> ensureActiveExecutor(containerName null) -> createExecutor, which does `removeContainer(fixedName).catch()` then `docker create --name fixedName`; if the stale one is still there, create fails with a name conflict, so recovery fails closed and never adopts the stale container. Container names come from the record id, so another workspace can't get the same name. No other code sets containerName to a name that came from the inventory.
- Package invariant (package-service.ts:650 "after leftover ephemeral containers are removed"): builders/package-helpers carry only ephemeral=true, so the helpers loop (:762) still fails closed for them. Executors mount package releases read-only.
- `workspaceId || name`: every current managed container has a workspace label (:1088, :2788, :2946), so the fallback only fires for a hand-made container that has no label. The reason text includes the name. Acceptable, and logged only.
- Test: passes (4/4). On the old code the unguarded `await removeContainer(stuck.container)` rejects (the mock throws for that name; the record is EXPIRED_RECOVERABLE and not active), so start() rejects and the test fails. It is a valid regression test.
- Docs: the `docker ps --filter label=cloud-harness.managed=true` command does appear above, at the top of "Containers and cleanup" (troubleshooting.md ~312-315).

## Findings
1. minor - apps/runner/src/workspace-service.ts:734-737, :762; docs/troubleshooting.md:341-343.
   The comment says a container Docker won't remove "never aborts this one", and the doc says "startup skips it". Neither holds for managed containers that are also ephemeral: `chm-priv-*` (:2786) and `chm-gh-*` (:2944) carry both managed=true and ephemeral=true. Failure path: a stuck chm-priv container is in the managed inventory -> removal fails -> a failure is pushed -> the helpers inventory lists it again -> the unguarded `removeContainer` at :762 throws. start() rejects, the pushed failures are lost, and startup aborts for every workspace, which is the #443 symptom. Keeping the helpers loop fail-closed is right for package builders. Fix one of two ways: (a) narrow the comment and the doc to workspace executor containers, or (b) skip `cloud-harness.ephemeral=true` entries in the managed loop and leave them to the helpers loop. Not blocking, because it is a partial fix and not a regression.

## Note (pre-existing, not introduced)
- A held workspace's stale container that Docker cannot remove stays until the next restart, even after the workspace auto-closes and its job directory is removed. holdForRecovery's `.catch` already leaked it before this change. Before, startup crash-looped, so exposure is no worse.

Status: DONE_WITH_CONCERNS
Summary: The change is safe. No skipped container can be reused or reattached, cleanup scoping is unchanged, the test is valid and fails on the old code, and the doc reference is accurate. One minor overclaim: managed+ephemeral helper containers still abort startup through the helpers loop.

## Resolution

Finding 1 is fixed by option (a). The code comment and `docs/troubleshooting.md`
now limit the skip to workspace executor containers and state that an
ephemeral helper that will not go away still stops startup, because package
cleanup relies on every builder being gone.
