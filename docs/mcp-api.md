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

Reusing a `workspace_open`, `shell_open`, `sessions_open`, `tasks_run`, or
`workspace_finalize` idempotency key returns the prior created resource for that
workspace. This makes a lost response recoverable without duplicating work.
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
  `pr_create`, `issue_list`, `issue_view`, `issue_create`, `issue_comment`,
  `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`,
  `issue_update`, `issue_publish`) through an ephemeral helper container using short-lived tokens
  minted from the configured GitHub App. `issue_publish` provides a single brokered request
  that posts a comment and adds or removes labels (with automatic missing-label creation).
  Tokens are supplied exclusively via stdin and are never written to workspace files.
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
- `workspace_lease_renew` and `workspace_recover` allow inspecting and extending
  workspace idle leases or recovering unpushed commits and patches from active or
  grace-period `EXPIRED_RECOVERABLE` workspaces.
- `operation_status`, `operation_cancel`, and `operation_wait` provide observable,
  cancellable, and reconnectable management of long-running operations.
- `symbols_search` uses Universal Ctags to find definitions. It is not a
  language server. `symbols_references` is a bounded lexical word search, so it
  can include definitions and same-spelling identifiers rather than semantic
  references. Their implementation owner is
  [`worker/harness-worker.mjs`](../worker/harness-worker.mjs), and the executor
  image owns the available indexer in
  [`docker/executor.Dockerfile`](../docker/executor.Dockerfile).
- Shells, named coding sessions, and detached tasks are workspace-owned during
  a runner process lifetime, but their handles and buffered output are in
  memory. They are not recoverable after a runner restart. Startup restarts
  each surviving executor so processes whose handles were lost cannot continue
  invisibly.
- In-memory operation retention is bounded per workspace: completed records
  are evicted as handle limits are reached, retained output shares a fixed
  budget, and closing the workspace evicts all shell/session/task state.
- A task with dependencies remains queued until every named prerequisite has
  succeeded. Failure or cancellation blocks its dependents; the dependency
  graph exposes that scheduling state. Dependency validation and scheduling
  are owned by
  [`apps/runner/src/operation-manager.ts`](../apps/runner/src/operation-manager.ts).
- Workspace metadata is durable in SQLite; executor files persist only until
  workspace close or TTL cleanup.
- Dashboard project/environment, encrypted-secret reference, GitHub binding,
  artifact, and audit operations use the distinct internal runner contract in
  [`packages/contracts/src/internal-runner-api.ts`](../packages/contracts/src/internal-runner-api.ts).
  They are not public MCP tools. Retained artifact snapshots are bounded
  control-plane records, not durable task/session output or a source-control
  replacement.
- Dashboard API-key lifecycle uses a separate internal contract and is not an
  MCP tool. A key remains bound to the creator's durable principal across an
  explicitly applied Access subject relink. Expiry and revocation are checked
  on every request; `lastUsedAt` is coalesced telemetry and never an
  authorization input.
- Executors have no network by default. Dependency installation, arbitrary
  commands, and repository-defined deployments that need network access require
  an explicitly requested/configured `bridge` workspace, which is a weaker
  security boundary. Remote Git fetch, pull, and push do not require executor
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
- Skills are discovered only from repository-local `.agents/skills`,
  `.codex/skills`, and `.claude/skills` directories. Hooks come from the
  repository's `.cloud-harness/hooks.json`, and memories are files inside the
  workspace. Named deployments come from the repository's
  `.cloud-harness/deployments.json` and execute inside the existing executor;
  they do not receive deployment secrets or host credentials from the harness.
  Treat all of these surfaces as repository-controlled code or data.

Tool annotations inform client approval UX. They do not replace review of the
command, repository, network mode, or workspace changes.

## Local stdio mode semantics

When running Cloud Harness MCP over local stdio (`--transport stdio --workspace <path>`):

1. **Pre-opened workspace:** The workspace is configured at process startup. Calling `workspace_open` returns `INVALID_INPUT` explaining that the workspace is already selected.
2. **Lifecycle operations:** `workspace_list` lists the active local workspace. `workspace_status` returns capabilities (`mode: 'local'`, `gitNetwork`, `gitPush`, `sandboxed: false`). `workspace_close` terminates owned child processes but **never deletes the local folder**.
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
access. The broker and leak boundary are owned by
[`apps/runner/src/github-app-broker.ts`](../apps/runner/src/github-app-broker.ts),
[`apps/runner/test/git-transfer-leak.test.ts`](../apps/runner/test/git-transfer-leak.test.ts),
and
[`test/integration/git-transfer-helper.docker.test.ts`](../test/integration/git-transfer-helper.docker.test.ts).
Live private-repository verification still requires owner-supplied credentials
and sanitized evidence.
