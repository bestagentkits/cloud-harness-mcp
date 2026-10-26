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
  -> api.harness.zuey.me/mcp or /mcp-gateway (fixed Cloudflare Worker)
  -> path-scoped Cloudflare Access application (Worker Service Auth only)
  -> harness.zuey.me/mcp-api-key or /mcp-api-key/gateway (exact hidden origin
     routes)
  -> API (verified gateway subject AND principal-bound API key)
  -> the same runner and execution path above, or the MCP gateway composition
     root below scoped to the key's principal

MCP gateway client
  -> harness.zuey.me/mcp-gateway (same owner bearer or verified Access assertion)
  -> credential-free TCP ingress proxy (loopback-published)
  -> API (gateway composition root; registry, policy, traces, and secret
     resolution stay in the runner)
  -> principal-configured downstream MCP server over an API-owned, address-pinned
     outbound socket

MCP Events webhook delivery
  -> runner records a terminal task/agent event in its state database
  -> API delivery worker leases due deliveries over the service channel
  -> client-registered public HTTPS callback over an API-owned, address-pinned
     outbound socket (Standard Webhooks signature)

Webhook automation, GitHub / Linear / Jira / custom (optional)
  -> existing nginx /integrations/webhooks/ (no Access, no bearer)
  -> credential-free TCP ingress proxy -> API (host check, own rate window,
     provider header allowlist, raw bytes forwarded unparsed)
  -> runner internal automations channel (provider adapter: signature and
     timestamp, dedupe, normalization, rule matching)
  -> runner automation engine -> the runner's own workspace and agent
     operations -> optional post-back: brokered GitHub comment and check run,
     or a Linear/Jira comment from the runner with a sealed outbound credential
  -> GitHub coding rules only: coding broker (policy gate on every agent action)
     -> verify -> runner commit, create-only agent/ branch push, pull request

Automation management (MCP)
  -> authenticated /mcp tools automation_* -> API -> runner automations
     channel (owner-scoped operations only, never ingest)

Dashboard Terminal (browser)
  -> /dashboard BFF on the API (session cookie, Origin, CSRF)
  -> runner internal terminal operation (service bearer, not an MCP tool)
  -> Docker Engine API exec with a PTY over the runner's unix socket
  -> interactive shell inside the workspace's existing executor
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
optional management of the inbound Managed OAuth grant
([ADR 0002](adr/0002-inbound-oauth-grant-provider.md)), Docker policy, and
cleanup. Only the runner receives the Docker socket,
job/state/artifact mounts, and key files. The API and runner
share an internal control network; the trusted runner also has a separate
egress network for repository DNS validation, optional GitHub App calls, and
optional Cloudflare Access API calls.

The extra byte-proxy hop is required because Docker does not activate a host
port mapping for a service attached only to an `internal` network on the target
Linux engine. Docker documents internal networks as having no connection to
host network interfaces or external gateway in its
[Compose networking guide](https://docs.docker.com/compose/how-tos/networking/#internal-networks).
Published from a separate, secret-free proxy preserves the loopback listener
without granting the API an external gateway.

The gateway adds one egress path from the API: it dials downstream MCP servers
at principal-configured URLs. That socket is validated and pinned at connect
time, stays on the API's egress network, and never runs in the runner. The
runner instead resolves the referenced global secrets for one server and one
explicit purpose and returns them over the internal service-token channel; the
[security model](security-model.md) records the boundary change and its
residual risk. Downstream OAuth discovery, registration, token, and revocation
requests use the same API egress path under the same URL policy, while the
encrypted grants they produce stay in the runner.

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

The gateway budget is conservative by design, so it never charges less than
the provider bills. Each request reserves its worst case before it goes
upstream. Input is estimated at one token per request byte, plus a fixed
surcharge for each media part, and priced at the highest input-side price
(input, cache read, or cache write). Output is reserved at the cap sent
upstream. One token per byte is a safe upper bound for text, because each
byte-level BPE token covers at least one byte and a message's template tokens
are fewer than its JSON framing bytes. Media is the exception, which is why it
carries the surcharge. When the response ends, the gateway prices the reported
usage. Cache reads, cache writes, and reasoning are priced separately, and long
prompts are priced at the tier their prompt total reaches. Where a provider's
report is ambiguous, the gateway charges the more expensive reading, and a
provider-reported cost is used as a floor. A completed request is refunded at
most what it reserved. A request that fails, is cancelled, or reports no usage
keeps its whole reservation. Usage above the reservation is recorded as an
overrun. Revoking a lease drains its in-flight requests and returns a
settlement of what the lease consumed. The gateway keeps that settlement in RAM
for 24 hours, so a repeated revoke returns it again. On `/v1/responses` the
gateway refuses `previous_response_id`, `conversation`, and an object-valued
`prompt`, because the stored context they pull in cannot be bounded.
[`apps/model-gateway/src/budget.ts`](../apps/model-gateway/src/budget.ts),
[`apps/model-gateway/src/usage-normalizer.ts`](../apps/model-gateway/src/usage-normalizer.ts),
and [`apps/model-gateway/src/lease-registry.ts`](../apps/model-gateway/src/lease-registry.ts)
own these rules.

The Dashboard Terminal reuses the executor rather than adding an execution
engine. The browser never talks to the runner or Docker: the API BFF in
[`apps/api/src/dashboard-terminal-router.ts`](../apps/api/src/dashboard-terminal-router.ts)
rebuilds each request from the session and path, the runner dispatches it in
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts),
and [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts)
keeps the PTY beside the pipe-based shells and sessions over the transport in
[`apps/runner/src/docker-pty.ts`](../apps/runner/src/docker-pty.ts). The runner
talks to the Engine API directly because the Docker CLI cannot allocate a TTY
without a local one. The browser pulls output with long-poll reads over
ordinary dashboard requests. [ADR 0003](adr/0003-terminal-bash-and-managed-toolbox.md) records
the decision; the [security model](security-model.md#dashboard-terminal) records
its boundary.

Managed toolbox packages split orchestration from building. The `packages_*`
MCP tools reach the runner like every other tool, but the runner dispatches
them before workspace resolution, so they take no workspace mutation lock.
[`apps/runner/src/package-service.ts`](../apps/runner/src/package-service.ts)
owns the plan resolution, approval, durable apply, rollback, uninstall,
startup reconciliation, and hourly garbage collection over the SQLite records in
[`apps/runner/src/package-store.ts`](../apps/runner/src/package-store.ts).
[`apps/runner/src/package-builder.ts`](../apps/runner/src/package-builder.ts)
runs resolution and builds in short-lived executor-image containers on the
provisioning network and verifies each release tree below `PACKAGES_ROOT`.
When the runner starts an executor or a `bash` toolbox container, it mounts
the owner's and workspace's bound releases read-only and puts their `bin`
directories on PATH. The Dashboard lists, rolls back, and uninstalls packages
and approves plans through internal runner operations behind the BFF. The
[security model](security-model.md#managed-toolbox-packages) records the
boundary.

The Decision Plane ([ADR 0004](adr/0004-decision-plane.md)) lives in the
runner under
[`apps/runner/src/decision-plane/`](../apps/runner/src/decision-plane/). It
holds the provider key, redaction, bounds, metrics, and audit. The workspace
service asks it for an advisory diagnosis of generic GitHub failures. The API's
gateway `search` reaches it only through the internal `decision_rerank_tools`
operation, and checks the returned ordering against its own candidate pool. The
API never holds the provider credential.

Webhook automations live in the runner under
[`apps/runner/src/automation-service.ts`](../apps/runner/src/automation-service.ts).
Each provider is one adapter (verify, event name, delivery id, normalize,
match, optional publish) registered in
[`apps/runner/src/automation-providers.ts`](../apps/runner/src/automation-providers.ts),
with the interface in
[`apps/runner/src/automation-adapter.ts`](../apps/runner/src/automation-adapter.ts);
the service and engine are provider-neutral.
The API owns only the public ingress
([`apps/api/src/automations/webhook-ingress.ts`](../apps/api/src/automations/webhook-ingress.ts)),
the Dashboard BFF routes, and the `automation_*` MCP tools
([`apps/api/src/automations/automation-tools.ts`](../apps/api/src/automations/automation-tools.ts));
all reach the runner over the internal automations channel whose schema is
[`packages/contracts/src/automations-api.ts`](../packages/contracts/src/automations-api.ts).
Ingest only verifies, deduplicates, and stores a normalized delivery, so a
webhook returns quickly; an in-process engine tick, outside any request path,
matches deliveries to rules and drives each workflow through the same
`workspace_open`, `agent_spawn`, `agent_status`, `agent_logs`, `github_action`,
and `workspace_close` operations an MCP client uses, under the rule owner's
principal. Every step carries an idempotency key derived from the workflow id,
so a runner restart resumes rather than duplicates a workspace, agent, or
comment; the publisher's last reference (comment or check run id) is stored
with the workflow so later phases edit instead of re-posting. Success is the agent's authoritative status, never log scraping; the
logs supply only the final answer text. The terminal transition and its
[MCP event](mcp-api.md#mcp-events-webhook-delivery) commit together. The
tables are additive and unversioned
([`apps/runner/src/automation-schema.ts`](../apps/runner/src/automation-schema.ts)),
and the trust decisions are in the
[security model](security-model.md#webhook-automation-ingress).

Agent execution policies live in the runner under
[`apps/runner/src/agent-governance/`](../apps/runner/src/agent-governance/)
([ADR 0006](adr/0006-policy-governed-coding-agents.md)). The policy store keeps
immutable revisions and compare-and-swap heads in the runner state database;
the resolver turns the global and project heads into a frozen snapshot; the
pure gate evaluator (`PURE_GATE_EVALUATOR`) decides. It serves both the
Dashboard simulation and the coding broker. The API holds no policy state: the Dashboard BFF
([`apps/api/src/dashboard-policies-router.ts`](../apps/api/src/dashboard-policies-router.ts))
forwards validated owner requests over the internal agent-policies channel,
whose schema is
[`packages/contracts/src/agent-policy-api.ts`](../packages/contracts/src/agent-policy-api.ts).
The versioned ports in
[`ports.ts`](../apps/runner/src/agent-governance/ports.ts) are the seams that
runtime adapters, the action broker and advisors plug into.

Coding automations (`AGENT_CODING_ENABLED`) extend the same engine. A rule's
optional `coding` action admits the workflow against the policy and pins its
revisions; the engine then runs one step per tick through
[`apps/runner/src/automation-coding.ts`](../apps/runner/src/automation-coding.ts):
the agent phase, verify, commit, push and pull request. The coding broker
([`action-broker.ts`](../apps/runner/src/agent-governance/action-broker.ts))
wraps the agent manager's tool executor, so the agent's edits and commands
reach the workspace only after a gate decision, and it records every agent and
runner action as a receipt in `coding_actions`
([`action-store.ts`](../apps/runner/src/agent-governance/action-store.ts)) and
as an `action` span on the agent's trace. Receipts are what make a restart
safe: a step whose receipt is applied is skipped, and one whose effect is
unknown is reconciled by reading GitHub before anything is repeated. Commits,
pushes and pull requests use the runner's own `git_commit`, `git_push` and
`github_action` operations, so publishing credentials stay in the runner. The
optional lockfile install
([`install-executor.ts`](../apps/runner/src/agent-governance/install-executor.ts))
is a one-shot container the runner starts before the agent; it is not an agent
tool. The trust decisions are in the
[security model](security-model.md#coding-automations).

Third-party agent toolkits are acquired and normalized via disposable clone helpers running on a dedicated internal Docker network (`cloud-harness-provisioning`). All helper egress routes through the dual-homed `provisioning-proxy` (port 3128) with DNS destination allowlists. Normalized bundles are published to runner Content-Addressed Storage (`TOOLKIT_CACHE_ROOT`) and mounted into executors read-only at `/opt/cloud-harness/owner-skills:ro` or staged into `.cloud-harness/skills` under explicit confirmation.

## Composition roots and transports

Cloud Harness MCP supports four distinct composition roots. The coding-harness
roots share the public `TOOL_SPECS` and result envelopes; the
gateway root owns its own constant five-tool contract.

1. **Streamable HTTP mode (default):**
   `cloud-harness-mcp --transport http` (or default without flags).
   Assembles Express routes, bearer/Access authentication, and translates requests through `RunnerClient` to the isolated Docker runner on a private network.
   The [Skills over MCP extension](mcp-api.md#skills-over-mcp-extension) rides the same root: the API only validates and maps JSON-RPC, while the runner resolves, hashes, and reads skills for the bound principal through read-only internal operations. Local stdio mode has no such backend and does not advertise it.

2. **MCP gateway mode:**
   `https://<host>/mcp-gateway`.
   A second Streamable HTTP composition root that exposes the constant five
   meta-tools over a principal-scoped registry of downstream MCP servers. The
   runner owns registry persistence, cached tool metadata, the allow/deny
   decision, traces, and encrypted-secret resolution; the API owns the outbound
   MCP client socket and never dials a configured URL from the runner. See the
   [MCP gateway](mcp-gateway.md).

3. **Local stdio mode:**
   `cloud-harness-mcp --transport stdio --workspace <path>`.
   Assembles `serveStdio` directly connected to `LocalWorkspaceBackend`. Binds to one canonical local project directory, manages host subprocesses via `LocalOperationManager`, and parameterizes `worker/harness-worker.mjs` via `HARNESS_WORKSPACE_ROOT`.

4. **Local multi-workspace mode:**
   `cloud-harness-mcp --transport stdio|http --workspace-config <path>`.
   Loads an operator-owned root registry and keeps one `LocalWorkspaceBackend`
   per root in a pool; `MultiLocalWorkspaceBackend` routes each call by
   `workspaceId`. Over stdio it is served by `serveStdio`; over HTTP by a
   separate local Express app that never creates a runner client. Owners:
   [`apps/api/src/local/`](../apps/api/src/local/) and
   [`apps/api/src/index.ts`](../apps/api/src/index.ts). Semantics:
   [local multi-workspace mode](mcp-api.md#local-multi-workspace-mode).

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
- MCP gateway contracts, registry, connection manager, URL policy, and traces:
  [`packages/contracts/src/mcp-gateway-schemas.ts`](../packages/contracts/src/mcp-gateway-schemas.ts),
  [`apps/runner/src/mcp-gateway-store.ts`](../apps/runner/src/mcp-gateway-store.ts), and
  [`apps/api/src/mcp-gateway/`](../apps/api/src/mcp-gateway/)
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
   `worker/harness-worker.mjs` executes bounded passive discovery of allowlisted instruction files (`INSTRUCTION_CANDIDATES` and the client rule directories), language manifests, and test declarations. The scanner performs zero dynamic execution and enforces strict byte budgets (32 KiB default, 128 KiB max) and a 250ms deadline.
   The runner reuses the same discovery, through a runner-internal worker operation, for a per-workspace repository-guidance snapshot: `workspace_open` returns its content-free summary and `agent_spawn` composes it into a managed agent's first message. The selection lives in the contracts package so `workspace_context` and agent bootstrap agree; see [repository guidance bootstrap](mcp-api.md#repository-guidance-bootstrap).

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

A multi-repository workspace keeps the same executor mount: its tree root holds
one checkout per alias under `repos/<alias>/`, and the repository set is written
to an additive registry in the transaction that admits the workspace. The
runner resolves a `repositoryId` selector to an in-memory record view scoped to
one checkout, which every existing clone, transfer, recovery, GitHub, and
capability helper receives unchanged, so per-repository behaviour needs no
second code path. A single-repository workspace has no registry rows and gets a
synthesized deterministic entry. The resolver lives in
[`apps/runner/src/workspace-repositories.ts`](../apps/runner/src/workspace-repositories.ts);
the reasoning is in [ADR 0005](adr/0005-multi-repository-workspaces.md).

The skill registry is a separate concern that shares that store. Sources, revisions, sets, and import
jobs are written through [`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts), while
4-tier resolution and the same-tier conflict rule live in
[`apps/runner/src/skill-resolver.ts`](../apps/runner/src/skill-resolver.ts) and are applied both when a
workspace launches and when the dashboard previews a set, so the two paths cannot disagree.
Integration credentials are deliberately not model provider credentials: they live beside them in
[`apps/runner/src/principal-store.ts`](../apps/runner/src/principal-store.ts) under the same keyring
envelope, so a key that is not a gateway provider never travels through a gateway snapshot.

Dependency-task records, dependency DAGs, execution state, and output byte counts
are durable SQLite state (`durable_tasks`, `task_dependencies`), while task output
logs are streamed to 0600 log files on disk. They survive runner restarts and
remain queryable via `tasks_list`/`tasks_status`.
A restart reconciles prior-epoch in-flight tasks as terminal failed tasks
(`status: 'failed'`, `errorCode: 'RUNNER_RESTARTED'`) and spools completed task logs
into retained artifact storage upon workspace closure. In contrast, interactive
shell and named-session process handles, Dashboard Terminal PTYs, and their
in-memory output streams live in volatile runner memory and do not survive a
runner restart.

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
GitHub bindings, artifact metadata, MCP gateway registry/tool/permission/trace tables,
encrypted downstream MCP OAuth grants and pending flows,
and audit state share the runner-owned SQLite database. Ingest-time stream redactors in the runner sanitize exact secret matches
(≥ 4 UTF-8 bytes) across streaming task, shell, and session stdout/stderr chunks before
retained buffering, while synchronous `exec_run` command outputs are sanitized after
capture before return. Artifact payloads persist under the artifact root until deletion
or bounded retention reaping. Dashboard runtime summaries remain volatile. The exact
schemas and lifecycle owners are under `apps/runner/src/metadata-*`,
[`apps/runner/src/secret-metadata-store.ts`](../apps/runner/src/secret-metadata-store.ts),
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts), and
[`apps/runner/src/github-installation-sqlite-store.ts`](../apps/runner/src/github-installation-sqlite-store.ts).

MCP Events use a transactional outbox in the same state database (schema
v13). The outbox row and its per-subscription delivery rows are written in the
same savepoint as the generation-guarded terminal transition they describe, so
a state change and its event commit or roll back together, and a task or agent
yields at most one logical event. The runner owns subscriptions, fan-out,
retry scheduling, retention, and API-key revocation checks; the API only
claims leased deliveries, signs, and posts them, so a crash between post and
report re-sends the same event after the lease expires. The owners are
[`apps/runner/src/event-outbox.ts`](../apps/runner/src/event-outbox.ts),
[`apps/runner/src/mcp-event-service.ts`](../apps/runner/src/mcp-event-service.ts),
and
[`apps/api/src/events/event-delivery-worker.ts`](../apps/api/src/events/event-delivery-worker.ts);
the protocol contract is in [MCP API](mcp-api.md#mcp-events-webhook-delivery).

The notification inbox, when enabled, rides the same savepoints: the outbox's
terminal emitters also write a deduplicated `notifications` row and one
`notification_deliveries` row per channel (tables created additively, without
a schema version bump). The inbox channel is settled at write time; the MCP
Events channel records a `cloudharness.notification.created` outbox event and
then mirrors that event's delivery state, and the GitHub channel mirrors the
automation's own comment state, so the dispatcher opens no network connection
itself. A failure to write a notification is caught inside a nested savepoint,
logged, and counted, and does not roll back the transition; only an error after
which SQLite has already rolled back the enclosing transaction is re-thrown,
since the transition is lost either way. Turning the MCP Events channel off
revokes its pending notification deliveries and, in the same transaction,
abandons the pending webhook deliveries of their events, so nothing is sent
afterwards. The dispatcher leases due deliveries with a compare-and-set token,
backs off retries to a bounded attempt count (an expired lease counts as a
failed attempt and backs off too, so a delivery that keeps crashing its
dispatcher still stops), fails a delivery still open past
twice the retention window, and keeps purging old notifications while the
feature is off. The owners
are
[`apps/runner/src/notifications/notification-emitter.ts`](../apps/runner/src/notifications/notification-emitter.ts),
[`apps/runner/src/notifications/notification-store.ts`](../apps/runner/src/notifications/notification-store.ts),
and
[`apps/runner/src/notifications/notification-dispatcher.ts`](../apps/runner/src/notifications/notification-dispatcher.ts).

Aggregate model spend is tracked in a durable ledger in the same database
(`model_spend_ledger` and `model_spend_policies`, created additively without a
schema version bump, so an older runner ignores them). A gateway lease is the
reservation. Spawn admission reserves the run's whole cost cap against the
principal's and the profile's daily and monthly UTC policies in the same write
transaction that admits the spawn, so concurrent spawns are serialised and a
replay never reserves twice. The gateway still enforces the per-run cap in
memory, so a policy only bounds how many caps may be outstanding and needs no
per-request round trip. When the runner revokes the lease, it settles the row
from the gateway's frozen settlement: at the gateway's cost (which can exceed
the cap on overrun, and is at least the cap when a request reported no usage),
released at zero when the lease was never issued (including when the gateway
explicitly refused to issue it), or `unreconciled` at the cap when the lease may
have been issued (an ambiguous issue failure, or no settlement from the issuing
gateway).
A gateway restart therefore over-counts rather than under-counts: open rows stay
committed at their cap, and revoking a lost lease returns a new boot id. A
runner restart keeps the ledger, and a sweep at startup and every minute
settles rows whose agent is terminal or gone and prunes closed rows after 400
days. Every aggregate figure is an estimate, never provider billing. A first
crossing of a policy's warning threshold writes one structured
`model spend threshold reached` log line with identifiers only. The owners are
[`apps/runner/src/model-spend-ledger.ts`](../apps/runner/src/model-spend-ledger.ts),
[`apps/runner/src/agent-manager.ts`](../apps/runner/src/agent-manager.ts), and
[`packages/contracts/src/model-spend-schemas.ts`](../packages/contracts/src/model-spend-schemas.ts).

Agent traces, when enabled, add `agent_traces` and `agent_trace_spans` to the
runner state database, created by an idempotent initializer without a schema
version bump and without foreign keys, so a trace outlives its workspace and
agent rows. The agent manager feeds a recorder from the same runtime events,
proxy tool calls, and gateway settlement it already handles; the recorder
writes only at span boundaries (never per stream delta), and a store failure is
logged once and marks the trace degraded instead of affecting the agent. At
startup, traces left `RUNNING` by a previous runner epoch become `INCOMPLETE`.
At startup and hourly, a purge removes traces past retention, even with traces
disabled, in bounded batches of one transaction each that yield to the event
loop between batches; shutdown stops it between batches and waits for it before
the database closes. The per-principal quota evicts in the same bounded batches.
Neither removes a trace whose automation workflow has not ended, and reads keep
returning it past its retention date while it is held: a coding
workflow can wait for an approval longer than the retention and still records
its approval and action spans into the trace of its finished agent run. A
runner-recorded span moves the trace's retention to count from that span, and an
approval request holds the trace a full retention past its decision deadline.
Like a `RUNNING` trace, a workflow that never ends stops holding its trace seven
days after the retention deadline.
The owners are
[`apps/runner/src/agent-trace-schema.ts`](../apps/runner/src/agent-trace-schema.ts),
[`apps/runner/src/agent-trace-recorder.ts`](../apps/runner/src/agent-trace-recorder.ts),
and
[`apps/runner/src/agent-trace-store.ts`](../apps/runner/src/agent-trace-store.ts).

The admission policy permits up to `MAX_ACTIVE_WORKSPACES_PER_OWNER` concurrent
counted workspaces per principal (default 3; `1` restores single-workspace
behaviour). Admission and promotion are counted atomically in
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts) and enforced
by
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts).
Idle and wall TTLs are per workspace and converge on the earliest expiry, and the
runner remains the single cleanup authority.

## Deployment topology

Production Compose binds the credential-free ingress proxy to
`127.0.0.1:3100`; the API and runner have no published host ports. Runner
egress does not expose an ingress port. Existing
nginx is the only intended origin host listener and proxies `/mcp`, the
workspace-bound `/mcp/workspaces/<workspaceId>` prefix,
`/mcp-gateway`, `/mcp-api-key`, `/mcp-api-key/gateway`, `/dashboard`,
`/healthz`, and `/readyz` to loopback. In Access mode the owned public hostname
uses one Access application for `/mcp` (including its workspace-bound paths),
`/mcp-gateway`, and `/dashboard`, plus a
separate application scoped to the `/mcp-api-key` path, which also covers its
`/mcp-api-key/gateway` subpath. The external Worker owns the public static-key
hostname, forwards only its two fixed paths, and cannot proxy dashboard or
arbitrary origin traffic. The
[deployment guide](deployment.md) explains the safe install order and the TLS
step that is intentionally outside Compose.
