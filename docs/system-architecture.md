# System architecture

## Boundary map

```text
MCP client
  -> existing nginx (public TLS)
  -> credential-free TCP ingress proxy (loopback-published)
  -> API (private network, owner bearer or verified Access assertion)
  -> runner (internal Compose network, service bearer)
  -> rootful Docker socket
  -> ephemeral clone/Git transfer helpers and one executor for the workspace

Static-header MCP client
  -> api.harness.zuey.me/mcp (fixed Cloudflare Worker)
  -> path-scoped Cloudflare Access application (Worker Service Auth only)
  -> harness.zuey.me/mcp-api-key (exact hidden origin route)
  -> API (verified gateway subject AND principal-bound API key)
  -> the same runner and execution path above
```

Cloudflare Access is an optional public authentication edge in front of nginx;
it does not join the Compose control network. GitHub and Google are IdPs of
that Access application, not direct API integrations.

The split is deliberate. The ingress proxy owns no secret or application
logic; it only bridges host loopback to an internal frontend network. The API owns public HTTP, MCP negotiation, request
security, and translation to a versioned private runner request. It has no
published port, Docker socket, or host job mount. It has a dedicated egress
network so the bounded Access verifier can retrieve the configured JWKS; its
frontend and runner-control paths remain internal. The proxy
cannot join the API/runner control network. The runner owns principal
resolution, workspace lifecycle, SQLite metadata, repository materialization,
retained artifact snapshots, secret encryption, GitHub App authorization,
Docker policy, and cleanup. Only the runner receives the Docker socket,
job/state/artifact mounts, and key files. The API and runner
share an internal control network; the trusted runner also has a separate
egress network for repository DNS validation and optional GitHub App calls.

The extra byte-proxy hop is required because Docker does not activate a host
port mapping for a service attached only to an `internal` network on the target
Linux engine. Docker documents internal networks as having no connection to
host network interfaces or external gateway in its
[Compose networking guide](https://docs.docker.com/compose/how-tos/networking/#internal-networks).
Publishing from a separate, secret-free proxy preserves the loopback listener
without granting the API an external gateway.

The executor is where repository-controlled code runs. It is non-root, has a
read-only root filesystem, receives one writable repository mount, and has no
Docker socket or control-plane credentials. These controls reduce accidental
impact; they do not create a hostile-tenant boundary because the executor
shares the host kernel.

Remote Git is a runner-mediated boundary rather than executor egress. The
runner pauses the executor while a no-network helper stages or imports a
sibling transfer repository, and only the separate fetch/push helper receives
temporary network access and an optional token. This split exists so remote
repository synchronization does not put long-lived credentials in the
repository executor.

Coding-agent subagents run in dedicated ephemeral containers separate from the
workspace executor. Each agent container has a read-only root filesystem,
bounded tmpfs, no host/repository mounts, no Docker socket, and no secrets.
Agent tools communicate with the runner via a bounded stdio JSONL protocol for
10 safe file and search operations. Model API requests route exclusively through
the trusted Model Gateway service via per-agent internal Docker networks using
opaque, short-lived capability leases with pre-reserved token and cost budgets.

Third-party agent toolkits are acquired and normalized via disposable clone helpers running on a dedicated internal Docker network (`cloud-harness-provisioning`). All helper egress routes through the dual-homed `provisioning-proxy` (port 3128) with DNS destination allowlists. Normalized bundles are published to runner Content-Addressed Storage (`TOOLKIT_CACHE_ROOT`) and mounted into executors read-only at `/opt/cloud-harness/owner-skills:ro` or staged into `.cloud-harness/skills` under explicit confirmation.

## Composition roots and transports

Cloud Harness MCP supports two distinct composition roots sharing the same public `TOOL_SPECS` and result envelopes:

1. **Streamable HTTP mode (default):**
   `cloud-harness-mcp --transport http` (or default without flags).
   Assembles Express routes, bearer/Access authentication, and translates requests through `RunnerClient` to the isolated Docker runner on a private network.

2. **Local stdio mode:**
   `cloud-harness-mcp --transport stdio --workspace <path>`.
   Assembles `serveStdio` directly connected to `LocalWorkspaceBackend`. Binds to one canonical local project directory, manages host subprocesses via `LocalOperationManager`, and parameterizes `worker/harness-worker.mjs` via `HARNESS_WORKSPACE_ROOT`.

Executable owners:

- Loopback-to-frontend byte proxy:
  [`deploy/ingress-proxy.mjs`](../deploy/ingress-proxy.mjs)
- Public HTTP and MCP assembly:
  [`apps/api/src/app.ts`](../apps/api/src/app.ts) and
  [`apps/api/src/mcp-server.ts`](../apps/api/src/mcp-server.ts)
- Access authentication, dashboard BFF, and browser response boundary:
  [`apps/api/src/auth.ts`](../apps/api/src/auth.ts),
  [`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts), and
  [`apps/api/src/dashboard-response.ts`](../apps/api/src/dashboard-response.ts)
- Static API-key Worker and dual-credential origin boundary:
  [`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts),
  [`apps/api/src/auth.ts`](../apps/api/src/auth.ts), and
  [`apps/runner/src/api-key-store.ts`](../apps/runner/src/api-key-store.ts)
- Versioned API/runner contract and tool schemas:
  [`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts)
  and
  [`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts)
- Versioned dashboard-only runner contracts:
  [`packages/contracts/src/internal-runner-api.ts`](../packages/contracts/src/internal-runner-api.ts)
  and [`packages/contracts/src/api-key-api.ts`](../packages/contracts/src/api-key-api.ts)
- Workspace lifecycle, Docker policy, unified reaper, and repository caching:
  [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts) and
  [`apps/runner/src/repository-cache-manager.ts`](../apps/runner/src/repository-cache-manager.ts)
- Toolkit acquisition, CAS cache manager, and provisioning proxy:
  [`apps/runner/src/toolkit-service.ts`](../apps/runner/src/toolkit-service.ts),
  [`apps/runner/src/toolkit-cache-manager.ts`](../apps/runner/src/toolkit-cache-manager.ts), and
  [`deploy/provisioning-proxy.mjs`](../deploy/provisioning-proxy.mjs)
- Durable tasks, in-memory shells, named sessions, and restart reconciliation:
  [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts) and
  [`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts)
- Credential-isolated remote Git staging and CAS push:
  [`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh) and
  [`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts)
- Executor-side file, code-intelligence, command, repository-local Git, and
  manifest behavior:
  [`worker/harness-worker.mjs`](../worker/harness-worker.mjs)
- Model Gateway dynamic control plane and framed stdin transport:
  [`apps/model-gateway/src/control.ts`](../apps/model-gateway/src/control.ts),
  [`apps/model-gateway/src/gateway.ts`](../apps/model-gateway/src/gateway.ts), and
  [`apps/runner/src/agent-gateway-control.ts`](../apps/runner/src/agent-gateway-control.ts)
- Subagent model profile and provider credential repository:
  [`apps/runner/src/model-profile-state-repository.ts`](../apps/runner/src/model-profile-state-repository.ts) and
  [`packages/contracts/src/model-profile-schemas.ts`](../packages/contracts/src/model-profile-schemas.ts)
- Runtime topology:
  [`compose.yaml`](../compose.yaml) and
  [`compose.production.yaml`](../compose.production.yaml)

The dashboard BFF reuses bounded public runner operations for workspace/files
and a distinct internal runner schema for retained control metadata. Internal
operations are not MCP tools and do not create a second executor path. Browser
responses are mapped at the API; runner tokens, Access assertions, raw secret
values, provider credentials, ciphertext, and artifact filesystem paths are
outside that contract.

## Provenance, context plane, and automation architecture

Cloud Harness MCP provides a portable coding context plane across agent clients without elevating repository text or scripts to trusted policy:

1. **Passive Context Scanner:**
   `worker/harness-worker.mjs` executes bounded passive discovery of allowlisted instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.aider.conf.yml`), language manifests, and test declarations. The scanner performs zero dynamic execution and enforces strict byte budgets (32 KiB default, 128 KiB max) and a 250ms deadline.

2. **Runner Provenance Resolver:**
   The trusted Runner control plane (`apps/runner/src/workspace-service.ts`) stamps canonical provenance metadata (`source`, `trust`, `mutableBy`, `contentSha256`, `discoveredAt`) based on physical isolation boundaries:
   - `built-in` (`trust: trusted-control-plane`, `mutableBy: release`)
   - `owner` (`trust: owner-controlled`, `mutableBy: owner`)
   - `workspace` (`trust: untrusted-executor`, `mutableBy: workspace-process`)
   - `repository` (`trust: untrusted-executor`, `mutableBy: repository-commit`)
   Repository content claiming owner or built-in status is strictly ignored and attributed as untrusted repository data.

3. **4-Tier Skill Precedence:**
   Skills resolve deterministically in the fixed order `built-in > owner > workspace > repository` (with repository sub-priority `.agents/skills > .codex/skills > .claude/skills`). Shadowed candidates remain visible. `skills_run` requires matching the approved SHA-256 bundle digest before executing in an isolated container.

4. **Scoped SQLite Memories (StateStore Schema v5):**
   Memories are persisted in runner-owned SQLite isolated by `principal_id`:
   - `owner`: Principal-wide, persistent across all workspaces
   - `repository`: Scoped to `(principal_id, repository_key)`, persistent across workspaces for the same repository
   - `workspace`: Scoped to `(principal_id, workspace_id)`, automatically reaped upon workspace termination
   Enforces Optimistic Concurrency Control via `expectedGeneration` (CAS) and TTL expiration.

5. **Declarative Lifecycle Hooks:**
   Hooks defined in `.cloud-harness/hooks.json` support named lifecycle events (`pre_commit`, `post_checkout`, `on_workspace_open`, `post_commit`). Automatic execution requires explicit owner activation (`hooks_activate`) pinned to the manifest SHA-256 digest and executes in an unprivileged, no-network executor container.

6. **Adversarial Output Boundary:**
   Structured MCP results keep repository text nested in `data` under `trust: untrusted-executor`. Text projections (`mcp-response-text.ts`) format context items with trusted boundary markers and JSON-escaped excerpts to prevent delimiter breakouts or prompt injection.

## State and lifecycle

Workspace metadata, status, expiry, durable task graphs, Git operation idempotency,
and principal ownership are persisted in SQLite by
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts) with versioned
schema migrations. The
repository checkout lives under the configured jobs root and persists across
MCP calls while the workspace is active. Close or TTL cleanup removes the
executor and its workspace directory; SQLite retains the resulting metadata.

Dependency-task records, dependency DAGs, execution state, and output byte counts
are durable SQLite state (`durable_tasks`, `task_dependencies`), while task output
logs are streamed to 0600 log files on disk. They survive runner restarts and
remain queryable via `tasks_list`/`tasks_status`.
A restart reconciles prior-epoch in-flight tasks as terminal failed tasks
(`status: 'failed'`, `errorCode: 'RUNNER_RESTARTED'`) and spools completed task logs
into retained artifact storage upon workspace closure. In contrast, interactive
shell and named-session process handles and in-memory output streams live in
volatile runner memory and do not survive a runner restart.

A restart reconciles persisted workspace records against Docker containers and
restarts every surviving executor. This preserves repository files while
terminating processes whose in-memory handles were lost; the handles themselves
cannot be restored. Docker reconciliation is scoped by a random runner-instance
identity persisted in SQLite, so another state store or Compose stack using the
same daemon does not delete this instance's containers.

Owner-scoped repository caching stores bare Git repositories under the configured
`repoCacheRoot`, scoped strictly by opaque principal ID. Cloning from the cache
uses `git clone --reference-if-able <cache> --dissociate` to create completely independent, writable
worktree checkouts without cross-principal state sharing. Caching is opt-in
(`enableRepoCache: false` by default).
The MCP transport is stateless: the API creates a fresh server for request
handling while the durable workspace identity lives below the transport. A
lost `workspace_open` response can therefore be recovered by replaying its
idempotency key or by listing workspaces.

Principal, project/environment, encrypted global and environment secret
references/versions (`global_secret_references`, `global_secret_versions`,
`secret_references`, `secret_versions`), workspace secret snapshots
(`workspace_secret_snapshots`, `workspace_secret_snapshot_headers`), API-key digests,
GitHub bindings, artifact metadata, and audit state share the runner-owned SQLite
database. Ingest-time stream redactors in the runner sanitize exact secret matches
(≥ 4 UTF-8 bytes) across streaming task, shell, and session stdout/stderr chunks before
retained buffering, while synchronous `exec_run` command outputs are sanitized after
capture before return. Artifact payloads persist under the artifact root until deletion
or bounded retention reaping. Dashboard runtime summaries remain volatile. The exact
schemas and lifecycle owners are under `apps/runner/src/metadata-*`,
[`apps/runner/src/secret-metadata-store.ts`](../apps/runner/src/secret-metadata-store.ts),
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts), and
[`apps/runner/src/github-installation-sqlite-store.ts`](../apps/runner/src/github-installation-sqlite-store.ts).

The current admission policy permits one active workspace per principal. Idle
and wall TTLs converge on the earliest expiry, and the runner is the single
cleanup authority.

## Deployment topology

Production Compose binds the credential-free ingress proxy to
`127.0.0.1:3100`; the API and runner have no published host ports. Runner
egress does not expose an ingress port. Existing
nginx is the only intended origin host listener and proxies `/mcp`,
`/mcp-api-key`, `/dashboard`,
`/healthz`, and `/readyz` to loopback. In Access mode the owned public hostname
uses one Access application for `/mcp` and `/dashboard`, plus a separate
application scoped exactly to `/mcp-api-key`. The external Worker owns the
public static-key hostname and cannot proxy dashboard or arbitrary origin
traffic. The
[deployment guide](deployment.md) explains the safe install order and the TLS
step that is intentionally outside Compose.
