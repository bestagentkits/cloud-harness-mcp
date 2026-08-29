# Workspace lifecycle, results, and recovery

Every operation outside workspace listing/opening requires the exact opaque
`workspaceId` returned by Cloud Harness. A workspace is owner-bound, limited to
one active workspace in the current service, and removed by close or TTL expiry.

## Result envelope

MCP tool results provide formatted human-readable output and continuation markers
in standard text content, while `structuredContent` carries the machine envelope:

| Field | Meaning |
| --- | --- |
| `ok` | `true` only when the operation succeeded |
| `message` | Bounded human summary |
| `data` | Operation-specific JSON payload when available |
| `error.code` | Stable failure category |
| `error.message` | Bounded failure detail |
| `error.retryable` | Whether retry may be appropriate after checking state |
| `truncated` | Output was cut at a configured or operation bound |
| `cursor` | Continuation handle only for the operation that returned it |

`message` and error messages are at most 2,000 characters. A cursor is at most
256 characters. Not every truncated operation supports continuation; if no
cursor is returned, narrow the request rather than inventing one.

## Error codes

| Code | Response |
| --- | --- |
| `AUTHENTICATION_FAILED` | Stop; correct or rotate client credentials outside the workspace. |
| `FORBIDDEN` | Stop; target or action is outside owner policy. |
| `INVALID_INPUT` | Correct fields, bounds, paths, or invalid state transition. |
| `NOT_FOUND` | Re-list or re-read; do not guess an ID/name/path. |
| `CONFLICT` | Re-read current state and rebuild the intended mutation. |
| `EXPIRED` | The workspace/resource is gone; open a new workspace if authorized. |
| `LIMIT_EXCEEDED` | Close/reduce resources or wait when explicitly retryable. |
| `TIMEOUT` | Inspect current state before rerunning; work may have partially changed state. |
| `CANCELLED` | Inspect current files/Git/process state before deciding next action. |
| `UNAVAILABLE` | Retry only when marked retryable and after checking external prerequisites. |
| `INTERNAL_ERROR` | Preserve bounded evidence and stop repeated retries. |

## Idempotency keys

Keys are 8–128 characters and may contain ASCII letters, digits, `.`, `_`, `:`,
and `-`. Use a fresh semantic key for a new resource. Reuse the same key only to
recover a lost response from `workspace_open`, `shell_open`, `sessions_open`, or
`tasks_run`. Reuse returns the previously created resource in that workspace;
it does not create a replacement.

## Workspace operations

<!-- cloudharness-tool:workspace_open -->
### `workspace_open`

Clone an approved repository and start its bounded executor.

- Required: `repositoryUrl` (credential-free HTTPS URL), `idempotencyKey`.
- Optional: `ref` (1–255 characters, cannot start with `-`), `networkMode`
  (`none` or `bridge`; service default when omitted).
- Returns workspace metadata including opaque `workspaceId`, status, network
  mode, timestamps, and expiry.
- Side effects: clone, state record, workspace directory, executor creation;
  may contact the approved repository host through the trusted clone broker.
- Recovery: after a lost response, retry with the same key. A different key is
  a new open request and may hit the one-active-workspace limit.

<!-- cloudharness-example:workspace_open
{"repositoryUrl":"https://github.com/example/project.git","ref":"main","idempotencyKey":"open-project-20260817","networkMode":"none"}
-->

<!-- cloudharness-tool:workspace_list -->
### `workspace_list`

List owner-visible workspace records, including inactive records.

- Optional: `cursor`; `limit` defaults to 100 and permits 1–500.
- Returns `data.workspaces`; a next cursor is returned when another page exists.
- Read-only and safe to repeat.

<!-- cloudharness-tool:workspace_status -->
### `workspace_status`

Read one workspace record by opaque ID.

- Required: `workspaceId`.
- Returns current lifecycle state and metadata. It can inspect a closed or failed
  record, unlike tools that require an active executor.
- Read-only and safe to repeat.

<!-- cloudharness-tool:workspace_capabilities -->
### `workspace_capabilities`

Inspect workspace and bound repository authorization capabilities without modifying state or minting tokens.

- Optional: `workspaceId`.
- Returns high-level capabilities (`repository`, `workspace`), fine-grained permissions (`contents`, `issues`, `pullRequests`), and direct operation authorizations (`gitPush`, `issueCreate`, `pullRequestCreate`, etc.).
- Read-only and safe to repeat.

<!-- cloudharness-example:workspace_capabilities
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa"}
-->

<!-- cloudharness-tool:workspace_close -->
### `workspace_close`

Terminate the executor and remove the workspace directory.

- Required: `workspaceId`.
- Returns the final closed record. Closing an already closed workspace succeeds.
- Destructive and irreversible for uncommitted changes and unpushed commits.
  Review Git status, close managed processes, and preserve authorized results
  before calling.

<!-- cloudharness-example:workspace_close
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa"}
-->

<!-- cloudharness-tool:workspace_lease_renew -->
### `workspace_lease_renew`

Explicitly renew the active workspace idle lease or reactivate a recoverable expired workspace.

- Optional: `workspaceId`, `extensionSeconds` (60–86,400).
- Returns refreshed lease metadata with remaining lease time.

<!-- cloudharness-example:workspace_lease_renew
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","extensionSeconds":3600}
-->

<!-- cloudharness-tool:workspace_recover -->
### `workspace_recover`

Recover an active or recoverable expired workspace to active state, or inspect, patch, or export unpushed work.

- Optional: `workspaceId`, `mode` (`resume` (default), `status`, `patch`, or `export`), `targetBranch`.
- Returns restored active workspace, recovery status, unpushed patch, or branch recovery details.

<!-- cloudharness-example:workspace_recover
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","mode":"resume"}
-->

<!-- cloudharness-tool:workspace_context -->
### `workspace_context`

Read compact active workspace overview, branch, remaining lease, and Git identity.

- Optional: `workspaceId`.
- Returns active workspace ID, repository URL, current branch, remaining lease time, and default Git author.

<!-- cloudharness-example:workspace_context
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa"}
-->

<!-- cloudharness-tool:workspace_set_active -->
### `workspace_set_active`

Set the preferred active workspace for subsequent calls that omit `workspaceId`.

- Required: `workspaceId`.
- Returns confirmation and updated active workspace context.

<!-- cloudharness-example:workspace_set_active
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa"}
-->

## Lifecycle details

- Active workspace calls refresh idle expiry but cannot extend beyond the
  configured absolute lifetime.
- Workspace metadata is durable; executor files exist only until close/expiry.
- Shell, session, task handles and buffered output are in runner memory. After a
  runner restart, surviving executors are restarted so lost processes do not
  continue invisibly; old process handles are not recoverable.
- Closing a workspace evicts every shell/session/task record for that workspace.
- If a workspace is `EXPIRED`, never reuse its handle. Open a new authorized
  workspace and reconstruct state from durable repository history.

## Interrupted mutation checklist

1. Read the structured error and `retryable` flag.
2. Recheck workspace status.
3. Inspect the affected file, Git state, task list, or external result.
4. Retry only when the desired effect is absent and the operation is safe.
5. For create operations with an idempotency key, reuse the original key.
6. Report any outcome that remains unverifiable.
