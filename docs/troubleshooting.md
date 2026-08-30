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
| Frequent MCP sign-out or re-authentication prompts in AI tools | AI clients connecting via Managed OAuth (`https://harness.zuey.me/mcp`) require interactive browser re-authentication when their OAuth grant expires. In Cloudflare Zero Trust, edit the MCP application → **Advanced settings → Managed OAuth → Grant session duration** and set it to the desired continuity window (e.g. 1–2 weeks or 1 month); do not lengthen the short access-token lifetime. For AI coding clients (Claude Code, Cursor, Codex, etc.) that support static headers, switch to the dedicated API-key gateway `https://api.harness.zuey.me/mcp` with an API key generated from `/dashboard/api-keys` (valid for 1–3,650 days, approximately 10 years) for zero interactive re-authentication during normal operation. |
| Client cannot connect with static token or header | The client is configured with a static Bearer token/env var but pointed to the OAuth endpoint `https://harness.zuey.me/mcp`. Static-header clients must point to the dedicated API key gateway `https://api.harness.zuey.me/mcp` and use a managed API key generated from `/dashboard/api-keys`. |
| API-key gateway returns JSON `401 authentication_failed` | The Worker reached the origin, but the path-scoped Access assertion did not match the configured audience/subject or the managed key was malformed, unknown, expired, or revoked. Check the distinct Access application, exact pinned service subject, feature configuration, and dashboard metadata without printing the key. All invalid key classes intentionally share this response. |
| API-key client receives `text/html` or an Access login page | The client is using the OAuth hostname/path, Cloudflare selected an interactive policy for `/mcp-api-key`, or the Worker is not bound to the requested hostname. Static clients must use `https://api.harness.zuey.me/mcp`; the hidden path must have a separate Service Auth-only Access application. Do not add browser cookies, bypass Access, or point the client at the hidden route. |
| API-key gateway returns JSON `400`, `404`, or `405` | The request has an invalid/missing Bearer header, query string, path, method, or oversized/ambiguous forwarded header. Use exact `/mcp` with Streamable HTTP `GET`, `POST`, or `DELETE`; do not forward Cloudflare or proxy headers from the client. |
| API-key gateway returns JSON `502` or `503` | `502` means the fixed upstream failed or redirected; `503` means Worker service-token secrets are unavailable. Check the Worker deployment, exact origin route, Access application, and secret bindings without logging their values. OAuth/dashboard availability is independent. |
| Dashboard login loop or `session_ended` | `/dashboard` did not receive a current Access assertion, or its short-lived CSRF session was lost. Re-authenticate at Access and reload the dashboard; never copy the assertion into browser storage. |
| `403 forbidden_host` | The request hostname is absent from `API_PUBLIC_HOSTS`, or nginx did not preserve `Host`. Compare the public hostname with the nginx proxy and runtime environment. |
| `403 forbidden_origin` | A supplied `Origin` is absent from `API_ALLOWED_ORIGINS`. Add only the exact trusted origin; CLI clients normally omit this header. |
| `403 origin_required` or CSRF rejection on dashboard mutation | The browser request was not same-origin or did not use the current dashboard session token. Fix the trusted origin/session flow; do not relax the mutation check. |
| `415 unsupported_media_type` | An MCP POST was not JSON. Use an MCP Streamable HTTP client. |
| `429 rate_limited` | The process-local request window or active-request bound was exceeded. Wait for `Retry-After`; investigate stuck/parallel clients before restarting. |
| Public `/healthz` works but `/readyz` is 503 | API is up but cannot reach the runner. Inspect the Compose runner health, internal network, and matching `RUNNER_TOKEN`. |
| Local stdio: `--workspace path is not a directory` or `must be absolute` | Stdio mode requires an existing directory and an absolute path format (e.g. `/home/user/project` or `/path/to/repo`). Check the `--workspace` parameter. |
| Local stdio: Windows platform notice | Local stdio v1 currently supports POSIX platforms (Linux and macOS) due to POSIX process-group semantics. On Windows, run the command within WSL (Windows Subsystem for Linux) or use Cloud Harness over Streamable HTTP. |
| Local stdio: `workspace_open is unsupported in local stdio mode` | In local stdio mode, the workspace is already selected and pre-opened at startup. Do not call `workspace_open`; proceed directly to file, search, exec, session, or Git tools using the active workspace ID. |
| Local stdio: `network Git operations are disabled` or `Git push operations are disabled` | In local mode, remote network fetch/pull and push are disabled by default. Pass `--git-network` to enable network fetch/pull, and `--git-push` to enable push. |

The request policy is owned by
[`apps/api/src/request-security.ts`](../apps/api/src/request-security.ts) and
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts). Worker error and header
behavior is owned by
[`apps/api-key-gateway/src/gateway.ts`](../apps/api-key-gateway/src/gateway.ts).

## Workspace opening

- `LIMIT_EXCEEDED` with an active-workspace message means this MVP already has
  one active workspace. List it, recover it by ID, or close it.
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

- `files_apply_patch` conflict: read the file again, choose an exact unique
  `oldText`, and pass the latest SHA when concurrency matters. It is not a
  unified diff.
- `EXPIRED` or a closed workspace: open a new workspace. The old job directory
  is intentionally removed.
- Missing shell/session handle after a runner restart: interactive PTY streams
  are in memory and cannot be reconnected. Background task metadata and output
  logs persist across restarts and can be inspected via `tasks_status` or `tasks_list`.
- A dependency download, arbitrary network command, or networked deployment
  fails in a `none` workspace: open a new owner-approved `bridge` workspace if
  egress is necessary and accept the weaker boundary. Remote Git fetch/pull/push
  use runner-owned helpers and do not require executor bridge networking.
- Private fetch/pull failure: verify GitHub App installation access and Contents
  read permission. Push additionally requires Contents read and write
  permission; only `origin`, branch refspecs, and optional force-with-lease are
  accepted. The executor intentionally has no credential to inspect or repair.
- A dependent task remains `queued` while prerequisites are unfinished and
  becomes `blocked` if one fails or is cancelled. Inspect the task graph rather
  than rerunning it with a new idempotency key.
- A repository-defined deployment is missing or cannot authenticate: inspect
  `.cloud-harness/deployments.json`, executor network mode, and the repository's
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

## Containers and cleanup

Inspect before acting:

```bash
sudo docker ps -a --filter label=cloud-harness.managed=true \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "cloud-harness.workspace"}}'
df -h /var/lib/cloud-harness
```

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
