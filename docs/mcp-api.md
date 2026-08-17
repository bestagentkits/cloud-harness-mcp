# MCP usage and tool semantics

## Connection

The Streamable HTTP endpoint is
`https://cloud-harness-mcp.46-250-239-227.sslip.io/mcp`. Every request must
carry the owner's bearer token. The recommended Codex configuration is in the
[README](../README.md#connect-from-codex); the supported fields are documented
by [OpenAI](https://developers.openai.com/codex/mcp).

The canonical public tool names are the `RunnerOperationSchema` values in
[`packages/contracts/src/runner-api.ts`](../packages/contracts/src/runner-api.ts).
Inputs, bounds, annotations, and defaults are owned by
[`packages/contracts/src/tool-schemas.ts`](../packages/contracts/src/tool-schemas.ts).
Results use the stable envelope defined in
[`packages/contracts/src/mcp-results.ts`](../packages/contracts/src/mcp-results.ts):
inspect `structuredContent` for `ok`, `data`, `error`, `truncated`, and
`cursor`; the text content is a concise human message.

## Normal workflow

1. Call `workspace_open` with a credential-free HTTPS repository URL, an
   optional ref, and a fresh idempotency key.
2. Keep the returned opaque `workspaceId` and pass it to workspace-scoped
   tools. Do not derive IDs or use filesystem paths as handles.
3. Use bounded file and code-intelligence tools for inspection and edits. Use
   `exec_run`, shells, sessions, or tasks only when arbitrary code execution is
   intended.
4. Read cursors and `truncated` instead of assuming a response is complete.
5. Close shells and sessions, cancel unwanted tasks, then call
   `workspace_close`.

Reusing a `workspace_open`, `shell_open`, `sessions_open`, or `tasks_run`
idempotency key returns the prior created resource for that workspace. This
makes a lost response recoverable without duplicating work.

## Semantics that are easy to misread

- `files_apply_patch` is not a unified-diff parser. It performs one exact
  `oldText` to `newText` replacement and rejects a missing or non-unique
  `oldText`. Supply `expectedSha256` when a concurrent edit must be detected.
- `files_write` replaces a file atomically inside the workspace. Its
  `expectedSha256` option requires the target to exist and match.
- `exec_run` accepts raw Bash and is intentionally remote code execution
  inside the executor. It is request-owned and bounded by timeout/output
  settings. If its API request disconnects or reaches the API deadline, the
  runner terminates and verifies the operation's process groups; the workspace
  remains active for later calls.
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

## Repository opening policy

The runner accepts credential-free HTTPS URLs on configured allowlisted hosts,
rejects URL userinfo and non-443 custom ports, and rejects hosts resolving to
private/link-local addresses. Clone uses a constrained helper and resets the
stored remote URL to the credential-free URL.

Optional GitHub App settings let the trusted runner mint a short-lived,
repository-scoped installation token for clone and later remote Git transfers.
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
