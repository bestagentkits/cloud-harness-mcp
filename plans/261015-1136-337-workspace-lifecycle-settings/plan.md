# Workspace limits & lifecycle settings (issue #337)

Status: in progress. Branch `claude/determined-gates-kjy1j7`, PR base `dev`.

## Outcome

Operators change the per-principal active-workspace quota, idle timeout, hard
lifetime, and recoverable grace from Dashboard → Settings without a redeploy.
Changes are durable, audited, concurrency-safe, never retroactive for TTLs, and
auto-close never silently discards unpushed or uncommitted work.

## Non-goals

- Changing the lease policy of already-open workspaces (separate feature).
- A per-principal admin allowlist for instance-wide settings (tracked as its own
  hardening issue; the existing dashboard-only boundary applies here).
- MCP tool access to the policy (dashboard-only internal operation).

## Contract (shared by runner, BFF, UI, docs)

Owner: `packages/contracts/src/workspace-lifecycle.ts`.

Bounds for a Dashboard override (integer seconds):

| Setting | Override range | Runner env (unchanged) | Built-in default |
| --- | --- | --- | --- |
| `maxActiveWorkspacesPerOwner` | 1..64 | `MAX_ACTIVE_WORKSPACES_PER_OWNER` | 3 |
| `idleTtlSeconds` | 60..43200 | `WORKSPACE_IDLE_TTL_SECONDS` (30..43200) | 300 |
| `wallTtlSeconds` | 60..86400 | `WORKSPACE_WALL_TTL_SECONDS` | 900 |
| `recoverableGraceSeconds` | 0..86400 | `WORKSPACE_RECOVERABLE_GRACE_SECONDS` (new) | 3600 |

`settings_update` input (internal runner op and BFF `POST /api/v1/settings`):
`{ defaultNetworkProfile?, workspaceLifecycle? }`, strict, at least one key.
`workspaceLifecycle` = `{ expectedRevision, <setting>?: int | null, acknowledgeImmediateClose?: true }`;
`null` resets a field to the runner value; omitted fields are unchanged; at least
one setting is required; grace `0` requires `acknowledgeImmediateClose: true`;
the resulting effective idle may not exceed the effective wall TTL; a stale
`expectedRevision` is `CONFLICT` (409).

`settings_get`/`settings_update` response adds `workspaceLifecycle`:
`{ revision, updatedAt, settings: { <name>: { value, source: 'setting'|'environment'|'default', runnerValue, min, max } }, reaperIntervalSeconds, usage: { counted, limit, recoverable, autoCloseDeferred }, executorCeilings: { memoryBytes, cpus, pids } }`.

## Runner semantics

- Quota: dashboard override → env → default, resolved inside the same SQLite
  transaction as `admit`/`activateWithLimit`; relinks use the same resolver.
  Lowering it never closes existing workspaces.
- TTL snapshot: `workspace_open` stores `idle_ttl_seconds` and
  `recoverable_grace_seconds` on the row; `hard_expires_at` already snapshots the
  wall TTL. Touch, lease renew, recover, and the reaper use the row snapshot.
  Legacy rows (NULL) fall back to the runner env idle TTL and the former 3600 s grace.
- Expiry transition stamps `expired_at` and `recoverable_until`; `last_activity_at`
  is no longer the grace anchor. Back to ACTIVE clears both.
- Auto-close: the reaper claims only `EXPIRED_RECOVERABLE` rows whose
  `recoverable_until` passed, after a pre-delete check under a recoverable
  mutation lease: active agents, uncommitted/untracked changes, stashes, or
  commits unreachable from any remote ref → defer (stay recoverable, retry after
  max(grace, 1 h), audit `workspace.auto_close_deferred`). Check failure defers
  too (fail closed). A clean workspace closes via `closeRecord`, audited
  `workspace.auto_closed`. Close failures (stop/spool) re-arm the retry window.
- Reads (`workspace_list`, `workspace_status`, dashboard polling) never touch.

## Phases

1. Contracts + config (`packages/contracts`, `apps/runner/src/config.ts`, `.env.example`).
2. Store + service (`apps/runner/src/state-store.ts`, `workspace-service.ts`, worker close check, `agent-manager.ts`).
3. BFF + Dashboard UI (`apps/api/src/dashboard-router.ts`, `apps/api/dashboard/*`).
4. Docs (`docs/configuration.md`, `docs/operations.md`, `docs/mcp-api.md`, `docs/security-model.md`, `docs-site/`).
5. Tests, `npm run verify`, isolated review, PR to `dev`.
