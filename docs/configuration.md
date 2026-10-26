# Configuration

Copy [`.env.example`](../.env.example) to an ignored `.env` for local Compose,
or use the root-owned production file described in the
[deployment guide](deployment.md). Replace every `change-me` value with an
independent random secret. Do not commit runtime environment files.

The executable configuration authorities are:

- API loading and `_FILE` secret behavior:
  [`apps/api/src/config.ts`](../apps/api/src/config.ts)
- Runner loading, including optional GitHub App assembly:
  [`apps/runner/src/config.ts`](../apps/runner/src/config.ts)
- Types, validation, allowed ranges, and code defaults:
  [`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts)
- Local/production wiring and host overrides:
  [`compose.yaml`](../compose.yaml) and
  [`compose.production.yaml`](../compose.production.yaml)
- Maintained operator baseline: [`.env.example`](../.env.example)

Use those files when an exact default or allowed range matters; this document
records the decisions behind the settings rather than copying a second mutable
inventory.

## Authentication and request policy

`AUTH_MODE` selects one mutually exclusive deployment contract:

- `owner-bearer` is the default. `MCP_BEARER_TOKEN` authenticates the one
  configured `OWNER_ID`, and the browser dashboard is disabled.
- `cloudflare-access` trusts only a verified Cloudflare Access assertion for
  identity. Configure the issuer, application audience, and JWKS URL from the
  same Access application, remove the owner bearer, and protect both `/mcp`
  (including the workspace-bound `/mcp/workspaces/<workspaceId>` paths) and
  `/dashboard` at the Access edge. GitHub and Google are Access identity
  providers; Cloud Harness does not integrate their login tokens directly.

The exact required/forbidden combinations are owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts).
Access is appropriate only for one owner or a named set of mutually trusted
operators in one security domain; it does not turn the shared executor host
into a hostile multi-tenant service. Dashboard mutations also require an exact
allowed same-origin request and a short-lived CSRF session. The owning request
paths are [`apps/api/src/auth.ts`](../apps/api/src/auth.ts) and
[`apps/api/src/dashboard-security.ts`](../apps/api/src/dashboard-security.ts).

`RUNNER_TOKEN` is independent of either public authentication mode and is used
only from API to runner. Secret-valued settings accept their documented
`_FILE` form and must meet schema length/placeholder checks.

### Dashboard-managed API-key gateway

The static-client lane is an opt-in extension of `cloudflare-access`, not a
third authentication mode. `API_KEY_AUTH_ENABLED=true` requires all of:

- `API_KEY_GATEWAY_ACCESS_AUDIENCE`, the audience of the separate Access
  application scoped to the `/mcp-api-key` path (which also covers the
  `/mcp-api-key/gateway` subpath);
- `API_KEY_GATEWAY_SERVICE_SUBJECT`, the normalized `cf-service:` subject
  observed from the dedicated Worker service token; and
- `API_KEY_GATEWAY_PUBLIC_URL`, the client-facing Worker URL, currently
  `https://api.harness.zuey.me/mcp`. The dashboard derives the API-key lane's
  MCP gateway URL from its origin plus `/mcp-gateway`.

The gateway audience must differ from the main `/mcp` and `/dashboard`
application audience. Partial configuration and enabling this lane in
`owner-bearer` mode fail validation. The exact combinations and subject shape
are owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts).

The Worker stores `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as
Cloudflare Worker secrets, never in the runtime environment, Wrangler
manifest, or repository. They belong only to the Service Auth policy of the
path-scoped gateway application. Its manifest also owns an aggregate
Cloudflare Rate Limiting binding shared by both fixed gateway paths: 600 requests per
60 seconds in each Cloudflare location. Limiter exhaustion returns JSON `429`;
a missing or failed binding returns JSON `503`. This eventual, edge-local cap
is defense in depth; the origin's per-credential limits remain authoritative.
The secret-free route and proxy contract are owned by
[`apps/api-key-gateway/wrangler.jsonc`](../apps/api-key-gateway/wrangler.jsonc)
and
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts).

### Managed OAuth session settings

The optional `CLOUDFLARE_ACCESS_*` API integration lets Dashboard Settings read
and update the grant session duration and access-token lifetime of the Access
application that protects `/mcp`. It is valid only in `cloudflare-access` mode
and is configured on the runner alone:

- `CLOUDFLARE_ACCESS_API_TOKEN_FILE` (preferred) or
  `CLOUDFLARE_ACCESS_API_TOKEN`, a Cloudflare API token scoped to one account
  with **Access: Apps and Policies Write**, or **Read** for read-only;
- `CLOUDFLARE_ACCESS_ACCOUNT_ID` and `CLOUDFLARE_ACCESS_APP_ID`, identifying
  that application;
- `CLOUDFLARE_ACCESS_OAUTH_ACCESS`, `read-write` or `read-only`; and
- `CLOUDFLARE_ACCESS_OAUTH_MAX_GRANT_SECONDS`, which overrides the provider
  maximum offered as **Stay signed in** when a tenant accepts a different
  ceiling. The built-in value is `CLOUDFLARE_DEFAULT_MAX_GRANT_SECONDS` in
  [`apps/runner/src/cloudflare-access-oauth-provider.ts`](../apps/runner/src/cloudflare-access-oauth-provider.ts).

Setting any of these without the token and both identifiers fails runner
startup rather than silently hiding the Dashboard controls. Leaving all unset
keeps the grant managed only in Cloudflare Zero Trust. Production Compose
mounts `/etc/cloud-harness-mcp` read-only at `/run/cloud-harness-secrets` in
the runner, so the maintained token path is
`/run/cloud-harness-secrets/cloudflare-access-api-token`; the API service
explicitly blanks both token variables inherited from the shared environment.
Loading is owned by [`apps/runner/src/config.ts`](../apps/runner/src/config.ts),
shapes and the mode rule by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts), and
the Dashboard bounds by
[`apps/runner/src/oauth-grant-settings-service.ts`](../apps/runner/src/oauth-grant-settings-service.ts).
The safety boundary is in the
[security model](security-model.md#inbound-mcp-oauth-session-lifetimes).

Access principals are durable exact `(issuer, subject)` identities. Email and
display name are never an authorization or account-link key. The first Access
cutover can bind one legacy owner only through the complete explicit legacy
mapping in the maintained operator baseline. A later subject rotation requires
an operator-reviewed exact old-to-new mapping in `ACCESS_PRINCIPAL_RELINKS`;
the runner records the mapping transactionally and never guesses from email.
Remove completed mappings only after their applied state and rollback window
have been verified. Apply a relink only during a maintenance window with
dashboard and MCP writes quiesced. The schema and ledger owners are
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts) and
[`apps/runner/src/principal-store.ts`](../apps/runner/src/principal-store.ts).

`API_PUBLIC_HOSTS` is the hostname allowlist evaluated for every MCP request.
`API_ALLOWED_ORIGINS` applies when a client sends `Origin`; non-browser clients
may omit it. Include the public hostname and keep loopback entries only when
required for local health or smoke checks.

`REQUEST_TIMEOUT_MS` bounds API-to-runner work and `MAX_BODY_BYTES` bounds JSON
request bodies. If a client tool timeout is increased, the server-side timeout
must still be large enough for the intended operation. Keep it above the
inline wait of `packages_plan` (`PACKAGES_PLAN_INLINE_WAIT_MS` in
[`packages/contracts/src/package-schemas.ts`](../packages/contracts/src/package-schemas.ts)):
a slower plan resolution continues in the runner and is polled through
`packages_status`, but a timeout below the inline wait aborts the call before
the plan or its `resolutionId` comes back.

## Workspace and repository policy

`ALLOWED_GIT_HOSTS` is a host allowlist, not permission to use arbitrary URL
schemes or private addresses. The effective executor network profile resolves in
three tiers, each of which outranks the next:

1. an explicit `workspace_open.networkProfile`;
2. the instance-wide default persisted from the dashboard Settings page
   (`GET`/`POST /api/v1/settings`);
3. `WORKSPACE_NETWORK_PROFILE`, whose shipped and built-in default is
   `dependency-access`.

`dependency-access` is therefore the default posture: it exists so a workspace
can reach the GitHub API and the bundled `gh` CLI, and it permits public DNS and
public TCP 80/443 only, while a Linux host firewall (attested by the runner
before each dependency executor starts) blocks loopback-to-host,
Docker/control-plane, RFC 1918, link-local, and cloud-metadata ranges. It is not
an allowlist or DLP boundary and still permits exfiltration to public endpoints.
Host firewall attestation is a hard prerequisite: provision the firewall with
`deploy/scripts/setup-dependency-firewall.sh` and confirm readiness from the
Settings page before relying on egress. If attestation fails,
`dependency-access` fails closed (`DEPENDENCY_EGRESS_UNAVAILABLE`, HTTP 503) and
is never silently downgraded to `network-none`. `network-none` remains available
as the per-workspace or instance-wide opt-out that blocks all executor egress;
existing deployments that pin `WORKSPACE_NETWORK_PROFILE` keep that value until
the operator changes it in Settings or edits the variable.
`DEPENDENCY_DNS_RESOLVERS`, `DEPENDENCY_BRIDGE_SUBNET`,
`DEPENDENCY_BRIDGE_INTERFACE`, and `DEPENDENCY_NETWORK_NAME` configure the
managed bridge and firewall. The legacy `WORKSPACE_NETWORK_MODE` variable is
rejected at startup. The precedence and fail-closed behavior are owned by
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts)
and
[`apps/runner/src/network-profile-manager.ts`](../apps/runner/src/network-profile-manager.ts);
the persisted default and its reset semantics by
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts) and
[`apps/api/src/dashboard-router.ts`](../apps/api/src/dashboard-router.ts).
Runner-owned remote Git helpers do not depend on the executor network profile.

`WORKSPACE_WALL_TTL_SECONDS`, `WORKSPACE_IDLE_TTL_SECONDS`,
`WORKSPACE_RECOVERABLE_GRACE_SECONDS`, and `REAPER_INTERVAL_SECONDS` define
lifecycle timing. The grace is how long an expired workspace stays
`EXPIRED_RECOVERABLE` before the reaper may close it; `0` closes clean expired
workspaces on the next reaper pass, and auto-close never discards unsaved work
(see [operations](operations.md#expired-workspaces-and-auto-close)).
`MAX_OUTPUT_BYTES` bounds runner/worker results. `MIN_FREE_BYTES` gates new
workspace admission against a host reserve.

**Dashboard lifecycle overrides.** Dashboard → Settings → **Workspace limits &
lifecycle** stores durable, instance-wide overrides for
`MAX_ACTIVE_WORKSPACES_PER_OWNER`, the idle TTL, the wall TTL, and the
recoverable grace, so these can change without a redeploy. Each value resolves
as Dashboard override, then the runner environment variable, then the built-in
default, and the panel shows which source applies. Resetting a field returns it
to the runner value. Override ranges are narrower than some environment ranges
(the idle floor is a minute, and the Dashboard edits whole minutes); the bounds
are owned by
[`packages/contracts/src/workspace-lifecycle.ts`](../packages/contracts/src/workspace-lifecycle.ts)
and the environment schema by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts). The
TTLs and grace are snapshotted onto each workspace at `workspace_open`, so a
change applies only to workspaces opened afterwards; a workspace persisted
before the snapshot existed uses the runner idle TTL and a one-hour grace. The
quota is re-read on every admission and recovery. Writes, validation, and
auditing are owned by
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts)
and [`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts).

`MAX_ACTIVE_WORKSPACES_PER_OWNER` bounds the concurrent counted workspaces one
principal may hold, unless a Dashboard override replaces it. Counted statuses are `CREATING`, `ACTIVE`, and
`NETWORK_QUARANTINED`; a record in `REAPING` is in flight to teardown and holds no
slot, so destroying a workspace never consumes capacity. The shipped default is `3`
and the accepted range is `1..64`, where `1` restores single-workspace behaviour.
Admission (`workspace_open`) and promotion out of `EXPIRED_RECOVERABLE` are counted
atomically, so the limit holds under concurrent callers. Lowering the limit never
reaps an existing workspace; it only blocks new admission and recovery until the
counted total drops. An implicit target is resolved only when it is unambiguous, so
with more than one counted workspace every operation must pass `workspaceId`.
Each counted workspace retains its own container memory, CPU, and pid bounds, the
per-workspace `MAX_WORKSPACE_BYTES` ceiling, and its own TTL, so host memory must be
sized for this limit times the expected simultaneous builds. Admission and
promotion are owned by [`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts)
and [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts).

**Rollback constraint.** The retired `one_active_workspace_per_owner` unique index
is dropped at runner startup, and a release that predates its retirement re-creates
it during `StateStore` construction. Against a database that holds two or more
counted workspaces for one principal, that statement fails and the older runner
exits during startup. Before deploying a release that predates this change, reduce
each principal to one counted workspace. For the same reason,
`downgradeStateSchemaToV5` is now data-dependent: it reproduces the historical v5
schema including that index, so it fails on a database holding more than one counted
workspace per principal. The retirement and its boot-time drop are owned by
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts) and
[`apps/runner/src/principal-store.ts`](../apps/runner/src/principal-store.ts).

`MAX_WORKSPACE_BYTES` is a soft ceiling checked after clone, around synchronous
operations, and by the runner reaper. It is not a filesystem quota and cannot
stop a fast-running process between checks. Operate with disk monitoring and a
host reserve; use quota-backed dedicated storage before treating this as an
untrusted service.

`MAX_WORKSPACE_REPOSITORIES` bounds how many repositories one
[multi-repository workspace](mcp-api.md#multi-repository-workspaces) may hold.
It may only lower the schema ceiling, and a larger `repositories` set is
refused with `LIMIT_EXCEEDED` before anything is admitted or cloned. The
checkouts share one executor and the single `MAX_WORKSPACE_BYTES` ceiling, so
raise it only with disk headroom. The default and bounds are owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts).
There is no Dashboard override.

`JOBS_ROOT` contains ephemeral workspace directories. `STATE_DB` points to
SQLite control metadata. `ARTIFACT_ROOT` contains retained, bounded dashboard
snapshots and spooled task outputs; it must use runner-confined durable storage
distinct from the TTL-bound jobs root. Quotas and retention are defined by
`MAX_ARTIFACT_BYTES` (default 16 MiB), `MAX_PRINCIPAL_ARTIFACT_BYTES` (default 128 MiB),
and `ARTIFACT_RETENTION_SECONDS` (default 86,400 seconds / 24 hours), validated
by the configuration schema and enforced by
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts).

`REPO_CACHE_ROOT` (mapped via `HOST_REPO_CACHE_ROOT` in Compose) configures the
runner storage path for bare Git repository caches (`/var/lib/cloud-harness/cache/repos`).
`ENABLE_REPO_CACHE` (default `false`) toggles owner-scoped bare cloning; when
enabled, initial clones reference local Git object storage via `git clone --reference-if-able <cache> --dissociate`
while keeping writable checkouts strictly isolated.

`EXECUTOR_IMAGE` is chosen by the trusted operator; callers cannot select an
image.

The shipped executor includes the AgentKit `ak` CLI independently of mounted
kit skills. [`docker/executor.Dockerfile`](../docker/executor.Dockerfile) owns
the exact beta version and Linux architecture-specific archive checksums; builds
fail if the artifact changes. The CLI is proprietary and retains its licence
under `/usr/local/share/licenses/agentkit/`; operators need an AgentKit licence
or permission to use it. No AgentKit login, kit installation, or provisioning
credential is baked into the image. Upgrade the image through the normal release
path and open a new workspace to receive the binary; existing containers retain
their image. Custom images and local stdio mode must provide their own CLI.

`TOOLKIT_CACHE_ROOT` configures the runner's content-addressed storage volume for pre-cached agent toolkits (`/var/lib/cloud-harness/cache/toolkits`), and `TOOLKIT_NETWORK_POLICY` (`cache-only` vs `runner-fetch`) controls whether uncached toolkits can be fetched dynamically at workspace open.

Skill registry imports follow the same policy. With `cache-only` an uncached `skills.sh` or `SkillX` import fails closed with `NOT_FOUND` and import guidance instead of opening a network channel; importing a new registry skill therefore requires `runner-fetch`. When fetching is enabled, acquisition runs in the runner provisioning containers behind `provisioning-proxy`, whose `ALLOWED_HOSTS` allowlist is the only egress authority: `skills.sh` references resolve to GitHub repositories and need no additional host, while `SkillX` imports call `skillx.sh`, which is on that allowlist.

## Operator-provided skills (`built-in` tier)

`BUILTIN_SKILLS_ROOT` names an absolute **host** directory that is mounted
read-only into every executor at `/opt/cloud-harness/skills`, the worker's
highest-precedence skills tier. It is the operator's own channel for skill
content that should be available to every workspace on the instance without a
toolkit selection — including licensed vendor content an operator hosts on their
own machine instead of consuming a signed registry package.

- Lay content out as `/opt/cloud-harness/skills/<skill-name>/SKILL.md` (plus any
  `references/` or `scripts/`). `skills_list` reports each one as `built-in`
  with trust `trusted-control-plane`.
- The harness never writes to this directory, and the mount is read-only in the
  executor, so the runner rebuilds nothing and the content is not copied into
  the toolkit cache.
- Leave it unset to keep the tier empty (the default). The runner mounts nothing
  in that case, so an unconfigured instance cannot expose an unowned path.
- Compose passes the runner environment file through unchanged, so setting the
  variable in `/etc/cloud-harness-mcp/runtime.env` (or `.env`) is enough; no
  Compose change is required. `deploy/scripts/bootstrap-vps.sh` creates
  `/var/lib/cloud-harness/skills` on first install.
- The runner rescans the same `BUILTIN_SKILLS_ROOT` directory when it builds the
  context manifest, so the partition the executor sees and the partition the
  runner attributes as `built-in` are identical. This is the only name that
  selects the tier: the executor worker, the local stdio backend, and the
  provenance classifier all read it. In the executor the name is normally unset,
  so the worker resolves the fixed `/opt/cloud-harness/skills` mount target; in
  local stdio mode, which has no executor mount, the name falls back to the same
  literal. The mount target stays authoritative on the executor side.
- `BUILTIN_SKILLS_ROOT` is a reserved name. A caller can never supply it as a
  workspace secret or environment value, so a workspace cannot shadow the
  operator's catalog. A principal that already holds a stored record with that
  name fails closed with `INVALID_INPUT` (HTTP 400) at `workspace_open` and
  `workspace_recover`; failing closed is deliberate, because silently ignoring a
  name that selects the trusted tier would hide a shadowing attempt. The operator
  removes the record with `secret_delete` or `global_secret_delete`, which stay
  shape-validated only, since deletion cannot inject a value.
- **Migration.** The former `CH_BUILTIN_SKILLS_ROOT` override is no longer read.
  It was honoured from a custom `EXECUTOR_IMAGE` `ENV` and from the local stdio
  process environment. Rename that variable to `BUILTIN_SKILLS_ROOT`, or move the
  catalog to the fixed mount target.
- **Upgrading with live workspaces.** Deleting the record does not change a
  container that already exists, because the executor environment is written when
  the container is created. A workspace created before this release can therefore
  keep a caller-supplied `BUILTIN_SKILLS_ROOT` inside its running container, and
  the worker reads it for `skills_list` and `skills_read` until that container is
  closed, rebuilt, or reaped; the `workspace_context` manifest still re-attributes
  every worker item as `repository`. Close or let pre-upgrade workspaces expire
  before relying on the tier being operator-only.

## Licensed AgentKit kits

The `agentkit` toolkit kind mounts licensed AgentKit kit skills (for example
`engineer`) into a workspace. It is the only toolkit kind that reads a paid,
registry-published artifact, so it needs three settings before it is available:

- `AGENTKIT_REGISTRY_URL` — registry origin, `https://agentkit.best` by default.
- `AGENTKIT_REGISTRY_CREDENTIAL_SECRET` — name of the principal's global secret
  holding the licence token (`AGENTKIT_REGISTRY_TOKEN` by default). The token is
  the operator's `ak_dev_`/`ak_cli_` registry credential and **must** be created
  with `purpose: provisioning`; a `runtime`-purpose token is refused, because
  runtime secrets are injected into executor environments. The runner never
  accepts a credential from a tool argument, and a caller without a
  provisioning-purpose secret gets a fail-closed `INVALID_INPUT` naming it.
- `AGENTKIT_REGISTRY_KEY_ID` and `AGENTKIT_REGISTRY_PUBLIC_KEY` — the pinned
  Ed25519 signing key (PEM or base64 SPKI DER). Both are required: the runner
  refuses a manifest whose `keyId` or signature does not match, so a
  misconfigured or downgraded instance cannot mount unverified vendor content.

Resolution and verification are owned by
[`apps/runner/src/agentkit-registry.ts`](../apps/runner/src/agentkit-registry.ts)
and [`apps/runner/src/adapters/agentkit-adapter.ts`](../apps/runner/src/adapters/agentkit-adapter.ts):
the runner resolves `GET /api/agentkit/kits/{kitId}/resolve?runtime=cloud-harness`
with the stored credential, verifies the Ed25519 manifest signature, downloads
the pre-signed artifact, verifies its SHA-256 against the signed manifest, and
extracts it inside a network-disabled helper container. The runner contacts the
registry directly (like its GitHub API calls); helper containers used for
inspection and extraction run with `--network none`. Only the small signed
manifest is fetched through the network on a cache hit — the package itself is
served from the toolkit CAS identified by its artifact digest.

## Dashboard secrets

Dashboard secret values are write-only. The browser receives reference
metadata, readiness, and generations, never a submitted value or ciphertext.
Encryption uses the versioned runner-held keyring selected through
`SECRET_KEYRING_FILE`; the API explicitly clears keyring settings inherited
from the shared environment. The maintained file location is under the
runner-only `/run/cloud-harness-secrets` mount. Key shape and loading are owned
by [`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts)
and [`apps/runner/src/config.ts`](../apps/runner/src/config.ts).

Keep old decrypt keys while their versions exist and through the rollback
window. Rotate by adding a new active version, restarting with the complete
keyring, quiescing writes, and invoking the runner re-encryption entry point
via `npm run secrets:rekey -w @cloud-harness/runner` as documented in the
[operations guide](operations.md#secret-key-rotation). Missing or invalid key
material disables secret-dependent operations without exposing key details;
non-secret dashboard reads remain available.

Secrets support a `purpose` attribute (`runtime` vs `provisioning`). `runtime` secrets are injected into executor container environments; `provisioning` secrets are excluded from runtime container injection.

Dashboard-managed MCP API keys use a different write-only contract from
encrypted environment secrets. The runner stores only a SHA-256 digest and
safe metadata (with configurable lifetime up to 3,650 days, approximately 10 years); the complete random key crosses the authenticated, CSRF-
protected Dashboard response exactly once. Lifecycle limits and response
schemas are owned by
[`packages/contracts/src/api-key-api.ts`](../packages/contracts/src/api-key-api.ts)
and [`apps/runner/src/api-key-store.ts`](../apps/runner/src/api-key-store.ts).

## Dashboard Terminal

The Dashboard Terminal runs a real PTY inside the owned workspace executor. PTYs
live in runner memory, are never resumed after a runner restart, and end with
their workspace. A running terminal's reads and input refresh the workspace's
idle lease (`WORKSPACE_IDLE_TTL_SECONDS`) at most every 30 s, but never past its
wall-clock cap (`WORKSPACE_WALL_TTL_SECONDS`). The runner reaches the Docker
Engine API over its unix socket for this, so a non-unix `DOCKER_HOST` makes
terminals unavailable. Exact ranges are owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts); the
lifecycle by [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts).

| Variable | Default | Decision |
|---|---|---|
| `TERMINAL_MAX_PER_WORKSPACE` | `4` | Bounds live PTYs per workspace; another open is refused with `LIMIT_EXCEEDED` (429). |
| `TERMINAL_RETAINED_BYTES` | `1048576` | Raw output kept per terminal for reconnecting readers; older bytes are reported as `missedBytes`. |
| `TERMINAL_IDLE_TIMEOUT_MS` | `900000` | Input, resize, and reads reset it; expiry ends the terminal as `timed_out`. |
| `TERMINAL_MAX_LIFETIME_MS` | `28800000` | Absolute lifetime regardless of activity. |

## Managed toolbox

The toolbox is the `bash` tool's `toolbox` target: each command runs in a
disposable container from `EXECUTOR_IMAGE` with the executor hardening, no
network, and no workspace checkout. The boundary and rollout order are recorded
in [ADR 0003](adr/0003-terminal-bash-and-managed-toolbox.md); the container
arguments are owned by [`apps/runner/src/toolbox-runner.ts`](../apps/runner/src/toolbox-runner.ts).

| Variable | Default | Decision |
|---|---|---|
| `PACKAGES_ENABLED` | `false` | Runner flag. Only `true` enables the toolbox target; otherwise it is refused with `FORBIDDEN` (403) before any container starts. The `workspace` target is unaffected. |
| `TOOLBOX_MAX_CONCURRENT` | `2` | Runner cap on toolbox containers running at once, sync and async together. Each holds the executor's 1 GiB memory, 1 CPU, and 256-pid bounds, so size it with `MAX_ACTIVE_WORKSPACES_PER_OWNER` against host memory. A call beyond it is refused with `LIMIT_EXCEEDED` (429, retryable). |

Managed packages are immutable releases that the runner builds below
`PACKAGES_ROOT` and binds per owner or per workspace. Their input and result
schemas are owned by
[`packages/contracts/src/package-schemas.ts`](../packages/contracts/src/package-schemas.ts),
the bounds by `RunnerConfigSchema` in
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts), and
the durable plan, apply, release, and binding records by
[`apps/runner/src/package-store.ts`](../apps/runner/src/package-store.ts).
Every variable below is runner-only and inert while `PACKAGES_ENABLED` is not
`true`.

| Variable | Default | Decision |
|---|---|---|
| `PACKAGES_ROOT` | `/var/lib/cloud-harness/packages` | Absolute release store, mounted only into the runner. Compose mounts `HOST_PACKAGES_ROOT` at the same path, so the two must be equal; production keeps the default because Compose interpolation does not read `runtime.env`. Backup and retention are in [operations](operations.md#managed-package-releases). |
| `PACKAGES_ECOSYSTEMS` | `npm,uv` | Comma-separated subset of the buildable ecosystems. A plan for another ecosystem is refused. |
| `PACKAGES_APPROVAL_MODE` | `required` | `required` holds each plan for an owner decision in the dashboard before apply. Owner-bearer auth has no dashboard approver, so planning still works but apply is refused with `FORBIDDEN` and the runner logs one startup warning; `none` records plans as approved by policy instead. |
| `PACKAGES_NPM_LIFECYCLE_SCRIPTS` | `deny` | `allow` lets an npm plan that explicitly requests lifecycle scripts run them during the build; otherwise installs ignore them. |
| `PACKAGES_MAX_RELEASE_BYTES` | `536870912` | Per-release size cap, 16 MiB to 4 GiB, and never above the owner cap. |
| `PACKAGES_MAX_OWNER_BYTES` | `4294967296` | Per-owner cap on retained releases plus in-flight builds, 64 MiB to 64 GiB. Exceeding it is refused with `LIMIT_EXCEEDED`. |
| `PACKAGES_MAX_BINDINGS` | `32` | Per-owner binding count, 1 to 256. |
| `PACKAGES_BUILD_TIMEOUT_MS` | `600000` | Build deadline, 60000 to 1800000 ms. |

Registry egress for builds is not a runner variable. The provisioning proxy's
default allow-list contains no package registry; the owner opts registries in
through `PACKAGES_PROXY_HOSTS` in the proxy-only
`/etc/cloud-harness-mcp/provisioning-proxy.env`, as described in
[operations](operations.md#package-registry-egress). The proxy is shared with
toolkit helpers, so its Compose-set `ALLOWED_HOSTS` reach builders as well.

## MCP gateway

The `/mcp-gateway` composition root adds nine settings. Their exact defaults,
ranges, and code owners remain
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts) and
[`apps/api/src/config.ts`](../apps/api/src/config.ts); the generated
[environment-variable reference](../docs-site/reference/environment-variables.md)
and [`.env.example`](../.env.example) carry the current values.

| Variable | Default | Decision |
|---|---|---|
| `MCP_GATEWAY_TIMEOUT_MS` | `30000` | Bounds one downstream connect or call. |
| `MCP_GATEWAY_MAX_RESPONSE_BYTES` | `262144` | Caps a downstream response body before it is parsed. |
| `MCP_GATEWAY_MAX_TOOLS_PER_SERVER` | `500` | Caps cached tool metadata per server. |
| `MCP_GATEWAY_MAX_SCHEMA_BYTES` | `65536` | An oversized upstream schema is cached as `unavailable`, never truncated. |
| `MCP_GATEWAY_MAX_CATALOG_BYTES` | `2097152` | Bounds the whole per-principal catalog. |
| `MCP_GATEWAY_MAX_TRACE_ROWS` | `20000` | Retention cap for gateway traces. |
| `MCP_GATEWAY_MAX_CONNECTIONS` | `32` | Bounds the per-process connection cache with LRU eviction. |
| `MCP_GATEWAY_ALLOW_PRIVATE_ENDPOINTS` | `false` | Permits loopback, private, and link-local MCP endpoints. |
| `MCP_GATEWAY_ALLOW_INSECURE_HTTP` | `false` | Permits cleartext HTTP MCP endpoints. |

Both opt-ins are default-off and gate separate hazards. A private endpoint
requires `MCP_GATEWAY_ALLOW_PRIVATE_ENDPOINTS=true`; a cleartext `http` endpoint
requires **both** that opt-in and `MCP_GATEWAY_ALLOW_INSECURE_HTTP=true`.
Validation refuses `MCP_GATEWAY_ALLOW_INSECURE_HTTP=true` on its own. In
`cloudflare-access` mode both opt-ins are refused outright, so the only
permitted endpoints there are public https URLs. The endpoint policy itself is
owned by [`apps/api/src/mcp-gateway/url-policy.ts`](../apps/api/src/mcp-gateway/url-policy.ts),
and the gateway boundary is described in the [MCP gateway](mcp-gateway.md).

### Downstream MCP OAuth

Two optional API settings enable the **outbound** OAuth client that lets the
gateway connect to OAuth-protected downstream MCP servers. They do not
configure the inbound Cloudflare Access Managed OAuth lane. Both are unset by
default; their accepted shapes are owned by `ApiConfigSchema` in
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts), and
[`.env.example`](../.env.example) carries commented examples.

- `MCP_DOWNSTREAM_OAUTH_REDIRECT_URL` is the browser callback that
  authorization servers redirect to: the public dashboard origin followed by
  exactly `/dashboard/mcp-oauth/callback`, over https (plain http is accepted
  only for a loopback host during local development), with no query or
  fragment. While it is unset, servers can still be saved with an `oauth`
  configuration, but Connect returns `unavailable` and OAuth servers cannot be
  authorized. Set it to the hostname operators actually use for the dashboard,
  because the callback must arrive with that browser's Access session.
- `MCP_DOWNSTREAM_OAUTH_CLIENT_METADATA_URL` is optional: a public https URL
  with a non-root path that serves this deployment's OAuth Client ID Metadata
  Document. When set and the authorization server advertises support, the URL
  itself is used as the `client_id`, so no registration is created at the
  authorization server. Without it, dynamic client registration or a manually
  entered client ID is used. Cloud Harness does not serve this document; host
  it separately, with a `client_id` equal to its own URL and `redirect_uris`
containing the redirect URL above.

Both are read only by the API container through the runtime environment file.
The deployment steps are in
[deployment](deployment.md#downstream-mcp-oauth-redirect).

## Model gateway provider overrides

`MODEL_GATEWAY_SESSION_HEADER` names one optional upstream header that the model
gateway fills with the calling agent id, for OpenAI-compatible providers that
ask for or require a conversation identifier. It is unset by default, so no
header is invented for other providers. The gateway always identifies itself
through `user-agent: cloud-harness-model-gateway`. The accepted shape and the
reserved names the override may not collide with are owned by
[`apps/model-gateway/src/config.ts`](../apps/model-gateway/src/config.ts), and
production Compose forwards the setting into the gateway container.

A registry provider that asks for such a header names it in the provider
registry
([`packages/contracts/src/model-provider-registry.ts`](../packages/contracts/src/model-provider-registry.ts)),
for example `x-opencode-session` for OpenCode Go. The runner exports it with the
credential in the gateway snapshot, and the gateway applies the same name
validation and rejects the whole snapshot if it fails. The gateway sends the
provider's own header when it has one and falls back to
`MODEL_GATEWAY_SESSION_HEADER` otherwise; the value is always the agent id. So
the variable is needed only for a Custom route to a provider that asks for a
session header, and setting it never changes the header OpenCode Go receives.

## Optional GitHub App repository access

The same GitHub App settings also govern authenticated fetch, pull, and push.

GitHub login through Access establishes identity only. Repository permission is
a separate GitHub App boundary verified and stored per principal by
[`apps/runner/src/github-binding-service.ts`](../apps/runner/src/github-binding-service.ts).
In `owner-bearer` mode the App configuration includes the fixed installation
ID. In `cloudflare-access` mode it instead includes the App slug and each
principal completes a bounded, single-use installation ceremony; no global
installation is required. The configuration schema rejects partial or
mode-incompatible combinations.

Prefer the file form. Production Compose mounts the root-owned
`/etc/cloud-harness-mcp` directory read-only at `/run/cloud-harness-secrets`
in the runner, so the maintained key path is
`/run/cloud-harness-secrets/github-app-private-key.pem`. The API explicitly
clears all GitHub App variables inherited from the common environment file.
These credentials belong to the trusted runner only. They are used to mint
short-lived repository-scoped tokens for clone, fetch, pull, and push and must
never be added to the executor environment. Public clone/fetch/pull do not need
an App token. A private repository needs Contents read permission for
clone/fetch/pull; push always requires a configured installation with Contents
read and write permission.

Private repository access is optional. Do not report it as live-verified until
an owner has supplied valid credentials and completed a sanitized clone and
transfer leak check. The broker and transfer boundary are described in
[`mcp-api.md`](mcp-api.md#repository-opening-policy). Follow the
[GitHub App setup guide](github-app-private-repositories.md) to create the App,
grant least-privilege repository access, install the key, and verify the
integration.

## Local multi-workspace registry

`--workspace-config` reads an operator-owned, versioned YAML or JSON file that
names each local root, optional per-root Git network/push overrides of the CLI
flags, and optional local HTTP bind settings. It is parsed strictly (unknown
fields, duplicate keys, and aliases are errors) and every root is validated at
startup, because a typo must stop the server rather than silently expose or
drop a directory. Registration is file-only by design: no tool can change the
set of roots. Local HTTP mode reads its bearer token from `MCP_BEARER_TOKEN` or
`MCP_BEARER_TOKEN_FILE`, like the remote API, but uses none of the Compose or
runner settings in this document.

The schema and defaults are owned by
[`apps/api/src/local/local-workspace-registry.ts`](../apps/api/src/local/local-workspace-registry.ts);
the token rule by
[`apps/api/src/local/local-http-server.ts`](../apps/api/src/local/local-http-server.ts);
flag parsing by [`apps/api/src/cli-options.ts`](../apps/api/src/cli-options.ts).
An example file is in the
[user guide](../docs-site/connect.md#several-local-workspaces-from-one-server).

## Decision Plane

| Variable | Default | Decision |
|---|---|---|
| `DECISION_PLANE_PURPOSES` | empty (off) | Runner flag. A comma-separated subset of `mcp-routing`, `failure-classification` and `execution-risk`. A listed purpose is evaluated only for owners who stored a TypeSafe integration key. Any other value fails startup. |
| `TYPESAFE_EGRESS` | `on` | Runner flag. `off` stops every TypeSafe call, both skill suggestions and the Decision Plane, even for owners with a stored key. `typesafe_status` then reports `enabled: false`. |

`mcp-routing` reranks MCP gateway `search` results. `failure-classification`
adds an advisory `data.diagnosis` to GitHub actions that end in the generic
`GITHUB_ACTION_FAILED`. Both fall back to the deterministic result on any error.
`execution-risk` lets the agent policy gate ask Jev about an action whose effect
is `advisor_or_approval`. It also needs the owner to enable the advisor in the
global agent policy (see [Agent execution policies](security-model.md#agent-execution-policies));
its threshold, confidence floor and fallback live in that policy, not here. Any
failure falls back to approval, or to deny when the policy says so. The coding
broker (`AGENT_CODING_ENABLED`) consults the advisor when a coding run executes
an `advisor_or_approval` action that passed every deterministic check, so with
all three opt-ins each such action sends TypeSafe one redacted, runner-computed
summary. Its fields are listed under
[what leaves the runner](security-model.md#decision-plane) and built by
[`apps/runner/src/decision-plane/execution-risk-advisor.ts`](../apps/runner/src/decision-plane/execution-risk-advisor.ts);
paths, arguments, branch and repository names, and agent or issue text are not
sent, and the command digest is an unsalted truncated SHA-256, so a guessed
low-entropy command can be confirmed against it.
Before rolling back to a release that predates `execution-risk`, remove it from
`DECISION_PLANE_PURPOSES`: older runners reject the value and fail startup.
The purpose list is owned by
[`packages/contracts/src/decision-plane.ts`](../packages/contracts/src/decision-plane.ts),
the call bounds by
[`apps/runner/src/decision-plane/decision-plane.ts`](../apps/runner/src/decision-plane/decision-plane.ts),
and the rationale by [ADR 0004](adr/0004-decision-plane.md). Live counters are
at `GET /api/v1/decision-plane/status`.

## Agent runtime limits and retention

Subagents (`agent_spawn` and the other `agent_*` tools) are configured on the
runner. Compose sets `AGENT_IMAGE`, `AGENT_GATEWAY_URL` and `AGENT_PROFILES_FILE`
for it, with the profile file mounted from `AGENT_PROFILES_HOST_FILE`. Outside
Compose, setting any variable in this section turns the agent configuration on,
so the image, the gateway URL and exactly one of `AGENT_PROFILES_JSON` or
`AGENT_PROFILES_FILE` must be set too, or the runner refuses to start.

| Variable | Default | Decision |
|---|---|---|
| `AGENT_GLOBAL_ACTIVE`, `AGENT_PRINCIPAL_ACTIVE`, `AGENT_WORKSPACE_ACTIVE`, `AGENT_PARENT_ACTIVE` | see schema | Active agents at once per scope. Must satisfy parent ≤ workspace ≤ principal ≤ global. |
| `AGENT_WORKSPACE_LIFETIME_RECORDS` | see schema | Spawn and message records one workspace may create over its life. Idempotency records are never evicted to admit new work, so a full workspace refuses further spawns and messages with `LIMIT_EXCEEDED`. |
| `AGENT_MIN_TTL_SECONDS`, `AGENT_MAX_TTL_SECONDS` | see schema | Range of TTLs a spawn may request; the minimum cannot exceed the maximum. |
| `AGENT_MAX_PROMPT_BYTES`, `AGENT_MAX_MESSAGE_BYTES`, `AGENT_MAX_OUTPUT_BYTES` | see schema | Largest prompt, message body and per-agent output budget a request may carry. |
| `AGENT_MAX_LOG_BYTES`, `AGENT_MAX_LOG_EVENTS`, `AGENT_MAX_LOG_EVENT_BYTES` | see schema | Log kept per agent; the oldest events are dropped first, and an `agent_logs` cursor older than the retained base reports `truncated`. |
| `AGENT_GLOBAL_RETAINED_ROWS`, `AGENT_PRINCIPAL_RETAINED_ROWS`, `AGENT_WORKSPACE_RETAINED_ROWS` | see schema | Rows kept per scope. Agent records plus compacted tombstones count toward spawn admission, and log events toward the log cap. Must satisfy workspace ≤ principal ≤ global. |
| `AGENT_GLOBAL_RETAINED_BYTES`, `AGENT_PRINCIPAL_RETAINED_BYTES`, `AGENT_WORKSPACE_RETAINED_BYTES` | see schema | Log bytes kept per scope; a full scope trims the oldest log of the agent being written. Must satisfy workspace ≤ principal ≤ global. |
| `AGENT_CANCELLATION_GRACE_MS` | see schema | Grace between TERM and KILL when an agent container is stopped. |
| `AGENT_CLEANUP_RETRY_LIMIT`, `AGENT_CLEANUP_RETRY_MAX_DELAY_MS` | see schema | Attempts with exponential backoff, and the longest backoff, for a failed agent container cleanup. After the limit, cleanup keeps retrying every `AGENT_CLEANUP_RETRY_MAX_DELAY_MS`. An agent stays `CANCELLING` until its cleanup succeeds. |
| `AGENT_RETENTION_SECONDS` | 7 days | How long a closed workspace keeps full agent records (logs, messages, usage) after its last agent ended. Then the runner compacts them to tombstones. Cannot exceed `AGENT_LOOKUP_HORIZON_SECONDS`. |
| `AGENT_LOOKUP_HORIZON_SECONDS` | 30 days | How long after an agent ended its tombstone still answers `agent_status` with `compacted: true`. Then the tombstone is purged. The expiry is stored when the tombstone is written, so a new value applies only to workspaces compacted afterwards. |

Code defaults and ranges are owned by `RunnerAgentLimitsSchema` in
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts); admission,
compaction and purge are owned by
[`apps/runner/src/agent-state-repository.ts`](../apps/runner/src/agent-state-repository.ts).
The runner compacts and purges at startup and on every reaper pass. Compaction
needs a closed workspace with no nonterminal agent, so open workspaces and agents
still `CANCELLING` are never compacted; the purge needs only a closed workspace.
Compaction and the tombstone purge are the only paths that delete agent rows. A
rollback or schema downgrade that needs agent state gone has to wait for these
horizons. A shorter `AGENT_RETENTION_SECONDS` and a runner restart compact older
closed workspaces sooner, because retention is evaluated on each pass, but
tombstones already written keep the expiry they were written with.

## Agent traces

| Variable | Default | Decision |
|---|---|---|
| `AGENT_TRACES_ENABLED` | off | Runner only. Records one durable trace per coding-agent run and enables the four `agent_trace*` tools and the Dashboard Traces page. Off, the tools answer `FEATURE_DISABLED` and the page stays hidden. |
| `AGENT_TRACE_RETENTION_DAYS` | see schema | How long a finished trace is kept, counted from its latest span, before the hourly purge removes it. A trace whose automation workflow has not ended, for example one waiting for an approval, is kept and stays readable regardless. |
| `AGENT_TRACE_MAX_SPANS` | see schema | Spans kept per trace; later spans are dropped behind one truncation marker. |
| `AGENT_TRACE_MAX_PER_PRINCIPAL` | see schema | Traces kept per principal; the oldest finished traces are evicted first, never one whose automation workflow has not ended. |
| `AGENT_TRACE_PREVIEW_BYTES` | `0` | Bytes of redacted tool-input preview per tool span. `0` stores digests only; raise it only when a bounded, redacted preview is worth the extra stored data. |

Code defaults and ranges are owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts). Traces
live in the runner's state database; turning the flag off stops recording and
reading, while the hourly purge keeps removing traces past retention, so the
retention period holds with the flag off.
What a trace may contain is described in
[security model](security-model.md#agent-traces).

## Notifications

| Variable | Default | Decision |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | off | Runner only. Writes a notification to the owner's inbox on terminal automation runs and top-level agents and, with `AGENT_APPROVALS_ENABLED`, when a coding run starts waiting for an approval (`workflow.waiting_for_human`) and when that approval is decided or expires (`approval.decided`). Delivers it to the channels the owner's preferences allow (the `cloudharness.notification.created` MCP event and the GitHub comment mirror), and shows the Dashboard Inbox. Off, nothing is written or sent, the inbox list and preference routes answer `FEATURE_DISABLED`, and the Inbox entry stays hidden. |

Notifications live in the runner's state database. Turning the flag off is the
rollback: emission and delivery stop at once, while the retention purge keeps
removing old notifications. Retention, the per-principal cap, and the retry
schedule are owned by
[`apps/runner/src/notifications/`](../apps/runner/src/notifications/); the
behaviour is described in [MCP API](mcp-api.md#notification-inbox).

## Webhook automations

| Variable | Default | Decision |
|---|---|---|
| `AUTOMATIONS_ENABLED` | off | Read by both services. On the API it mounts the public webhook route for every provider and lets the `automation_*` MCP tools reach the runner (they stay listed and answer `UNAVAILABLE` while it is off); on the runner it admits deliveries, workflows, and Dashboard and MCP management. Set the same value for both. The shared environment file does this; a mismatch leaves the route answering `503` (API on, runner off) or absent (API off). |
| `AUTOMATIONS_MAX_CONCURRENT_WORKFLOWS` | see schema | Runner only. Instance-wide ceiling on automation workflows holding a workspace at once, above each rule's own `maxConcurrent`. Workflows over the ceiling wait queued and expire if they cannot start in time. |

The feature also needs the runner secret keyring, because connection secrets
and Linear or Jira outbound credentials are sealed with it. The GitHub App slug, when configured, is how the runner
recognizes and ignores the harness's own comments. Code defaults and ranges are
owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts);
per-rule limits, budgets, and retention by
[`packages/contracts/src/automations-api.ts`](../packages/contracts/src/automations-api.ts).
The public route needs the managed nginx location and, in Access mode, an
Access bypass for that path only; see
[deployment](deployment.md#webhook-automations-rollout).

## Agent policies

| Variable | Default | Decision |
|---|---|---|
| `AGENT_POLICIES_ENABLED` | off | Runner only. Turns on the owner's execution policies for coding agents: the Dashboard editor, simulation, history and rollback, and the policy store. While off, the runner answers `FEATURE_DISABLED` and the Dashboard shows how to enable it. |

The policy document shape, its bounds and the read-only default that applies
until the owner saves a global policy are owned by
[`packages/contracts/src/agent-policy-api.ts`](../packages/contracts/src/agent-policy-api.ts).
Precedence is owned by
[`apps/runner/src/agent-governance/gate-evaluator.ts`](../apps/runner/src/agent-governance/gate-evaluator.ts),
and the rationale by [ADR 0006](adr/0006-policy-governed-coding-agents.md).
Policies are stored per owner in the runner state database, so they survive
restarts and are covered by its backups. The coding broker below enforces
them on every action a coding workflow takes.

## Coding automations

| Variable | Default | Decision |
|---|---|---|
| `AGENT_CODING_ENABLED` | off | Runner only. Lets an automation rule with a `coding` action edit, test, commit, push an `agent/` branch and open a pull request, each action decided by the execution policy. Needs `AGENT_POLICIES_ENABLED` and `AUTOMATIONS_ENABLED`; the runner refuses to start otherwise. It is also the kill switch: setting it back to off fails running coding workflows with `CODING_DISABLED` at their next step, before anything else is published. |
| `AGENT_CODING_PACKAGE_INSTALL_ENABLED` | off | Runner only. Lets a coding workflow install the checkout's npm lockfile once, before the agent starts, in a one-shot `dependency-access` container with lifecycle scripts off. Needs `AGENT_CODING_ENABLED`. Each locked package is still a `package_install` action the policy must allow; with the flag off, a lockfile is ignored and the agent works without installed dependencies. |
| `AGENT_APPROVALS_ENABLED` | off | Runner only. Lets a runner step of a coding workflow (verify, path checks, commit, push, opening the pull request) that the execution policy holds for approval pause the run as `WAITING_FOR_HUMAN` until the owner approves or denies it once on the Dashboard Approvals page. Off: such a step fails as `ACTION_DENIED:APPROVALS_DISABLED`, and the sweeper fails runs still waiting with `APPROVALS_DISABLED`. Agent tool calls are never paused; one that needs approval is refused as before. It has no effect while `AGENT_CODING_ENABLED` is off. |
| `AGENT_APPROVAL_TTL_MINUTES` | 60 | Runner only, 1 to 10080. The longest a run waits for a decision. The policy's `approval.ttlSeconds` and the workspace lease (renewed for the wait) can only shorten it; an undecided approval then expires and the run fails with `APPROVAL_EXPIRED`. |

Rule fields (`coding.projectId`, `verifyCommand`, `baseBranch`) and receipt
shapes are owned by
[`packages/contracts/src/coding-actions.ts`](../packages/contracts/src/coding-actions.ts);
the pipeline by
[`apps/runner/src/automation-coding.ts`](../apps/runner/src/automation-coding.ts);
and the rationale by [ADR 0006](adr/0006-policy-governed-coding-agents.md).
Approvals are owned by
[`packages/contracts/src/agent-approvals-api.ts`](../packages/contracts/src/agent-approvals-api.ts)
and [`apps/runner/src/agent-governance/approval-service.ts`](../apps/runner/src/agent-governance/approval-service.ts).

Rollback: set `AGENT_CODING_ENABLED=false` and restart the runner. Running
coding workflows fail with `CODING_DISABLED` and their workspaces close;
branches and pull requests already published stay on GitHub for the owner to
review or delete. Receipts in `coding_actions` stay readable on the run page
and are purged with their workflow. No table is dropped, so turning the flag on
again needs no migration. To stop only the pauses, set
`AGENT_APPROVALS_ENABLED=false`: waiting runs fail with `APPROVALS_DISABLED` on
the next sweep, their approvals expire, and later held steps fail instead of
waiting. Approval records stay readable until their workflow is purged.

## Compose and logging overrides

`CLOUD_HARNESS_ENV_FILE` selects the runtime environment file. `API_HOST_PORT`
changes the loopback host port. `HOST_JOBS_ROOT` and `HOST_STATE_ROOT` select
the host persistence paths. `LOG_LEVEL` is read by API and runner logging.

`API_HOST`/`RUNNER_HOST`, service ports, and the private `RUNNER_URL` are wired
by Compose. Avoid publishing the API or runner, or changing the ingress proxy from loopback
on an Internet-facing host.

`HOST_ARTIFACT_ROOT` selects the host persistence path for `ARTIFACT_ROOT`, in
the same way the existing job and state host overrides select their mounts.
Keep the artifact mount, state database, runtime configuration, GitHub App
key, optional Cloudflare Access API token, and secret keyring in the coherent
recovery set described in
[`operations.md`](operations.md#backup-and-restore).
