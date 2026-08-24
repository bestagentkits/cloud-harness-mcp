---
phase: 3
title: "Local processes, Git, and repository extensions"
status: completed
priority: P1
effort: "2-4d"
dependencies: [2]
---

# Phase 3: Local processes, Git, and repository extensions

## Context links

- Parent plan: [plan.md](./plan.md)
- Codebase ownership: [scout report](./reports/scout-report.md)
- Threat review: [red-team review](./reports/red-team-review.md)
- Node child-process API: https://nodejs.org/api/child_process.html

## Overview

Add host-side execution for bounded commands, shells, named sessions, tasks, applicable Git operations, worktrees, and repository extensions. Match remote result/state semantics where they are meaningful, while exposing local security and capability differences instead of routing through Docker assumptions.

## Requirements

- Run commands as the current host user; never claim OS-level sandboxing.
- Confine only tool-supplied paths and `cwd`; command text remains capable of accessing the user's host authority.
- Launch owned long-running processes in POSIX process groups, retain handles/output cursors, and terminate descendants on cancellation, close, signals, and normal shutdown.
- Use TERM → bounded grace period → KILL, then reconcile handles and terminal states.
- Build child environments from a documented allowlist. Scrub Cloud Harness/API/runner/broker secrets and never inherit the entire parent environment.
- Permit extra environment names only via explicit startup flags; prevent overriding reserved control variables.
- Reject `exec_run.privileged=true` in local v1.
- Allow local-only Git operations in Git roots. Network fetch/pull/clone require one startup opt-in; push requires a separate stronger opt-in.
- Use the user's existing credential mechanism only when the matching Git opt-in is enabled; do not copy or persist credentials.
- Register `github_action` through the shared schema but return an explicit unsupported-capability error in local v1.
- Non-Git roots must retain all non-Git functionality and return structured Git-specific errors.

## Process model

Implement a local manager parallel to, or behind a shared behavioral interface with, the Docker operation manager. Reuse semantics—not Docker launch mechanics—for:

- opaque handle generation and workspace ownership;
- per-stream bounded ring buffers and cursor reads;
- maximum concurrent handles and task dependencies;
- cancellation, timeout, exit code/signal, and terminal-state reporting;
- idempotent stop/close and garbage collection.

On POSIX, start long-running children as process-group leaders and signal the negative PID after verifying ownership. Never use broad process-name matching. Short `exec_run` commands still need timeout/cancellation cleanup of descendants.

## Capability matrix

| Capability | Local v1 behavior |
|---|---|
| Bounded exec | Supported as host user |
| Privileged exec | Structured unsupported error |
| Shell/session/task | Supported with owned process groups |
| Local Git/status/diff/commit/worktree | Supported in Git folders |
| Fetch/pull/clone | Disabled unless local network Git flag is set |
| Push | Disabled unless both network and push flags are set |
| Brokered `github_action` | Structured unsupported error |
| Skills/hooks/memory/deployments | Supported where current worker contract applies; documented as repository-controlled host code |

## Related code files

Create:

- `apps/api/src/local/local-operation-manager.ts`
- `apps/api/src/local/local-environment.ts`
- Process/environment tests under `apps/api/test/local/`

Modify:

- `apps/api/src/local/local-workspace-backend.ts`
- `apps/api/src/local/local-worker-client.ts`
- `worker/harness-worker.mjs`
- CLI option/help tests from Phase 1
- Integration fixtures for processes, Git, and repository extensions

## Implementation steps

1. Translate existing handle/state/output invariants into a local operation-manager interface without importing Docker command builders or container IDs.
2. Implement bounded stdout/stderr capture with monotonic cursors, concurrency limits, timeout and abort propagation.
3. Launch process groups and implement verified owner-only TERM/KILL cleanup. Reconcile direct-child and group outcomes into stable terminal records.
4. Centralize child-environment construction: baseline allowlist, secret denylist, explicitly forwarded names, fixed root/control variables, and test-visible redaction.
5. Route `exec_run`, shell, session, and task operations through the local manager; apply path policy to every `cwd`.
6. Enforce dependency scheduling, stop behavior, close behavior, and output bounds consistent with remote contracts.
7. Route worker-supported local Git/worktree/repository-extension operations through the parameterized worker.
8. Gate network Git and push before process spawn. Surface disabled capability, non-Git root, authentication failure, and remote failure distinctly.
9. Reject privileged execution and `github_action` before any subprocess or network access.
10. Exercise hook/skill/deployment commands with the curated environment and add host-authority warnings to local server instructions.

## Todo

- [ ] Local process handles/cursors match public response contracts.
- [ ] Descendant cleanup is proven for exec, shell, session, and task paths.
- [ ] Environment forwarding is allowlisted and reserved names cannot be overridden.
- [ ] Privileged and brokered GitHub actions cannot execute locally.
- [ ] Network Git and push require separate startup authorization.
- [ ] Non-Git roots remain usable for non-Git tools.
- [ ] Repository extensions clearly inherit host-user authority.

## Tests and validation

- Process: success/failure/timeout/cancel, stdout and stderr truncation, cursor pagination, concurrent limit, task dependencies.
- Cleanup: spawn a child and grandchild, close/cancel/signal, verify the owned process group is gone and unrelated processes survive.
- Environment: allowed baseline values available; known control-secret patterns absent; requested extra name forwarded; reserved names rejected.
- Security: `privileged=true` and `github_action` perform no spawn/network side effect.
- Git: non-Git root, clean/dirty status, diff/add/commit/worktree, disabled fetch, enabled fetch, disabled push, explicitly enabled push using test-only credentials.
- Repository extensions: representative skill/hook/memory/deployment flows preserve bounds and use the local root.

## Success criteria

- No owned child or grandchild remains after workspace close or server shutdown.
- Result envelopes, handle state, and cursors remain compatible with the remote tool contract.
- Secret/environment and Git authorization tests demonstrate least-privilege defaults.
- Unsupported capabilities fail early with actionable local-mode messages.
- Non-Git folders support the full non-Git subset.

## Risks and rollback

Host execution is inherently higher authority than Docker execution. Keep the local manager isolated from remote code and make every authority-expanding flag visible in help and status. If long-running lifecycle cannot meet cleanup guarantees, ship only bounded exec behind an experimental flag rather than silently leaving process support partial.
