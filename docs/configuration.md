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

`MCP_BEARER_TOKEN` authenticates the owner to `/mcp`; `RUNNER_TOKEN` is a
different secret used only from API to runner. Both accept a corresponding
`_FILE` variable and must meet the schema's length/placeholder checks.
`OWNER_ID` is the single ownership subject, not a multi-user account system.

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
owner choice for a workspace that needs dependency downloads or `git_fetch`.

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
SQLite metadata. `EXECUTOR_IMAGE` is chosen by the trusted operator; callers
cannot select an image.

## Optional private GitHub clone

All three settings are required together:

- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE`

Prefer the file form. Production Compose mounts the root-owned
`/etc/cloud-harness-mcp` directory read-only at `/run/cloud-harness-secrets`
in the runner, so the maintained key path is
`/run/cloud-harness-secrets/github-app-private-key.pem`. The API explicitly
clears all GitHub App variables inherited from the common environment file.
These credentials belong to the trusted runner only. They are used to mint a
short-lived repository-scoped token for initial clone and must never be added
to the executor environment.

Private cloning is optional. Do not report it as live-verified until an owner
has supplied valid credentials and completed a sanitized clone/leak check.

## Compose and logging overrides

`CLOUD_HARNESS_ENV_FILE` selects the runtime environment file. `API_HOST_PORT`
changes the loopback host port. `HOST_JOBS_ROOT` and `HOST_STATE_ROOT` select
the host persistence paths. `LOG_LEVEL` is read by API and runner logging.

`API_HOST`/`RUNNER_HOST`, service ports, and the private `RUNNER_URL` are wired
by Compose. Avoid publishing the runner or changing the API bind from loopback
on an Internet-facing host.
