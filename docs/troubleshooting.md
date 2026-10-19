# Troubleshooting

Start with the smallest boundary that distinguishes the failure:

```bash
curl --fail http://127.0.0.1:3100/healthz
curl --fail http://127.0.0.1:3100/readyz
sudo systemctl status cloud-harness-mcp.service
sudo journalctl -u cloud-harness-mcp.service --since "30 minutes ago"
sudo nginx -t
sudo certbot certificates
```

Do not paste bearer tokens, private keys, environment dumps, private repository
URLs, or raw command content into tickets or shared logs.

## Connection and HTTP errors

| Symptom | Meaning and next check |
|---|---|
| TLS hostname/certificate error | Certbot has not issued/installed the dedicated hostname certificate, nginx is serving another site's default certificate, or DNS points elsewhere. Check `certbot certificates`, `nginx -T`, DNS, and the [TLS install step](deployment.md#obtain-https-with-the-existing-nginx). Do not disable certificate verification. |
| `401` with `WWW-Authenticate: Bearer` in owner-bearer mode | The MCP bearer is missing or differs from `MCP_BEARER_TOKEN`. Check that the client names an exported local variable, then restart it after changing the value. |
| MCP `401` in Access mode | The public request did not arrive with a valid Access assertion for the configured issuer/audience, or the Access OAuth credential is expired/revoked. Check the Access application, policy, discovery flow, and sanitized edge logs; do not add an origin bearer bypass. |
| OAuth DCR error: `redirect_uri is not allowed by the account configuration` | Claude Desktop, Codex App, ChatGPT Web, or another OAuth MCP client failed during Dynamic Client Registration. Cloudflare Access Managed OAuth requires whitelisting allowed callback URLs in the Access Application. In Cloudflare Zero Trust, edit the application for the MCP hostname, go to **Advanced settings → Managed OAuth → Allowed redirect URIs**, and add the target client callback URLs: for Claude Desktop, add `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`; for Codex App and loopback clients, pin `mcp_oauth_callback_port = 3118` in `~/.codex/config.toml` and add `http://127.0.0.1:3118/callback/*`, `http://127.0.0.1:3118/*`, `http://localhost:3118/callback/*`, and `http://localhost:3118/*`; for ChatGPT Web, add `https://chatgpt.com/connector/oauth/*`, `https://chatgpt.com/connector_platform_oauth_redirect`, and `https://chatgpt.com/api/aip/p/oauth/callback`. |
| Frequent MCP sign-out or re-authentication prompts in AI tools | Managed OAuth clients (`https://harness.zuey.me/mcp`) sign in again when their OAuth grant expires. Lengthen the grant in **Dashboard → Settings → MCP OAuth sessions** (or, without the [Cloudflare API integration](configuration.md#managed-oauth-session-settings), under **Advanced settings → Managed OAuth** in Cloudflare Zero Trust); keep the access-token lifetime short, because a longer token does not reduce sign-ins. Static-header clients (Claude Code, Cursor, Codex, etc.) can use the API-key gateway `https://api.harness.zuey.me/mcp` with a key from `/dashboard/api-keys` instead. |
| Client cannot connect with static token or header | The client is configured with a static Bearer token/env var but pointed to the OAuth endpoint `https://harness.zuey.me/mcp`. Static-header clients must point to the dedicated API key gateway `https://api.harness.zuey.me/mcp` and use a managed API key generated from `/dashboard/api-keys`. |
| API-key gateway returns JSON `401 authentication_failed` | The Worker reached the origin, but the path-scoped Access assertion did not match the configured audience/subject or the managed key was malformed, unknown, expired, or revoked. Check the distinct Access application, exact pinned service subject, feature configuration, and dashboard metadata without printing the key. All invalid key classes intentionally share this response. |
| API-key client receives `text/html` or an Access login page | The client is using the OAuth hostname/path, Cloudflare selected an interactive policy for `/mcp-api-key`, or the Worker is not bound to the requested hostname. Static clients must use `https://api.harness.zuey.me/mcp`; the hidden path must have a separate Service Auth-only Access application. Do not add browser cookies, bypass Access, or point the client at the hidden route. |
| API-key gateway returns JSON `400`, `404`, or `405` | The request has an invalid/missing Bearer header, query string, path, method, or oversized/ambiguous forwarded header. Use exact `/mcp` or `/mcp-gateway` with Streamable HTTP `GET`, `POST`, or `DELETE`; do not forward Cloudflare or proxy headers from the client. |
| API-key gateway returns JSON `502` or `503` | `502` means the fixed upstream failed or redirected; `503` means Worker service-token secrets are unavailable. Check the Worker deployment, exact origin route, Access application, and secret bindings without logging their values. OAuth/dashboard availability is independent. |
| Dashboard login loop or `session_ended` | `/dashboard` did not receive a current Access assertion, or its short-lived CSRF session was lost. Re-authenticate at Access and reload the dashboard; never copy the assertion into browser storage. A diagnostic page naming a reason code instead means the origin rejected the assertion itself — see the row below. |
| Dashboard renders a diagnostic page or JSON `{"error":"authentication_failed"}` | The request reached the origin without a valid Cloudflare Access assertion. Browser navigations now render `apps/api/src/access-diagnostic.ts`, which names the reason; the API logs the same code as `access assertion rejected` with method, path, and host, and never logs the assertion. `missing_assertion`, `wrong_audience`, and `jwks_unavailable` cover most incidents — read the code, then match it to its cause: the Access application must cover that exact hostname and path with the application audience in `CLOUDFLARE_ACCESS_AUDIENCE`, the browser must resolve the Cloudflare-proxied hostname (pointing it at the origin address bypasses Access entirely), and the API container must reach `CLOUDFLARE_ACCESS_JWKS_URL`. |
| `cloud-harness-mcp.service` fails to start with `cloud-harness-service-compose: No such file or directory` | The installed unit expects the lifecycle wrapper, but the on-host deploy script that installed it predates the wrapper. The current unit falls back to the release's own `deploy/scripts/service-compose.sh`; for an older unit, install the wrapper from the checkout (`sudo install -m 0755 deploy/scripts/service-compose.sh /usr/local/sbin/cloud-harness-service-compose`), then `sudo systemctl daemon-reload` and `sudo systemctl start cloud-harness-mcp.service`. |
| `403 forbidden_host` | The request hostname is absent from `API_PUBLIC_HOSTS`, or nginx did not preserve `Host`. Compare the public hostname with the nginx proxy and runtime environment. |
| `403 forbidden_origin` | A supplied `Origin` is absent from `API_ALLOWED_ORIGINS`. Add only the exact trusted origin; CLI clients normally omit this header. |
| `403 origin_required` or CSRF rejection on dashboard mutation | The browser request was not same-origin or did not use the current dashboard session token. Fix the trusted origin/session flow; do not relax the mutation check. |
| `415 unsupported_media_type` | An MCP POST was not JSON. Use an MCP Streamable HTTP client. |
| Workspace-bound `/mcp/workspaces/<workspaceId>` returns an nginx HTML `404` while `/mcp` works | The host's nginx site predates the managed `^~ /mcp/workspaces/` prefix route. Run `sudo /usr/local/sbin/cloud-harness-upgrade-nginx` (Access-mode release deploys run it; owner-bearer deploys do not). A `404` that reaches the API instead means the path is wrong: JSON `not_found` for a segment that is not a well-formed workspace ID, or no route for extra path segments after it. The static API-key lane forwards only exact `/mcp` and `/mcp-gateway`, so it cannot reach this endpoint. |
| `https://api.harness.zuey.me/mcp-gateway` returns an nginx HTML `404` while `https://api.harness.zuey.me/mcp` works | The Worker forwards to the hidden origin route `/mcp-api-key/gateway`, but the host's nginx site predates that exact location (or the Worker was redeployed before the origin release). Run `sudo /usr/local/sbin/cloud-harness-upgrade-nginx` and confirm the origin release serves the route; the Access application needs no change. If `/mcp` on the same hostname also fails, the lane itself is disabled or misrouted; use the API-key rows above. |
| `cloud-harness-upgrade-nginx` exits `10` | The selected server block already proxies something to `127.0.0.1:3100/mcp-api-key/` that is not the managed `/mcp-api-key/gateway` block, so the command refused to change the site. Reconcile it with `deploy/nginx/cloud-harness-mcp.conf` by hand and rerun; see [deployment](deployment.md). |
| `cloud-harness-upgrade-nginx` exits `11` | The selected server block already has a location mentioning `/dashboard/mcp-oauth` that is not the managed callback block (which sets `access_log off`), so the command refused to change the site. Reconcile it with `deploy/nginx/cloud-harness-mcp.conf` by hand and rerun; see [deployment](deployment.md). |
| `cloud-harness-upgrade-nginx` exits `9` | The selected server block already has a location or `proxy_pass` under `/mcp/` that is not the managed workspace-bound block, so the command refused to change the site. Reconcile that block with `deploy/nginx/cloud-harness-mcp.conf` by hand and rerun; see [deployment](deployment.md). |
| Dashboard skill ZIP upload returns `413` for an archive below 8 MiB | The application accepts skill archives up to 8 MiB, but an older managed nginx dashboard route can still inherit the server's 1 MiB request cap. Run the current `deploy/scripts/upgrade-nginx-dashboard.sh` (or the normal release deployment, which runs it) so `/dashboard/` gets `client_max_body_size 8m`; archives above 8 MiB remain intentionally rejected by the API and runner. |
| Dashboard skill ZIP upload is rejected with `INVALID_INPUT` | The archive broke a reader bound in `apps/runner/src/skill-archive.ts`: 8 MiB archive, 200 `SKILL.md` documents, 20,000 files in total, and 64 Ki characters per `SKILL.md`. Only `SKILL.md` documents are imported; bundled assets are ignored and never expanded. Split a larger library into several archives. |
| `429 rate_limited` | The process-local request window or active-request bound was exceeded. Wait for `Retry-After`; investigate stuck/parallel clients before restarting. |
| Public `/healthz` works but `/readyz` is 503 | API is up but cannot reach the runner. Inspect the Compose runner health, internal network, and matching `RUNNER_TOKEN`. |
| Local stdio: `--workspace path is not a directory` or `must be absolute` | Stdio mode requires an existing directory and an absolute path format (e.g. `/home/user/project` or `/path/to/repo`). Check the `--workspace` parameter. |
| Local stdio: Windows platform notice | Local stdio v1 currently supports POSIX platforms (Linux and macOS) due to POSIX process-group semantics. On Windows, run the command within WSL (Windows Subsystem for Linux) or use Cloud Harness over Streamable HTTP. |
| Local stdio: `workspace_open is unsupported in local stdio mode` | In local stdio mode, the workspace is already selected and pre-opened at startup. Do not call `workspace_open`; proceed directly to file, search, exec, session, or Git tools using the active workspace ID. |
| Local stdio: `network Git operations are disabled` or `Git push operations are disabled` | In local mode, remote network fetch/pull and push are disabled by default. Pass `--git-network` to enable network fetch/pull, and `--git-push` to enable push. |
| Local `--workspace-config`: `failed to load --workspace-config` at startup | The file or a root failed validation: unknown field, duplicate key, alias, invalid name, wrong `version`, or a root that is missing, not a directory, or overlaps another root. Fix the named entry; the server never starts with a partial registry. |
| Local multi-workspace: `CONFLICT` ... `pass workspaceId explicitly` | More than one root is registered and the call named none. Call `workspace_list` and pass the `workspaceId`; over stdio, `workspace_set_active` can set a default. |
| Local multi-workspace: retryable `UNAVAILABLE` ... `root ... is unavailable`, or `rootAvailable: false` | The root disappeared or was replaced since startup (for example a dropped NFS mount). Restore the mount, then retry; do not repoint the path at another directory, which changes the root's identity. |
| Local HTTP: `local HTTP mode requires MCP_BEARER_TOKEN` | `--transport http --workspace-config` needs a 32-512 character, non-placeholder token in `MCP_BEARER_TOKEN` or `MCP_BEARER_TOKEN_FILE`. |

The request policy is owned by
[`apps/api/src/request-security.ts`](../apps/api/src/request-security.ts) and
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts). Worker error and header
behavior is owned by
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts).

### MCP OAuth sessions panel

The panel's **Last provider sync** shows a reason code when a read or save
fails; the operator message for each code is owned by `PROVIDER_ERRORS` in
[`apps/runner/src/cloudflare-access-oauth-provider.ts`](../apps/runner/src/cloudflare-access-oauth-provider.ts).
Do not paste the Cloudflare API token or provider responses into tickets.

| Reason or panel state | Next check |
|---|---|
| Panel says no provider integration is configured | The runner has no `CLOUDFLARE_ACCESS_*` integration; the grant is managed only in Cloudflare Zero Trust. Configure it per [configuration](configuration.md#managed-oauth-session-settings) if Dashboard control is wanted. |
| Runner fails to start after adding `CLOUDFLARE_ACCESS_*` | The integration is partial, malformed, or set in `owner-bearer` mode. Supply the token and both identifiers together in `cloudflare-access` mode. |
| `provider_unreachable` or `provider_invalid_response` | Nothing was changed. Check runner egress to `api.cloudflare.com` and Cloudflare status, then use **Reload from provider**. |
| `provider_permission_denied` or `provider_write_denied` | The token lacks **Access: Apps and Policies** Read or Write on that account. Replace the token file and restart the runner. |
| `provider_application_not_found` | `CLOUDFLARE_ACCESS_ACCOUNT_ID` or `CLOUDFLARE_ACCESS_APP_ID` does not name the `/mcp` application. |
| `provider_rejected` | Cloudflare refused the update; nothing was changed. If the duration is the cause, choose a shorter grant or lower `CLOUDFLARE_ACCESS_OAUTH_MAX_GRANT_SECONDS`; otherwise review the application in Cloudflare Zero Trust, because the update re-sends the whole application. |
| Panel is read-only: configured read-only | `CLOUDFLARE_ACCESS_OAUTH_ACCESS=read-only`. Switch to `read-write` with a Write token to save from the Dashboard. |
| `provider_unsupported_application` | The application uses SCIM provisioning or is not self-hosted, so Cloud Harness refuses to rewrite it. Change the grant in Cloudflare Zero Trust. |
| `managed_oauth_disabled` | Managed OAuth is off for the application. Turn it on in Cloudflare Zero Trust first. |
| `revision_conflict` | The OAuth configuration changed in Cloudflare after the page loaded. Reload and review before saving again. |
| `write_unconfirmed` | The update timed out or Cloudflare answered with a server error, so it may or may not have landed. Reload before retrying. |
| `readback_mismatch` | Cloudflare accepted the update but did not confirm the values; the change may or may not be in effect. Reload to see the effective values before retrying. |
| Management shows **Set outside Cloud Harness** or **Changed outside Cloud Harness** | The grant was customised in Cloudflare, or changed after the last Dashboard save (including after a release rollback). The runner never overwrites it; choose **Adopt** or save a value to manage it. |

## Downstream MCP OAuth

These rows cover the gateway authenticating *to* an OAuth-protected downstream
MCP server. Inbound Managed OAuth problems are in the table above.

| Symptom | Meaning and next check |
|---|---|
| OAuth panel reads **Not configured** with no Connect, or Connect returns `503 unavailable` | `MCP_DOWNSTREAM_OAUTH_REDIRECT_URL` is unset on the API. Set it as described in [deployment](deployment.md#downstream-mcp-oauth-redirect). A grant connected before it was unset keeps working and can still be disconnected. |
| A Reconnect failed but the panel still reads **Connected** with a warning | Expected: a failed or declined interactive attempt keeps the working grant and records the cause as `lastError`, which clears on the next successful Connect or refresh. |
| Test or Refresh returns `409` / a gateway call returns `AUTHORIZATION_REQUIRED` | The server has OAuth configured but no usable grant for this principal: never connected, disconnected, discarded after an endpoint or client change, or the refresh was rejected. Use Connect or Reauthorize on the server's Overview tab. Background calls intentionally never start an authorization. |
| Callback returns to the server page with `oauth=error&reason=invalid_state` or `expired` | The one-time flow was already used, superseded by a newer Connect, started by another principal, or older than its short lifetime. Start Connect again from the same browser session. |
| `reason=denied` | The user or the authorization server declined the request. Check the requested scopes and the account used at the provider. |
| `reason=issuer_mismatch` | The authorization response named a different issuer from the one discovered at Connect. Treat this as a possible mix-up attack; verify the server's protected-resource metadata before retrying. |
| `reason=exchange_failed` | The code exchange failed; the sanitized cause is stored as the OAuth status `lastError`. Common causes are a redirect URL the provider does not accept, a manual client ID or secret the provider rejects, or a token endpoint refused by the gateway URL policy or redirect refusal. |
| Connect fails before the browser opens | Discovery or registration failed. The provider may support neither Client ID Metadata Documents nor dynamic registration (enter a manually registered client ID), the OAuth metadata may point at an address the gateway URL policy refuses, or an OAuth endpoint answered with a redirect, which is refused. |
| Saving a server fails with an `Authorization` header or `sse` message | OAuth owns the `Authorization` header and is `streamable-http` only. Remove the custom header or keep the static-header configuration without OAuth. |

The flow, status, and reasons are owned by
[`apps/api/src/mcp-gateway/oauth-flow.ts`](../apps/api/src/mcp-gateway/oauth-flow.ts)
and [`apps/api/src/dashboard-gateway-router.ts`](../apps/api/src/dashboard-gateway-router.ts).
Never paste tokens, authorization codes, or callback URLs carrying `code` or
`state` into tickets.

## Workspace opening

- `LIMIT_EXCEEDED` with `active workspace limit reached: N active of a maximum M`
  means the principal already holds `M` counted workspaces (`CREATING`, `ACTIVE`,
  `NETWORK_QUARANTINED`). Call `workspace_list` to see them and `workspace_close`
  to free a slot, or raise the quota in Dashboard → Settings → **Workspace
  limits & lifecycle** (or `MAX_ACTIVE_WORKSPACES_PER_OWNER` on the runner when
  no override is set). Lowering the limit never reaps an existing workspace; it
  only blocks new admission. A record in `REAPING` is in flight to teardown and holds no slot, so it
  never appears in this count.
- A workspace whose lease is `ACTIVE` also frees its slot when its idle or wall TTL
  expires. A `NETWORK_QUARANTINED` record does not expire, so close it explicitly.
  A `REAPING` record is already being torn down, so `workspace_close` retries the
  removal and is the supported remedy; only the fenced dashboard close refuses a
  `REAPING` record with `409 CONFLICT`.
- A free-space reserve error means `/var/lib/cloud-harness` is below
  `MIN_FREE_BYTES`. Inspect disk use before deleting anything. The configured
  workspace size is a periodically checked soft ceiling, not a hard quota.
- URL rejection means the repository is not credential-free HTTPS, is not on
  `ALLOWED_GIT_HOSTS`, contains userinfo/a disallowed port, or resolves to a
  forbidden address.
- Public clone failure can be DNS, upstream availability, an invalid ref, or
  the fixed clone timeout/limits.
- Private clone failure requires all GitHub App settings, installation access
  to the repository, and a valid PEM key. The optional path is not considered
  live-verified merely because configuration loads.
- In Access mode, GitHub login is not repository authorization. If the
  dashboard shows no grant, complete the principal-bound GitHub App setup. If
  reconcile reports removal or suspension, correct the installation at GitHub
  and reconcile again; do not substitute another principal's installation.

Replay the same `workspace_open` idempotency key or call `workspace_list` after
a lost response; do not create a second key until the first result is resolved.

## Tool behavior

- In a multi-repository workspace, `INVALID_INPUT` naming `needs repositoryId`
  is a Git-bound tool called without a selector, and `FORBIDDEN` with
  `error.repository` and `is read-only` is a brokered write to a repository
  opened `read-only`; access is fixed at open. A repository-count
  `LIMIT_EXCEEDED` on `workspace_open` is `MAX_WORKSPACE_REPOSITORIES`. The
  selector rules are in
  [MCP usage](mcp-api.md#multi-repository-workspaces); the user-facing steps
  are in [`docs-site/troubleshooting.md`](../docs-site/troubleshooting.md).
- An agent's model request fails with `400 invalid_model_request` naming a
  field or tool type: the Model Gateway refuses requests it cannot bound or
  that would let the provider act on the agent's behalf. These are stored
  Responses context (`previous_response_id`, `conversation`, an object-valued
  `prompt`), any tool type other than `function` and `custom`, the fields
  `plugins` and `web_search_options`, and media parts (image, audio, video,
  file) with a `file_id` or a URL that is not a `data:` URL. Hosted tools and
  remote media would give an agent in a `network-none` workspace network or
  remote MCP access through the provider. The runtime must resend the full
  input, run tools itself, and send media inline as a `data:` URL or base64;
  see the
  [security model](security-model.md#subagent-model-provider-credential-isolation--gateway-control) and
  [`apps/model-gateway/src/budget.ts`](../apps/model-gateway/src/budget.ts).
- `agent_spawn` fails with `LIMIT_EXCEEDED` and `model spend policy (...)
  would be exceeded`: the owner's daily or monthly spend policy, for the
  principal or the model profile, cannot fit this run's whole `maxCostMicros`
  on top of the estimated spend already committed in that UTC window. Open
  runs count at their full cap until their lease settles, and a lease lost to
  a gateway restart counts at its cap as `unreconciled`. Nothing was created,
  so lower `maxCostMicros` or wait for running agents to end, then retry; the
  owner can also raise or remove the policy through the dashboard spend routes
  (see [Spend policies](../docs-site/dashboard/models.md#spend-policies)). A `model spend threshold reached`
  runner log line marks the first time a window reaches the policy's warning
  percentage. All of these figures are estimates: a run counts entirely in
  the window it was admitted in, so spend near a window boundary can exceed
  one window's limit. "Not retryable" means an unchanged retry right away
  fails the same way. The per-run cap is enforced by the gateway as before. The rules are in
  [`apps/runner/src/model-spend-ledger.ts`](../apps/runner/src/model-spend-ledger.ts).
- `files_apply_patch` conflict: read the file again, choose an exact unique
  `oldText`, and pass the latest SHA when concurrency matters. It is not a
  unified diff.
- `EXPIRED` or a closed workspace: open a new workspace. The old job directory
  is intentionally removed.
- Missing shell/session handle after a runner restart: interactive shell and
  session streams are in memory and cannot be reconnected. Background task
  metadata and output logs persist across restarts and can be inspected via
  `tasks_status` or `tasks_list`.
- Dashboard Terminal shows "no longer available" (the runner answered
  `NOT_FOUND`): the runner restarted, or the terminal was closed, timed out, or
  pruned after ending. Terminals are never resumed; open a new session. See
  [operations](operations.md#dashboard-terminals). If it says the terminal
  ended with its workspace (the runner answered `410`), the workspace was
  closed or expired; renew or recover it, then open a new session.
- Dashboard Terminal echo lags by one key (for example `g` appears only after
  the next key): the typed text matches the start of an injected secret value,
  and the redactor holds it until the next bytes rule a secret out. This is
  intended; see [ADR 0003](adr/0003-terminal-bash-and-managed-toolbox.md).
- Opening a Dashboard Terminal returns `429` with "too many open terminals":
  the workspace already holds the configured number of live terminals. Close
  one from the workspace tab or `/dashboard/terminals`, or raise the limit
  described in [configuration](configuration.md#dashboard-terminal). A `429`
  while typing means input is arriving faster than the PTY drains; the
  dashboard retries in order, then reports dropped keystrokes rather than
  queueing them without bound.
- Opening a Dashboard Terminal returns `503` while other workspace actions
  work: check that the workspace executor is running, and that the runner's
  `DOCKER_HOST` is unset or a `unix://` path. Terminals use the Docker Engine
  API over a unix socket and are unavailable with any other Docker host.
- `workspace_open` fails with `DEPENDENCY_EGRESS_UNAVAILABLE` (HTTP 503): the
  effective profile is `dependency-access` — the shipped default — but the Linux
  host firewall is missing or drifted. Provision it with
  `deploy/scripts/setup-dependency-firewall.sh`, confirm egress readiness from
  the dashboard Settings page, then open with a fresh idempotency key: the failed
  open recorded its key with a `FAILED` status, and replaying that key returns the
  failed record without retrying. The open fails closed by design and is never
  silently downgraded to `network-none`. To keep working without egress in the
  meantime, select `network-none` and Save on the Settings page, or open with
  `networkProfile: "network-none"`; the Reset action only clears the instance
  setting, so it returns a host with the egress default to `dependency-access`.
- A dependency download, arbitrary network command, or networked deployment
  fails with a network error: the workspace is on `network-none`. Open a new
  workspace on `dependency-access` — or select `dependency-access` and Save as the
  instance default in Settings — if public egress is necessary, and accept the
  weaker boundary (public DNS and TCP 80/443 only). Remote Git fetch/pull/push use
  runner-owned helpers and do not require executor egress.
- `github_action` returns `GITHUB_PERMISSION_MISSING` following GitHub's `403
  Resource not accessible by integration`: no configured credential can perform
  the action. The error names the missing scope. Add that permission to the
  GitHub App and approve the pending installation change on GitHub (the App's own
  table in [GitHub App setup](github-app-private-repositories.md) lists which
  operations need which permission), or configure the fallback credential for the
  requesting principal: the runner-environment `GH_TOKEN`/`GITHUB_TOKEN` in
  `owner-bearer` mode, or that principal's global runtime secret in
  `cloudflare-access` mode, where the operator-wide environment token is refused.
  An action-scoped token also carries `contents: read`, so **Contents:
  Read-only** is required for `github_action` even when the App grants the named
  action scope; when the installation lacks Contents read the mint fails before
  `gh` runs and the reported scope cannot distinguish the two causes.
  The two boundaries differ: the runner-environment credential is harness-side
  only and never enters an executor, while the principal's global runtime secret
  is injected into that principal's workspaces and therefore also authenticates
  the workspace `gh` CLI. A
  `403` from the helper is never retried, because the operation may already have
  had side effects.
- Private fetch/pull failure: verify GitHub App installation access and Contents
  read permission. Push additionally requires Contents read and write
  permission; only `origin`, branch refspecs, and optional force-with-lease are
  accepted. The executor intentionally has no credential to inspect or repair.
- A dependent task remains `queued` while prerequisites are unfinished and
  becomes `blocked` if one fails or is cancelled. Inspect the task graph rather
  than rerunning it with a new idempotency key.
- A repository-defined deployment is missing or cannot authenticate: inspect
  `.cloud-harness/deployments.json`, executor network profile, and the repository's
  own setup. The harness does not inject deployment secrets.
- A command times out earlier than Codex's tool timeout: compare
  `REQUEST_TIMEOUT_MS`, the tool's `timeoutMs`, and Codex
  `tool_timeout_sec`. Raising one does not raise the others.
- Truncated output: follow the returned cursor where the tool supports it or
  narrow the command/search/read. Do not assume omitted output succeeded.
- Secret controls report unavailable while other dashboard pages work: the
  runner could not load a complete decrypt keyring. Compare the configured key
  versions with the coherent backup without printing key material. Restore the
  matching keyring or complete the documented re-encryption/rotation process;
  never delete an old key merely to make readiness green.
- An artifact is absent after retention: retained snapshots are bounded and
  reaped independently of TTL workspace files. Inspect redacted audit metadata
  and the configured artifact root; a database row without its matching
  payload indicates an incoherent restore.

## MCP Events

The error mapping is owned by
[`apps/api/src/events/events-extension.ts`](../apps/api/src/events/events-extension.ts);
inspect delivery state with `GET /dashboard/api/v1/event-subscriptions`, which
shows each subscription's state, callback origin, last error category, and
recent deliveries.

| Symptom | Meaning and next check |
|---|---|
| `server/discover` has no `events` capability | The client is on local stdio, local HTTP, or `/mcp-gateway`, or the release predates events. Use the remote `/mcp` endpoint. |
| `-32602` on `events/subscribe` | The `delivery.url` is not a public `https` URL without credentials or fragment, the secret is not `whsec_` plus base64 of 24–64 bytes, or the filter arguments have an unknown key. |
| `-32011` / `-32012` / `-32013` / `-32014` | Unknown event name; unauthenticated request or a filter naming a workspace, task, or agent the caller does not own; per-principal active or retained subscription quota reached (revoked and expired rows count until retention purges them); a delivery mode other than `webhook`. |
| `-32015` with `reason` | The callback failed the signed verification challenge: it was unreachable, timed out, failed TLS, answered non-`2xx` or a redirect, or did not echo the exact `challenge`. Fix the receiver; nothing was stored. |
| `-32603` "Events are temporarily unavailable" | The runner is unreachable or has no secret keyring configured. Check `/readyz` and the runner keyring. |
| Subscription `REVOKED` without a dashboard action | It was created over a managed API key that was revoked or expired; the audit entry carries `reason: credential_revoked`. Subscribe again with a valid credential. |
| Deliveries `ABANDONED` | The receiver kept failing past the retry window, answered `410` or `413`, or the subscription lapsed or was revoked first. Events are not replayed; fix the receiver and wait for the next transition. |
| Duplicate deliveries at the receiver | Expected under at-least-once delivery. Deduplicate on `webhook-id`. |

## Webhook automations

The status mapping is owned by
[`apps/api/src/automations/webhook-ingress.ts`](../apps/api/src/automations/webhook-ingress.ts)
and the delivery and workflow outcomes by
[`apps/runner/src/automation-service.ts`](../apps/runner/src/automation-service.ts).
GitHub's webhook **Recent Deliveries** view shows each response; the Dashboard
Automations **Deliveries** and **Runs** views show what the runner did with it.

| Symptom | Meaning and next check |
|---|---|
| GitHub delivery gets `404` or an nginx page | `AUTOMATIONS_ENABLED` is off on the API, or the managed `/integrations/webhooks/` nginx location is missing. Rerun the nginx upgrade; exit status `12` means an unmanaged route under `/integrations/` must be reconciled by hand. |
| GitHub delivery gets an Access login page or `302` | Access is protecting the path. Add the path-scoped Bypass application for `/integrations/webhooks/` only ([deployment](deployment.md#webhook-automations-rollout)). |
| `401 {"error":"unauthorized"}` | Unknown, disabled, or deleted connection, or a signature mismatch; the body is identical on purpose. Check the URL's connection id and that GitHub holds the current secret. After **Rotate secret**, every delivery signed with the old secret fails until GitHub is updated. |
| `415` | The GitHub webhook content type is `application/x-www-form-urlencoded`. Change it to `application/json`. |
| `429` with `Retry-After` | The API's ingress window for this connection id or the connection's per-minute delivery rate is exhausted. GitHub does not retry automatically; redeliver from GitHub after the window. |
| `503 {"error":"unavailable"}` | The runner is unreachable, its `AUTOMATIONS_ENABLED` does not match the API's, or it has no secret keyring. Check `/readyz` and both services' environment. |
| `202` with `status: "ignored"` | Verified, but not an admitted event (for example `ping`, or an action other than `labeled`), or the body was malformed (listed as quarantined). Only label additions on issues and pull requests start runs. |
| `202` with `status: "duplicate"` | GitHub redelivered a `X-GitHub-Delivery` id already stored; nothing new runs. |
| Delivery processed but no run | The delivery outcome names why: no enabled rule for that repository and label, `self_trigger`, `bot_sender`, `actor_not_allowed`, `coalesced` (a run for that rule and issue or pull request is already active), or `cooldown`. Use the rule's **Test event** to check a sample. |
| Run `EXPIRED` or `CANCELLED` | It could not start within the queue window (instance or rule concurrency full, or workspace opens kept failing), or the rule was disabled or deleted while it waited. The transition code names the cause. |
| Run `FAILED` | The error code names the step: `WORKSPACE_OPEN_FAILED:*` (for example a private repository without GitHub App access), `AGENT_SPAWN_FAILED:*` (profile or budget), `AGENT_<status>` (the agent's own terminal status), or `WORKSPACE_LOST`. |
| Run shows **Publish failed** | The comment action kept failing after its retries or failed non-retryably (often a GitHub App without issue write access on that repository). The run state is unaffected and the answer is still on the run page. |

## Containers and cleanup

Inspect before acting:

```bash
sudo docker ps -a --filter label=cloud-harness.managed=true \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "cloud-harness.workspace"}}'
df -h /var/lib/cloud-harness
```

An `EXPIRED_RECOVERABLE` workspace that outlives its grace, with `error`
starting `auto-close deferred:`, is retained on purpose: the reaper found
running agents, uncommitted or untracked files, stashes, or unpushed commits,
or could not run the check. Earlier releases deleted it after an hour
regardless. Recover or export the work, then `workspace_close`; the Settings
panel counts these as retained by auto-close. See
[expired workspaces and auto-close](operations.md#expired-workspaces-and-auto-close).

An `EXPIRED_RECOVERABLE` workspace whose `error` starts `executor
reconciliation failed during startup:` lost its executor across a runner
restart: the retained container would not restart and a replacement could not
be built. Startup holds only that workspace, logs the runner warning
`workspace executor reconciliation failed during startup`, and finishes for the
rest. During the recoverable grace `workspace_recover` rebuilds the executor
once the cause in the message (for example a full disk or a missing executor
image) is fixed; after it, auto-close treats the workspace like any expired
one. A workspace whose checkout is already gone from disk is closed instead.
The same warning with a reason starting `leftover container` names a workspace
executor container Docker would not remove; startup skips it and retries at the
next start. A short-lived helper container that will not go away still stops
startup, because package cleanup must not run while one may be writing. Inspect it with the `docker ps` filter above before removing it by name.

Prefer `workspace_close`. If manual recovery is unavoidable, match the opaque
workspace ID in SQLite, the Docker label, and the exact job directory first.
Never remove the jobs root or unrelated Docker resources. Continue with the
[operations guide](operations.md#cleanup).

## Deployment failure

Read the service journal and deploy output without enabling shell tracing
around secrets. The deploy script automatically returns to the recorded prior
release and quiesced database/artifact state on failure when one exists. A
first-install failure disables the service. Configuration/key snapshots are
retained for coherent manual recovery.

After any failure, check the repository origin/commit, `nginx -t`, loopback
readiness, available disk, Docker image build, and the state schema error before
retrying. Use the [rollback runbook](operations.md#release-rollback) instead of
editing a detached production checkout by hand.
