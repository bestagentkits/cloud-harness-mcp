# System architecture

## Boundary map

```text
MCP client
  -> existing nginx (public TLS)
  -> credential-free TCP ingress proxy (loopback-published)
  -> API (private network, bearer + Host + Origin policy)
  -> runner (internal Compose network, service bearer, Docker authority)
       -> ephemeral clone/Git transfer helpers
       -> one network-none workspace executor and writable repository
       -> no-mount Pi worker
            -> closed no-touch proxy -> workspace executor
            -> unique internal agent network -> trusted fixed-profile gateway
                 -> dedicated provider egress -> configured provider
```

The split is deliberate. The ingress proxy owns no secret or application
logic; it only bridges host loopback to an internal frontend network. The API owns public HTTP, MCP negotiation, request
security, and translation to a versioned private runner request. It has no
published port, external network, Docker socket, or host job mount. The proxy
cannot join the API/runner control network. The runner owns workspace lifecycle, SQLite
metadata, repository materialization, Docker policy, and cleanup. Only the
runner receives the Docker socket and job/state mounts. The API and runner
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

The Pi worker deliberately has no repository mount. A closed custom-tool proxy
routes only the selected `AgentProxyOperationSchema` operations into the
existing network-none workspace executor without refreshing workspace
activity. This preserves one writer and reuses executor path/symlink/output
policy. A unique internal network connects each worker only to the trusted
fixed-profile model gateway; only that gateway joins provider egress. The
gateway is a credential-confinement boundary inside the private single-owner
system, not an isolation boundary against a hostile gateway.

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
- Versioned API/runner contract and tool schemas:
  [`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts)
  and
  [`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts)
- Workspace lifecycle and Docker policy:
  [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts)
- In-memory shells, named sessions, and dependency-task scheduling:
  [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts)
- Coding-agent dispatch, lifecycle, durable spawn/message reservation,
  lineage, persisted aggregate usage, logs, idempotency, and cleanup:
  [`apps/runner/src/agent-manager.ts`](../apps/runner/src/agent-manager.ts),
  [`apps/runner/src/agent-state-repository.ts`](../apps/runner/src/agent-state-repository.ts),
  and [`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts)
- Pi protocol and closed proxy-tool surface:
  [`apps/agent-runtime/src`](../apps/agent-runtime/src/) and
  [`docker/agent.Dockerfile`](../docker/agent.Dockerfile)
- Fixed-profile provider gateway and credential loading:
  [`apps/model-gateway/src`](../apps/model-gateway/src/) and
  [`docker/model-gateway.Dockerfile`](../docker/model-gateway.Dockerfile)
- Credential-isolated remote Git staging:
  [`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh) and
  [`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts)
- Executor-side file, code-intelligence, command, repository-local Git, and
  manifest behavior:
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

Shell, named-session, and dependency-task handles, output buffers, graphs, and
idempotency mappings are runner memory, not SQLite state. They survive ordinary
calls but not a runner restart. A restart reconciles persisted workspace
records against Docker containers and restarts every surviving executor. This
preserves repository files while terminating processes whose in-memory handles
were lost; the handles themselves cannot be restored. Docker reconciliation is
scoped by a random runner-instance identity persisted in SQLite, so another
state store or Compose stack using the same daemon does not delete this
instance's containers.

Coding-agent orchestration state is different: spawn/message replay records,
lineage, budgets, redacted cursorable logs, status, and cleanup retries are
durable. Active-workspace replay protection is preserved until workspace
closure and bounded by a lifetime record cap that rejects new reservations
instead of evicting old keys. Agent activity intentionally does not extend the
workspace idle TTL.

Pi conversation processes are not resumable after runner restart, and no
prompt, message, model request, or proxy call is auto-replayed. Reconciliation
first closes admission and drains or removes correlated containers, gateway
leases/requests, and proxy work. Cleanup failure leaves the record nonterminal
with retry metadata; only confirmed drain/removal permits the terminal
`INTERRUPTED`/`outcomeUnknown` record.

The MCP transport is stateless: the API creates a fresh server for request
handling while the durable workspace identity lives below the transport. A
lost `workspace_open` response can therefore be recovered by replaying its
idempotency key or by listing workspaces.

The current admission policy permits one active workspace for the owner. Idle
and wall TTLs converge on the earliest expiry, and the runner is the single
cleanup authority.

## Deployment topology

Production Compose binds the credential-free ingress proxy to
`127.0.0.1:3100`; the API, runner, and model gateway have no published host
ports. Runner and provider egress do not expose ingress ports. Existing
nginx is the only intended public listener and
proxies `/mcp`, `/healthz`, and `/readyz` to loopback. The
[deployment guide](deployment.md) explains the safe install order and the TLS
step that is intentionally outside Compose.
