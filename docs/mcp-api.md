# MCP usage and tool semantics

## Connection

The current operator deployment has two Streamable HTTP endpoints:

- `https://harness.zuey.me/mcp` for Cloudflare Access Managed OAuth through
  GitHub or Google; and
- `https://api.harness.zuey.me/mcp` for static-header clients using a
  dashboard-managed API key as `Authorization: Bearer <key>`.

The lanes are intentionally non-interchangeable. Managed keys are accepted
only through the fixed Worker gateway; the hidden origin path is not a client
endpoint. `owner-bearer` remains the default authentication contract for
separate private deployments. The
recommended client routes are in the
[README](../README.md#connect-from-ai-clients). Do not treat implementation or
configuration as proof that a specific client has completed live OAuth.

The canonical public tool names are the `RunnerOperationSchema` values in
[`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts).
Inputs, bounds, annotations, and defaults are owned by
[`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts).
Results use the stable envelope defined in
[`packages/contracts/src/mcp-results.ts`](../packages/contracts/src/mcp-results.ts):
MCP tools return formatted human-readable output, metadata, error details, and
continuation markers in the text content, while preserving the complete machine
envelope in `structuredContent`.

Create, inspect, and revoke managed keys in `/dashboard/api-keys`. The complete
key is returned once at creation; later list responses contain only safe
metadata. Keys grant the same full MCP/RCE authority as their creator, expire
in 1–3,650 days (approximately 10 years), and are limited to 10 active keys per principal. There are no
scopes, recovery, ownership transfer, or rotation endpoint. Rotate by creating
a replacement, updating the client, verifying it, then revoking the old key.
The lifecycle contract is owned by
[`packages/contracts/src/api-key-api.ts`](../packages/contracts/src/api-key-api.ts).

## Normal workflow

1. Call `workspace_open` with a credential-free HTTPS repository URL, an
   optional ref, and a fresh idempotency key. To inject a retained dashboard
   environment, select its opaque ID and explicitly confirm the injection in
   the same request; omitting either injects nothing.
   To pre-install agent toolkits (e.g. `mattpocock/skills`, `obra/superpowers`,
   or custom Git repos), provide the `toolkits` parameter. Default `owner`
   scope mounts toolkits read-only at `/opt/cloud-harness/owner-skills` without
   polluting git status; `workspace` scope materializes files into
   `.cloud-harness/skills` with `allowToolkitWorkspaceChanges: true`.
2. Subsequent tool calls can omit `workspaceId` when exactly one active
   workspace is open. The runner automatically resolves the active workspace,
   or returns a structured `CONFLICT` ambiguity error if multiple exist.
3. Use bounded file and code-intelligence tools for inspection and edits.
   `files_write_batch` allows atomic multi-file creation with parent directory
   scaffolding in one call.
4. When ready to publish, use `workspace_finalize` to run preflights, stage,
   commit, and push to origin in a single idempotent transaction.
5. Read cursors and `truncated` or use `readAll: true` instead of assuming a response is complete.
6. Close shells and sessions, cancel unwanted tasks, then call
   `workspace_close`.

Reusing a `workspace_open`, `shell_open`, `sessions_open`, `tasks_run`,
`workspace_finalize`, `agent_spawn`, or `agent_message` idempotency key returns the
prior created resource or delivery state for that workspace. This makes a lost
response recoverable without duplicating work.

## Coding-agent operations

The six `agent_*` tools run a bounded Pi coding session against an existing
`networkMode: "none"` workspace. Their exact input limits and result shapes
are the executable `TOOL_SCHEMA_BY_NAME` and `Agent*DataSchema` definitions in
[`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts)
and
[`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts).
Agent calls do not refresh the parent workspace idle TTL.

- `agent_spawn` durably reserves the prompt, budgets, profile, parent, and
  requested proxy-tool subset before launch. Its result is an acknowledgement
  with an opaque ID, generation, status, and replay flag—not prompt
  completion.
- `agent_status` accepts exactly one of the agent ID or spawn idempotency key.
  While full state is retained, it reports lineage, configured policy and
  budgets, usage, timestamps, terminal reason, and `outcomeUnknown`.
  `SPAWNING`, `RUNNING`, and `CANCELLING` are nonterminal; `SUCCEEDED`,
  `FAILED`, `CANCELLED`, `TIMED_OUT`, `LIMIT_EXCEEDED`, and `INTERRUPTED` are
  terminal.
- `agent_logs` uses a nonnegative decimal byte cursor. Continue with
  `nextCursor` while `hasMore` is true. `truncated` means the requested cursor
  predates `retainedBaseCursor`; it can also coexist with another bounded page,
  so neither flag should be treated as the other.
- `agent_message` accepts a bounded `steer` or `followUp` message and a
  message-specific idempotency key. `RESERVED` means delivery was durably
  admitted, `SENT` means it was written to the live worker channel (not that
  the model acted on it), `REJECTED` means it was not accepted, and `UNKNOWN`
  means restart or transport loss prevented a trustworthy determination.
  Replaying the same key returns the recorded state without another send.
- `agent_cancel` is idempotent and cancels descendants in post-order before the
  target. Its bounded result identifies the affected agents; terminal agents
  are not restarted.
- `agent_list` returns a bounded workspace-scoped page without log payloads.
  Its cursor is opaque (unlike a log cursor), and optional parent/status
  filters narrow the page.

Spawn and message idempotency records are durable for the active workspace.
They are never evicted to admit fresh side effects: once the configured
workspace lifetime-record cap is full, new spawn/message reservations are
rejected. After closure and full-state retention, `agent_status` returns a
bounded `compacted: true` outcome record containing the terminal status,
generation, compaction time, and expiry. These tombstones preserve status
and key-collision evidence through the configured lookup horizon; the SQLite
schema and retention policy are owned by
[`apps/runner/src/state-store.ts`](../apps/runner/src/state-store.ts) and
[`apps/runner/src/agent-state-repository.ts`](../apps/runner/src/agent-state-repository.ts).

A runner restart never replays prompts, messages, model requests, or proxy
writes. Any active agent from a prior runner epoch is reconciled: its model
lease is revoked, its container is removed, and its status transitions to
`INTERRUPTED` with `outcomeUnknown: true`.

## Semantics that are easy to misread

- `files_apply_patch` is not a unified-diff parser. It performs one exact
  `oldText` to `newText` replacement and rejects a missing or non-unique
  `oldText`. Supply `expectedSha256` when a concurrent edit must be detected.
- `files_write` replaces a file atomically inside the workspace. Its
  `expectedSha256` option requires the target to exist and match.
- `exec_run` accepts raw Bash and is intentionally remote code execution
  inside the executor. It is request-owned and bounded by timeout/output
  settings. Standard execution runs as user `10001:10001` with `--read-only` rootfs
  and dropped capabilities. When `privileged: true` is requested in `cloudflare-access` mode,
  it requires a valid `approvalGrantToken`. An unapproved request returns `PRIVILEGE_APPROVAL_REQUIRED`
  with a `grantId` for the operator to approve in the dashboard. Approved grants
  execute once in an isolated ephemeral container with `try/finally` cleanup.
  In `owner-bearer` mode, `privileged: true` is rejected as `FORBIDDEN` to prevent unbrokered elevation.
  If its API request disconnects or reaches the API deadline, the
  runner terminates and verifies the operation's process groups; the workspace
  remains active for later calls.
- `github_action` executes authenticated GitHub CLI actions (`pr_list`, `pr_view`,
  `pr_create`, `pr_update`, `pr_comment`, `issue_list`, `issue_view`, `issue_create`, `issue_comment`,
  `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`,
  `issue_update`, `issue_publish`) through an ephemeral helper container using short-lived tokens
  minted from the configured GitHub App. `pr_create` supports draft PRs and labels; `pr_update` supports
  updating title, body, base branch, and closing or reopening PRs; `pr_comment` adds comments with
  idempotency support. `issue_publish` provides a single brokered request
  that posts a comment and adds or removes labels (with automatic missing-label creation).
  Tokens are supplied exclusively via stdin and are never written to workspace files.
  All write actions emit structured `github_action.<action>` events in `audit_events`.
  Failures return typed machine-actionable error codes (`GITHUB_RATE_LIMITED` with retryAfterMs,
  `GITHUB_PERMISSION_MISSING`, `INVALID_PULL_REQUEST_BASE`, `GITHUB_ACTION_FAILED`).
  Comment, label, and publish mutations support idempotency keys.
- Output pagination for tools such as `files_read`, `git_diff`, and `git_log` uses
  snapshot-bound continuation cursors. The cursor is bound to content hashes or commit
  signatures; if underlying files, index, or repository state change between calls,
  subsequent page requests fail deterministically with `CONFLICT` to prevent silent corruption.
- `files_write_batch` writes an array of files in a single atomic transaction. It
  creates missing parent directories by default and verifies expected SHA256 hashes
  prior to modifying any file. If any file fails validation or write, original files
  are restored.
- `workspace_finalize` provides a single transactional endpoint to stage changes,
  run diff preflight checks, commit with workspace/owner default Git identity, and
  push to remote. If a push is rejected or network fails, actionable resumption hints
  and the created commit SHA are returned.
- `workspace_lease_renew` and `workspace_recover` allow inspecting, extending,
  and restoring workspaces across their lifecycle states:
  - **`ACTIVE` → `EXPIRED_RECOVERABLE` → `CLOSED` Lifecycle:** When an active
    workspace's idle lease expires, its container executor is reaped to release CPU
    and memory, but its repository files, unpushed commits, branches, and working-tree
    modifications are retained during a recoverable grace period (`EXPIRED_RECOVERABLE`).
    If the recoverable grace period lapses or the workspace is explicitly closed, it
    transitions to `CLOSED` and all host files are permanently pruned.
  - **`workspace_recover`:** Restores or exports work from active or `EXPIRED_RECOVERABLE`
    workspaces. In `resume` mode (default), it restores the workspace to `ACTIVE` state,
    recreates and starts the executor container on demand, and refreshes the idle lease
    while preserving all local Git and file state. In `status` and `patch` modes, it
    non-destructively returns unpushed changes or unified diffs. In `export` mode, it
    creates a recovery snapshot commit and pushes it to a target remote branch as a
    safety escape hatch even if the hard wall-clock deadline was reached.
  - **`workspace_lease_renew`:** Explicitly extends the idle lease of an `ACTIVE` or
    `EXPIRED_RECOVERABLE` workspace (clamped to the maximum `hardExpiresAt` limit),
    reactivating the executor container if previously reaped.
  - **`availableActions` Metadata:** `workspace_status` and `workspace_list` responses
    expose an `availableActions` string array listing valid lifecycle operations
    (e.g., `['workspace_recover', 'workspace_lease_renew', 'workspace_close']` for
    `EXPIRED_RECOVERABLE` workspaces) to remove guesswork for MCP clients.
- `secrets_list` discovers available global and environment secret names and descriptions without revealing secret values:
  - **Value-Free Discovery:** Returns `{ name, description, scope: 'global' | 'environment', environmentId, version, updatedAt }[]`. Values are write-only and physically unqueried by MCP tools.
  - **Global & Environment Precedence:** Workspaces automatically inherit active Global Secrets. When an environment is specified or bound, environment secrets are merged and override colliding global keys.
  - **Output Redaction (Defense-in-Depth):** When commands (`exec_run`, `tasks_status`, `shell_io`, `sessions_io`) or error messages emit injected secret values (global or environment), the runner's ingest-time stream redactor sanitizes exact matches to `[REDACTED_SECRET: <NAME>]` before buffering, preserving monotonic byte cursor offsets without leaking secret plaintext into MCP conversation transcripts.
- `operation_status`, `operation_cancel`, and `operation_wait` provide observable,
  cancellable, and reconnectable management of long-running operations.
- `symbols_search` uses Universal Ctags to find definitions. It is not a
  language server. `symbols_references` is a bounded lexical word search, so it
  can include definitions and same-spelling identifiers rather than semantic
  references. Their implementation owner is
  [`worker/harness-worker.mjs`](../worker/harness-worker.mjs), and the executor
  image owns the available indexer in
  [`docker/executor.Dockerfile`](../docker/executor.Dockerfile).
- Shells and named interactive coding sessions are workspace-owned during a runner
  process lifetime and remain in-memory ephemeral streams. Background tasks (`tasks_run`,
  `tasks_status`, `tasks_list`, `tasks_cancel`, `tasks_graph`) are durable across process
  restarts: task metadata is persisted in SQLite (`durable_tasks`, `task_dependencies`) with
  composite tenant foreign keys, while task log output is spooled to disk (`/job/.chm/tasks/<id>.log`)
  with 0600 permissions and capped at `maxOutputBytes`.
- Process-scoped `runner_boot_id` ensures safe restart reconciliation: upon runner restart, any
  in-flight tasks from previous boot IDs are cleanly marked `FAILED` (`error_code: "RUNNER_RESTARTED"`),
  while completed task outputs remain readable via cursor-based offset pagination. When a workspace is
  closed or reaped, completed task logs are automatically archived into `ArtifactStore` (`task-output-<id>.log`)
  before the workspace directory is deleted.
- Retrying `tasks_run`, `git_commit`, or `git_push` with an existing `idempotencyKey` returns the
  recorded result with `alreadyFinalized: true` without duplicate execution. Reusing an idempotency key with
  mismatched request parameters is rejected with `CONFLICT`.
- Remote Git push operations enforce Compare-And-Swap via `--force-with-lease=<ref>:<expectedRemoteOid>`
  and classify errors into deterministic `CONFLICT` (409) or network interruptions `UNKNOWN_REMOTE_STATE` (504)
  with structured `resumeAction: "reconcile_push"`. When retrying after an unknown outcome, the runner probes
  the remote reference OID via `git ls-remote` before re-pushing. `git_commit` accepts an optional `expectedHeadOid`
  to reject commits on stale HEADs with `STALE_HEAD` (409).
- Owner-scoped repository caching (`REPO_CACHE_ROOT`, default disabled via `ENABLE_REPO_CACHE=false`)
  maintains isolated bare mirror caches (`chmod 0700`) per principal and clones using
  `git clone --reference-if-able <cache_path> --dissociate`, ensuring workspace object databases become
  completely independent after clone with automatic fallback to blobless clone.
- **MCP Tasks Specification Evaluation (2026-07-28 Revision):** The official Model Context Protocol specification
  ([Overview](https://modelcontextprotocol.io/extensions/tasks/overview), 2026-07-28 revision) transitioned Tasks from
  basic utilities into an optional extension (`io.modelcontextprotocol/tasks`) negotiated via per-request server capabilities
  and `server/discover`. The specification defines methods (`tasks/get`, `tasks/update`, `tasks/cancel`), polymorphic
  tool results (`resultType: "task"`), and progress notifications (`notifications/tasks/progress`).
  According to the official [Extension Client Matrix](https://modelcontextprotocol.io/extensions/client-matrix), major host
  clients (Claude Desktop, Cursor, Codex, ChatGPT Web) do not yet advertise or verify Tasks extension capability handshake.
  Cloud Harness MCP maintains its stable, verified public task tool contracts (`tasks_run`, `tasks_status`, `tasks_list`,
  `tasks_cancel`, `tasks_graph`) as canonical. Standard MCP Tasks facade integration remains evaluated and **default-off**
  until official client host runtime support is verified across the ecosystem matrix.
- Retained artifact snapshots (`artifacts_snapshot`, `artifacts_list`, `artifacts_read`,
  `artifacts_restore`, `artifacts_delete`) allow agents to explicitly retain selected
  workspace files beyond ephemeral workspace TTLs, list and read bounded base64 chunks,
  and restore snapshots into active workspaces for cross-session and cross-agent handoffs.
  Artifacts are principal-owned, TTL-bounded snapshots; they are not Git source history,
  volatile task/session buffers, or arbitrary object storage.
- Dashboard project/environment, encrypted-secret reference, GitHub binding, and audit
  operations use the distinct internal runner contract in
  [`packages/contracts/src/internal-runner-api.ts`](../packages/contracts/src/internal-runner-api.ts).
  They are not public MCP tools.
- Dashboard API-key lifecycle uses a separate internal contract and is not an
  MCP tool. A key remains bound to the creator's durable principal across an
  explicitly applied Access subject relink. Expiry and revocation are checked
  on every request; `lastUsedAt` is coalesced telemetry and never an
  authorization input.
- Executors have no network by default (`networkProfile: "network-none"`).
  Dependency installation, arbitrary networked commands, and repository-defined
  deployments that need egress require an explicitly requested
  `networkProfile: "dependency-access"` workspace. That profile permits only
  public DNS and public TCP 80/443 and blocks loopback-to-host,
  Docker/control-plane, RFC 1918, link-local, and cloud-metadata ranges below
  the executor; it is a weaker boundary that still permits public exfiltration
  and fails closed (`DEPENDENCY_EGRESS_UNAVAILABLE`) when host firewall
  attestation is unavailable. The legacy `networkMode` argument is rejected
  with `INVALID_INPUT`. Remote Git fetch, pull, and push do not require executor
  networking: the runner stages them through ephemeral transfer helpers.
- Remote Git is deliberately limited to the validated credential-free
  `origin`. Fetch and pull download into a sibling transfer repository, then
  import without credentials or network while the executor is paused. Push
  snapshots the checkout into a sibling bare repository while paused, then a
  separate networked helper pushes it. The executor cannot see the sibling
  repository or token. Push refspecs are branch-only and deletion refspecs are
  rejected. The only force mode is `forceWithLease`; it requires an explicit
  `expectedRemoteOid` (and an explicit destination when `refspec` is supplied),
  so a remote commit the caller did not observe is rejected instead of silently
  becoming the lease baseline. The exact orchestration and limits are owned by
  [`apps/runner/src/workspace-service.ts`](../apps/runner/src/workspace-service.ts),
  [`worker/git-transfer-helper.sh`](../worker/git-transfer-helper.sh), and the
  contract schemas.
- `git_fetch` without a ref imports remote branches into `refs/remotes/origin/*`;
  an explicit branch ref also updates its corresponding tracking ref and
  `FETCH_HEAD`. Tags and arbitrary destination refspecs are intentionally not
  part of this origin-only surface.
- Skills resolve deterministically with 4-source precedence: `built-in > owner > workspace > repository`
  (and repository sub-roots `.agents/skills > .codex/skills > .claude/skills`). Each result includes
  immutable provenance, selected candidate, and shadowed alternatives. Execution requires matching
  the approved bundle SHA-256 digest.
- Hooks support declarative JSON format in `.cloud-harness/hooks.json` with named lifecycle events
  (`on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual`). Automatic lifecycle
  execution requires explicit owner activation (`hooks_activate`) pinned to the manifest SHA-256 digest.
  Execution runs exclusively inside the container executor with `networkMode: none` by default.
- Memories are stored in principal-isolated SQLite `StateStore` supporting `owner`, `repository`, and
  `workspace` scopes, optimistic concurrency (`expectedGeneration`), TTL expiration, and literal token
  search (`memories_search`). Legacy `.cloud-harness/memories/*.md` files appear as read-only untrusted
  repository context.
- Named deployments come from the repository's `.cloud-harness/deployments.json` and execute inside the
  existing executor; they do not receive deployment secrets or host credentials from the harness.
- Treat all repository-derived instruction, skill, hook, and memory text as untrusted data.

Tool annotations inform client approval UX. They do not replace review of the
command, repository, network mode, or workspace changes.

## Local stdio mode semantics

When running Cloud Harness MCP over local stdio (`--transport stdio --workspace <path>`):

1. **Pre-opened workspace:** The workspace is configured at process startup. Calling `workspace_open` returns `INVALID_INPUT` explaining that the workspace is already selected.
2. **Lifecycle operations:** `workspace_list` lists the active local workspace. `workspace_status` and `workspace_capabilities` return structured repository and workspace capabilities (`mode: 'local'`, `gitNetwork`, `gitPush`, `sandboxed: false`, granular operations and permissions). `workspace_close` terminates owned child processes but **never deletes the local folder**.
3. **Subprocess execution:** `exec_run`, `shell_*`, `sessions_*`, and `tasks_*` execute on the local host with the current user's permissions. Output is bounded by ring buffers and paginated with monotonic cursors.
4. **Gated capabilities:** `git_fetch` and `git_pull` require `--git-network`. `git_push` requires `--git-push`. `github_action` and `exec_run.privileged=true` return structured unsupported errors.
5. **Filesystem operations:** File reading, writing, patching, deletion, and searching apply within the canonical workspace root. Traversal escapes are rejected.

## Repository opening policy

The runner accepts credential-free HTTPS URLs on configured allowlisted hosts,
rejects URL userinfo and non-443 custom ports, and rejects hosts resolving to
private/link-local addresses. Clone uses a constrained helper and resets the
stored remote URL to the credential-free URL.

Optional GitHub App settings let the trusted runner mint a short-lived,
repository-scoped installation token for clone and later remote Git transfers.
In Access mode the installations and repository grants are bound to the exact
authenticated principal; a principal may bind multiple concurrent installations
(e.g. personal and organization accounts) and the runner selects the matching
installation by repository owner. GitHub SSO alone grants nothing. In
owner-bearer mode the fixed configured installation remains the compatibility
path.
The token is passed over stdin only to the ephemeral helper that needs it; it
is absent from Docker arguments, the checkout remote, result envelopes, and the
long-lived executor. Public clone/fetch/pull can proceed without an App token.
Private clone/fetch/pull require repository Contents read access, while every
push requires a configured App installation with Contents read and write
access. `workspace_capabilities` and `workspace_status` expose structured preflight
information (`capabilities.repository`, `permissions`, `operations`) so clients can
verify whether operations like `git_push` or GitHub actions are authorized before
starting work. Unauthorized repository operations fail with `REPOSITORY_OPERATION_NOT_AUTHORIZED`
identifying the missing capability. The broker and leak boundary are owned by
[`apps/runner/src/github-app-broker.ts`](../apps/runner/src/github-app-broker.ts),
[`apps/runner/test/git-transfer-leak.test.ts`](../apps/runner/test/git-transfer-leak.test.ts),
and
[`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts).
Live private-repository verification still requires owner-supplied credentials
and sanitized evidence.
