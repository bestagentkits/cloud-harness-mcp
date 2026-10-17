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

The database persists workspace and task metadata across runner restarts.
Interactive shell, session, and Dashboard Terminal streams remain in-memory, while background tasks
and dependency graphs are durable in SQLite. Startup reconciles in-flight tasks
from prior process boots to `FAILED` with `error_code: "RUNNER_RESTARTED"` while
preserving completed task metadata and file logs.
Workspace clones are operational, TTL-bound data and are deleted on
close/expiry; they are not a durable source control remote or a backup.
The same state database also owns the stable random runner-instance identity
used to scope Docker reconciliation.

Metadata schema v2 adds principal-bound API-key hashes and safe lifecycle
metadata. A database backup therefore does not recover plaintext keys; clients
must keep their one-time value in a private credential store.

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

That command re-encrypts secret versions, workspace secret snapshots,
downstream MCP OAuth grants and pending flows, and MCP Events webhook secrets. A grant is rewritten only while
its generation is unchanged, so a concurrent token refresh is never overwritten.

The command is interruptible and safe to resume; verify that it completes,
take a new coherent backup, and keep old decrypt keys through the release and
rollback window. Remove an old key only after source, database inspection, and
a restore rehearsal prove no retained ciphertext or rollback snapshot needs
that version. Do not run re-encryption from the API or expose key material in
command output.

## Cleanup

Normal cleanup is `workspace_close` or reaper auto-close after the recoverable
grace. It stops known shell/session/task children, removes the named executor,
deletes only the verified job directory, and records the workspace as closed.
TTL expiry alone only removes the executor; the checkout stays on disk while
the workspace is `EXPIRED_RECOVERABLE`. Startup also reconciles database,
filesystem, and Docker inventories, scoped to the configured runner instance.

### Expired workspaces and auto-close

The quota, idle TTL, wall TTL, and recoverable grace are set in Dashboard →
Settings → **Workspace limits & lifecycle**, falling back to the runner
environment ([configuration](configuration.md#workspace-and-repository-policy)).
The panel also shows the reaper interval, your counted, recoverable, and
auto-close-retained workspaces, and the per-executor ceilings that multiply
with every concurrent workspace. TTL and grace changes apply only to
workspaces opened afterwards. Lowering the quota closes nothing; it blocks new
opens and recoveries until usage drops.

An expired workspace becomes due for auto-close at roughly expiry + grace +
one reaper interval. Before deleting it, the reaper holds a mutation lease and
checks for running agents within their TTL, uncommitted or untracked paths
in the checkout and in each linked worktree (a clean worktree does not hold the
workspace), stashes, and commits on any local branch or worktree `HEAD` that no
remote-tracking ref contains. A
successful `git_push` moves the checkout's remote-tracking ref to the pushed
commit, and the commit a workspace was cloned at counts as on the remote, so
pushed and freshly cloned work is not mistaken for unsaved work. Git-ignored
files are not checked and are deleted with the checkout. Any of these,
or a check that cannot run, defers the close: the workspace stays
`EXPIRED_RECOVERABLE`, its `error` starts with `auto-close deferred:` and names
the reason, and the reaper retries after the longer of its grace and one hour.
A clean workspace is closed and audited as `workspace.auto_closed`; a deferral
is audited as `workspace.auto_close_deferred` when its reason changes. Before
this check existed, the reaper deleted recoverable workspaces after a fixed
hour regardless of unsaved work.

A retained workspace never closes on its own while the unsaved work remains,
so it keeps using disk. To clear one, use `workspace_status` or
`workspace_recover` in `status` or `patch` mode to see what is unsaved, push
or export it (`workspace_recover` `export` mode, or resume and push), then
`workspace_close`. Calling `workspace_close` directly discards the unsaved
work. The check is owned by `autoCloseBlocker` in
[`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts)
and the `close_check` mode in
[`worker/harness-worker.mjs`](../worker/harness-worker.mjs).

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

## Managed package releases

Managed toolbox packages live below `PACKAGES_ROOT`
(`/var/lib/cloud-harness/packages` by default), mounted read-write only into
the runner; `HOST_PACKAGES_ROOT` must name the same path. Each release is an
immutable directory recorded in the state database with its tree digest, lock,
SBOM, and provenance. Plans, applies, bindings, and the binding history are
rows in the same database, owned by
[`apps/runner/src/package-store.ts`](../apps/runner/src/package-store.ts).

Retention is reference-based. A release stays while a binding points at it,
while it is among the last five entries of a binding's rollback history, or
while a retained workspace's profile references it. Workspace bindings go
away with their workspace once it is closed or failed. Uninstalling a package
(`packages_remove` or **Uninstall** on the Dashboard Packages page, audited as
`package.removed`) deletes its binding and history and frees releases nothing
else references at once; releases a retained workspace still mounts wait for
the hourly collection. That is the way to recover from the per-owner storage
quota. Collection of unreferenced releases is scoped to the recorded release
path. Expired and rejected plans are purged, and applied plans lose their lock
text, after a fixed retention owned by `package-store.ts`.

A release directory found missing at startup is marked `MISSING` rather than
rebuilt. If the packages root itself is absent (storage not mounted yet),
startup marks and removes nothing. When a `MISSING` release's directory comes
back, startup or the hourly collection restores it to `VERIFIED` if its tree
digest still matches (audited as `package.release.restored`) and removes the
directory if it does not. A filesystem failure during this startup reconcile
is logged as a runner warning (`managed package startup reconcile failed`)
and does not stop the runner; check the mount and permissions of
`PACKAGES_ROOT`.

Releases are rebuildable from their locked plans, so they are not part of the
deploy script's recovery set. If you back them up, treat the state database
and `PACKAGES_ROOT` as one unit: stop the service, copy both, and restore them
together. An old database with a newer package tree, or the reverse, leaves
bindings pointing at releases that the startup verification marks `MISSING`.
Never delete the packages root recursively; remove a release only through the
runner or after confirming in SQLite that nothing references it.

Monitor its size alongside the other state roots:

```bash
sudo du -sh /var/lib/cloud-harness/packages
```

### Package registry egress

The provisioning proxy's built-in allow-list has no npm or PyPI host, and
`scripts/verify-compose-boundaries.mjs` asserts that. To let package builds
reach a registry, the owner adds hostnames to the non-secret, proxy-only file
`/etc/cloud-harness-mcp/provisioning-proxy.env`. Compose loads it only into the
`provisioning-proxy` service and treats a missing file as empty, which needs
Docker Compose 2.24 or newer. Never point it at `runtime.env` and never put
credentials in it.

```bash
# /etc/cloud-harness-mcp/provisioning-proxy.env
PACKAGES_PROXY_HOSTS=registry.npmjs.org,pypi.org,files.pythonhosted.org
```

Use `registry.npmjs.org` for npm, and `pypi.org` plus `files.pythonhosted.org`
for uv. A uv build also downloads its managed Python from GitHub releases, so
it needs `github.com` and `release-assets.githubusercontent.com` as well. The
proxy's Compose-set `ALLOWED_HOSTS` (the Git and toolkit hosts, which normally
include `github.com`) apply to package builders too, and these registry hosts
apply to toolkit helpers too, because both share the one proxy. The value is a comma-separated list of lowercase DNS hostnames; IP
literals, wildcards, ports, and other non-hostnames are logged on the proxy's
stderr and ignored, and the proxy still starts. Apply a change by restarting
the service, which recreates the stack through the installed Compose wrapper
with the production file set, then check the proxy for ignored entries:

```bash
sudo systemctl restart cloud-harness-mcp.service
sudo docker logs --tail 200 cloud-harness-mcp-provisioning-proxy-1 2>&1 | grep PACKAGES_PROXY_HOSTS
```

Remove the line, or the file, and restart again to withdraw registry access. Builds that need a blocked host fail with `UNAVAILABLE` and name the
host to add.

## Dashboard terminals

Dashboard Terminal PTYs are runner memory, not state. A runner restart or
redeploy ends every open terminal; operators see them as lost and open a new
session, and there is nothing to back up or restore. The executor restart that
follows reconciliation ends any process those shells left behind. Closing a
terminal from `/dashboard/terminals` or the workspace tab ends its whole shell
session without touching the workspace.

Terminals need the runner to reach Docker over a unix socket, which the
production Compose topology provides. The per-workspace limit, idle timeout,
lifetime, and retained output are runner settings documented in
[configuration](configuration.md#dashboard-terminal). Their lifecycle appears
in the audit log only as `terminal.opened` and `terminal.closed`; input and
output are never retained there, so the audit log cannot reconstruct a session.

## Managed API-key lifecycle

Create, list, and revoke keys through the Access-authenticated dashboard. A key
cannot be recovered after its creation response. For planned replacement,
create a new key, update and canary the client against
`https://api.harness.zuey.me/mcp`, then revoke the old key and verify the next
request is rejected. For suspected disclosure, revoke first and inspect only
redacted audit/log metadata. Do not copy a key into shell history, URLs,
tickets, or shared logs.

### API-key schema rollback

Downgrading from metadata schema v2 to a binary that supports only v1 destroys
all managed API-key records by design. Quiesce dashboard and MCP writes, stop
the service, and take a coherent recovery backup before running the runner's
compiled migration command from the exact release checkout:

```bash
npm run metadata:down:v1 -w @cloud-harness/runner -- /path/to/db
```

Keep the database offline for the command. It requires version 2, drops only
the API-key table, and resets the metadata version to 1. Then deploy the prior
binary, keep `API_KEY_AUTH_ENABLED=false`, and canary readiness, OAuth,
dashboard, unrelated metadata, and the absence of the hidden route. Restore
the backup instead of retrying manually if the downgrade does not complete.

## MCP gateway schema rollback

A pre-v6 runner cannot start on a v6 ledger. Downgrading from metadata schema v6
to a pre-v6 runner destroys the MCP gateway registry by design. Quiesce dashboard
and MCP writes, stop the service, and take a coherent recovery backup before
running the runner's bounded downgrade from the exact release checkout:

```bash
npm run metadata:down:v5 -w @cloud-harness/runner -- /path/to/db
```

Keep the database offline for the command. It requires version 6, drops only the
four `mcp_gateway_*` tables (servers, cached tools, tool permissions, and
traces), and resets the metadata version to 5. Unlike `metadata:down:v1`, it does
not chain further down, so `api_keys`, `global_secret_references`,
`global_secret_versions`, `secret_references.description`, and the
`secret_references.purpose` and `global_secret_references.purpose` columns are
preserved.
Then deploy the prior runner and canary readiness, the dashboard, unrelated
metadata, and the absence of the `/mcp-gateway` route. Restore-from-backup
remains the fallback instead of retrying a downgrade that does not complete.

## Downstream MCP OAuth schema rollback

Metadata schema v7 adds the encrypted downstream OAuth grant and pending-flow
tables and the per-server OAuth configuration column. A v6 runner cannot start
on a v7 ledger. Downgrading to a v6 runner destroys every downstream OAuth
grant and every server's OAuth configuration by design; affected servers must
be reconfigured and reconnected after a later upgrade. Quiesce dashboard and
MCP writes, stop the service, and take a coherent recovery backup before
running the bounded downgrade from the exact release checkout:

```bash
npm run metadata:down:v6 -w @cloud-harness/runner -- /path/to/db
```

Keep the database offline for the command. It requires version 7 and changes
only the downstream OAuth schema, leaving the MCP gateway registry, API keys,
and secret tables in place; it never chains further down. To reach v5, run
`metadata:down:v5` afterwards as described above. The exact statements are
owned by `downgradeMetadataSchemaToV6` in
[`apps/runner/src/metadata-schema.ts`](../apps/runner/src/metadata-schema.ts)
and the command by
[`apps/runner/src/metadata-schema-down-v6.ts`](../apps/runner/src/metadata-schema-down-v6.ts).
Then deploy the prior runner and canary readiness, the dashboard, and the MCP
server list. Restore-from-backup remains the fallback.

## MCP Events state schema rollback

MCP Events add runner state schema v13 (event subscriptions, callback
verifications, the event outbox, and delivery rows). A pre-v13 runner refuses a
v13 state database, so release rollback relies on the pre-deploy recovery set,
which restores the prior database together with the release. There is no
packaged command for this downgrade. The bounded `downgradeStateSchemaToV12` in
[`apps/runner/src/principal-store.ts`](../apps/runner/src/principal-store.ts)
drops only the four event tables, and refuses while any subscription or outbox
row exists unless data loss is explicitly allowed. A lossy downgrade discards
every subscription and undelivered event; clients must subscribe again after a
later upgrade, and nothing replays the lost events.

## Model catalog state schema rollback

The model catalog adds runner state schema v14: one table of last-good catalog
snapshots. A pre-v14 runner refuses a v14 state database, so release rollback
relies on the pre-deploy recovery set as for v13. The snapshots are a cache the
runner rebuilds from providers, so the bounded `downgradeStateSchemaToV13` in
[`apps/runner/src/principal-store.ts`](../apps/runner/src/principal-store.ts)
drops the table without a data-loss guard; the next search refetches.

## Revision pricing columns rollback

Revision cache prices, long-prompt tiers, and price provenance are columns added in place
to `agent_model_profile_revisions` by `initializeModelProfilePricingColumns` in
[`apps/runner/src/model-profile-state-repository.ts`](../apps/runner/src/model-profile-state-repository.ts),
without a state schema version bump. Every column is nullable or defaulted, so existing
revisions read as user overrides of unknown confidence, and a rolled-back runner keeps
reading and writing revisions by column name; its new revisions take the defaults. No data
change is needed to roll back, and the columns stay in place for the next upgrade.

A rolled-back runner ignores the new prices when it sends revisions to the model gateway:

- Cache usage is billed at the input price, which over-charges models with cheaper cached
  reads.
- Long prompts on a revision with tiers are billed at the base prices, which under-charges.
  Tiers exist only on revisions saved after the upgrade; while running the older release,
  lower the per-run cost caps of tiered profiles or avoid long prompts on them.

## MCP Events deployment verification

Automated tests prove [MCP Events](mcp-api.md#mcp-events-webhook-delivery)
against a mock callback receiver only. A live ChatGPT subscription is
separate, owner-authorized evidence; do not claim it from the mock tests or
from configuration. After a release that ships or changes events:

1. Deploy through the normal release path and confirm readiness.
2. Confirm `server/discover` on the remote `/mcp` endpoint advertises
   `capabilities.events` and that `events/list` returns the four
   `cloudharness.*` events.
3. From ChatGPT with the Cloud Harness connector, subscribe to a task or agent
   event, so ChatGPT supplies its own callback URL and secret. Confirm the
   subscription appears in `GET /dashboard/api/v1/event-subscriptions` with
   the expected event name and callback origin, and that the audit log records
   `mcp_event.subscribed`.
4. Run a short `tasks_run` task in a disposable workspace and confirm ChatGPT
   receives the event; the subscription's recent deliveries should show
   `DELIVERED` with no `lastError`.
5. Revoke the subscription through the dashboard revoke route
   (`POST /dashboard/api/v1/event-subscriptions/<id>/revoke`, with the normal
   dashboard session and CSRF token) or unsubscribe from the client, then
   confirm no further delivery and the matching audit entry. Close the
   workspace.

Record the result in the tracking issue as a live receipt: release SHA, date,
client and plan, event name, subscription and event ids, delivery status, and
the revocation outcome. Keep callback URLs, secrets, and payload contents out
of the receipt. Label mock-receiver test runs as mock evidence, never as live
ChatGPT verification.

## Release rollback

Each merge to `main` deploys once. When Release cuts a version, it requests CI
for its `chore(release)` commit and the merge deploy is skipped, so production
runs the tagged tree after that second CI run passes; otherwise the merge
commit deploys right after push CI. If the version commit's CI fails or is
cancelled while it is still the head of `main`, its CI-tested parent merge
deploys instead; once a newer merge lands, that merge's CI decides the deploy. A flaky failure can be
retried with `gh workflow run ci.yml --ref main` while the version commit is
still the head of `main`; a real fix is a new merge, which deploys on its own.
Run **Deploy production** manually (`workflow_dispatch`, optionally with an
explicit 40-character commit SHA) to force a deploy;
[`docs/deployment.md`](deployment.md) owns the decision rule.

An automatic deployment failure restores the prior recorded commit, the
quiesced database/artifact state, the last healthy runtime configuration and
runner-only key files, and rebuilt service images when a prior release exists.
The deploy script records the active configuration only after readiness,
image-identity, and canary checks succeed.

That automatic recovery has two limits worth knowing before you rely on it.

It is fail-closed. If the restore itself fails, `contain_failed_release` in
`deploy/scripts/release-runtime.sh` runs
`systemctl disable --now cloud-harness-mcp.service` and
`compose down --remove-orphans`, deliberately leaving the release **stopped**
rather than serving a half-promoted one.

It cannot run when the deploy process is killed outright. The deploy therefore
never runs inside the caller's session: `cloud-harness-deploy` starts it as the
transient unit `cloud-harness-deploy-<sha>` and only follows its journal. A
dropped SSH connection used to stop the release and then lose the deploy,
because `sudo` (with `use_pty`) answers a dead connection by sending the
command's process group `SIGHUP`, `SIGTERM` and, two seconds later, `SIGKILL`,
before the signal trap could start the rollback. Inside the unit the deploy also
traps `ERR` plus `HUP`, `INT`, `TERM` and `PIPE`, and writes signal-path output
to `/var/lib/cloud-harness/deploy-interrupt.log`.

A `SIGKILL`, OOM kill, or host reboot bypasses every in-process trap, so the
deploy records `/var/lib/cloud-harness/deploy-in-progress` (the previous
release, plus the snapshot once it is complete) before it stops the release and
removes it on every normal exit. A marker left behind means a killed deploy:
the deploy unit's `ExecStopPost` runs `cloud-harness-deploy --recover` after a
kill, and the enabled `cloud-harness-deploy-recover.service` runs it at boot.
Recovery takes the deploy lock and performs the ordinary rollback to the
recorded release and snapshot. A shutdown signal skips the in-process rollback
and leaves the marker for the boot recovery, because Docker is stopping too.
Check `journalctl -u cloud-harness-deploy-recover` after an unplanned reboot.

The deploy script installs itself into `/usr/local/sbin` only after a
successful promotion, so every deploy runs the script of the release it
replaces, and a change to `deploy-release.sh` takes effect from the deploy after
the one that ships it. The installed tooling only moves forward:
`/var/lib/cloud-harness/deploy-tooling-release` records the release it came
from, and promoting a release that is not its descendant (a rollback to an
older commit) keeps the newer scripts and recovery unit.

The deploy compiles the target images while the current release keeps serving,
then stops it, so the outage lasts for the backup and the cached rebuild and
start, not for a cold image build. A failed or interrupted build never stops the
current release: the deploy puts the checkout and the `:local` image tags back
on the recorded release and exits. During that build the checkout and the
`:local` tags already point at the target, so a host reboot in that window
starts the target release without a pre-deploy backup.
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
state, API-key gateway disablement when applicable, and managed-container
cleanup after a rollback. Retain at least one
known-good coherent recovery set; backup retention is an operator policy, not
an automated service feature.

## Owner-Authorized Real-Provider Canary Runbook (Subagents)

To verify live provider connectivity and obtain the operational receipts required for closing Issue #19, execute a bounded canary on isolated staging before general use.

### 1. Preflight and authorization

- Verify exact release SHA, image digests, and staging deployment status.
- Prepare a disposable test repository (no private secrets, PII, or customer data).
- Ensure workspace uses `networkMode: "none"`.
- Configure an operator profile in `/etc/cloud-harness-model-gateway/profiles.json` with low hard caps (`maxCostMicros: 500000`, approximately $0.50 maximum spending ceiling).
- Mount the provider API key exclusively into Model Gateway (`/etc/cloud-harness-model-gateway/provider-api-key`).

### 2. Execution protocol

1. **Spawn & Idempotency:** Call `agent_spawn` with the disposable workspace and curated test prompt. Replay the same idempotency key 3 times; verify identical `agentId` returned, `replayed: true` on subsequent calls, and exactly 1 container/lease created.
2. **Live Execution & Paging:** Call `agent_status` by `agentId` and `idempotencyKey`. Stream and page `agent_logs` via byte cursors. Verify all sensitive tokens/canaries are redacted.
3. **Steering & Cancellation:** Send an `agent_message` (`steer` or `followUp`). Test `agent_cancel`; verify post-order cascading cancellation of any child subagents and exact `Revoke -> Drain -> TERM/KILL -> Remove` order.
4. **Failure & Restart Resilience:** Exercise a controlled runner restart with an active agent; confirm status reconciles to `INTERRUPTED` with `outcomeUnknown: true` without auto-replaying unverified side effects.
5. **Closure & Zero Residual:** Call `workspace_close`. Confirm `docker ps -a` and `docker network ls` show 0 residual agent containers and networks, Model Gateway shows 0 active leases, and workspace directories are deleted only after barrier completion.

### 3. Sign-off and receipts

Record the test evidence (image digests, execution trace, token/cost reconciliation, and zero-residual confirmation) in the tracking issue before signing off on full operational readiness.
