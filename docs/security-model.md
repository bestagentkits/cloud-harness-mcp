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
joins the internal frontend and control networks plus a dedicated egress
network required to retrieve the configured Cloudflare Access JWKS. JWKS
fetching remains limited by the verifier's fixed URL, redirect rejection,
timeouts, response bounds, and key-cache controls. The runner has no
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

Dashboard-managed API keys add a separate static-client lane without weakening
the Managed OAuth lane. The public `api.harness.zuey.me/mcp` Worker is a fixed
streaming proxy to exact `harness.zuey.me/mcp-api-key`: it rebuilds a small
header allowlist, discards caller-supplied Cloudflare and forwarding identity,
and injects its own Access service-token headers. The hidden origin path is
protected by a separate path-scoped Access application and audience. The
origin requires both a cryptographically verified assertion for the exactly
pinned gateway service subject and a valid principal-bound API key. Neither
credential is sufficient alone, and the reserved gateway subject is rejected
on the normal `/mcp` route. Before forwarding, the Worker enforces the
manifest-owned aggregate Rate Limiting binding and fails closed if the binding
cannot answer. That edge-local, eventually consistent cap is defense in depth;
the origin still enforces authoritative per-credential concurrency and request
limits. The executable owners are
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts),
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts), and
[`apps/runner/src/api-key-store.ts`](../apps/runner/src/api-key-store.ts).

An API key inherits its creator's full MCP authority, including arbitrary
remote command execution. It is not a fine-grained capability and has no tool
scopes. The browser can create, list, and revoke keys only through the existing
Access-authenticated, same-origin CSRF boundary. Plaintext is shown once;
SQLite retains only the SHA-256 digest and non-secret metadata. Expiry is
mandatory (configurable up to 3,650 days, approximately 10 years; choosing a longer lifetime lengthens exposure if the secret is compromised). Revocation takes effect on the next request, and authentication has
no positive cache. Treat disclosure as full account compromise: revoke the key,
inspect redacted audit and request metadata, and create a replacement only
after the leak path is closed.

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

The default executor network profile is `network-none`, which blocks all
executor egress, including dependency installation and networked repository
commands. The owner opt-in `dependency-access` profile is enforced below MCP
tool policy: the executor attaches only to a dedicated managed Docker bridge
(`chm-egress0`) with inter-container communication disabled and Docker's
default masquerade off, and a transactional host firewall (installed via a
single `iptables-restore` commit and verified through an ephemeral
`NET_ADMIN`-only network-guard container) permits only public DNS and public
TCP 80/443. The managed jump is the first rule of both `INPUT` and
`DOCKER-USER`, and forbidden destination classes — loopback-to-host,
Docker/control-plane, RFC 1918, carrier-grade NAT, link-local, and
cloud-metadata (`169.254.169.254`) — are rejected before the allowed ports.
IPv6 is disabled on the bridge. The runner attests the Docker network and the
exact ordered host ruleset before every dependency executor start and during
periodic reaper reconciliation; on drift it fences the workspace to
`NETWORK_QUARANTINED`, stops the executor, and retains its data for recovery
after policy reconciliation. If attestation is unavailable the profile fails
closed (`DEPENDENCY_EGRESS_UNAVAILABLE`) and never falls back to broad bridge
egress. `dependency-access` is not an allowlisted proxy or DLP boundary: it
still permits exfiltration and callbacks to public endpoints. Production
enforcement targets Linux with the Docker iptables backend; the host firewall
is a trusted operator-owned control outside the executor's authority.

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

### Owner-scoped repository cache isolation

When repository caching is enabled (`enableRepoCache: true`):
1. Bare repository caches are stored under `repoCacheRoot` partitioned strictly by the authenticated principal's opaque ID (`<repoCacheRoot>/<principalId>/...`). Cross-principal cache access is structurally impossible.
2. Cache initialization and synchronization use ephemeral helper containers that mount the owner's cache directory writable (`:rw`) to fetch or clone bare repository mirrors.
3. Initial workspace checkouts mount the cache directory strictly read-only (`:ro`) in the clone helper and use `git clone --reference-if-able <cache> --dissociate <workspace>`. The `--dissociate` flag copies referenced objects into the workspace repository during creation, severing any ongoing link to the shared object store before the executor starts.
4. Checkouts are fully independent and writable only to their own workspace; no writable Git state is ever shared across workspaces or principals.

### Brokered GitHub actions

Authenticated GitHub operations (`pr_list`, `pr_view`, `pr_create`, `pr_update`, `pr_comment`, `issue_list`, `issue_view`, `issue_create`, `issue_comment`, `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`, `issue_update`, `issue_publish`) are executed through the `github_action` tool using an ephemeral helper container (`worker/gh-helper.sh`). Action-scoped tokens (`pull_requests: read|write`, `issues: read|write`) are minted by the runner from the trusted GitHub App installation and passed exclusively via `stdin`. The helper container runs read-only with dropped capabilities, and is forcibly removed on all exit paths in a `try/finally` block. Tokens never enter the workspace filesystem or environment.

All write mutations and token authorization denials emit auditable events (`github_action.<action>`) into `audit_events` recording principal, repository, target entity numbers, success status, and structured error codes without storing token secrets or unbounded request payloads. Helper execution failures are classified into structured, typed error codes (`GITHUB_RATE_LIMITED` with retryAfterMs, `GITHUB_PERMISSION_MISSING`, `INVALID_PULL_REQUEST_BASE`, `GITHUB_ACTION_FAILED`) to provide deterministic machine-readable recovery semantics for autonomous agents.
### Three-zone storage and toolchain isolation

Executors operate across three partitioned storage zones:
1. **Zone A (Secrets & Session Config)**: `/tmp/cloud-harness-home` backed by RAM tmpfs (`128MB`), containing ephemeral configurations, temporary tokens, and tool cache metadata. Destroyed on container exit and cannot be committed into Git.
2. **Zone B (User-Space Toolchains & Caches)**: `/opt/user-tools` and `/var/cache/harness` mounted from runner-managed job paths with UID `10001:10001` ownership and mode `0755`. Accommodates global user-space toolchain installations (`npm -g`, `bun`, `uv`, `pnpm`, `wrangler`) without requiring root.
3. **Zone C (Git Repository)**: `/workspace` containing the clean repository working tree.

Workspace disk usage metering calculates the combined footprint of all three persistent zones against `maxWorkspaceBytes`.

### Skill tiers and execution isolation

Skills are resolved across four deterministic precedence tiers (`built-in > owner > workspace > repository`):
1. **Built-in & Owner Tiers (`/opt/cloud-harness/skills:ro`, `/opt/cloud-harness/owner-skills:ro`)**: Mounted read-only (`:ro`) at the container boundary. Because they reside on immutable host mounts, processes within the executor (including any process running as UID 10001) cannot modify these skill files.
2. **Workspace & Repository Tiers (`/workspace/.cloud-harness/skills`, `/workspace/.agents/skills`)**: Reside on the mutable working tree volume. Execution creates an isolated snapshot under `/tmp/cloud-harness-exec/<runId>` and validates the full-tree bundle digest and script SHA before invocation to prevent unintentional concurrent filesystem race conditions. Within the single-tenant container boundary, all processes share UID 10001; users requiring kernel-enforced mount immutability should install skills into the `owner` scope.

### Privileged execution and operator approval grants

Standard executors strictly preserve `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and user `10001:10001`. Sudo/root execution is treated as an explicit owner-approved threat model weakening (similar to `networkMode: bridge`).

When `exec_run` is invoked with `privileged: true`:
1. Privileged execution is supported in `cloudflare-access` mode (where the operator dashboard is authenticated via Cloudflare Access) and is disabled in `owner-bearer` mode to prevent self-approval.
2. In `cloudflare-access` mode, an unapproved request is rejected with `PRIVILEGE_APPROVAL_REQUIRED` and returns a single-use `grantId` bound to the command and working directory with a 60-second TTL.
3. The operator must explicitly approve the grant via the authenticated Dashboard BFF API (`POST /api/v1/privilege-grants/:grantId/approve`). MCP clients cannot self-approve.
4. The caller provides the `approvalGrantToken`. The runner validates the grant and command/cwd hash, atomically consumes it (single-use), and executes the command in an isolated ephemeral container with `try/finally` cleanup. The standard executor container remains permanently hardened and unmodified.
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
hashed API-key metadata, GitHub installation, artifact metadata, and redacted
audit state. Artifact
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

## Local stdio security model

Local stdio mode intentionally alters the trust boundary compared to the remote Docker executor:

### Host authority vs Docker isolation

- Commands executed in local mode (`exec_run`, shells, sessions, tasks) run with the authority of the current host user.
- File path confinement ensures that tool-supplied file paths and working directories cannot resolve outside the canonical workspace root.
- **Path confinement is not an OS command sandbox.** A command running under `exec_run` or in a shell can still access anything accessible to the host user. Never claim local stdio mode is a sandboxed environment.

### Filesystem confinement policy

- The workspace root is canonicalized once at startup from the `--workspace` argument using `realpath`.
- Relative paths, lexical traversal (`..`), absolute paths, and null bytes are rejected before resolution.
- Symlinks are resolved against the canonical root; attempts to escape via symlinks or parent symlinks fail with a structured error.
- `workspace_close` is terminal and idempotent: it terminates child processes and marks the workspace closed, but **never deletes or modifies the user's project folder**.

### Environment curation and secret isolation

- Child subprocesses do not inherit the complete host environment.
- An allowlist provides standard system variables (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, etc.).
- Cloud Harness tokens, bearer secrets, GitHub App credentials, session secrets, and database URLs are actively scrubbed.
- Reserved control prefixes (`HARNESS_*`, `CH_*`) cannot be overridden by tool input.
- Additional host environment variables can be explicitly forwarded via `--env <NAME>`.

### Process cleanup

- Local long-running children are launched in POSIX process groups.
- Cancellation, workspace close, signal receipt (SIGINT, SIGTERM), and process exit trigger process-group termination (`SIGTERM` followed by a grace period and `SIGKILL` escalation).

### Network Git and push opt-ins

- Network Git operations (`git_fetch`, `git_pull`) and Git push (`git_push`) are disabled by default in local mode.
- Enabling them requires explicit startup flags (`--git-network` and `--git-push`).
- Local Git operations use the user's existing checkout configuration and credentials only when authorized by these flags.

### Unsupported capabilities

- `exec_run` with `privileged: true` and `github_action` are unsupported in local v1 and return immediate structured capability errors.

## Repository capability introspection and authorization preflight

To prevent late-stage workflow failures where an agent completes extensive edits before discovering that pushing or publishing is unauthorized, Cloud Harness exposes preflight authorization state:

- **`workspace_capabilities` and `workspace_status`:** Inspectable at any point without modifying state, minting tokens, or launching containers. Returns structured `capabilities.repository` (`read`, `push`, `issuesRead`, `issuesWrite`, `pullRequestsRead`, `pullRequestsWrite`), `permissions`, and `operations`.
- **Policy-driven derivation:** Capabilities reflect Cloud Harness security policy:
  - In `owner-bearer` mode, write capabilities require a configured GitHub App installation on GitHub repositories.
  - In `cloudflare-access` mode, write capabilities are derived from verified GitHub App installation grants bound to the authenticated principal.
  - In local stdio mode, capabilities reflect explicit operator flags (`--git-push`, `--git-network`).
- **Structured denial error:** Unauthorized operations reject immediately with `REPOSITORY_OPERATION_NOT_AUTHORIZED` (403, non-retryable) indicating the exact `operation`, `repository`, and `requiredCapability` (e.g. `repository.push`, `repository.issuesWrite`, `repository.pullRequestsWrite`).

## Provenance and workspace context security model

Cloud Harness MCP provides vendor-neutral coding context across AI agents (Claude, Codex, Cursor, Aider) while maintaining strict boundaries against prompt injection and privilege escalation:

### Passive discovery and zero execution

- `workspace_context` passively inspects known allowlisted instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.aider.conf.yml`), language manifests, and declared test commands.
- Passive discovery performs **zero script executions**, invokes no package managers, and triggers no Git hooks.
- Files are read under strict size and time bounds (max 256 candidate files, 250ms deadline, 32 KiB default response budget).

### Immutable provenance attribution

- Provenance (`source`, `trust`, `mutableBy`, `contentSha256`, `discoveredAt`) is assigned exclusively by the trusted Runner control plane based on physical boundary locations:
  - `built-in` (`trust: trusted-control-plane`, `mutableBy: release`)
  - `owner` (`trust: owner-controlled`, `mutableBy: owner`)
  - `workspace` (`trust: untrusted-executor`, `mutableBy: workspace-process`)
  - `repository` (`trust: untrusted-executor`, `mutableBy: repository-commit`)
- Repository text claiming `source: built-in` or `source: owner` is ignored; the Runner stamps canonical repository provenance.

### Adversarial output-boundary containment

- In `structuredContent`, repository text is encapsulated inside `data.manifest.items` under `trust: untrusted-executor`.
- In text projections (`content[0].text`), items are formatted with trusted boundary markers and JSON-escaped excerpts to prevent delimiter breakout or fake system header forgery.
- Malicious instructions in repository files cannot create persistent SQLite memories without explicit authenticated tool mutation calls.

### Scoped SQLite memories with optimistic concurrency

- Memories are stored in SQLite `StateStore` (schema v5), isolated by `principal_id`:
  - `owner`: Principal-wide, persistent across workspaces
  - `repository`: Scoped to `(principal_id, repository_key)`, persistent across workspaces for that repository
  - `workspace`: Scoped to `(principal_id, workspace_id)`, reaped when the workspace is closed
- Mutations enforce Optimistic Concurrency Control via `expectedGeneration` (CAS) and automatic TTL expiration.

### Declarative lifecycle hooks & sandboxed execution

- Hooks are defined in `.cloud-harness/hooks.json` supporting declarative JSON format with named lifecycle events (`on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual`).
- Automatic lifecycle execution requires explicit owner activation (`hooks_activate`) pinned to the exact manifest SHA-256 digest.
- Modifying the hook script or manifest invalidates activation and blocks execution before process spawn.
- All hooks execute in unprivileged executor containers with `networkMode: none` by default, no broker credentials, and no Docker socket.

### Third-Party Agent Toolkits & Provisioning Network Firewall

- **Network-isolated helpers:** Ephemeral helper containers run on a dedicated `cloud-harness-provisioning` network (`internal: true`) with no default gateway. Direct raw TCP sockets fail with `ENETUNREACH`.
- **Dual-homed egress proxy:** All outbound provisioning traffic is forced through `provisioning-proxy:3128`. The proxy enforces destination allowlists (`allowedGitHosts` + catalog endpoints), blocks private IP ranges (RFC1918), loopback, and cloud metadata (`169.254.169.254`), and connects directly to validated numeric IPs to prevent DNS rebinding.
- **Secret Purpose Classification:** Secrets are marked `purpose: "runtime" | "provisioning"`. Provisioning-only keys are delivered exclusively via stdin pipe to ephemeral helpers on tmpfs and are strictly excluded from runtime container environments (`docker inspect`).
- **Read-only Owner Injection:** Toolkits selected under `owner` scope are projected to `/job/toolkit-projection/owner-skills/` and mounted read-only at `/opt/cloud-harness/owner-skills:ro`, keeping `git status --porcelain` 100% clean.
