---
phase: 3
title: "Workspace Cockpit shell, Summary, and bounded Dashboard REST adapters (issue Phase 2)"
status: pending
priority: P1
effort: "2-3d"
dependencies: [1, 2]
---

# Phase 3: Workspace Cockpit and bounded REST adapters

Issue phase: **Phase 2**. This is the phase that makes workspace detail an
operator surface and that adds the adapter layer every later phase depends on.

## Goal

Workspace detail becomes a cockpit: `Summary | Agents | Runtime | Files | Git |
Automation | Deploy | Artifacts | Activity`, with a header that answers "what is
this, what state is it in, how long has it got" and the lifecycle actions an
operator actually needs. Every capability the cockpit reaches is exposed through
a bounded Dashboard REST adapter, never a raw runner endpoint.

## Tasks

1. **Adapter layer first.** Extend `apps/api/src/dashboard-control-router.ts`
   (or the adjacent router that owns the operation) with `endpoint(op, parse)`
   registrations and add each operation to `DASHBOARD_RESPONSE_OPERATIONS` in
   `apps/api/src/dashboard-response.ts` with a mapper that whitelists fields.
   Operations this phase needs:
   `workspace_lease_renew`, `workspace_recover`, `workspace_context`,
   `workspace_finalize`, `agent_list`, `agent_status`, `agent_logs`,
   `agent_message`, `agent_cancel`, `task_status`, `task_cancel`, `task_graph`,
   `session_list`, `session_open`, `session_close`, `git_status`, `git_diff`,
   `git_log`, `worktree_list`, `skill_list` (workspace-scoped), `hook_list`,
   `deployment_list`. Confirm exact tool names against
   `packages/contracts/src/tool-schemas.ts` before wiring.
   - Whitelist mapper per operation: never pass through owner IDs, runner tokens,
     container names, internal paths, or unbounded output. Reuse
     `cleanWorkspace`'s allowlist style.
   - Every mutating operation keeps CSRF/Origin protection and principal scoping.
2. **Redaction evidence.** One test per new mapper asserting that forbidden field
   names and values never appear in the response, plus a case for a populated raw
   runner payload containing those fields.
3. **Cockpit shell.** Workspace sub-navigation rendered from the workspace route
   set (not global sidebar entries), preserving the current `#context-nav`
   pattern (`dashboard.js:2688`) and `aria-current="page"`.
4. **Header state.** Repository name, workspace status, ref/branch, network
   profile, TTL remaining with thresholds, and a concise attention state; primary
   actions `Renew lease`, `Finalize workspace`, and a `More actions` menu with
   recover/close where applicable.
5. **Summary tab.** Health, active/running agents, running/blocked tasks, Git
   dirty state, cost used vs budget where available, lease remaining, network
   posture, and a "Needs attention" panel with reasons: near expiry,
   failed/limit-exceeded agent, blocked/failed task, dirty Git before finalize,
   network quarantine, MCP/integration failure relevant to this workspace.
6. **Secondary metadata.** Technical IDs, generation and timestamps move into a
   secondary metadata block, not the header.
7. **Loading, empty and error states** for every cockpit tab, including tabs whose
   phase has not landed yet (they must explain the next useful action rather than
   render nothing).

## Acceptance criteria

- Cockpit tabs navigate with keyboard only, mark exactly one `aria-current`, and
  keep the workspace context on back/forward.
- Header shows the listed state; TTL emphasises as it approaches expiry.
- Needs-attention covers all six listed reasons and links to the filtered view.
- Every new adapter is redaction-tested and principal-scoped; no response contains
  a forbidden field.
- `/dashboard/workspaces/:id` and its `files`/`runtime` sub-routes still work.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Browser QA: desktop, tablet and ~375px; dark and light; keyboard-only cockpit
navigation; TTL near-expiry emphasis; empty and error states.

## Risks

| Risk | Mitigation |
|---|---|
| Adapter surface is large and ships half-wired | Adapters land in one commit with tests; UI tabs consume them one commit each |
| A needed operation does not exist in the runner contract | Stop and ask: adding runner capability can change the security model (blocker rule) |
| Runner payloads leak internal fields into the DOM | Mapper whitelist first, then UI; redaction tests per operation |
