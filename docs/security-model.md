# Security model

## Intended use

Cloud Harness MCP is for one authenticated, trusted owner operating
owner-approved repositories. It is not an anonymous service, a shared team
sandbox, or a hostile multi-tenant platform.

`exec_run`, interactive shells, detached tasks, repository hooks, and skill
scripts are intentional remote code execution inside the executor. Bearer
authentication controls who may request that execution; it does not make the
repository code trustworthy.

## Trust boundaries

Trusted control plane:

- the VPS, Docker daemon, deployment identity, nginx, API, runner, runtime
  configuration, and executor image;
- the rootful runner's Docker socket mount, which is host-root-equivalent
  authority.

Untrusted execution input:

- repository content, dependencies, Git metadata, hook definitions, skills,
  memories, and commands supplied through tools.

The API is deliberately separated from Docker authority. The runner has no
published port and is the only service with `/var/run/docker.sock`; it uses a
separate egress network for DNS validation and optional GitHub App calls while
the API/runner control network remains internal.
The executor does not receive that socket, host credentials, or arbitrary host
mounts. The exact container flags are owned by
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts);
Docker-backed checks live in
[`test/integration/docker-sandbox.docker.test.ts`](../test/integration/docker-sandbox.docker.test.ts).

Rootful Docker and a shared kernel remain the principal limitation. A runner
compromise can control the host, and a container escape crosses the executor
boundary. Do not expose this design to mutually distrustful tenants. That
requires a separate execution host or VM/microVM-grade boundary, quota-backed
storage, per-tenant identity/authorization, and stronger abuse controls.

## Public request controls

The API checks, in order, the request hostname policy, an Origin allowlist when
`Origin` is present, and the bearer token before applying owner rate limits or
dispatching MCP. The bearer is a
long-lived replayable secret for this private MVP, not OAuth or a general
authorization server. The API also applies bounded request size, a
process-local request/concurrency limit, no-store/nosniff headers, and a runner
deadline.

These controls are implemented in
[`apps/api/src/request-security.ts`](../apps/api/src/request-security.ts),
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts), and
[`apps/api/src/app.ts`](../apps/api/src/app.ts). Process-local limits reset on
API restart and are not a distributed denial-of-service control.

Rotate `MCP_BEARER_TOKEN` after suspected disclosure and restart the API.
Rotate `RUNNER_TOKEN` independently and restart both control services. Review
logs for exposure before resuming service; tokens must not appear in URLs,
commands, documentation, or source control.

## Executor and repository controls

Executors run as a non-root UID with a read-only root filesystem, dropped
capabilities, `no-new-privileges`, bounded CPU/memory/PIDs/file descriptors,
bounded per-operation and aggregate retained output, bounded operation-handle
counts, and TTL cleanup. Only the workspace repository mount is writable.

Network mode is `none` by default. This blocks ordinary executor egress,
including dependency installation and `git_fetch`. Owner opt-in `bridge`
networking enables broad container egress and weakens protection against
exfiltration, SSRF, callbacks, and dependency-script behavior. It is not an
allowlisted proxy.

Repository opening accepts only credential-free HTTPS URLs on configured
hosts and rejects private/link-local resolutions. The clone helper disables
hooks, recursive submodules, tag downloads, redirects, and LFS smudging.
Repository code is never evaluated by the runner during clone.

Optional GitHub App credentials remain in the runner. A short-lived token may
be supplied to the clone helper over stdin and the remote is rewritten to its
credential-free URL. The executor has no clone token and no push credential.
The repository-policy tests verify the unconfigured and malformed-path cases;
live private cloning is unverified unless the owner supplies credentials and
records a sanitized leak check.

## Storage and state limits

Workspace paths are server-generated and checked beneath the configured jobs
root. Worker paths reject absolute/traversal paths and symlink escapes. SQLite
stores workspace metadata, not a credential cache.

The current storage ceiling is not a hard quota. One-workspace admission, a
host free-space floor, operation-boundary checks, and periodic reaping reduce
risk, but a process can still fill the shared filesystem between checks.
Monitor the host and use a dedicated quota-backed filesystem before accepting
untrusted workloads.

The GitHub Actions SSH identity is separate from the operator's normal key and
must be installed with OpenSSH `restrict` plus the root-owned deploy forced
command. The wrapper accepts only the fixed deploy action and one exact commit
SHA, so broader privileges on the interactive operator account are not exposed
through the automation key.

Close/TTL removes the executor and workspace directory. Shell/task state is
in-memory and disappears on runner restart. Startup restarts surviving
executors to stop processes whose handles were lost; this remains a durability
limitation, not a security guarantee.
