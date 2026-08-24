---
title: "Issue 33 plan red-team review"
status: completed
created: 2026-08-24
tags: [review, security, mcp, local-execution]
---

# Issue 33 plan red-team review

## Summary

The proposed shared factory/local backend design is viable, but only if the implementation refuses to blur remote isolation with local host authority. The review accepted six changes that are reflected in the plan and phase files.

## Accepted findings

1. **Local close must not reuse runner cleanup.** Runner close recursively removes a verified jobs-root path. Local lifecycle must have an independent terminal close path with no filesystem deletion.
2. **A dynamic worker root must not become tool input.** The root is canonicalized from CLI startup configuration and passed only through trusted process configuration.
3. **Path checks alone do not sandbox commands.** Documentation and server instructions must state that shell, task, hook, skill, deployment, and exec commands can access everything available to the local user.
4. **Current public contract is larger than the issue text.** Local behavior for `exec_run.privileged` and `github_action` must be explicit. Both are unsupported in v1.
5. **Credential inheritance needs an allowlist.** Local child processes must not inherit the complete host environment. Network Git and push require startup opt-ins and narrowly forwarded credential helpers.
6. **Process cleanup must target descendants.** Tracking only direct child PIDs can leave grandchildren alive. POSIX process groups, TERM/KILL escalation, and shutdown reconciliation are required and tested.

## Rejected concerns

- **Create an entirely separate local tool schema.** Rejected because `TOOL_SPECS` and its annotation tests are current public authorities; capability differences belong in status/instructions/errors.
- **Require Docker for local mode.** Rejected for v1 because the issue explicitly asks to avoid uploading/cloning to the VPS and distinguishes direct host execution from optional future isolation.
- **Make Windows a silent partial implementation.** Rejected. The plan limits v1 to Linux/macOS and requires an explicit unsupported-platform error on Windows.

## Residual risks

- Pure Node path resolution reduces but cannot mathematically eliminate every hostile concurrent rename/symlink race across all filesystems. Use direct-open patterns, `O_NOFOLLOW` where available, post-operation containment checks, and deterministic race tests; document the boundary.
- Host commands can exfiltrate local data or modify files outside the root. This is inherent in unsandboxed local execution and must remain visible in docs and MCP instructions.
- Users may enable Git network/push without understanding credential exposure. Flags, help text, and approval annotations must make the authority change explicit.

## Whole-plan consistency sweep

- Files covered: plan, four phases, research findings, scout report.
- Decision deltas checked: implicit workspace, POSIX v1, opt-in network Git, unsupported privileged/GitHub actions, no-delete close, host-authority warning.
- Unresolved contradictions: 0.
