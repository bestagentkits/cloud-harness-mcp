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
```

Cloudflare Access is an optional public authentication edge in front of nginx;
it does not join the Compose control network. GitHub and Google are IdPs of
that Access application, not direct API integrations.

The split is deliberate. The ingress proxy owns no secret or application
logic; it only bridges host loopback to an internal frontend network. The API owns public HTTP, MCP negotiation, request
security, and translation to a versioned private runner request. It has no
published port, external network, Docker socket, or host job mount. The proxy
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
- Versioned API/runner contract and tool schemas:
  [`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts)
  and
  [`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts)
- Versioned dashboard-only runner contract:
  [`packages/contracts/src/internal-runner-api.ts`](../packages/contracts/src/internal-runner-api.ts)
- Workspace lifecycle and Docker policy:
  [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts)
- In-memory shells, named sessions, and dependency-task scheduling:
  [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts)
- Credential-isolated remote Git staging:
  [`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh) and
  [`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts)
- Executor-side file, code-intelligence, command, repository-local Git, and
  manifest behavior:
  [`worker/harness-worker.mjs`](../worker/harness-worker.mjs)
- Runtime topology:
  [`compose.yaml`](../compose.yaml) and
  [`compose.production.yaml`](../compose.production.yaml)

The dashboard BFF reuses bounded public runner operations for workspace/files
and a distinct internal runner schema for retained control metadata. Internal
operations are not MCP tools and do not create a second executor path. Browser
responses are mapped at the API; runner tokens, Access assertions, raw secret
values, provider credentials, ciphertext, and artifact filesystem paths are
outside that contract.

## State and lifecycle

Workspace metadata, idempotency, principal ownership, status, and expiry are persisted in
SQLite by
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts). The
repository checkout lives under the configured jobs root and persists across
MCP calls while the workspace is active. Close or TTL cleanup removes the
executor and its workspace directory; SQLite retains the resulting metadata.

Shell, named-session, and dependency-task handles, output buffers, graphs, and
idempotency mappings are runner memory, not SQLite state. They survive ordinary
calls but not a runner restart. A restart reconciles persisted workspace
records against Docker containers and restarts every surviving executor. This
preserves repository files while terminating processes whose in-memory handles
were lost; the handles themselves cannot be restored. Docker reconciliation is
scoped by a random runner-instance identity persisted in SQLite, so another
state store or Compose stack using the same daemon does not delete this
instance's containers.

The MCP transport is stateless: the API creates a fresh server for request
handling while the durable workspace identity lives below the transport. A
lost `workspace_open` response can therefore be recovered by replaying its
idempotency key or by listing workspaces.

Principal, project/environment, encrypted secret-reference, GitHub binding,
artifact metadata, and audit state share the runner-owned SQLite database.
Artifact payloads persist under the artifact root until deletion or bounded
retention reaping. Dashboard runtime summaries remain volatile. The exact
schemas and lifecycle owners are under `apps/runner/src/metadata-*`,
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts), and
[`apps/runner/src/github-installation-sqlite-store.ts`](../apps/runner/src/github-installation-sqlite-store.ts).

The current admission policy permits one active workspace per principal. Idle
and wall TTLs converge on the earliest expiry, and the runner is the single
cleanup authority.

## Deployment topology

Production Compose binds the credential-free ingress proxy to
`127.0.0.1:3100`; the API and runner have no published host ports. Runner
egress does not expose an ingress port. Existing
nginx is the only intended host listener and proxies `/mcp`, `/dashboard`,
`/healthz`, and `/readyz` to loopback. In Access mode the owned public hostname
is additionally protected by the external Access application. The
[deployment guide](deployment.md) explains the safe install order and the TLS
step that is intentionally outside Compose.
