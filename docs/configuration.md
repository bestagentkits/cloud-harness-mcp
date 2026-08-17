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
schemes or private addresses. `WORKSPACE_NETWORK_MODE=none` is the safe
baseline. `bridge` enables ordinary container egress and should be an explicit
owner choice for a workspace that needs dependency downloads, arbitrary
networked commands, or networked repository-defined deployments. Runner-owned
remote Git helpers do not depend on executor network mode.

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
snapshots and must use runner-confined durable storage distinct from the
TTL-bound jobs root. Quotas and retention are validated by the configuration
schema and enforced by
[`apps/runner/src/artifact-store.ts`](../apps/runner/src/artifact-store.ts).
`EXECUTOR_IMAGE` is chosen by the trusted operator; callers cannot select an
image.

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
keyring, quiescing writes, and using the runner-only re-encryption entry point documented in the
[operations guide](operations.md#secret-key-rotation). Missing or invalid key
material disables secret-dependent operations without exposing key details;
non-secret dashboard reads remain available.

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
