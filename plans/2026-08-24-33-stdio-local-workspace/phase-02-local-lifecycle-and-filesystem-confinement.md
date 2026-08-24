---
phase: 2
title: "Local lifecycle and filesystem confinement"
status: completed
priority: P1
effort: "2-3d"
dependencies: [1]
---

# Phase 2: Local lifecycle and filesystem confinement

## Context links

- Parent plan: [plan.md](./plan.md)
- Security research: [research findings](./research/research-findings.md)
- Red-team review: [red-team review](./reports/red-team-review.md)
- Node filesystem API: https://nodejs.org/api/fs.html

## Overview

Implement one implicit, pre-opened local workspace and safely reuse the existing worker for file/search/symbol operations. The workspace root comes only from trusted CLI startup configuration, is canonicalized once, and is never cloned, uploaded, or deleted.

## Requirements

- Support Linux and macOS in v1; fail fast with an explicit unsupported-platform message on Windows.
- Resolve `--workspace` to an existing directory and store its canonical real path before serving MCP requests.
- Generate an opaque workspace ID and require it on every operation that currently requires `workspaceId`.
- Define local lifecycle behavior: list/status expose the one workspace, open returns a mode capability error, and close is terminal/idempotent.
- Never feed the selected root into remote runner cleanup or recursive deletion.
- Keep schema-level relative-path checks and add operation-time containment checks for symlinks and concurrent filesystem changes.
- Parameterize the worker root from trusted process configuration while retaining `/workspace` as the container default.
- Preserve bounded outputs, cursors, patch semantics, and structured result envelopes.

## Lifecycle state model

```text
starting -> ready -> closing -> closed
                 \-> failed
```

- `workspace_list`: returns zero or one local workspace according to terminal state.
- `workspace_status`: validates the opaque ID and returns mode, canonical root metadata safe to expose, platform, capabilities, and lifecycle.
- `workspace_open`: returns a structured `UNSUPPORTED_IN_LOCAL_MODE` error explaining that startup already selected the root.
- `workspace_close`: stops owned operations, marks closed, and never removes root contents. Repeated calls return the same terminal result.
- All other operations after close fail deterministically without reopening the root.

## Path policy

For every path-bearing operation:

1. Retain the contract's lexical rejection of absolute paths and `..`.
2. Resolve the existing target, or the nearest existing parent for creates, against the canonical root.
3. Use `lstat`/realpath checks so symlinks cannot resolve outside the root.
4. Prefer direct-open operations and `O_NOFOLLOW` for the final component where Node/platform support allows; do not rely on check-then-open alone.
5. Re-check containment after mkdir, write, patch, move, and copy operations that create or replace entries.
6. Return a stable structured confinement error without leaking unrelated host paths.

Document that these checks confine file-tool targets and command working directories; they do not sandbox command contents.

## Related code files

Create:

- `apps/api/src/local/local-workspace-backend.ts`
- `apps/api/src/local/local-worker-client.ts`
- `apps/api/src/local/local-path-policy.ts`
- Local backend/path-policy tests under `apps/api/test/local/`

Modify:

- `worker/harness-worker.mjs`
- `apps/api/src/index.ts`
- Shared result/capability types only if existing contracts cannot express the mode error
- Existing worker/path tests and fixtures

## Implementation steps

1. Validate platform and startup root, canonicalize it, capture stable identity metadata, and create the local workspace state object.
2. Implement the lifecycle dispatch table before ordinary operations. Do not instantiate or call `WorkspaceService`.
3. Define a local capability descriptor/instruction string that names host execution, unsupported privileged/GitHub actions, and Git opt-ins.
4. Extract or wrap worker startup so `HARNESS_WORKSPACE_ROOT` (or an equivalent trusted channel) selects the root, with `/workspace` as the unchanged default.
5. Ensure the root value cannot be supplied or overridden by a tool request or forwarded child environment.
6. Implement centralized local path-policy helpers and apply them to worker operations rather than adding ad hoc checks per tool.
7. Preserve current byte/output limits, cursors, encoding checks, patch validation, search caps, and error normalization.
8. Add deterministic tests for symlink escapes and rename/symlink swaps using test synchronization hooks, not timing-only races.
9. Verify close/shutdown leaves a sentinel file and the entire selected directory intact.

## Todo

- [ ] POSIX-only startup boundary is explicit.
- [ ] Root is canonicalized once from CLI configuration.
- [ ] Opaque ID and lifecycle operations behave deterministically.
- [ ] Local close has no filesystem deletion path.
- [ ] Worker root is configurable only through trusted startup state.
- [ ] All path-bearing handlers use the centralized confinement policy.
- [ ] Existing Docker worker continues to default to `/workspace`.

## Tests and validation

- Unit: nonexistent path, file instead of directory, relative path, symlinked startup root, spaces and Unicode in root.
- Unit: unknown/wrong workspace IDs; open/list/status/close; repeated close; operation-after-close.
- Security: `../`, absolute paths, interior symlink escape, final-component symlink, broken link, symlink swap during read/write/move/copy.
- Behavior: read/write/edit/patch/search/symbol operations remain bounded and compatible.
- Safety: sentinel tree before and after close/signal is byte-identical except for intentional tool edits.
- Regression: worker Docker tests prove absent root configuration still selects `/workspace`.

## Success criteria

- A local stdio client can inspect and edit files inside a folder containing spaces.
- Every tested path escape returns a structured error and changes nothing outside the root.
- Closing or crashing the backend never deletes, uploads, clones, or relocates the selected folder.
- Remote Docker workspace lifecycle remains unchanged.

## Risks and rollback

Filesystem race resistance varies by platform and filesystem. Limit v1 to POSIX, prefer descriptor-based operations, and keep the trust boundary documented. If worker parameterization regresses Docker mode, revert the environment-root hook and temporarily place a local-only wrapper around the worker while preserving the lifecycle/path tests.
