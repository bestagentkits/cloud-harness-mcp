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
3. Use bounded file/search tools for inspection and edits. Use `exec_run`,
   shells, or tasks only when arbitrary code execution is intended.
4. Read cursors and `truncated` instead of assuming a response is complete.
5. Close shells and tasks when appropriate, then call `workspace_close`.

Reusing a `workspace_open`, `shell_open`, or `tasks_run` idempotency key returns
the prior created resource for that workspace. This makes a lost response
recoverable without duplicating work.

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
- Shells and detached tasks are workspace-owned during a runner process
  lifetime, but their handles and buffered output are in memory. They are not
  recoverable after a runner restart. Startup restarts each surviving executor
  so processes whose handles were lost cannot continue invisibly.
- In-memory operation retention is bounded per workspace: completed records
  are evicted as handle limits are reached, retained output shares a fixed
  budget, and closing the workspace evicts all of its shell/task state.
- Workspace metadata is durable in SQLite; executor files persist only until
  workspace close or TTL cleanup.
- Executors have no network by default. `git_fetch`, dependency installation,
  and other network commands require an explicitly requested/configured
  `bridge` workspace, which is a weaker security boundary.
- There is no Git push tool. Executors receive no GitHub App token, deployment
  credential, SSH key, or persisted Git credential. A private repository may
  be cloned by the trusted broker at workspace creation, but later authenticated
  fetch or push is not available inside the executor.
- Skills are discovered only from repository-local `.agents/skills`,
  `.codex/skills`, and `.claude/skills` directories. Hooks come from the
  repository's `.cloud-harness/hooks.json`, and memories are files inside the
  workspace. Treat all of them as repository-controlled code or data.

Tool annotations inform client approval UX. They do not replace review of the
command, repository, network mode, or workspace changes.

## Repository opening policy

The runner accepts credential-free HTTPS URLs on configured allowlisted hosts,
rejects URL userinfo and non-443 custom ports, and rejects hosts resolving to
private/link-local addresses. Clone uses a constrained helper and resets the
stored remote URL to the credential-free URL.

Optional GitHub App settings let the trusted runner mint a repository-scoped
installation token for the initial GitHub clone. The token is passed to the
clone helper over stdin and never enters the executor. This path is
configuration- and leak-tested without credentials; live private-clone
verification must be performed by the owner when valid App credentials are
supplied.
