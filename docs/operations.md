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

- SQLite workspace, principal, dashboard, GitHub binding, artifact metadata,
  and audit state at
  `/var/lib/cloud-harness/state/cloud-harness.db`;
- active workspace clones below `/var/lib/cloud-harness/jobs`;
- retained artifact payloads below `/var/lib/cloud-harness/artifacts`;
- release-time recovery sets below `/var/lib/cloud-harness/backups`; and
- runtime configuration, GitHub App key, and secret keyring below
  `/etc/cloud-harness-mcp`.

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
stops the service before creating a timestamped recovery set containing the
SQLite database, artifact payload archive, and a root-owned copy of the runtime
configuration/key directory. On deployment failure it restores the prior
database and artifact payloads and reuses the unchanged configuration. It does
not back up active workspace files or prune old recovery sets.

Treat the database, artifact payloads, runtime configuration, GitHub App key,
and complete secret decrypt keyring as one coherent recovery unit. Stop the
service before copying it so no dashboard, MCP, reaper, WAL, or artifact write
can race the snapshot. List and close active workspaces first, or explicitly
accept that their TTL-bound checkouts and in-memory operations are excluded.
Use the directory shape created by the deploy script rather than inventing a
database-only backup.

To restore, keep the service stopped, preserve the current recovery unit, and
select one verified snapshot. Restore its database and matching artifact
archive together. If the configuration or keyring changed since that snapshot,
restore the matching root-owned config copy before starting the same or a
schema-compatible release. Never combine an old database with newer artifacts
or a keyring that cannot decrypt its recorded versions. Check readiness,
dashboard secret readiness, artifact retrieval, and sanitized audit continuity
before reopening writes. The state store intentionally refuses an unsupported
schema version.

If workspace content must be retained, commit changes and use `git_push` only
when the configured GitHub App has repository write access; verify the remote
result before closing. Otherwise export the required files before close. The
executor itself never receives a repository credential. Host-side archival
should be exceptional, performed only after stopping the exact verified
executor, and scoped to its opaque job directory.

## Secret key rotation

The keyring is versioned so encryption can move to a new active key without
losing decrypt access to older secret versions. Back up the coherent recovery
unit first. Add a new unique key version, make it active, retain every old key,
and restart with the complete runner-only keyring. Quiesce secret mutations,
keep the service or all write paths quiesced for the operation, then invoke the
one-off runner re-encryption entry point owned by
[`apps/runner/src/rekey-secrets.ts`](../apps/runner/src/rekey-secrets.ts) through
the `secrets:rekey` package script or its compiled runner command.

The command is interruptible and safe to resume; verify that it completes,
take a new coherent backup, and keep old decrypt keys through the release and
rollback window. Remove an old key only after source, database inspection, and
a restore rehearsal prove no retained ciphertext or rollback snapshot needs
that version. Do not run re-encryption from the API or expose key material in
command output.

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
quiesced database/artifact state, and rebuilt service images when a prior
release exists. Runtime configuration is not modified by the deploy script;
its snapshot copy is retained for coherent manual recovery.
A manual:

```bash
sudo /usr/local/sbin/cloud-harness-rollback
```

delegates to the deploy script with the recorded previous release. To deploy a
different known-good commit on `origin/main`, pass its exact
40-character SHA to `/usr/local/sbin/cloud-harness-deploy`. The current
pipeline builds images on the VPS and records local image IDs; it does not pull
an externally attested image digest.

Always verify loopback readiness, HTTPS, dashboard secret readiness, artifact
state, and managed-container cleanup after a rollback. Retain at least one
known-good coherent recovery set; backup retention is an operator policy, not
an automated service feature.
