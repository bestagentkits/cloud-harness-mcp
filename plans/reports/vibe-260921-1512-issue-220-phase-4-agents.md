# Phase 4 (issue #220, Phase 3): Agent Control Center

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-3` (task-4 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-04-agent-control-center.md`

## Summary

Agents are now first-class. `/dashboard/agents` is a global control center, the
workspace cockpit's Agents tab renders the same body scoped to one workspace, and
one agent opens in a detail view with Overview, Usage, Logs and Messages plus
steer, follow-up and cancel. Adapters for the six agent operations are bounded and
redaction-tested.

Phase 4 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — `agent_list`, `agent_status`, `agent_logs`,
  `agent_message` and `agent_cancel` join the response union. The agent projection
  keeps identity (agent, workspace, parent, profile), status, timestamps, the
  runner's `proxyOperations` allowlist, budget and usage counters; owner ids,
  container names, job paths and prompts never cross. Log events are bounded per
  event (oversized content is truncated with an explicit marker).
- `apps/api/src/dashboard-router.ts` — principal-scoped routes:
  `GET /api/v1/agents`, `GET /api/v1/workspaces/:id/agents`,
  `GET /api/v1/agents/:id`, `GET /api/v1/agents/:id/logs`,
  `POST /api/v1/agents/:id/messages`, `POST /api/v1/agents/:id/cancel`. Status
  filters validate against the runner's enum, so an unknown status is a 400 rather
  than a silent empty list.
- `apps/api/src/dashboard-assets.ts` + `dashboard-pages.js` — the Agents page joins
  the registry under **Operate** (nav, palette, title, help, icon) with `/agents`
  and `/agents/:agentId` served as shell paths; the registry/allowlist parity test
  covers it.
- `apps/api/dashboard/dashboard-render.js` — `agentStatusLabel`,
  `budgetUtilization`, `agentAge`, `agentTtl`, `agentTreeIndex`,
  `renderAgentHierarchy`, `renderAgentTable`, `renderAgentsIndex`,
  `renderAgentDetail`.
- `apps/api/dashboard/dashboard.js` — the global page and the workspace tab share
  one loader and renderer, filters are URL-backed, the detail view loads status and
  bounded logs together, messages carry a client-generated idempotency key, and
  cancel confirms before cascading.
- `docs/design-guidelines.md` — the agent contract, including why a missing budget
  limit reads as "Not reported" instead of 0%.

## Verification

- `npx vitest run dashboard` — 19 files, 274 tests, all passing.
- `apps/api/test/dashboard-agents.test.ts` — hierarchy nesting plus orphan
  attachment, the flat table fallback with its parent column, budget edge cases
  (unknown, zero, 80%, 100%, over-spend clamping), status naming for all nine
  runner states, age/TTL readouts, scoped-vs-global filter shapes, "Not reported"
  honesty, and log-content escaping.
- `apps/api/test/dashboard-router.test.ts` — agent records drop `internal-owner`,
  `executor-secret`, job paths and prompts while keeping identity, budget and usage;
  oversized log content is truncated and marked; the workspace-scoped list passes
  the scope; an unknown status is rejected before the runner is called.
- `npm run typecheck -w @cloud-harness/api` — clean. `npx eslint` — clean.
- `renderAgentDetail` renders for a running agent, a terminal agent and an agent
  with no logs.

## Residual

The issue's attention list mentions failed/limit-exceeded agents as a Workspace
Cockpit reason. The agent data now exists, so that reason is wired in the cockpit
attention panel when the summary is next touched; the cockpit currently reports
the reasons it can read from the workspace record alone (lease, failure,
quarantine, dirty Git).
