---
title: "Dashboard terminal, bash tool, and managed toolbox"
issue: 312
status: in-progress
created: 2026-10-13
branch: claude/determined-gates-scf47h
---

# Dashboard terminal, `bash` tool, and managed toolbox (#312)

Boundary and threat model: [ADR 0003](../../docs/adr/0003-terminal-bash-and-managed-toolbox.md).

| Slice | Scope | Status |
| --- | --- | --- |
| 1 | ADR 0003 and threat model | done |
| 2 (P0) | Runner PTY mode, dashboard terminal BFF routes, vendored xterm.js, Terminal tab and operator view, docs | in progress |
| 3 (P1) | `bash` MCP tool (`workspace` reuses `exec_run`; `toolbox` behind the feature flag) | pending |
| 4 (P2–P4) | Managed toolbox: plan/apply/list/status/rollback, isolated builder, releases, Packages page, approvals, config, docs | pending |

## Acceptance criteria

The issue's acceptance list is authoritative. Each slice proves its part with
unit tests, Docker integration tests against a real executor, and the
repository gate (`npm run verify`).

## Decisions

- Terminal ops are dashboard-only internal runner operations, not MCP tools.
- PTY uses Docker Engine exec (`Tty: true`) over the runner's existing socket;
  pipe shells stay unchanged.
- Package scopes: `owner` and `workspace`. `instance` is refused because in the
  single-owner model the owner scope covers it.
- System packages return `NOT_SUPPORTED`, pointing to the image-variant workflow.
