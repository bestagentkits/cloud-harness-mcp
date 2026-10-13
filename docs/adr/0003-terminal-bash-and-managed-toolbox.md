# ADR 0003: Dashboard Terminal, `bash` Tool, and Managed Toolbox Boundary

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related Issues:** Issue #312 (this feature), Issue #16 and
  [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md) (multi-tenant
  boundary, which this ADR does not relax)

## Context

Operators want an interactive terminal in the Dashboard. Agents want a single
`bash` entry point and a way to install, upgrade, and roll back CLI tools that
outlive one workspace. All three add a new path from a person or an agent to
command execution, so the first question is where those commands are allowed
to run.

Cloud Harness is a private, single-owner harness
([security model](../security-model.md#trust-boundaries)). The runner holds the
host Docker socket, which is host-root-equivalent. Workspace executors are the
only place untrusted commands run, and they are hardened: read-only root
filesystem, all capabilities dropped, `no-new-privileges`, uid 10001, resource
limits, and no control-plane credentials or Docker socket.

## Decision

### Three scopes, one rule

| Scope | Where commands run | Persistence |
| --- | --- | --- |
| Workspace | The selected workspace's existing executor | The workspace checkout and its Zone B tool paths, until the workspace closes |
| Managed toolbox | A disposable, unprivileged toolbox container, plus isolated builder containers | Immutable, verified releases under the runner's packages root, mounted read-only |
| Control plane and host | **Never**: no generic shell, no `apt`, no Docker socket, no live-container mutation | Changes only through the release and deployment workflow |

No terminal, `bash` call, or package operation executes in the API, the
runner, or on the host. The API never receives the Docker socket. The browser
never talks to the runner or Docker and never receives a control-plane token.

### Terminal (real PTY)

- The runner creates a Docker Engine exec with `Tty: true` inside the
  workspace executor, as uid 10001, over its existing socket. Resize uses the
  exec resize call, so the kernel delivers `SIGWINCH`. This is a separate
  interactive mode next to the pipe-based `shell_*` and `sessions_*`
  handles, which stay unchanged. It lives in the same operation manager rather
  than a second execution engine.
- The browser reaches terminals only through dashboard BFF routes on the API.
  Those routes use the dashboard session, CSRF, and Origin checks and select
  the principal server-side. The runner re-authorizes the workspace on every
  call: it must be owned, active, and inside its lease.
- Output is raw PTY bytes in a bounded per-terminal window with absolute byte
  cursors. Reads long-poll, and a reader that fell behind is told how many
  bytes it missed. The per-workspace secret redactor filters output before it
  is retained, so injected secret values never reach the browser or the
  retained window. Echo of characters that match the start of a secret value
  is held until the following bytes disambiguate it; that visible lag is a
  deliberate trade-off so a secret is never sent, not even split across reads.
  Input has a per-call size cap and a backpressure limit.
- Lifetime is bounded: there is a maximum number of live terminals per
  workspace, an idle timeout, and a maximum lifetime. A running terminal is
  active work: its reads and input refresh the workspace lease (at most every
  30 s), but never past the workspace's wall-clock cap, and its reported
  expiries are clamped to the workspace's own. Close ends the whole PTY
  session, including job-control children. Closing the attach stream alone
  does not end the shell, so every end path kills the session by its recorded
  pid, retries a failed kill with bounded backoff, and keeps the terminal
  tracked until the kill succeeds or the workspace stops.
- Terminals live in runner memory. A runner restart ends them; startup
  reconciliation restarts each executor, so no process is left behind. The UI then shows the terminal as lost and
  offers a new session. It never pretends to resume a dead PTY.
- Audit records contain lifecycle metadata only: open, close, and the end
  reason. Keystrokes and output are never written to the audit log.

### `bash` MCP tool

- `bash` is a convenience entry point, not a new engine. With
  `target: "workspace"` it uses the same executor path, limits, lease checks,
  and asynchronous operation handles as `exec_run`. A long command returns an
  operation handle instead of holding the MCP response open.
- With `target: "toolbox"`, the command runs in a disposable toolbox container:
  the executor image's hardening, no network, no workspace checkout, and the
  principal's active managed releases mounted read-only. This target exists
  only when the managed toolbox feature flag is on. A long toolbox command
  also returns an operation handle (`async: true`) instead of holding the MCP
  response open; the handle has no workspace, so it is scoped to the owner
  that started it, and cancelling it removes the container.
- The server authorizes the target. A client-supplied target never grants
  capability on its own, and no string blocklist is treated as a security
  control.

### Managed toolbox (packages)

- **Plan, approve, apply.** `packages_plan` resolves an exact version, its
  source, an integrity value where the ecosystem provides one, the dependency
  count, the size estimate, binary conflicts, and the affected workspaces. It
  stores an immutable plan whose digest covers that content, the principal,
  the scope target, and the current binding generation. Package search is part
  of plan resolution, not a separate tool. Approval is recorded against that
  digest. `packages_apply` refuses a different digest, a changed generation,
  an expired plan, or a plan that was already used. When the approval policy
  is `required` (the default), approval is a Dashboard action that MCP clients
  cannot perform.
- **Isolated build.** Builds run in a disposable builder container:
  executor-image hardening, a uid-10001 user, CPU, memory, and pid limits, a
  wall-clock timeout, and no credentials or secret environment. Its only
  egress is the existing provisioning proxy, whose host allow-list the
  operator controls. npm installs run with lifecycle scripts disabled unless
  policy allows them. The builder writes into a staging directory mounted at
  the release's final path, so shebangs and absolute paths stay valid when the
  release is mounted read-only later.
- **Verify, then publish atomically.** The runner refuses a release that is
  oversized or fails the launch check. The launch check runs each declared
  binary in a fresh no-network container with the release mounted read-only.
  The runner records provenance, an SBOM-style dependency list, and the
  runtime it was built against. Only after that does a rename publish the
  release. List and status report verified releases only, never queued
  downloads.
- **Pinned consumption.** When a workspace executor is created, the runner
  snapshots the principal's active bindings into a read-only profile and mounts
  only the referenced releases, read-only. Existing workspaces change only when
  they are recreated. Releases are immutable. Garbage collection removes only
  releases that no binding, rollback history, or open workspace references.
- **Rollback and recovery.** Rollback rebinds a previously verified release and
  is audited. It needs no new approval, because it restores state that was
  already approved and verified. On boot, the runner discards staging
  directories and fails interrupted applies. A fence on the binding allows
  only one apply per package and scope at a time.
- **System packages.** An `apt` or system-library request returns an explicit
  `NOT_SUPPORTED` result. The answer is a new, validated executor image variant
  shipped through the release workflow, never a mutation of a running
  container.
- **Feature flag.** The toolbox is off by default. Roll it out in order:
  workspace Terminal, then `bash`, then user-space packages, then validated
  image variants.

## Consequences

- The trust model does not change. Everything stays inside the single trusted
  owner's security domain, on a shared kernel. A container escape from a
  terminal, a toolbox run, or a builder crosses the same boundary as any
  workspace command. That is acceptable for this owner and not for mutually
  distrustful tenants, per ADR 0001.
- In `owner-bearer` mode, the MCP caller and the Dashboard operator share one
  credential, so plan approval records intent but is not separation of duties.
- Package releases are runtime state under the operator's packages root. They
  survive redeploys because they live on the host volume, not in an image.
  Backups and retention follow the same operator runbook as other runner
  state.

The executable owners are listed in the [security model](../security-model.md)
and the [MCP API](../mcp-api.md) as each slice lands.
