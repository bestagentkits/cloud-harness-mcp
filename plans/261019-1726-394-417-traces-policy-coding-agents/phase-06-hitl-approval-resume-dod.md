# Phase 06 (PR6): HITL WAITING_FOR_HUMAN, single-use approval, fenced resume, DoD evidence (#417 D3, D6)

Branch: `feat/417-hitl-approvals` from `dev` after PR2, PR4 and PR5 merge (PR3 for the
full-cycle Jev case). Target `dev`. Effort about 28h. Wave W3. Merges last.

## Context

- PR4 fails closed on REQUIRE_APPROVAL with `ACTION_REQUIRES_APPROVAL`. This PR turns that into a pause.
- `automation_workflows.state` is a CHECK constraint (`apps/runner/src/automation-schema.ts:84`)
  with the partial unique index `automation_workflows_one_active` (:104). Adding a state requires a
  table rebuild.
- Approval precedent: the `privilege_grants` table (command_sha256, status, expires_at, consumed_at),
  routes at `apps/api/src/dashboard-control-router.ts:228-230`, and page `/dashboard/approvals`
  (`apps/api/dashboard/dashboard-pages.js:96`, `renderApprovals` at
  `apps/api/dashboard/dashboard-render.js:730`).
- Admission counts held workspaces at `automation-service.ts:751`.

## Design

- On REQUIRE_APPROVAL, `ActionBroker` creates an approval in the same transaction that moves the
  workflow to `WAITING_FOR_HUMAN`. The approval records the action descriptor digest, policy revision
  ids, gate decision, advisor decision id, agent generation and expiry. The trigger order is:
  1. Snapshot the diff as an artifact.
  2. Stop and clean up the Pi agent, so no idle container is left.
  3. Keep the workspace (counted by `workspacesHeld`).
  4. Emit `emitWaitingForHumanNotification` (PR5).
  5. Write an `approval` span (PR1 store).
- Approve and deny are single-use through `UPDATE ... SET state=? WHERE approval_id=? AND
  state='PENDING' AND principal_id=? AND descriptor_digest=? AND expires_at>now`. Exactly
  one row changes or the request is rejected with a typed reason: `APPROVAL_NOT_FOUND`, `APPROVAL_FORBIDDEN`,
  `APPROVAL_EXPIRED`, `APPROVAL_STALE` (digest or generation changed) or `APPROVAL_ALREADY_DECIDED`.
- Resume (`automation-resume.ts`):
  1. Re-run the broker gate with the approval as the only accepted override for that exact digest.
     A global hardDeny added since then still wins.
  2. Execute the exact approved action.
  3. Spawn a fenced continuation with a new generation and idempotency key `automation:<wf>:resume:<approvalId>`.
  4. Continue the publish pipeline.
  Redelivery or restart reuses the same key, so there is exactly one resumed run.
- Deny or expiry moves the workflow to terminal FAILED with `APPROVAL_DENIED` or `APPROVAL_EXPIRED`, an audit entry
  and an `approval.decided` notification. The diff artifact is kept.
- The approval TTL is capped at the workspace's recoverable lifetime. An expiry sweeper runs on the
  existing automation timer.
- When `AGENT_APPROVALS_ENABLED=false`, REQUIRE_APPROVAL becomes DENY with `APPROVALS_DISABLED`, and the
  sweeper moves existing WAITING rows to FAILED/`APPROVALS_DISABLED`. This is the drain path for rollback.

## Migration (the one rebuild)

`automation-schema.ts` adds an idempotent `ensureWorkflowStateWaiting(database)`:
1. Inspect `sqlite_master.sql` for `automation_workflows`. If it already contains
   `WAITING_FOR_HUMAN`, return.
2. In one transaction: create `automation_workflows_v2` with the widened CHECK and all
   columns, including PR4's ALTERed columns; `INSERT INTO ... SELECT` with explicit column lists;
   drop the old table; rename; recreate every index, with `automation_workflows_one_active` covering
   `QUEUED, RUNNING, WAITING_FOR_HUMAN, ...` as it does today plus WAIT.
3. Verify the row count equals the count before and run `PRAGMA integrity_check`; roll back on a mismatch.

Tests: run twice (idempotent); preserve rows in every existing state; reject an unknown state;
the unique index still blocks two active workflows for one subject.

## Files to create

| File | Purpose |
|------|---------|
| `packages/contracts/src/agent-approvals-api.ts` | Approval DTO, decision request (approve/deny with `expectedDigest`), typed reasons, internal channel |
| `packages/contracts/test/agent-approvals-api.test.ts` | Schemas |
| `apps/runner/src/agent-governance/approval-schema.ts` | `initializeAgentApprovalSchema`: `agent_action_approvals(approval_id PK, principal_id, workflow_id, action_id, descriptor_digest, descriptor_json, decision_json, policy_revision_json, advisor_decision_id, generation, state CHECK(PENDING,APPROVED,DENIED,EXPIRED,CONSUMED), expires_at, decided_at, decided_by, consumed_at, created_at)` with an index on `(principal_id, state, expires_at)` |
| `apps/runner/src/agent-governance/approval-store.ts` | CAS decide and consume |
| `apps/runner/src/agent-governance/approval-service.ts` | List, decide, expire sweep; audit |
| `apps/runner/src/agent-governance/approval-router.ts` | `/v1/internal/agent-approvals` |
| `apps/runner/src/automation-resume.ts` | Fenced resume and terminal deny/expiry |
| `apps/runner/test/approval-service.test.ts`, `approval-store.test.ts`, `automation-resume.test.ts`, `automation-schema-waiting.test.ts` | Unit tests and the migration test |
| `apps/api/dashboard/dashboard-action-approvals.js` | "Agent actions" section on `/dashboard/approvals`: descriptor, diff stats, gate reasons, Jev consult, approve/deny |
| `apps/api/test/dashboard-action-approvals-router.test.ts`, `-ui.test.ts` | CSRF, wrong principal, double submit |
| `test/integration/hitl-approval-resume.test.ts` | D3 scenarios |
| `test/integration/full-cycle-coding-dod.test.ts` | D1-D6 combined run (evidence source) |

## Files to modify

| File | Change |
|------|--------|
| `packages/contracts/src/index.ts`, `packages/contracts/src/config.ts`, `apps/runner/src/config.ts`, `.env.example` | Export; `AGENT_APPROVALS_ENABLED` (false), `AGENT_APPROVAL_TTL_MINUTES` |
| `packages/contracts/src/automations-api.ts` | Add `WAITING_FOR_HUMAN` to the workflow state enum; add an `approvalId` field on the run DTO |
| `apps/runner/src/automation-schema.ts` | `ensureWorkflowStateWaiting` |
| `apps/runner/src/automation-service.ts` | Enter WAIT on `ACTION_REQUIRES_APPROVAL`; count WAIT in `workspacesHeld` (:751); route resume; poll skips WAIT |
| `apps/runner/src/agent-governance/action-broker.ts` | Return `REQUIRES_APPROVAL` with the approval id; accept an approval override for the exact digest |
| `apps/runner/src/state-store.ts`, `apps/runner/src/app.ts`, `apps/runner/src/index.ts` | Initializer, router, sweeper |
| `apps/api/src/runner-client.ts`, `apps/api/src/dashboard-control-router.ts` | Approval routes next to :228-230 |
| `apps/api/dashboard/dashboard-render.js` | WAITING badge in automation run views; hook in `renderApprovals` (:730) for the new section |
| `apps/api/dashboard/dashboard-pages.js`, `apps/api/src/dashboard-assets.ts`, `dashboard.css` | Asset registration and CSS block |
| `docs/mcp-api.md` (lifecycle state), `docs/security-model.md`, `docs/configuration.md`, `docs-site/dashboard/approvals.md`, ADR 0006 notes, `.agents/skills/cloudharness/**` (automation lifecycle) | Docs and skill |

## Must not touch

`event-outbox.ts` (it calls PR5 emitters only), `apps/runner/src/notifications/` internals, `tool-schemas.ts`,
`agent-manager.ts` (the stop is done through the existing interrupt/cleanup API), and trace store internals.

## D3 scenarios (`hitl-approval-resume.test.ts`)

1. REQUIRE_APPROVAL produces WAITING_FOR_HUMAN, the agent is stopped (launcher shows no live process), the diff artifact exists, and one WAITING notification is created.
2. Approve once: exactly one resumed run, the action executes, then commit, push and PR; the approval is CONSUMED.
3. Double click or concurrent approve: one succeeds; the other gets `APPROVAL_ALREADY_DECIDED`; zero extra effects.
4. Wrong principal gets `APPROVAL_FORBIDDEN`. Expired gets `APPROVAL_EXPIRED` and the workflow FAILED. Changed descriptor digest gets `APPROVAL_STALE`. Stale generation gets `APPROVAL_STALE`. All produce zero effects.
5. Deny: FAILED/`APPROVAL_DENIED`, an audit entry and an `approval.decided` notification; the diff artifact remains.
6. A hardDeny added to global policy after the request: approving still yields DENY, with zero effects.
7. Runner restart while WAITING and again during resume: one resumed run (key fenced).
8. Flag turned off while WAITING: the sweeper moves the workflow to FAILED/`APPROVALS_DISABLED`.

## DoD evidence (`full-cycle-coding-dod.test.ts` plus PR description)

One scripted scenario runs the full cycle: labelled issue, policy with the advisor enabled
(fake Jev escalates one discretionary action), WAIT, approve, resume, PR on fake GitHub,
notifications, and traces read over MCP after workspace close with model, tool, action, decision and
approval spans linked and totals reconciled. The PR description contains a table with one row per
D1-D6 bullet: the test file and case name, the result, and "not run (out of scope)" for the real
canary and real Jev.

## Tests (Windows-friendly)

```
npm run build -w @cloud-harness/contracts
npx vitest run packages/contracts/test/agent-approvals-api.test.ts packages/contracts/test/automations-api.test.ts
npx vitest run apps/runner/test/automation-schema-waiting.test.ts apps/runner/test/approval-store.test.ts apps/runner/test/approval-service.test.ts apps/runner/test/automation-resume.test.ts apps/runner/test/automation-service.test.ts apps/runner/test/action-broker.test.ts
npx vitest run apps/api/test/dashboard-action-approvals-router.test.ts apps/api/test/dashboard-action-approvals-ui.test.ts apps/api/test/dashboard-pages.test.ts
npm run build -w @cloud-harness/api
npx vitest run test/integration/hitl-approval-resume.test.ts test/integration/full-cycle-coding-dod.test.ts test/integration/coding-issue-to-pr.test.ts test/integration/notifications-failure-injection.test.ts test/integration/agent-traces-http.test.ts
npm run typecheck && npm run lint && npm run plugin:sync && npm run plugin:check && npm run docs:reference && npm run docs:check
```

CI runs all of these in `npm run verify`. Then confirm the Docker job (`npm run test:docker`,
`npm run test:e2e`) is green on the PR, because PR4 changed executor-visible proxy ops.

## Risks

| Risk | L x I | Mitigation |
|------|-------|------------|
| Table rebuild loses rows or indexes | L x H | Transactional rebuild, count and integrity check, idempotent guard, dedicated test over every state |
| Workspace held indefinitely | M x M | TTL cap, sweeper, counted in admission |
| Approval replay or TOCTOU | M x H | CAS plus digest plus generation; re-gate at execution; hardDeny still wins |
| Lost work on deny or expiry | M x M | Diff artifact snapshot before WAIT |

## Rollback

1. Set `AGENT_APPROVALS_ENABLED=false` and wait for the sweeper to drain WAITING rows to FAILED.
2. Verify `SELECT count(*) FROM automation_workflows WHERE state='WAITING_FOR_HUMAN'` returns 0.
3. Revert the code. The widened CHECK is a superset and remains harmless to older code; the approvals
   table is inert. Never rebuild back to the narrow CHECK.
