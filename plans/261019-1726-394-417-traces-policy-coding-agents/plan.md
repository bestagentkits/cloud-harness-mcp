---
title: "Agent traces (#394) and policy-governed full-cycle coding agents (#417)"
description: "Six PRs into dev: durable Pi traces, global/project ExecutionPolicy + GateDecision, Jev execution-risk advisor, runner-mediated issue->PR coding broker, notification inbox on the existing outbox, and HITL approval with fenced resume."
status: pending
priority: P1
effort: 140h
branch: dev (each PR cut from origin/dev f49cceb or newer)
tags: [agents, traces, policy, decision-plane, automations, notifications, approvals, dashboard, mcp]
created: 2026-10-19
---

# Agent traces and policy-governed coding agents

Issues: bestagentkits/cloud-harness-mcp#394 (deliver fully) and #417 (DoD D1-D6).
Base: `origin/dev` at `f49cceba` or newer. Every PR targets `dev`. Never `main`.

## Outcome

A webhook-labelled GitHub issue in an allowlisted repository produces exactly one
policy-gated workflow. Pi edits files and runs tests through the runner broker; the
runner commits to `agent/*`, pushes and opens a PR on the fake GitHub backend. Every
model call, tool call and brokered action is a retained, redacted span readable in the
Dashboard and over MCP after the workspace closes. Risky actions pause in
`WAITING_FOR_HUMAN`, are approved once in the Dashboard, and resume in a fenced new run.
Owners get one inbox notification per authoritative transition, plus the existing MCP
Events and GitHub result when enabled.

## Confirmed scope boundary

- In: #394 in full (P0, P1, P2 including pull-based OTLP-JSON export and profile
  diagnostics); #417 D1-D6 verified with a fake/integration GitHub backend and a fake
  Jev provider.
- Out: the live GitHub canary, real TypeSafe/Jev calls, merge/deploy to `main`, Claude
  Code/Codex adapters (#397), Linear/Jira (#406), and Slack/email adapters. Their absence
  is recorded in the DoD evidence table as "not run (out of scope)", never as passed.

## Cross-cutting decisions (locked)

1. **Schema strategy.** Every new table is created by a per-feature, additive,
   idempotent initializer with no `schema_meta` bump and no foreign keys. This follows
   `apps/runner/src/automation-schema.ts:9` (#399) and removes the migration-sequence
   hotspot in `apps/runner/src/principal-store.ts:1159` (head is v14). New columns use
   `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`. The single exception is PR6, which
   rebuilds `automation_workflows` idempotently to admit `WAITING_FOR_HUMAN` in the CHECK
   constraint at `apps/runner/src/automation-schema.ts:84`.
2. **One store.** Everything lives in the runner state DB (`StateStore.database`,
   `apps/runner/src/state-store.ts:456`). Notifications extend the transactional outbox
   in `apps/runner/src/event-outbox.ts` and are written in the same savepoint as the
   transition they describe. There is no second event DB, Kafka or Redis.
3. **Traces outlive agents.** Agent rows are compacted after workspace close
   (`apps/runner/src/agent-state-repository.ts:1040`). Trace tables therefore carry their
   own owner id, retention and quota and never reference `agents`.
4. **Usage is reconciled, not re-measured.** Model-call span usage is the same cumulative
   delta that `AgentManager.reconcileUsage` writes to `agent_usage`
   (`apps/runner/src/agent-manager.ts:983`), so token sums match exactly. Reasoning tokens
   and request counts come from the gateway lease settlement
   (`apps/runner/src/agent-gateway-control.ts:51`). A missing value is `null` with a
   provenance label and is never rendered as zero.
5. **Authority.** `GateEvaluator` is a pure function. Advisor output is typed as
   `no_change | escalate`. The final decision is
   `max(deterministic, advisorEffect)` over the order `ALLOW < REQUIRE_APPROVAL < DENY`,
   and the advisor can never produce `ALLOW` or `DENY`. Only `ActionBroker`, after it
   re-checks generation, revocation and budget at execution time, dispatches an effect.
6. **Publishing belongs to the orchestrator.** Pi gets edit, test (`exec_run`),
   `git_status` and `git_diff` through proxy operations. Commit, push to `agent/*` and
   PR creation are deterministic runner-owned steps keyed by workflow id. This gives
   idempotent replay and model-independent branch names. Rationale goes in ADR 0006; the
   trade-off is listed under unresolved questions.
7. **Project identity.** A project is the existing metadata `projects` row
   (`apps/runner/src/metadata-schema.ts:19`). The owner-authored rule names `projectId`.
   Repository/project are never read from webhook payload fields beyond the verified
   `repository`, which is checked against the allowlist.
8. **Feature flags (runner, all default off).** `AGENT_TRACES_ENABLED` (PR1),
   `AGENT_POLICIES_ENABLED` (PR2), `execution-risk` in the existing
   `DECISION_PLANE_PURPOSES` plus a per-policy advisor toggle (PR3), `AGENT_CODING_ENABLED`
   (PR4, which is also the kill switch), `NOTIFICATIONS_ENABLED` (PR5),
   `AGENT_APPROVALS_ENABLED` (PR6). With every flag off, behaviour equals `dev` today.
9. **Dashboard modules.** Each feature gets its own browser module
   (`dashboard-traces.js`, `dashboard-policies.js`, `dashboard-inbox.js`,
   `dashboard-action-approvals.js`) that imports `api` from `dashboard-api.js:14`. This
   follows the `dashboard-models.js` precedent. Shared files only get registration lines.

## PR sequence and dependencies

| PR | Phase file | Issue scope | Depends on | Wave | Merge order |
|----|-----------|-------------|-----------|------|-------------|
| PR1 | [phase-01-agent-traces.md](phase-01-agent-traces.md) | #394 complete | none | W1 | 1 |
| PR2 | [phase-02-policy-contracts-gate.md](phase-02-policy-contracts-gate.md) | #417 ADR, ExecutionPolicy, GateDecision, editor | none (rebases on PR1 hotspots) | W1 | 2 |
| PR3 | [phase-03-jev-execution-risk.md](phase-03-jev-execution-risk.md) | #417 B / #333 `execution-risk` | PR2 | W2 | 3 |
| PR4 | [phase-04-coding-broker-issue-to-pr.md](phase-04-coding-broker-issue-to-pr.md) | #417 A, D1, C (action spans) | PR1, PR2 | W2 | 4 |
| PR5 | [phase-05-notifications-inbox.md](phase-05-notifications-inbox.md) | #417 D, D5 | none to build; PR4 for deep-link fields at merge | W2 | 5 |
| PR6 | [phase-06-hitl-approval-resume-dod.md](phase-06-hitl-approval-resume-dod.md) | #417 D3, D6, DoD evidence | PR2, PR4, PR5 (PR3 for the full-cycle Jev case) | W3 | 6 |

```
PR1 ──┬──────────────► PR4 ──► PR5(merge) ──► PR6
PR2 ──┼──► PR3 ───────────────────────────────┘
      └──────────────► PR4
```

Parallel development is safe inside a wave only with the file ownership below. Merges
are strictly sequential in the order shown, and each later PR rebases and resolves
append-only hotspot edits.

## Shared hotspot ownership

| Hotspot | Rule |
|---------|------|
| `packages/contracts/src/index.ts` | One appended `export *` line per PR. Resolve conflicts by keeping both lines. |
| `packages/contracts/src/config.ts`, `apps/runner/src/config.ts`, `.env.example` | One delimited flag block per PR, appended at the end of the runner schema/env map. |
| `packages/contracts/src/runner-api.ts` (`RunnerOperationSchema` :4, `AgentProxyOperationSchema` :277) | PR1 owns the trace operations. PR4 owns the proxy-op additions. No other PR edits this file. |
| `packages/contracts/src/tool-schemas.ts` (sets :1425-1475) | Only PR1 adds MCP tools. PR2, PR3, PR5 and PR6 add no MCP tools. Feature channels use their own internal routes, following the automations pattern. |
| `packages/contracts/src/model-profile-schemas.ts`, `apps/agent-runtime/src/protocol-schemas.ts`, `package.json` `test:docker` list | PR4 only, except that PR1 adds optional `turn_ended` fields to `protocol-schemas.ts`. These edits are sequential because PR4 rebases on PR1. |
| `apps/runner/src/workspace-service.ts` (execute :2976, AgentManager deps :382) | PR1: one dispatch line plus recorder injection. PR4: broker injection and spawn-time proxy-op validation. Nobody else. |
| `apps/runner/src/agent-manager.ts` | PR1 (recorder hooks), then PR4 (broker gate in `proxyTool` :677). Sequential: PR4 rebases on PR1. |
| `apps/runner/src/automation-service.ts` / `automation-schema.ts` | PR4 (code mode), then PR6 (WAITING state). PR5 never edits them; it hooks `emitAutomationTerminalEvent` instead. |
| `apps/runner/src/event-outbox.ts` | PR5 only. PR6 calls the emitters PR5 exports. |
| `apps/runner/src/app.ts`, `apps/runner/src/index.ts`, `apps/api/src/runner-client.ts` | One route/wiring block per PR (PR2, PR5, PR6). Append-only. |
| `apps/api/dashboard/dashboard-pages.js`, `apps/api/src/dashboard-assets.ts`, `apps/api/dashboard/dashboard.js` route switch, `dashboard.css` | Registration lines only, plus one delimited CSS section per feature at the end of the file. |
| `apps/api/dashboard/dashboard-render.js` | PR1 (Agent detail Traces tab, run-detail trace link), PR4 (rule dialog code mode, run-detail coding fields), PR6 (WAITING badge plus an approvals section hook). |
| Generated `docs-site/reference/tools.md`, `environment-variables.md`, `docs-site/public/llms.txt` | Never hand-merge. After each rebase run `npm run docs:reference` and commit the output. |
| `.agents/skills/cloudharness/**` and `plugins/cloud-harness/skills/**` | Edit `.agents` only, then `npm run plugin:sync`. PR1 (trace tools), PR4 (proxy ops, code mode), PR5 (notification event). |
| `docs/adr/0006-*` | Created by PR2. Later PRs append "Implementation notes" sections only. |

## Reusable test harnesses (build once)

- `apps/runner/test/support/agent-runtime-fakes.ts` is built in **PR1**. It holds a
  scripted `AgentLauncher`/`AgentGatewayControl` pair that emits turn, usage, tool and
  terminal records and settlements. PR4 and PR6 reuse it. `apps/runner/test/agent-manager.test.ts` is not modified.
- `apps/runner/test/support/fake-jev-provider.ts` is built in **PR3**. It is a
  `DecisionProvider` with scripted answers, failure modes and a call counter. PR6 reuses it.
- `test/support/fake-github-backend.ts` and `test/support/coding-harness.ts` are built in
  **PR4**. The fake backend is a temp git checkout plus a bare remote, with an in-memory
  PR registry and failure injection (429, 500, timeout-after-effect). The harness wires a
  real StateStore, AgentManager and AutomationService. PR5 and PR6 reuse both.
- `apps/runner/test/support/fake-notification-adapter.ts` is built in **PR5** as the
  second-channel conformance fake.

## Acceptance mapping

### #394 acceptance criteria -> PR1

| #394 AC | Evidence (PR1) |
|---------|----------------|
| 2 model requests + 2 tool calls -> one correlated trace with immutable profile revision after process exit | `apps/runner/test/agent-manager-traces.test.ts`; `test/e2e/pi-agent.docker.test.ts` extension (fake provider runs write/edit/complete, i.e. 3 model calls and 2 tools) |
| Partial traces for cancelled, timed-out, failed, expired, crashed; 401/429/500, missing usage, stream termination, nested child, retention expiry | `apps/runner/test/agent-trace-recorder.test.ts`, `agent-trace-store.test.ts` |
| Token/cost reconcile within documented tolerance; estimates labelled | recorder reconciliation tests; tolerance documented in `docs/mcp-api.md` |
| p50/p95 and TTFT only with adequate timestamps; bounded overhead | store aggregate tests; write-count test (no write per `text_delta`) |
| No secrets in traces, MCP, browser or exports; cross-principal isolation | `test/integration/agent-traces-http.test.ts`, dashboard router tests |
| Migration, indexes, ingestion/retention, API and UI tests, docs | `agent-trace-schema.ts` initializer plus the suites above, docs list in phase file |

### #417 Definition of Done -> phases

| DoD item | Built in | Final evidence |
|----------|----------|----------------|
| D1 issue->PR full cycle on fake GitHub, exactly one workflow, >=2 files, failing test fixed, commit on `agent/*`, push, PR linking issue, no merge | PR4 | `test/integration/coding-issue-to-pr.test.ts`; re-run in PR6 `test/integration/full-cycle-coding-dod.test.ts` |
| D1 redelivery/restart -> no duplicate workflow/commit/push/PR; UNKNOWN reconciled or blocked | PR4 | same, restart and crash-after-effect cases |
| D1 real-provider canary | out of scope | DoD table row "not run (out of scope)" |
| D2 precedence table 100% (global only, project only, both, missing project, stale, global deny vs project allow, mandatory approval vs project allow); webhook cannot set principal/project/policy | PR2 (evaluator), PR4 (webhook) | `apps/runner/test/gate-evaluator.test.ts`, PR4 integration |
| D2 hard-deny/mandatory approval beats project, Jev confidence 1 and prompt injection | PR2, PR3, PR4 | evaluator property tests, `gate-evaluator-advisor.test.ts`, PR4 injection scenario |
| D2 Jev escalates one discretionary action with typed decisionId/risk/confidence; never downgrades | PR3 | `apps/runner/test/execution-risk-advisor.test.ts` |
| D2 Jev disabled/unconfigured/timeout/429/invalid/low confidence/redaction failure -> conservative fallback, zero egress when off; purpose accepted by config | PR3 | fallback matrix plus config test |
| D2 Dashboard create/update/version/simulate; execution uses same evaluator | PR2 (editor), PR4 (parity test) | `dashboard-policies-*.test.ts`, `action-broker.test.ts` parity case |
| D3 WAITING_FOR_HUMAN, single approve/deny; wrong principal, expired, changed hash, double click, stale generation -> zero effects | PR6 | `apps/runner/test/approval-service.test.ts`, `test/integration/hitl-approval-resume.test.ts` |
| D3 approval resumes exactly one fenced run; reject/expiry audited; no idle Pi container; no lost changes | PR6 | same plus diff-artifact assertion |
| D4 every brokered action has span + receipt in Dashboard and MCP after workspace close; model/decision/approval linked; uncovered native actions `coverage: partial` | PR1 (store), PR4 (action spans), PR6 (approval spans) | DoD integration test |
| D4 concurrent cursors, reconnect, gap/expiry detection; cross-principal forbidden; redaction | PR1 | `test/integration/agent-traces-http.test.ts` |
| D4 trace totals match usage ledger; retries/children not double counted | PR1 | recorder reconciliation tests |
| D5 one logical inbox notification per success/failure/WAITING plus MCP Event and GitHub result; disabled channels none | PR5, PR6 (WAITING) | `test/integration/notifications-failure-injection.test.ts`, DoD test |
| D5 API outage, runner restart, duplicate claim, 429, 500 -> recovered, no second agent, visible delivery state | PR5 | same |
| D5 approval actionable in Dashboard; decision notifies subscribers; revocation stops delivery | PR6 + PR5 | DoD test |
| D6 isolation, scoping, redaction, injection, SSRF, package admission, ceilings, kill switch, crash-after-effect | PR2, PR4, PR5 | listed per phase |
| D6 compatibility, docs/skill/migration/flags/rollback, CI suites, evidence table | all; PR6 compiles | PR6 description DoD evidence table |

#417 may only be closed when D1-D6 pass together on `dev`. The canary row stays open as
an owner follow-up.

## Cross-checked risk register (peer #417 plan, re-verified on origin/dev f49cceba)

| # | Risk (verified evidence) | Handled in |
|---|--------------------------|-----------|
| 1 | Decision purposes are capped at 2 (`packages/contracts/src/config.ts:262`) | PR3 raises the cap to `.max(3)` and documents config cleanup before rollback |
| 2 | Profile proxy ops are capped at 10 (`packages/contracts/src/model-profile-schemas.ts:126`, `:142`); 10 ops exist today | PR4 raises both caps to 13 (the exact new size) and adds profile schema tests |
| 3 | The proxy-op enum is duplicated (`packages/contracts/src/runner-api.ts:277`, `apps/agent-runtime/src/protocol-schemas.ts:16`) | PR4 changes both together and adds a parity test asserting the enums are equal |
| 4 | `pr_create` base defaults to `'main'` (`packages/contracts/src/tool-schemas.ts:357`) | PR4: the publish pipeline always passes `base` from the rule; a test asserts that a missing base fails before dispatch |
| 5 | `recordEvent` writes nothing without a subscriber (`apps/runner/src/event-outbox.ts:65-88`) | PR5: the inbox has its own `notifications` table, written regardless of subscriptions |
| 6 | `WAITING_FOR_HUMAN` needs a CHECK rebuild (`apps/runner/src/automation-schema.ts:84`) | PR6: idempotent rebuild; rollback drains WAITING rows first |
| 7 | Pi proxy calls require a `network-none` workspace (`apps/runner/src/workspace-service.ts:5497`) | PR4 boundary decision: Pi and the workspace record stay `network-none`. `package_install` is a broker-only action (default DENY) executed in a one-shot `dependency-access` container on the workspace mount, lockfile-only with scripts disabled, no secrets and no Docker socket, attestation required (fail closed `DEPENDENCY_EGRESS_UNAVAILABLE`), under its own sub-flag. See unresolved question 5. |
| 8 | Workspace delete cascades `agent_effects` (`apps/runner/src/principal-store.ts:468-489`) | PR1 trace tables and PR4 `coding_actions` have no FKs; tests delete the workspace and still read traces and receipts |
| 9 | There is no fake GitHub backend; ADR number is unconfirmed | PR4 builds `test/support/fake-github-backend.ts`. `docs/adr/` on f49cceba ends at 0005, so 0006 is free; PR2 re-checks this before merge |

## Global gates (every PR)

Windows-friendly targeted runs first, then the CI-equivalent set:

```
npm ci
npm run build -w @cloud-harness/contracts
npx vitest run <phase test files>                 # narrowest first
npm run build -w @cloud-harness/api               # before test/integration suites
npx vitest run test/integration/<phase>.test.ts
npm run typecheck
npm run lint
npm run plugin:check
npm run docs:reference && npm run docs:check
```

CI (`.github/workflows/ci.yml:26-52`) runs `npm run verify:compose`, `npm run verify`
(plugin:check, lint, typecheck, all non-Docker vitest, build), the docs integrity step,
then the Docker job: `npm run test:docker` (explicit file list in `package.json`) and
`npm run test:e2e`. The POSIX-only suites `test/deploy-release-runtime.test.ts` and
`test/upgrade-nginx-routes.test.ts` are verified only in Linux CI.

## Coordination before starting

- Before PR1, check #394: it is labelled `in progress` for branch
  `claude/determined-gates-58q6i1`, which does not exist on the remote. Comment on #394
  with the PR1 branch and take over the label. Comment on #405, #416, #333 and #396 with
  PR links when each PR opens.
- #393 (in review) edits `renderAgentDetail` and `loadAgentDetail` and adds
  `dashboard-agent-run.js`. If it lands first, PR1 hooks into `showAgentDetail` and
  `createAgentRefresh` rather than adding a second poller.
- #408 (`feat/408-dynamic-repositories`, local checkout) edits `tool-schemas.ts`,
  `workspace-service.ts` and the dashboard. Expect rebase conflicts in PR1 and PR4.
- Move each issue through exactly one status label (AGENTS.md "Issue coordination").

## Rollback (global)

Every phase ships behind a default-off flag, so the first rollback is to turn the flag
off. Additive tables are inert for older code, so a code revert needs no data change.
PR6 is the exception: drain `WAITING_FOR_HUMAN` rows by setting
`AGENT_APPROVALS_ENABLED=false`, which moves them to `FAILED/APPROVALS_DISABLED`, before
reverting code. A revert never touches production; a merge to `main` is a separate,
owner-authorized operation.

## Unresolved questions

1. Decision 6 makes commit, push and PR creation orchestrator-owned rather than Pi tools.
   This satisfies D1 outcomes and makes idempotency tractable, but differs from the
   literal "Pi commits/pushes". Confirm, or ask for Pi `git_commit`/`git_push` proxy ops
   (doable in PR4 at the cost of a weaker branch/idempotency story).
2. #394 P2 OTel: PR1 ships a pull-only `otlp-json` export format with no egress. Is a
   push exporter to a collector wanted? It would need a new egress/SSRF policy and is
   currently not planned.
3. Approval TTL versus workspace lifetime: PR6 caps the approval TTL at the workspace
   recoverable window and snapshots the diff as an artifact before waiting. Confirm that
   longer approvals are not required.
5. Package install boundary (risk 7): the plan adopts a one-shot `dependency-access`
   install container (lockfile-only, scripts disabled) driven by the broker, while Pi stays
   `network-none`. This touches the executor boundary owned by `workspace-service.ts`, so the
   owner must confirm it before PR4b starts. The fallback is to keep `package_install`
   platform-denied in coding runs, so that verify commands rely only on what the checkout already contains.
6. Is #394 really unowned? Its label says in progress, but no remote branch exists.

## Orchestrator decisions (2026-10-19, resolve the unresolved questions)

1. The runner, not Pi, commits, pushes and opens the PR. Pi stays `network-none`, with no credentials and no Docker access. The PR records each step as a brokered action receipt.
2. Trace export is pull-only (`json`, `csv` and `otlp-json` download). A push exporter to an external collector is a follow-up and out of this run's scope.
3. Approval expiry is capped at the workspace's recoverable lifetime and at the policy TTL, whichever is shorter.
4. Package install uses the one-shot dependency-access container: lockfile only, scripts off, no secrets, no Docker socket. It sits behind its own flag, which is off by default, and the policy denies it by default. D6 covers supply-chain admission through gate tests.
5. This orchestrator session owns #394. The old `58q6i1` branch never reached the remote.

## Orchestrator state log (2026-10-19 20:55)

- PR1 #425 (#394 traces) is merged to dev as 918d3969. Issue #394 is labelled `done` and moves to `shipped` once it reaches main. Follow-up: #438.
- PR2 #424 (feat/417-policy-gate, worktree D:/www/oss/ch-wt-pr2) is fixing round-4 blockers B1-B3 by shrinking the shell grammar it accepts. When that is done: one isolated re-review, then merge to dev.
  - Decision: a definite platform match is DENY. An unanalyzable command is mandatory REQUIRE_APPROVAL. A docker.sock match is DENY.
- PR3 (Jev, D:/www/oss/ch-wt-pr3) and PR4 (broker, D:/www/oss/ch-wt-pr4) run in parallel from PR2 head b7b2e0de. Both merge dev in after #424 lands. PR4 also fills workflowId in traces.
- PR5 (notifications) has a worktree at D:/www/oss/ch-wt-pr5 but is not started yet, to save quota. PR6 starts after PR4 and PR5.
- Use PowerShell for gh. Git Bash gh and heredocs fail silently because of fnm.
- After each merge: remove the worktree, delete the branch, then `git branch -f dev origin/dev`.

## Orchestrator state log (2026-10-19 22:30)
- MERGED to dev: #424 policy gate (089e047e), #454 Jev execution-risk (c1ad60f7), #455 trace-store flake fix (be40b8a0, closed #456).
- Decision: gate is argv-only; shell strings/inline code = mandatory approval; unknown programs admitted by owner command scope are an accepted, documented residual (executor isolation is the containment).
- PR4 = #459 (worktree ch-wt-pr4): told to merge dev and wire decide() at execution time.
- PR5: worktree ch-wt-pr5 reset to origin/dev c1ad60f7; NOT dispatched (5h quota 95%, resets ~00:20 +07).
- PR6 after PR4 + PR5. Worktrees pr2/pr3 removed, branches deleted.

## Orchestrator state log (2026-10-20 03:35)
- MERGED to dev: #459 coding broker issue→PR (4178195a), after 4 isolated review rounds. The final design is a verified push: stage an isolated transfer clone, inspect it with a clean git config, gate it, then push from the same clone. The commit must have the runner identity and exactly the runner message, and repeated stage failures stop as COMMIT_UNVERIFIED.
- #468 (another session, closes #466) merged to dev in parallel and introduced per-helper mounts without `inspect`, so dev failed the runner typecheck. Hotfix #469 (worktree ch-wt-fix) mounts inspect on the staged clone alone, read-only. Merge it when CI is green.
- #463 notifications: CLEAN after 2 re-reviews, CI green at ea41e940. dev is merged locally (91027a8a) with additive conflicts resolved, not pushed yet. After #469 lands, merge dev again, push, CI, then merge.
- Filed: #464 (Windows-unguarded lease test), #466 (staging-clone isolation, now closed by #468).
- Accepted residual: the window between a commit and the HEAD read is documented. A substituted commit must still match the runner parent, identity and message and pass the path gate.
- Next: PR6 (phase-06 HITL) from dev after #463.
