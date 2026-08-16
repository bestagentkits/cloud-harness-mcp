---
phase: 3
title: "Sandbox and Workspace Runtime"
status: completed
priority: P1
effort: 4d
dependencies: [1, 2]
---

# Phase 3: Sandbox and Workspace Runtime

## Context Links

- [Plan](./plan.md)
- [MCP API phase](./phase-02-mcp-core-and-tool-surface.md)
- [Sandbox and deployment research](./reports/sandbox-deployment-research.md)

## Overview

Implement the private runner, persistent workspace lifecycle, repository credential broker, and hardened executor containers. This is a real private-owner sandbox with explicit Docker/kernel limitations, not a hostile multi-tenant boundary.

## Requirements

- Functional: one persistent container and isolated clone per workspace; owner-bound opaque IDs; status, operation, close, wall/idle TTL, restart reconciliation, and deterministic cleanup.
- Functional: runner implementations for every Phase 2 tool, including interactive shell/task operations and Git worktrees contained inside the isolated workspace clone.
- Functional: public HTTPS Git clone plus optional GitHub App installation-token broker for approved private repositories.
- Non-functional: runner is private, separately authenticated, unexposed on the host; only runner receives Docker socket and job-root mounts.
- Sandbox: fixed digest-pinned image, non-root UID, read-only root, capability drop, no-new-privileges, seccomp/AppArmor where available, no default egress, no published ports, and CPU/memory/PID/file/output/disk/time limits.

## Architecture

The runner owns a schema-versioned persistent SQLite registry and a configured jobs-root layout of `<server-id>/{metadata,workspace,result}`. It creates a `CREATING` record, then clones/checks out in a fixed resource-limited, socket-free helper container using a temporary directory and atomic promotion. It creates a fixed persistent executor and uses `docker exec` for bounded operations. API-to-runner calls travel only on a Compose internal network with a rotated service secret. Executor containers never receive MCP, runner, GitHub App, or deployment credentials.

Git worktrees are created only beneath the workspace's independent clone. They never point at the controller checkout or shared host repository metadata. Clone egress belongs only to the constrained helper; executor egress remains `none` by default, with a documented owner-enabled `bridge` profile. All post-clone Git commands and patch generation run inside socket-free containers with isolated Git configuration; the trusted runner never evaluates executor-writable `.git` config, hooks, filters, pagers, or diff drivers.

## Related Code Files

- Create: `apps/runner/package.json`, `apps/runner/tsconfig.json`, `apps/runner/src/index.ts`, `apps/runner/src/app.ts`, `apps/runner/src/config.ts`
- Create: `apps/runner/src/auth/service-auth.ts`, `apps/runner/src/stores/workspace-store.ts`, `apps/runner/src/stores/operation-store.ts`
- Create: `apps/runner/src/workspaces/workspace-service.ts`, `apps/runner/src/workspaces/repository-service.ts`, `apps/runner/src/workspaces/path-policy.ts`, `apps/runner/src/workspaces/reaper.ts`
- Create: `apps/runner/src/docker/docker-client.ts`, `apps/runner/src/docker/executor-policy.ts`, `apps/runner/src/docker/executor-service.ts`
- Create: `apps/runner/src/credentials/github-app-broker.ts`, `apps/runner/src/operations/operation-service.ts`, `apps/runner/src/operations/tool-operations.ts`
- Create: `apps/runner/test/workspace-lifecycle.test.ts`, `apps/runner/test/path-policy.test.ts`, `apps/runner/test/github-app-broker.test.ts`, `apps/runner/test/docker-isolation.test.ts`
- Create: `docker/api.Dockerfile`, `docker/runner.Dockerfile`, `docker/executor.Dockerfile`, `compose.yaml`
- Modify: `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts`
- Delete: none

## Implementation Steps

1. Build a private runner HTTP service that authenticates API requests, validates contracts again, binds every record to owner/expiry, and never publishes a host port.
2. Persist workspace/operation metadata in runner-owned SQLite with atomic state transitions, idempotency keys, schema version checks, operation launch acknowledgements, and generation fencing; reconcile database records, jobs-root entries, and labeled containers at startup.
3. Validate clone URLs/ref names: permit approved HTTPS Git hosts, reject userinfo, redirects to private/link-local addresses, local/file/SSH schemes, and caller-selected destination paths.
4. Implement public clone and optional GitHub App credential brokering in the helper container. Mint a short-lived repository-scoped installation token, keep token material in memory/tmpfs with guaranteed cleanup, scrub remote URLs, disable inherited/system Git config, hooks, LFS, filters, submodules, proxy variables and unsafe redirects, then destroy the helper before executor start.
5. Create server-generated job paths, canonical parent/symlink checks, fixed ownership, and independent clones; keep metadata/results outside the executor's writable mount.
6. Build and pin the executor image with Git, ripgrep, shell, Node tooling, and non-root UID `10001`; prohibit caller-controlled image, mount, namespace, device, capability, or Docker flags.
7. Start persistent workspace containers with configured defaults: 15-minute wall TTL, 5-minute idle TTL, one concurrent workspace, 1 CPU, 1 GiB memory/swap, 256 PIDs, 1,024 files, 10 MiB workspace output, and a 2 GiB best-effort workspace ceiling plus host free-space admission floor. Do not label the soft ceiling a hard quota.
8. Implement files/grep/exec/shell/tasks/Git/worktrees/skills/hooks/memories operations using argument arrays and workspace-relative paths. Enforce cursor paging, deadlines, process-group cancellation, stdin limits, optimistic patch/hash checks, and operation expiry. Synchronous exec is request-owned; detached task/shell state is workspace-owned.
9. Use exactly one cleanup authority in the runner. Active operations hold workspace leases; a transactional `ACTIVE -> REAPING` claim with generation fencing precedes cleanup. Stop/remove the container first, collect bounded results in a socket-free collector that ignores workspace Git configuration, remove the exact resolved workspace without following symlinks, then retain only bounded audit metadata. Make close idempotent.
10. Compose API, runner, and executor build inputs so API maps only loopback ingress; runner alone mounts the Docker socket and same absolute jobs root interpreted by the host daemon.

## Tests and Validation

- Real Docker integration tests inspect every required limit/flag and prove non-root identity, `/etc` read-only, `/workspace` writable, no socket/credentials, no host namespaces, no published port, and failed egress.
- Lifecycle tests prove cross-call persistence, wall/idle TTL, explicit close, crash/restart reconciliation, orphan cleanup, idempotency, and bounded retained results.
- Adversarial tests reject traversal, absolute paths, symlink escapes, foreign/expired IDs, malicious Git URL/ref, output floods, fork/memory/PID pressure, disk-floor violation, and cross-workspace reads.
- GitHub App tests use a controlled installation/token flow and assert tokens never appear in executor inspection, remotes, logs, output, metadata, or persisted database fields.
- End-to-end local Compose tests invoke every MCP tool through the API rather than calling runner internals directly.

## Success Criteria

- [x] A workspace container persists across MCP calls and is removed on close or TTL with no orphaned directory/container.
- [x] Required tools operate only within the selected workspace and return bounded, resumable results.
- [x] API has no Docker authority; runner is unreachable publicly and is the sole Docker/socket owner.
- [x] Public clone works and configured GitHub App broker/leak boundaries are tested; a private live clone remains conditional on owner credentials.
- [x] Isolation and resource-limit assertions pass against real Docker.

## Risk Assessment and Rollback

- Risk: rootful Docker socket grants host-root-equivalent authority to a compromised runner. Mitigation: private single-owner scope, minimal runner image, internal-only service, fixed Docker policy, patched host, and explicit documentation.
- Risk: the shared-filesystem soft disk ceiling can race rapid fill. Mitigation: one-workspace admission, clone/container timeouts, host reserve floor, active watcher, and prominent non-guarantee; require quota-backed storage before hostile use.
- Risk: cleanup deletes the wrong path. Mitigation: server IDs, resolved-parent checks, no glob deletion, container-first cleanup, and adversarial tests.
- Rollback: stop admissions, drain or fence active operations, checkpoint/backup schema-versioned state, remove only labeled MVP containers through the verified reaper, and restore compatible previous images/config/state. Refuse a downgrade when its supported schema range excludes the current database.

## Security Considerations

- Docker is defense in depth under a shared kernel; never claim tenant-grade isolation or expose this endpoint anonymously.
- Do not mount home, root, controller checkout, SSH agent, system paths, or secrets into executors. Keep Docker TCP disabled.
- Hooks, package scripts, repositories, and command output are adversarial. Execute only inside the constrained executor and redact/cap before persistence.

## Next Steps

Phase 4 broadens automated gates and documents the exact operational/security contract; Phase 5 verifies it on the target VPS.
