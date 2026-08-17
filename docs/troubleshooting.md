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
| `401` with `WWW-Authenticate: Bearer` | The MCP bearer is missing or differs from `MCP_BEARER_TOKEN`. Check that the Codex `bearer_token_env_var` names an exported variable, then restart Codex after changing it. |
| `403 forbidden_host` | The request hostname is absent from `API_PUBLIC_HOSTS`, or nginx did not preserve `Host`. Compare the public hostname with the nginx proxy and runtime environment. |
| `403 forbidden_origin` | A supplied `Origin` is absent from `API_ALLOWED_ORIGINS`. Add only the exact trusted origin; CLI clients normally omit this header. |
| `415 unsupported_media_type` | An MCP POST was not JSON. Use an MCP Streamable HTTP client. |
| `429 rate_limited` | The process-local request window or active-request bound was exceeded. Wait for `Retry-After`; investigate stuck/parallel clients before restarting. |
| Public `/healthz` works but `/readyz` is 503 | API is up but cannot reach the runner. Inspect the Compose runner health, internal network, and matching `RUNNER_TOKEN`. |

The request policy is owned by
[`apps/api/src/request-security.ts`](../apps/api/src/request-security.ts) and
[`apps/api/src/auth.ts`](../apps/api/src/auth.ts).

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

Replay the same `workspace_open` idempotency key or call `workspace_list` after
a lost response; do not create a second key until the first result is resolved.

## Tool behavior

- `files_apply_patch` conflict: read the file again, choose an exact unique
  `oldText`, and pass the latest SHA when concurrency matters. It is not a
  unified diff.
- `EXPIRED` or a closed workspace: open a new workspace. The old job directory
  is intentionally removed.
- Missing shell/session/task after a runner restart: these handles, buffered
  output, and task dependency state are in memory and cannot be recovered. The
  workspace and its files may still be active.
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
release and database copy on failure when one exists. A first-install failure
disables the service.

After any failure, check the repository origin/commit, `nginx -t`, loopback
readiness, available disk, Docker image build, and the state schema error before
retrying. Use the [rollback runbook](operations.md#release-rollback) instead of
editing a detached production checkout by hand.
