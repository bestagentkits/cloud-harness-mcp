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
  and `/dashboard` at the Access edge. GitHub and Google are Access identity
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
  application scoped to exact `/mcp-api-key`;
- `API_KEY_GATEWAY_SERVICE_SUBJECT`, the normalized `cf-service:` subject
  observed from the dedicated Worker service token; and
- `API_KEY_GATEWAY_PUBLIC_URL`, the client-facing Worker URL, currently
  `https://api.harness.zuey.me/mcp`.

The gateway audience must differ from the main `/mcp` and `/dashboard`
application audience. Partial configuration and enabling this lane in
`owner-bearer` mode fail validation. The exact combinations and subject shape
are owned by
[`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts).

The Worker stores `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as
Cloudflare Worker secrets, never in the runtime environment, Wrangler
manifest, or repository. They belong only to the Service Auth policy of the
path-scoped gateway application. Its manifest also owns an aggregate
Cloudflare Rate Limiting binding for the exact gateway route: 600 requests per
60 seconds in each Cloudflare location. Limiter exhaustion returns JSON `429`;
a missing or failed binding returns JSON `503`. This eventual, edge-local cap
is defense in depth; the origin's per-credential limits remain authoritative.
The secret-free route and proxy contract are owned by
[`apps/api-key-gateway/wrangler.jsonc`](../apps/api-key-gateway/wrangler.jsonc)
and
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts).

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
must still be large enough for the intended operation.

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

`WORKSPACE_WALL_TTL_SECONDS`, `WORKSPACE_IDLE_TTL_SECONDS`, and
`REAPER_INTERVAL_SECONDS` define lifecycle timing. `MAX_OUTPUT_BYTES` bounds
runner/worker results. `MIN_FREE_BYTES` gates new workspace admission against a
host reserve.

`MAX_WORKSPACE_BYTES` is a soft ceiling checked after clone, around synchronous
operations, and by the runner reaper. It is not a filesystem quota and cannot
stop a fast-running process between checks. Operate with disk monitoring and a
host reserve; use quota-backed dedicated storage before treating this as an
untrusted service.

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
`TOOLKIT_CACHE_ROOT` configures the runner's content-addressed storage volume for pre-cached agent toolkits (`/var/lib/cloud-harness/cache/toolkits`), and `TOOLKIT_NETWORK_POLICY` (`cache-only` vs `runner-fetch`) controls whether uncached toolkits can be fetched dynamically at workspace open.

## Licensed AgentKit kits

The `agentkit` toolkit kind mounts licensed AgentKit kit skills (for example
`engineer`) into a workspace. It is the only toolkit kind that reads a paid,
registry-published artifact, so it needs three settings before it is available:

- `AGENTKIT_REGISTRY_URL` — registry origin, `https://agentkit.best` by default.
- `AGENTKIT_REGISTRY_CREDENTIAL_SECRET` — name of the principal's global secret
  holding the licence token (`AGENTKIT_REGISTRY_TOKEN` by default). The token is
  the operator's `ak_dev_`/`ak_cli_` registry credential; the runner never
  accepts one from a tool argument. A caller without that secret gets a
  fail-closed `INVALID_INPUT` naming the secret.
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

## Model gateway provider overrides

`MODEL_GATEWAY_SESSION_HEADER` names one optional upstream header that the model
gateway fills with the calling agent id, for OpenAI-compatible providers that
reject a request without a conversation identifier (for example
`x-opencode-session`, which OpenCode Go requires). It is unset by default, so no
header is invented for other providers. The gateway always identifies itself
through `user-agent: cloud-harness-model-gateway`. The accepted shape and the
reserved names the override may not collide with are owned by
[`apps/model-gateway/src/config.ts`](../apps/model-gateway/src/config.ts), and
production Compose forwards the setting into the gateway container. A profile
cannot carry extra upstream headers of its own, so this override is the only way
to serve such a provider.

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
key, and secret keyring in the coherent recovery set described in
[`operations.md`](operations.md#backup-and-restore).
