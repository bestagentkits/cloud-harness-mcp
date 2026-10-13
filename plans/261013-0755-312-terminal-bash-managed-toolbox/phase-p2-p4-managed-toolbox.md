# Slices P2–P4: managed toolbox packages (#312)

Binding design: [ADR 0003](../../docs/adr/0003-terminal-bash-and-managed-toolbox.md) "Managed toolbox".
Builds on P1 (`bash` tool, `PACKAGES_ENABLED`, `apps/runner/src/toolbox-runner.ts`), which lands first.
Line citations: `wt:` means the P1 worktree `.claude/worktrees/agent-ad11303c6983e22ef`; all others are `main`.

## Outcome

With `PACKAGES_ENABLED=true`, an agent can plan, apply (after Dashboard approval by default), list,
inspect, and roll back npm and uv CLI tools for the owner or for one workspace. Each apply produces an
immutable, verified release under `PACKAGES_ROOT`. The release is mounted read-only into the `bash`
toolbox and into newly created workspace executors. `apt` returns `NOT_SUPPORTED`. With the flag off,
nothing changes: every `packages_*` tool returns `FORBIDDEN`, and no mount, PATH entry, or container is added.

Non-goals: an uninstall or unbind tool, the `instance` scope, system packages, image variants, cancelling
an apply, and package search as a separate tool.

## Resolved decisions

1. **Apply progress is durable, not an operation handle.** `packages_apply` returns an `applyId`, and
   `packages_status` reads the `package_applies` row. This avoids the owner-less generic operations: they
   carry only `workspaceId` (wt:`apps/runner/src/operation-manager.ts:47-63`), and an operation without a
   workspace is readable by any principal (wt:`apps/runner/src/workspace-service.ts:2396-2403`). It also
   survives runner restarts. No `registerGenericOperation` change is needed.
2. **Approval and auth mode.** The Dashboard is mounted only in `cloudflare-access` mode
   (`apps/api/src/app.ts:120-129`). Values are `PACKAGES_APPROVAL_MODE=required|none`, default
   `required`. When the mode is `required` in `owner-bearer` mode, `packages_plan` still works and reports
   `approval: "unavailable"`, and `packages_apply` refuses with `FORBIDDEN` (the message names the
   `none` opt-in). The runner logs one warning at startup. With `none`, plans are created already
   `APPROVED` with `decided_by='policy'`. This differs from privileged grants, which owner-bearer mode
   disables outright (`apps/runner/src/workspace-service.ts:2012-2013`), because ADR 0003 accepts recorded
   intent without separation of duties.
3. **Registry egress opt-in.** In production, `compose.yaml` interpolation does not see `runtime.env`:
   `deploy/scripts/release-runtime.sh:35` exports only the `HOST_*` roots. Two changes follow.
   - `deploy/provisioning-proxy.mjs` appends hosts from a new `PACKAGES_PROXY_HOSTS` env var to its
     allow-list (`:8-13`). Invalid entries, meaning IP literals, wildcards, or non-hostnames, are logged
     and ignored.
   - `compose.yaml` gives `provisioning-proxy` the entry
     `env_file: [{path: "${PROVISIONING_PROXY_ENV_FILE:-/etc/cloud-harness-mcp/provisioning-proxy.env}", required: false}]`.
     This is a dedicated non-secret file and never `runtime.env`.

   The default allow-list is unchanged. The runner learns the effective list by probing: before any
   plan, it sends `CONNECT <host>:443` to `TOOLKIT_EGRESS_PROXY` (already `http://provisioning-proxy:3128`,
   `compose.yaml:79`). A 403 maps to `UNAVAILABLE`, with the hint "operator must add <host> to
   PACKAGES_PROXY_HOSTS". The documented values are `registry.npmjs.org` for npm, and `pypi.org`,
   `files.pythonhosted.org`, and `release-assets.githubusercontent.com` [UNVERIFIED redirect host for
   uv-managed Python] for uv.
4. **npm uses "global-style" via a pinned lockfile.** The plan resolves a `package-lock.json`. Apply runs
   `npm ci` in `<release>/npm`, so npm enforces the sha512 integrity of every tarball. Only the root
   package's `bin` entries are exposed. Lifecycle scripts get `--ignore-scripts` unless
   `PACKAGES_NPM_LIFECYCLE_SCRIPTS=allow` and the plan asked for `lifecycleScripts: true`.
5. **uv uses `uv tool`-equivalent semantics with hash pinning.** `uv tool install` cannot take a hashed
   lock, so apply runs these steps:
   - `uv python install` into `<release>/python` (only-managed);
   - `uv venv <release>/venv`;
   - `uv pip sync --require-hashes requirements.lock`;
   - `bin/` symlinks for the root distribution's `console_scripts`.

   The release is self-contained because the executor image has no python3.
6. **Store module.** Tables live in a new `apps/runner/src/package-store.ts` with its own idempotent
   `CREATE TABLE IF NOT EXISTS`, following `apps/runner/src/artifact-store-schema.ts:24`. The module is
   stateless over `StateStore.database`, so separate instances in WorkspaceService and
   DashboardControlService are safe. `state-store.ts` and `index.ts` are untouched.
7. **Profile = DB snapshot plus PATH.** Each release is mounted at `/opt/chm-packages/<releaseId>`. Its
   `bin` directory is inserted into PATH after `/tmp/cloud-harness-home/.local/bin` and before
   `/usr/local/sbin`. Workspace-local installs therefore still win over managed releases, and managed
   releases win over image tools. No profile directory is written.
8. **Binding precedence.** For the same `(ecosystem, name)`, a workspace-scope binding overrides the
   owner-scope binding. Any other bin-name collision is a conflict: the plan lists it and apply refuses
   with `CONFLICT`.

## Data flow

```text
MCP packages_plan ─► PackageService.plan ─► probe proxy ─► plan builder container (provisioning net)
   ─► resolved JSON (stdout, ≤8 MiB) ─► zod parse ─► conflicts/affected ─► package_plans row + digest
Dashboard Approvals ─► BFF POST /api/v1/package-plans/:id/approve {planDigest} ─► runner
   package_plan_approve ─► PackageStore.approvePlan (BEGIN IMMEDIATE + audit)
MCP packages_apply {planId, planDigest} ─► PackageStore.startApply (BEGIN IMMEDIATE: checks, CONSUMED,
   apply row, fence) ─► async: apply builder (staging at final path) ─► remove container ─► verify tree
   ─► launch check (toolbox, no network, ro) ─► rename staging→releases ─► PackageStore.publish (tx)
workspace create/recreate ─► PackageService.profileFor(owner, ws) ─► package_workspace_profiles row
   ─► --mount ro per release + PATH ;  bash toolbox ─► owner-scope releases ─► ro mounts + PATH
```

## Public contract

All tools are refused with `FORBIDDEN` while `PACKAGES_ENABLED` is not `true`. Local stdio backends refuse
them with the same `INVALID_INPUT` local-mode message as the P1 toolbox target
(wt:`apps/api/src/local/local-workspace-backend.ts:150-155`).

| Tool | Input (strict zod) | Result `data` | Annotations |
| --- | --- | --- | --- |
| `packages_plan` | `ecosystem: 'npm'\|'uv'\|'apt'`, `name`, `version?` (npm spec/tag, default `latest`; uv PEP 440 specifier), `scope: 'owner'\|'workspace'` (default `owner`), `workspaceId?` (required iff workspace), `python?` (uv only, `^3\.\d{1,2}(\.\d{1,2})?$`), `lifecycleScripts?: boolean` (npm only, default false) | `planId, planDigest, expiresAt, approval ('required'\|'not_required'\|'unavailable'), package{ecosystem,name,version}, source{registry,resolved}, integrity, dependencyCount, sizeEstimateBytes, binaries[], conflicts[], affectedWorkspaces[], bindingGeneration, runtime{imageId,node?,python?}` | openWorld |
| `packages_apply` | `planId`, `planDigest` (64 hex) | `applyId, planId, releaseId, state` (idempotent replay per planId) | openWorld, idempotent |
| `packages_list` | `scope?`, `workspaceId?`, `includeHistory?: boolean` | `bindings[]{bindingId,scope,workspaceId?,ecosystem,name,generation,release}`, `releases[]{releaseId,version,treeDigest,sizeBytes,binaries,createdAt,runtime,stale}` | readOnly, idempotent |
| `packages_status` | `applyId?`, `waitMs` 0–30000 (default 0) | with `applyId`: `apply{state,errorCode?,errorMessage?,outputTail?,releaseId}`; without it: `inFlight[]`, `pendingPlans[]`, `missingReleases[]`, `workspacesPendingRecreate[]` | readOnly, idempotent |
| `packages_rollback` | `bindingId`, `releaseId`, `expectedGeneration` | `binding` (new generation), `affectedWorkspaces[]` | destructive, idempotent |

The schemas validate names: npm uses `^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$` (≤214
characters), and uv uses `^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$` (≤128). Version specs may not
contain `:`, `/`, `@`, `;`, or a leading `-`, so URL, git, file, and marker specs are refused. Bin names
must match `^[A-Za-z0-9._+-]{1,64}$`. The instance scope fails schema validation, and the description says
so. `apt` passes the schema only so the runner can answer `NOT_SUPPORTED`, pointing to the image-variant
workflow.

**New `ErrorCodeSchema` values** (`packages/contracts/src/mcp-results.ts:3-36`): `NOT_SUPPORTED`,
`PACKAGE_APPROVAL_REQUIRED`, `PACKAGE_BUILD_FAILED`, `PACKAGE_VERIFICATION_FAILED`. Existing codes are
reused as follows:
- `FORBIDDEN`: disabled, ecosystem off, scripts not allowed, or approval unavailable.
- `NOT_FOUND`: unknown package, plan, binding, or release, or a foreign owner.
- `EXPIRED`: the plan expired.
- `STALE_GENERATION`: the digest mismatches, the binding generation moved, or the runtime image changed.
- `CONFLICT`: the plan was rejected, the fence is held, or bin names collide.
- `LIMIT_EXCEEDED`: release, owner, or binding quota, or the free-space reserve.
- `UNAVAILABLE`: the proxy host is blocked or the builder failed to start.
- `TIMEOUT`.
- `RUNNER_RESTARTED`: the apply was interrupted.

**Config** (`packages/contracts/src/config.ts` RunnerConfigSchema next to `packagesEnabled`,
wt:`:242-244`; `apps/runner/src/config.ts:160ff`; `.env.example`):

| Variable | Default | Bounds |
| --- | --- | --- |
| `PACKAGES_ROOT` | `/var/lib/cloud-harness/packages` | absolute path; compose `HOST_PACKAGES_ROOT` must equal it |
| `PACKAGES_ECOSYSTEMS` | `npm,uv` | subset of `npm,uv` |
| `PACKAGES_APPROVAL_MODE` | `required` | `required\|none` |
| `PACKAGES_NPM_LIFECYCLE_SCRIPTS` | `deny` | `deny\|allow` |
| `PACKAGES_MAX_RELEASE_BYTES` | 536870912 | 16 MiB – 4 GiB |
| `PACKAGES_MAX_OWNER_BYTES` | 4294967296 | 64 MiB – 64 GiB |
| `PACKAGES_MAX_BINDINGS` | 32 | 1 – 256, per owner |
| `PACKAGES_BUILD_TIMEOUT_MS` | 600000 | 60000 – 1800000 |
| `PACKAGES_PROXY_HOSTS` | empty | proxy-only, in `provisioning-proxy.env` |

Code constants: plan TTL 30 min, rollback history depth 5, 2 concurrent builds, GC at most hourly.

## State tables (`apps/runner/src/package-store.ts`)

- **`package_plans`** columns:
  - `id` PK (`pkp_`), `owner_id`, `scope`, `workspace_id` (NULL for owner), `ecosystem`, `package_name`,
    `version`, `requested_spec`;
  - `binding_id` (NULL if new), `binding_generation`, `digest`;
  - `plan_json` (canonical body, ≤64 KiB), `lock_text` (≤4 MiB: npm `package.json`+lock JSON, or uv
    `requirements.lock`);
  - `status` (`PENDING_APPROVAL|APPROVED|REJECTED|EXPIRED|CONSUMED`), `approval_mode`;
  - `created_at`, `expires_at`, `decided_at`, `decided_by`, `consumed_at`, `apply_id`.

  Index on `(owner_id, status)`.
- **`package_bindings`** columns: `id` PK (`pkb_`), `owner_id`, `scope`, `workspace_id` (`''` for owner),
  `ecosystem`, `package_name`, `release_id` (NULL until first publish), `generation` (default 0),
  `fence_apply_id`, `created_at`, `updated_at`. `UNIQUE(owner_id, scope, workspace_id, ecosystem,
  package_name)`.
- **`package_binding_history`** columns: `id` INTEGER PK AUTOINCREMENT, `binding_id`, `owner_id`,
  `generation`, `release_id`, `reason` (`apply|rollback`), `actor` (`mcp|dashboard`), `created_at`.
  Index on `(binding_id, generation DESC)`.
- **`package_releases`** columns:
  - `id` PK (`pkr_`), `owner_id`, `ecosystem`, `package_name`, `version`, `plan_id`, `plan_digest`;
  - `tree_digest`, `size_bytes`, `file_count`, `binaries_json`;
  - `provenance_json`: registry, resolved URL, root integrity, lock sha256, builder image ID, node/npm/uv/
    python versions, lifecycleScripts, and `built_at`;
  - `sbom_json` (≤1 MiB: `[{name,version,integrity?}]`);
  - `rel_path` (`releases/<ownerKey>/<id>`), `status` (`VERIFIED|MISSING|COLLECTED`), `created_at`,
    `collected_at`.
- **`package_applies`** columns: `id` PK (`pka_`), `owner_id`, `plan_id` UNIQUE, `binding_id`,
  `release_id` (reserved at start), `state`, `error_code`, `error_message` (≤2000), `output_tail`
  (≤64 KiB), `created_at`, `updated_at`, `finished_at`.
- **`package_workspace_profiles`** columns: `workspace_id` PK, `owner_id`, `release_ids_json`,
  `created_at`.

Every mutation uses `BEGIN IMMEDIATE` through `transaction()` (`apps/runner/src/metadata-records.ts:35`).
Audit goes through an injected `(database, principalId, action, subjectType, subjectId, generation,
details)` callback. WorkspaceService passes `metadata.recordAuditInTransaction`
(`apps/runner/src/metadata-store.ts:335`), and the callback is a no-op when no MetadataStore exists.
Actions are `package_plan.approved|rejected`, `package.apply.started|succeeded|failed`,
`package.rollback`, and `package.release.collected`. Details are scalars only. IDs come from
`opaqueId` (`apps/runner/src/metadata-records.ts:16`). `ownerKey` is the first 32 hex characters of
`sha256(ownerId)`.

## Digests

- **Plan digest:** `sha256(canonicalJson(body))`, as lowercase hex. `canonicalJson` is the sorted-key
  serializer at `apps/runner/src/cloudflare-access-oauth-provider.ts:163`, exported for reuse.
  `body` contains these fields:
  - `schema: 'cloud-harness.package-plan/v1'`, `ownerId`, `scope`, `workspaceId|null`, `ecosystem`,
    `name`, `version`, `requestedSpec`;
  - `source{registry,resolved}`, `integrity`, `lockSha256`, `dependencyCount`, `sizeEstimateBytes`;
  - sorted `binaries` and `conflicts`, `lifecycleScripts`;
  - `runtime{imageId,node,npm,uv,python}`;
  - `bindingId|null`, `bindingGeneration`, `createdAt`, `expiresAt`.

  The executor image ID is in the digest, so an image upgrade between plan and apply returns
  `STALE_GENERATION`.
- **Release tree digest:** `computeFullTreeDigest` (`apps/runner/src/adapters/mattpocock-adapter.ts:21`)
  over the staged tree, after the builder container is removed.

## Apply state machine and recovery

```text
plan: PENDING_APPROVAL ─approve─► APPROVED ─apply─► CONSUMED      (mode none: created APPROVED)
                       ─reject──► REJECTED;   any non-CONSUMED past expires_at ─► EXPIRED
apply: QUEUED ─► BUILDING ─► VERIFYING ─► PUBLISHING ─► SUCCEEDED
          └────────┴────────────┴────────────┴──► FAILED(code)
```

- **startApply (one transaction).** It checks each condition below in order, then writes:
  - flag on, ecosystem enabled, and the approval mode resolved;
  - the plan exists for this owner, else `NOT_FOUND`;
  - if the plan is already `CONSUMED`, return the existing apply (replay);
  - the digest equals `plan.digest`, else `STALE_GENERATION`;
  - `status=APPROVED`, else `PACKAGE_APPROVAL_REQUIRED` while pending, or `CONFLICT` if rejected;
  - the plan has not expired, else `EXPIRED`;
  - the binding generation is unchanged, else `STALE_GENERATION`;
  - `fence_apply_id` is NULL, else `CONFLICT`;
  - the binding-count and owner-byte quotas hold (plus the free-space reserve via `statfs(PACKAGES_ROOT)`).

  If every check passes, it creates the binding row when absent (`generation=0`), sets the plan to
  `CONSUMED`, inserts the `QUEUED` apply row with a reserved `release_id`, sets
  `fence_apply_id=applyId`, and writes the audit record. Then it schedules the job (2-slot semaphore).
- **Each state transition** is a single-row update. The failure transition also clears the fence.
- **Publish order.** First, verification passes and the launch check passes. Second,
  `rename(staging/<rel>, releases/<ownerKey>/<rel>)`. Third, one transaction: insert the `VERIFIED`
  release, update the binding (`release_id`, `generation+1`, fence NULL), append history and trim it
  to 5, mark the apply `SUCCEEDED`, and write the audit record. If that transaction throws, the
  renamed directory is removed and the apply fails.
- **Startup reconciliation.** `PackageService.reconcileStartup()` runs after `reconcileContainers()`
  (wt:`apps/runner/src/workspace-service.ts:453`), which already removes this instance's
  `cloud-harness.ephemeral=true` containers (`apps/runner/src/workspace-service.ts:496-501`), so no
  builder can still be writing. It then:
  1. marks applies in `QUEUED|BUILDING|VERIFYING|PUBLISHING` as `FAILED/RUNNER_RESTARTED` and clears
     their fences;
  2. removes the `staging/*` and `scratch/*` entries whose names match the ID regex;
  3. removes each `releases/<ownerKey>/<id>` directory that has no `VERIFIED` row, because a rename
     without a commit is never published;
  4. marks each `VERIFIED` row whose directory is missing as `MISSING`.

  Every removal uses an exact validated path under `PACKAGES_ROOT`, never the root itself.
- **Rollback** (MCP or Dashboard) is one transaction. It requires the fence to be NULL, the
  `expectedGeneration` to match, the target to be in the binding's history, not current, `VERIFIED`,
  and present on disk, and no bin conflicts. It sets `release_id`, increments the generation, appends
  history, and writes the audit record. No approval is needed (ADR 0003).
- **GC** runs from the reaper tick at most hourly (wt:`apps/runner/src/workspace-service.ts:456`,
  `reapExpired` `:4471`).
  - It first deletes workspace-scope bindings whose workspace is not active and not
    `EXPIRED_RECOVERABLE`, together with their history. Statuses are listed at
    `apps/runner/src/state-store.ts:155`.
  - It then collects a `VERIFIED|MISSING` release only when it is unreferenced on every count: by any
    binding's `release_id`, by the last 5 history entries, by any profile of an active or
    `EXPIRED_RECOVERABLE` workspace, and by any in-flight apply.
  - Collection does `rm -r` of its exact directory, sets the status to `COLLECTED`, and writes the
    audit record.

## Builder, verification, launch check

New file `apps/runner/src/package-builder.ts`. Scripts are fixed strings. User values travel only as
positional arguments (`bash -c <script> package-builder "$@"`).

**Builder argv**, reusing `EXECUTOR_HARDENING_ARGS` (wt:`apps/runner/src/toolbox-runner.ts:12-17`):
```text
run --rm --pull never --name chm-pkgbuild-<16hex>
  --label cloud-harness.role=package-builder --label cloud-harness.ephemeral=true
  --label cloud-harness.instance=<instanceId> ...EXECUTOR_HARDENING_ARGS
  --network <provisioningNetwork>            # only egress: provisioning proxy
  --env HTTP_PROXY=<proxy> --env HTTPS_PROXY=<proxy> --env NO_PROXY=localhost,127.0.0.1
  --env npm_config_proxy=<proxy> --env npm_config_https_proxy=<proxy>
  --env HOME=/work/home --env npm_config_cache=/work/npm-cache --env npm_config_registry=<registry>
  --env UV_CACHE_DIR=/work/uv-cache --env UV_PYTHON_PREFERENCE=only-managed --env UV_INDEX_URL=<index>
  --workdir /work
  --mount type=bind,source=<root>/scratch/<pkp|pka id>,target=/work
  [apply only] --mount type=bind,source=<root>/staging/<rel>,target=/opt/chm-packages/<rel>
  <executorImage> /bin/bash -c <script> package-builder <args...>
```
The runner creates the scratch and staging directories (mode 0755, chowned 10001:10001, with the helper
fallback from `apps/runner/src/workspace-service.ts:711-735`). The argv carries no secrets, env file,
socket, or credentials, and the timeout is `PACKAGES_BUILD_TIMEOUT_MS`. The container is always removed
by exact name, and its absence is confirmed (`inspectContainer`) before verification starts.

**Plan scripts** emit one JSON document on stdout, which zod parses (≤8 MiB).
- npm:
  1. write `package.json` with `{"name":"chm-release","private":true}`;
  2. `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact -- "$1@$2"`;
  3. read the root version, integrity, and resolved URL from `packages["node_modules/<name>"]`;
  4. `npm view -- "$1@<version>" bin dist.unpackedSize engines --json`;
  5. emit `{lock, packageJson, view}`.

  The runner checks that the resolved tarball host equals the registry host.
- uv:
  1. `UV_PYTHON_INSTALL_DIR=/work/python uv python install "$py"`, then `uv python find`;
  2. `uv pip compile --generate-hashes --no-header` of `name+spec` into `requirements.lock`;
  3. trial `uv venv /work/probe` and `uv pip sync --require-hashes`;
  4. read the root dist-info `entry_points.txt` console_scripts and `du -sb` for the size;
  5. emit `{lock, pythonVersion, uvVersion, scripts, sizeBytes}`.

**Apply layout** is staged at the final mount path `/opt/chm-packages/<rel>`:
```text
<PACKAGES_ROOT>/staging/<rel>/          → published as <PACKAGES_ROOT>/releases/<ownerKey>/<rel>/
  bin/<name> -> ../npm/node_modules/.bin/<name>        (npm)   | -> ../venv/bin/<name>  (uv)
  npm/package.json npm/package-lock.json npm/node_modules/  (npm ci --omit=dev [--ignore-scripts])
  python/<cpython-…>/  venv/  requirements.lock            (uv; venv shebangs = /opt/chm-packages/<rel>/venv/bin/python)
<PACKAGES_ROOT>/scratch/<id>/  (caches, plan output; deleted after the job)
```

**Verification** walks the tree with `lstat`, with no container running, and fails with
`PACKAGE_VERIFICATION_FAILED` on any of these:
- a special file, or a set setuid, setgid, or sticky bit;
- a symlink that resolves outside the release (relative targets normalized against the link
  directory; absolute targets must start with `/opt/chm-packages/<rel>/`);
- more than 200 000 entries;
- `bin/` differing from the plan's binaries.

Exceeding `PACKAGES_MAX_RELEASE_BYTES` fails with `LIMIT_EXCEEDED`.

**Launch check** reuses `runToolboxCommand` (wt:`apps/runner/src/toolbox-runner.ts:103`) per binary, with
`--network none`, the staged directory mounted read-only at the final path, and a 30 s timeout and
64 KiB output cap. The command is `B=/opt/chm-packages/<rel>/bin/<name>; "$B" --version || "$B" --help`.
The check passes only on exit 0, and the passing command is recorded in the provenance.

**Toolbox extension** (wt:`apps/runner/src/toolbox-runner.ts:26-34,77-96`): add
`binDirs?: readonly string[]` to `ToolboxRunSpec`. Each entry must be `<mount.target>/bin` of a provided
mount. A new exported helper `withManagedBins(basePath, binDirs)` inserts them before `/usr/local/sbin`;
workspace executors reuse it on their PATH (wt:`apps/runner/src/workspace-service.ts:777`).

## Sub-phases and file ownership

Dependency graph: **A → (B1 ∥ B2 ∥ C) → D.** No file is owned by two parallel sub-phases, and each
sub-phase merges with flag-off behaviour unchanged. B1, B2, and C add only unreachable code until D
registers the tools.

### A — Foundations (one implementer, blocks everything)
Files:
- `packages/contracts/src/package-schemas.ts` (new): ecosystem, scope, and name/spec/bin regexes; MCP
  input objects; result view schemas; the Dashboard input schemas used by C.
- `packages/contracts/src/index.ts` (export).
- `packages/contracts/src/mcp-results.ts` (4 codes).
- `packages/contracts/src/config.ts` and `apps/runner/src/config.ts` (the vars above).
- `.env.example`.
- `apps/runner/src/package-store.ts` (new): schema plus all transactions (createPlan, approvePlan,
  rejectPlan, expirePlans, startApply, transition, publish, rollback, overview, gcCandidates,
  setProfile, reconcile queries).
- `apps/runner/src/cloudflare-access-oauth-provider.ts` (export `canonicalJson` only).
- `deploy/provisioning-proxy.mjs` (`PACKAGES_PROXY_HOSTS`).
- `compose.yaml`: proxy `env_file`; runner `PACKAGES_ROOT` mount
  `${HOST_PACKAGES_ROOT:-/var/lib/cloud-harness/packages}:${PACKAGES_ROOT:-/var/lib/cloud-harness/packages}`
  after `:89`.
- `scripts/verify-compose-boundaries.mjs`: the runner packages mount exists; the proxy `env_file` is not
  the runtime env file; with the default env, proxy `ALLOWED_HOSTS` contains no npm or PyPI host.
- `docs/configuration.md` "Managed toolbox" table, `docs-site/reference/environment-variables.md`, and
  `docs/operations.md` (backup and retention of `PACKAGES_ROOT`, the `provisioning-proxy.env` runbook).

Tests:
- `packages/contracts/test/package-schemas.test.ts`: names, specs, scope/workspaceId refinements, `apt`
  accepted, `instance` refused.
- `contracts.test.ts`: the new codes.
- `apps/runner/test/package-store.test.ts`: every transition, replay, digest/generation/expiry/fence
  refusals, the history trim, GC selection, and reconcile queries, using a real temp SQLite.
- `apps/runner/test/egress-proxy.test.ts`: the extra-hosts parsing.
- Gates: `npm run verify:compose`, `npm run verify`.

### B1 — Builder and verification (parallel)
Files:
- `apps/runner/src/package-builder.ts` (new): argv builders, scripts, output parsers, proxy CONNECT
  probe, tree verification, launch check, image-ID lookup. Interface:
  `resolvePlan(spec) → ResolvedPlan`, `build(job) → {treeDigest,sizeBytes,fileCount,sbom,runtime}`,
  `launchCheck(rel, stagingDir, binaries)`, `probeHost(proxy, host)`.
- `apps/runner/src/toolbox-runner.ts` (`binDirs`, `withManagedBins`).
- `test/integration/package-registry-fixture.ts` (new) and `test/integration/fixtures/packages/**` (new).
- `test/integration/package-builder.docker.test.ts` (new).
- `package.json` (append it to `test:docker`).

Unit tests:
- `apps/runner/test/package-builder.test.ts`: exact argv (no socket, env-file, or secret flags; hardening
  present; the staging mount target equals the final path); positional-arg quoting; parser rejection of
  oversized or malformed output and foreign tarball hosts; symlink, special-file, and setuid fixtures;
  the probe against a local TCP server returning 200 and 403.
- `toolbox-runner.test.ts`: `binDirs` validation and PATH order.

### B2 — PackageService orchestration (parallel; tests use a fake of the B1 interface)
Files:
- `apps/runner/src/package-service.ts` (new):
  - `execute(ownerId, op, input)` for the 5 tools, including NOT_SUPPORTED, the flag, ecosystem, auth,
    and approval-mode gates, conflicts, and affected workspaces;
  - the async job runner with the semaphore, timeout, and redacted output tail;
  - `profileFor(ownerId, workspaceId) → {mounts, binDirs}`, which skips and reports `MISSING`
    releases and applies the precedence rule;
  - `toolboxMounts(ownerId)`, `reconcileStartup()`, and `collectGarbage(now)`.

Unit tests (`apps/runner/test/package-service.test.ts`):
- the full happy path with the fake builder;
- each failure code;
- a crash at each state, simulated by a new service over the same DB plus seeded directories, then
  reconcile;
- rename-then-commit failure cleanup;
- owner isolation: another owner's plan, apply, binding, or release returns `NOT_FOUND`;
- workspace-scope override and conflicts;
- the GC reference matrix;
- `waitMs` polling.

### C — Dashboard (parallel)
Files:
- `packages/contracts/src/internal-runner-api.ts`: `package_overview`, `package_plan_list`,
  `package_plan_approve {planId, planDigest}`, `package_plan_reject {planId}`, and
  `package_rollback {bindingId, releaseId, expectedGeneration}`, added to the enum (`:179-200`), the
  inputs (`:290`), and the union (`:591`).
- `apps/runner/src/dashboard-control-service.ts`: cases next to the privilege grants (`:394-430`), using
  `new PackageStore(this.principals.database)` and `this.metadata.recordAuditInTransaction`. These
  return `enabled:false` and empty lists when the flag is off; approve and rollback return `FORBIDDEN`.
- `apps/api/src/dashboard-control-router.ts` (after `:181`): `GET /api/v1/packages`,
  `GET /api/v1/package-plans`, `POST /api/v1/package-plans/:planId/approve|reject`, and
  `POST /api/v1/packages/rollback`.
- `apps/api/dashboard/dashboard-pages.js` (Packages page in `operate`).
- `apps/api/dashboard/dashboard-render.js`: `renderPackages`; `renderApprovals` gains a "Package plans"
  section showing digest, version, source, integrity, deps, size, binaries, and conflicts;
  `planIsActionable`.
- `apps/api/dashboard/dashboard.js`: the loaders, the approvals badge counting both kinds, and an
  approve action that posts the shown `planDigest`.
- `apps/api/src/dashboard-assets.ts` (path parity).
- `docs-site/dashboard/packages.md` (new), `docs-site/dashboard/approvals.md`, and
  `docs-site/.vitepress/config.ts` (sidebar near `:131`).

Tests:
- `apps/runner/test/dashboard-control-service.test.ts`: approve with a wrong digest, foreign owner, or
  expired plan; rollback refusals; the audit rows.
- `apps/api/test/dashboard-privilege-grants.test.ts`, extended or a sibling: the routes and the CSRF
  and Origin checks.
- `dashboard-pages.test.ts`, `dashboard-ui-contract.test.ts`, and `dashboard-response-totality.test.ts`.

### D — Integration and public surface (after B1, B2, C)
Files:
- `packages/contracts/src/runner-api.ts`: add the 5 ops (wt:`:10`).
- `packages/contracts/src/tool-schemas.ts`: schemas, titles, descriptions, and the annotation sets
  (wt:`:1153-1188`).
- `apps/runner/src/workspace-service.ts`:
  - construct `PackageService` in the constructor (`:214`);
  - dispatch `packages_*` before workspace resolution next to the toolbox line (wt:`:2395`), and pass
    `ownerId` into `runToolbox`;
  - replace `mounts: []` (wt:`:2122`) with `toolboxMounts(ownerId)` plus `binDirs`;
  - in `createExecutor` (wt:`:740-777`), add `profileFor` mounts with `:ro` and the PATH from
    `withManagedBins`;
  - call `reconcileStartup` after `:453` and `collectGarbage` in the reaper.

  The privileged ephemeral exec (wt:`:2185`) stays unchanged.
- `apps/api/src/local/local-workspace-backend.ts` and `multi-local-workspace-backend.ts`.
- `scripts/build-docs-reference.mjs`: a new "Managed Packages" category.
- `test/integration/packages-lifecycle.docker.test.ts` (new), and `package.json` (`test:docker`).
- The docs listed under Docs, below.

Tests:
- `apps/runner/test/packages-dispatch.test.ts`: flag-off `FORBIDDEN` for all 5 tools, with no container
  spawned (`docker` spy); `packages_*` never takes the workspace mutation lock; the executor argv
  contains each profile release `:ro` and the PATH order; the profile row is written.
- `packages/contracts/test/packages-tool-contract.test.ts`: annotations, and strictness.
- The local-backend tests.
- `cloudharness-skill-contract.test.ts`.
- `npm run docs:reference`, `npm run plugin:sync`, and `npm run verify`.

## Docker tests and running them behind the TLS-intercepting proxy

Both new suites use `dockerPrerequisiteIssue` and `requireDockerPrerequisites`
(`test/agent-docker-test-support.ts:15-41`), so CI (`CLOUD_HARNESS_REQUIRE_DOCKER_TESTS=1`,
`.github/workflows/ci.yml:51`) fails instead of skipping.

**Hermetic registries.** The fixture creates `docker network create --internal chm-pkgtest-<hex>` and
starts the executor image as `fake-registry` (alias), running
`test/integration/fixtures/packages/fake-registry.mjs` with the fixtures mounted read-only. At startup
the registry does the following:
- runs `npm pack` on the fixture packages: `chm-hello@1.0.0` (bin, one dependency `chm-dep`, and a
  `postinstall` that writes a marker), `chm-hello@1.1.0` (`--version` and `--help` both exit 1), and
  `chm-clash` (bin `chm-hello`);
- serves the packuments with `http://fake-registry:4873/...` tarballs and the computed sha512;
- writes `chm_hello-1.0.0-py3-none-any.whl` with a minimal STORED-zip writer (`zlib.crc32`), carrying
  a `console_scripts` entry;
- serves a PEP 503 `/simple/` index and `/python/<tag>/<file>` as the uv Python mirror.

The tests construct `PackageService` and `PackageBuilder` with test-only constructor options
`{ network, proxy: undefined, npmRegistry, pypiIndex, pythonMirror }`. These map to
`npm_config_registry`, `UV_INDEX_URL`, and `UV_PYTHON_INSTALL_MIRROR`, and the proxy probe is skipped.
No builder ever reaches the real network or TLS. For the uv Python archive, `beforeAll` runs
`uv python list --only-downloads --output-format json` in the executor image to find the URL for a 3.12
build, downloads it once on the host with `curl -fL` (which honours `HTTPS_PROXY`; here, set
`CURL_CA_BUNDLE=/root/.ccr/ca-bundle.crt`), and caches it under `.cloud-harness-test-fixtures/packages/`
(already gitignored). If the download fails, that becomes a prerequisite issue.

- `package-builder.docker.test.ts` (B1):
  - npm resolve, build, verify, and launch check pass;
  - the `postinstall` marker is absent;
  - the shebang and symlinks are valid at the final path;
  - the tree digest is stable across two reads;
  - 1.1.0 fails the launch check;
  - a tiny `maxReleaseBytes` gives `LIMIT_EXCEEDED`;
  - the uv build runs the CLI from a read-only mount with `--network none`;
  - no `cloud-harness.role=package-builder` containers are left.
- `packages-lifecycle.docker.test.ts` (D), through `WorkspaceService.execute`:
  - plan, approve via `PackageStore`, apply, then poll status to `SUCCEEDED`;
  - `bash` with the toolbox target runs `chm-hello`;
  - an apply with `chm-clash` plans `CONFLICT`;
  - re-plan 1.0.0 → 1.1.0 fails, and the binding stays on 1.0.0;
  - rollback works;
  - after killing mid-build (abort and a new service instance), reconcile leaves no staging, the apply
    is `FAILED/RUNNER_RESTARTED`, and the fence is cleared;
  - GC keeps the history releases.

  A workspace executor that opens a local bare repo gets the release mounted `:ro` and on PATH. The
  "existing workspace unchanged until recreated" case asserts that the profile row is unchanged.

**Building the executor image here.** The base must trust `/root/.ccr/ca-bundle.crt`.
1. Run
   `docker build -t node:24.11.0-bookworm-slim -f- "$SCRATCH/ca-base"`
   from a scratch dir holding `ca-bundle.crt`, with this Dockerfile:
   `FROM mirror.gcr.io/library/node:24.11.0-bookworm-slim`,
   `COPY ca-bundle.crt /usr/local/share/ca-certificates/agent-proxy.crt`, and
   `ENV NODE_EXTRA_CA_CERTS=… SSL_CERT_FILE=… CURL_CA_BUNDLE=…`, all pointing at that file.
2. Run
   `docker build --build-arg HTTP_PROXY --build-arg HTTPS_PROXY -f docker/executor.Dockerfile -t cloud-harness-executor:local .`.
3. Run `docker rmi node:24.11.0-bookworm-slim` to remove the shadowing base.

The resulting image is test-only and must never be pushed. If a fetch fails, check
`curl -sS "$HTTPS_PROXY/__agentproxy/status"`. Then run
`CLOUD_HARNESS_REQUIRE_DOCKER_TESTS=1 npm run test:docker` and stop the fixture containers and network
in `afterAll`.

## Docs (D unless assigned above)

- `docs/mcp-api.md`: tools, approval flow, durable status, pinning, `NOT_SUPPORTED`, and the new codes.
- `docs/security-model.md`: the builder boundary, the egress opt-in, verification, read-only mounts,
  owner-bearer approval semantics, and the executable owners plus Docker evidence.
- `docs/system-architecture.md`: the packages root and component.
- `docs-site/reference/tools.md`, generated.
- `docs-site/security-model.md`, `docs-site/troubleshooting.md` (proxy 403, approval unavailable,
  stale image), and `docs-site/reference/limits.md`.
- `.agents/skills/cloudharness/SKILL.md` and `references/execution-and-tasks.md` (when to use the
  toolbox versus workspace installs, plan/approve/apply/status), plus `tool-reference.md`; then
  `npm run plugin:sync`.
- ADR 0003 itself needs no change.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| A malicious package runs code in the builder or toolbox | M×M | Scripts off by default; executor hardening; builder egress only via the allow-listed proxy; no credentials; launch check `--network none`; same trust domain per ADR 0003 |
| A builder writes after the container "ends", or races the digest | L×H | Remove the container and confirm its absence before verifying; reconcile removes ephemeral containers before staging |
| Crash between rename and commit | L×M | A directory without a `VERIFIED` row is deleted at boot; the apply fails with `RUNNER_RESTARTED` |
| Unpinned `uv:latest` or an image upgrade breaks releases | M×M | Image ID in the plan digest; `stale` flag in list; re-plan guidance; launch check per release |
| Compose `env_file.required:false` needs Compose ≥2.24 | L×M | `verify:compose` in CI; documented minimum |
| The uv Python redirect host is not allow-listed | M×L | Probe error names the host; the Docker test uses the mirror; [UNVERIFIED] host listed |
| Proxy allow-list grows for all provisioning users | L×L | Separate opt-in file; default unchanged and asserted by `verify:compose` |
| Disk exhaustion | M×M | Release, owner, and binding quotas; free-space reserve; hourly GC; bounded history |

## Rollback

Each sub-phase reverts by commit, and setting `PACKAGES_ENABLED=false` disables everything at runtime
without a redeploy of data. The new tables and `PACKAGES_ROOT` are inert when unused, and no existing
table changes, so a revert needs no data migration. After D is reverted, workspaces created with
profiles keep their read-only mounts until recreated. The proxy change is inert while
`PACKAGES_PROXY_HOSTS` is empty.

## Success criteria

- `npm run verify` and `npm run verify:compose` pass.
- `npm run test:docker` passes, including both new suites, with `CLOUD_HARNESS_REQUIRE_DOCKER_TESTS=1`.
- With the flag off, the dispatch test proves that no container starts and no mount or PATH changes.
- The ADR invariants are each asserted by a named test: digest, generation, expiry, single-use, fence,
  read-only mounts, no network in the launch check, atomic publish, and boot recovery.

## Resolved decisions

1. uv uses `uv venv` plus `uv pip sync --require-hashes`. Integrity checking of every wheel outweighs
   matching the literal `uv tool install` command, which cannot consume a hashed lock.
2. No unbind or uninstall tool in this slice. The issue asks for install, upgrade, and rollback;
   rollback to an earlier verified release covers recovery. An unbind tool is a follow-up if needed.
3. `owner-bearer` with `required` approval keeps `packages_plan` working and refuses `packages_apply`
   with `FORBIDDEN`, naming the `PACKAGES_APPROVAL_MODE=none` opt-in. The runner still starts, because
   the toolbox flag is off by default and refusing to boot would break unrelated features.
4. The managed Python download redirect host is verified empirically in the 4B1 Docker test before it is
   added to any allow-list; until then it stays out of the documented host list.
