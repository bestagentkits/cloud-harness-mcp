# Security model

## Intended use

Cloud Harness MCP is for one authenticated trusted owner, or a named set of
mutually trusted operators in one security domain, operating owner-approved
repositories. It is not an anonymous service, a general team sandbox, or a
hostile multi-tenant platform. Principal-qualified authorization prevents
accidental cross-operator access; it does not strengthen the shared-kernel
executor boundary.

`exec_run`, interactive shells and sessions, detached tasks, repository hooks,
skill scripts, and repository-defined deployments are intentional remote code
execution inside the executor. Public authentication controls who may request
that execution; it does not make the repository code trustworthy.

## Trust boundaries

Trusted control plane:

- the VPS, Docker daemon, deployment identity, nginx, API, runner, runtime
  configuration, and executor image;
- the rootful runner's Docker socket mount, which is host-root-equivalent
  authority.

Untrusted execution input:

- repository content, dependencies, Git metadata, hook and deployment
  manifests, skills, memories, and commands supplied through tools.

The API is deliberately separated from Docker authority. A credential-free
TCP proxy is the only Compose service with a loopback-published port. It joins
the API frontend network but not the API/runner control network, and the API
itself joins only internal networks. The runner has no
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

## Public authentication and request controls

The default `owner-bearer` mode authenticates one long-lived replayable owner
secret and exposes MCP only. The opt-in `cloudflare-access` mode delegates
login, OAuth discovery/token issuance, and coarse admission to Cloudflare
Access. The origin derives identity only from the verified forwarded Access
assertion; the opaque client bearer is not interpreted as identity. The two
modes cannot be enabled ambiguously.

Access policies may offer GitHub and Google login, but Cloud Harness keys
authorization only on Access-normalized `(issuer, subject)`. Email and display
name are metadata, not linking signals. Subject recovery is an explicit,
collision-checked operator mapping with a redacted audit record; there is no
first-login or same-email takeover path. Cloudflare hostname ownership, Zero
Trust policy, IdP setup, revocation, and client compatibility remain external
operator controls that code and unit tests cannot prove.

The API checks hostname policy and an Origin allowlist before dispatch. In
Access mode, `/dashboard` additionally requires the Access assertion and
same-origin CSRF session for mutations. Browser responses use a strict
allowlist and must not contain the MCP/runner token, Access assertion, raw
secret, GitHub App credential, or minted provider token. The API also applies
bounded request size, process-local request/concurrency limits,
no-store/nosniff headers, and a runner deadline.

These controls are implemented in
[`apps/api/src/request-security.ts`](../apps/api/src/request-security.ts),
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts), and
[`apps/api/src/app.ts`](../apps/api/src/app.ts). Process-local limits reset on
API restart and are not a distributed denial-of-service control.

In owner-bearer mode, rotate `MCP_BEARER_TOKEN` after suspected disclosure and
restart the API. In Access mode, revoke at Access/IdP and verify the edge no
longer forwards an accepted assertion. Rotate `RUNNER_TOKEN` independently and
restart both control services. Review logs for exposure before resuming
service; tokens must not appear in URLs, commands, documentation, or source
control.

## Executor and repository controls

Executors run as a non-root UID with a read-only root filesystem, dropped
capabilities, `no-new-privileges`, bounded CPU/memory/PIDs/file descriptors,
bounded per-operation and aggregate retained output, bounded operation-handle
counts, and TTL cleanup. Only the workspace repository mount is writable.

Network mode is `none` by default. This blocks ordinary executor egress,
including dependency installation and networked repository commands. Owner
opt-in `bridge` networking enables broad container egress and weakens
protection against exfiltration, SSRF, callbacks, dependency scripts, and
repository-defined deployment commands. It is not an allowlisted proxy.

Repository opening accepts only credential-free HTTPS URLs on configured
hosts and rejects private/link-local resolutions. The clone helper disables
hooks, recursive submodules, tag downloads, redirects, and LFS smudging.
Repository code is never evaluated by the runner during clone.

Optional GitHub App credentials remain in the runner. Access GitHub SSO never
grants repository access. A separate principal-bound App installation and
verified repository grant authorize private Git operations. Short-lived,
repository-scoped tokens are supplied over stdin only to ephemeral clone,
fetch, or push helpers; the stored remote stays credential-free and the
executor never receives a token. Remote fetch/pull first stage outside the
executor and import without network or credentials. Push first stages a bare
snapshot without credentials, then uses a separate networked helper. Transfer
directories and helper containers are removed after the operation.

The public contract fixes remote transfers to `origin`, permits only branch
push refspecs, rejects deletion refspecs, and permits force only through
force-with-lease. Private clone/fetch/pull require GitHub App Contents read
access; push requires Contents read and write access. The executable boundary
and its evidence are
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts),
[`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh),
[`apps/runner/test/git-transfer-leak.test.ts`](../apps/runner/test/git-transfer-leak.test.ts),
and
[`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts).
Live private-repository verification remains owner-supplied evidence.

Repository-manifest deployments are named commands, not a secret broker. They
execute with the same unprivileged executor environment and network mode as
other repository commands; the harness does not inject host or deployment
credentials. Their manifest parsing and execution owner is
[`worker/harness-worker.mjs`](../worker/harness-worker.mjs).

## Storage and state limits

Workspace paths are server-generated and checked beneath the configured jobs
root. Worker paths reject absolute/traversal paths and symlink escapes. SQLite
stores workspace/principal, project/environment, encrypted-secret reference,
GitHub installation, artifact metadata, and redacted audit state. Artifact
payloads use a separate runner-confined bounded root. Raw secret values are
encrypted with a versioned runner-held keyring and are never returned to the
browser; the keyring and GitHub App private key never cross into API, ingress,
or executor surfaces. Their executable owners are
[`apps/runner/src/metadata-store.ts`](../apps/runner/src/metadata-store.ts),
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts), and
[`apps/runner/src/secret-keyring.ts`](../apps/runner/src/secret-keyring.ts).

Repository files may remain private to executor UID 10001. The runner meters
an active workspace with a fixed command inside its executor and checks a
newly cloned workspace with a no-network, capability-free helper mounted
read-only on the generated workspace path. A transient measurement failure is
retryable and does not close the workspace; only a successful measurement over
the ceiling triggers cleanup. If the host UID cannot remove executor-owned
files, cleanup uses a separate fixed no-network, capability-free helper;
startup reaps interrupted ephemeral helpers.

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

Close/TTL removes the executor and workspace directory. Shell/session/task
state is in-memory and disappears on runner restart. Startup restarts surviving
executors to stop processes whose handles were lost; this remains a durability
limitation, not a security guarantee.
