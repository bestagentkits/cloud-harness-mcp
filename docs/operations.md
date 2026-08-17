# Operations

## Health and service state

- `/healthz` proves the API process is serving HTTP.
- `/readyz` also checks runner reachability and returns 503 when the runner is
  unavailable.

On the VPS, inspect the service and the exact production Compose topology with:

```bash
sudo systemctl status cloud-harness-mcp.service
sudo journalctl -u cloud-harness-mcp.service --since "30 minutes ago"
sudo docker compose \
  -f /opt/cloud-harness-mcp/repo/compose.yaml \
  -f /opt/cloud-harness-mcp/repo/compose.production.yaml ps
curl --fail http://127.0.0.1:3100/readyz
```

The systemd and Compose owners are
[`deploy/systemd/cloud-harness-mcp.service`](../deploy/systemd/cloud-harness-mcp.service),
[`compose.yaml`](../compose.yaml), and
[`compose.production.yaml`](../compose.production.yaml).

## Persistent and ephemeral data

The production defaults place:

- SQLite workspace metadata at
  `/var/lib/cloud-harness/state/cloud-harness.db`;
- active workspace clones below `/var/lib/cloud-harness/jobs`;
- release-time database copies below `/var/lib/cloud-harness/backups`;
- runtime secrets in `/etc/cloud-harness-mcp/runtime.env`.

The database persists workspace metadata across runner restarts.
Shell/session/task handles, dependency graphs, and their output buffers do not.
Startup restarts surviving executors, which preserves repository files but
stops any process whose handle was lost.
Workspace clones are operational, TTL-bound data and are deleted on
close/expiry; they are not a durable source control remote or a backup.
The same state database also owns the stable random runner-instance identity
used to scope Docker reconciliation.

## Backup and restore

[`deploy/scripts/deploy-release.sh`](../deploy/scripts/deploy-release.sh)
stops the service before copying an existing SQLite database and restores that
copy automatically if deployment fails. It does not back up active workspace
files and does not prune old database copies.

For a manual metadata backup:

1. List and close active workspaces through MCP, or explicitly accept that
   in-flight executor state will not be captured.
2. Quiesce the database, copy it, and restart:

```bash
sudo systemctl stop cloud-harness-mcp.service
sudo cp --reflink=auto \
  /var/lib/cloud-harness/state/cloud-harness.db \
  "/var/lib/cloud-harness/backups/manual-$(date -u +%Y%m%dT%H%M%SZ).db"
sudo systemctl start cloud-harness-mcp.service
curl --fail http://127.0.0.1:3100/readyz
```

Do not copy only the main database while the runner is writing its WAL. To
restore, stop the service, preserve the current database, copy one verified
backup into the configured `STATE_DB`, start the same or a schema-compatible
release, and check readiness. The state store intentionally refuses an
unsupported schema version.

If workspace content must be retained, commit changes and use `git_push` only
when the configured GitHub App has repository write access; verify the remote
result before closing. Otherwise export the required files before close. The
executor itself never receives a repository credential. Host-side archival
should be exceptional, performed only after stopping the exact verified
executor, and scoped to its opaque job directory.

## Cleanup

Normal cleanup is `workspace_close` or TTL expiry. It stops known
shell/session/task children, removes the named executor, deletes only the
verified job directory, and records the workspace as closed. Startup also
reconciles database, filesystem, and Docker inventories, scoped to the
configured runner instance.

Inspect managed containers before any manual action:

```bash
sudo docker ps -a --filter label=cloud-harness.managed=true \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "cloud-harness.workspace"}}'
```

Call `workspace_close` when the runner still owns the record. After a damaged
or unavailable runner, reconcile the container label and opaque workspace ID
against SQLite before removing an exact container or directory. Never delete
the jobs root recursively and never apply broad Docker cleanup on a shared
host.

Monitor free space because the workspace size setting is not a hard quota:

```bash
df -h /var/lib/cloud-harness
sudo du -sh /var/lib/cloud-harness/jobs/*
```

## Release rollback

An automatic deployment failure restores the prior recorded commit, the
quiesced database copy, and rebuilt service images when a prior release exists.
A manual:

```bash
sudo /usr/local/sbin/cloud-harness-rollback
```

delegates to the deploy script with the recorded previous release. To deploy a
different known-good commit on `origin/main`, pass its exact
40-character SHA to `/usr/local/sbin/cloud-harness-deploy`. The current
pipeline builds images on the VPS and records local image IDs; it does not pull
an externally attested image digest.

Always verify loopback readiness, HTTPS, and managed-container cleanup after a
rollback. Retain at least one known-good compatible database copy; backup
retention is an operator policy, not an automated service feature.
