# Phase 5: Declarative Hooks, Lifecycle Integration & Ephemeral Sandbox Execution

## Context Links
- Plan: `plans/260830-0700-15-provenance-aware-workspace-context-skills-memories-hooks/plan.md`
- Code: `worker/harness-worker.mjs`, `apps/runner/src/workspace-service.ts`, `apps/runner/src/state-store.ts`

## Requirements
- Declarative Hook Grammar in `.cloud-harness/hooks.json`:
  ```json
  {
    "version": 1,
    "hooks": [
      {
        "name": "lint",
        "events": ["pre_commit"],
        "argv": ["npm", "run", "lint"],
        "cwd": ".",
        "order": 100,
        "timeoutMs": 60000,
        "maxOutputBytes": 65536,
        "failurePolicy": "block"
      }
    ]
  }
  ```
- Named Lifecycle Events Registry: `on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual`
- Digest-Pinned Activation:
  - Table `hook_activations` in SQLite: `(principal_id, workspace_id, event, manifest_sha256, expires_at)`
  - `hooks_activate`: Owner explicitly approves exact manifest SHA-256 for specified events
  - `hooks_deactivate`: Removes activation
  - Modifying the hook manifest immediately invalidates the digest and blocks execution before process spawn
- Lifecycle Triggers & Shared Commit Integration:
  - Hook execution must run on both `git_commit` and `workspace_finalize` via a unified internal commit pipeline
  - `pre_commit` runs before staging/commit and may veto if `failurePolicy: block`
  - `post_checkout` and `post_commit` failures are audited as warnings and do not roll back successful Git operations
- Ephemeral Automation Sandbox Executor:
  - Created specifically for automation tasks with `--network none`, UID/GID 10001, read-only root, dropped capabilities, `no-new-privileges`, bounded CPU/memory/PIDs/output/time, no environment secret file, no Docker socket
  - Guaranteed container cleanup in `try/finally` on success, failure, timeout, and cancellation
- Audit Baseline (#10):
  - Record audit events for `hook.activated`, `hook.deactivated`, `hook.executed`, `hook.denied`
  - Record pre-execution `REQUESTED` status to handle runner crash/restart reconciliation

## Files to Modify/Create
- `worker/harness-worker.mjs`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/src/state-store.ts`
- `apps/runner/test/declarative-hooks.test.ts` (new test file)

## Implementation Steps
1. Implement declarative JSON hook parser in `worker/harness-worker.mjs`.
2. Implement `hooks_activate`, `hooks_deactivate`, `hooks_list`, and `hooks_run` in `WorkspaceService`.
3. Integrate unified pre-commit and post-checkout hooks into `git_commit`, `workspace_finalize`, and `git_checkout` in `WorkspaceService`.
4. Implement ephemeral automation sandbox container launcher in `WorkspaceService`.
5. Add unit and integration tests covering digest pinning, veto semantics, and sandbox isolation.

## Tests & Validation
- `npm test apps/runner/test/declarative-hooks.test.ts`
- Verify digest mismatch blocks execution and pre-commit veto semantics work.
