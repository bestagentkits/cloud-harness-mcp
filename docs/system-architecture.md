# System architecture

## Boundary map

```text
MCP client
  -> existing nginx (public TLS)
  -> API (loopback-published, bearer + Host + Origin policy)
  -> runner (internal Compose network, service bearer)
  -> rootful Docker socket
  -> clone helper, then one executor for the workspace
```

The split is deliberate. The API owns public HTTP, MCP negotiation, request
security, and translation to a versioned private runner request. It has no
Docker socket or host job mount. The runner owns workspace lifecycle, SQLite
metadata, repository materialization, Docker policy, and cleanup. Only the
runner receives the Docker socket and job/state mounts. The API and runner
share an internal control network; the trusted runner also has a separate
egress network for repository DNS validation and optional GitHub App calls.

The executor is where repository-controlled code runs. It is non-root, has a
read-only root filesystem, receives one writable repository mount, and has no
Docker socket or control-plane credentials. These controls reduce accidental
impact; they do not create a hostile-tenant boundary because the executor
shares the host kernel.

Executable owners:

- Public HTTP and MCP assembly:
  [`apps/api/src/app.ts`](../apps/api/src/app.ts) and
  [`apps/api/src/mcp-server.ts`](../apps/api/src/mcp-server.ts)
- Versioned API/runner contract and tool schemas:
  [`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts)
  and
  [`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts)
- Workspace lifecycle and Docker policy:
  [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts)
- Executor-side file, command, and Git behavior:
  [`worker/harness-worker.mjs`](../worker/harness-worker.mjs)
- Runtime topology:
  [`compose.yaml`](../compose.yaml) and
  [`compose.production.yaml`](../compose.production.yaml)

## State and lifecycle

Workspace metadata, idempotency, ownership, status, and expiry are persisted in
SQLite by
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts). The
repository checkout lives under the configured jobs root and persists across
MCP calls while the workspace is active. Close or TTL cleanup removes the
executor and its workspace directory; SQLite retains the resulting metadata.

Shell and detached-task handles, output buffers, and idempotency mappings are
runner memory, not SQLite state. They survive ordinary calls but not a runner
restart. A restart reconciles persisted workspace records against Docker
containers and restarts every surviving executor. This preserves repository
files while terminating processes whose in-memory handles were lost; the
handles themselves cannot be restored. Docker reconciliation is scoped by a
random runner-instance identity persisted in SQLite, so another state store or
Compose stack using the same daemon does not delete this instance's containers.

The MCP transport is stateless: the API creates a fresh server for request
handling while the durable workspace identity lives below the transport. A
lost `workspace_open` response can therefore be recovered by replaying its
idempotency key or by listing workspaces.

The current admission policy permits one active workspace for the owner. Idle
and wall TTLs converge on the earliest expiry, and the runner is the single
cleanup authority.

## Deployment topology

Production Compose binds the API to `127.0.0.1:3100`; the runner has no
published host port. Runner egress does not expose an ingress port. Existing
nginx is the only intended public listener and
proxies `/mcp`, `/healthz`, and `/readyz` to loopback. The
[deployment guide](deployment.md) explains the safe install order and the TLS
step that is intentionally outside Compose.
