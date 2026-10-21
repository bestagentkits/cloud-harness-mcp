# Handoff: #394 + #417 (traces, policy, coding agents)

Status as of 2026-10-21 08:15 (+07). The run was paused because the weekly usage quota is nearly used up. Everything is committed and pushed. Nothing is merged to `main`.

## Objective and Done means (confirmed brief)

**Objective:** deliver #394 in full, and bring #417 to D1–D6 on `dev` through a chain of PRs into `dev`. A PR is merged only when CI is green and an isolated review finds nothing.

**Out of scope:**
- merging or deploying to `main`;
- a real GitHub or TypeSafe canary;
- real Claude Code / Codex adapters (#397);
- Linear and Jira (#406);
- Slack and email.

**Constraints:**
- AGENTS.md invariants hold.
- Jev is never an authorization source.
- Pi stays `network-none`.
- No second store.

## State

| Item | State | Evidence |
|---|---|---|
| #394 traces (store, retention, redaction, API + MCP `agent_trace_*`, Traces tab, export) | **Done on dev** | #425 merged (918d3969), flake fix #455; issue labelled `done` (→ `shipped` only once on `main`) |
| D2 policy + GateDecision | **Done on dev** | #424 (089e047e); argv-only gate |
| D2 Jev execution-risk (escalate only, fallbacks) | **Done on dev** | #454 (c1ad60f7) |
| D1 issue → PR on the fake GitHub, idempotent | **Done on dev** | #459 (4178195a); `test/integration/coding-issue-to-pr.test.ts`, `coding-publish.docker.test.ts` |
| D4 span + action receipt, cursors in MCP and Dashboard | **Mostly done on dev** | #425 + #459 (`coding_actions` receipts, keyset cursor); the approval span depends on D3 |
| D5 inbox + MCP Events + GitHub result, failure injection | **Done on dev** | #463 (8074e4e9); `test/integration/notifications-failure-injection.test.ts` scenarios 1–9 |
| D3 WAITING_FOR_HUMAN, single-use approval, fenced resume | **Not done** | Draft PR on `feat/417-hitl` (see below) |
| D6 security tests, flags, docs/skill/plugin:sync, DoD evidence table | **Partial** | Each merged PR has its own tests, flags and docs; the full-cycle DoD test and evidence table belong to the PR6 draft |

## Remaining work

1. **Finish the PR6 draft** (`feat/417-hitl`, worktree `D:/www/oss/ch-wt-pr6`). The spec is `phase-06-hitl-approval-resume-dod.md` in this folder. That phase file predates #459, so adapt it to the merged runner-driven pipeline:
   - The pipeline lives in `apps/runner/src/automation-coding.ts` (`CodingWorkflowEngine`) and `apps/runner/src/agent-governance/action-broker.ts`.
   - REQUIRE_APPROVAL currently fails closed with `ACTION_REQUIRES_APPROVAL`; that is the point to turn into WAIT.
   - Notifications are emitted only through the exported `emitWaitingForHumanNotification` / `emitApprovalDecidedNotification` from #463.
   - The single table rebuild of `automation_workflows` must be transactional and idempotent, preserve the row count, and pass the integrity check.
   - D3 scenarios 1–8, `full-cycle-coding-dod.test.ts`, Dashboard "Agent actions", docs/skill plus `npm run plugin:sync`.
   - The PR body needs a D1–D6 evidence table. The real canary and real Jev are recorded as "not run (out of scope)".
   No code exists yet: the draft PR carries only this plan and handoff. The design below was settled by reading the code on `dev` at 8074e4e9. Treat it as the starting point:
   - **Where runs pause:** only at runner-owned steps (verify, commit path checks, commit, push, open PR). An agent's own tool call that needs approval still gets `ACTION_REQUIRES_APPROVAL` back and the run continues. List this deviation from phase-06 in the PR body.
   - **Flag off:** a step needing approval fails as `ACTION_DENIED:APPROVALS_DISABLED`, and the sweeper drains WAITING runs to FAILED/`APPROVALS_DISABLED`. Update `apps/runner/test/automation-coding.test.ts:599` to match.
   - **Override:** an approval lifts REQUIRE_APPROVAL to ALLOW only when all of these hold:
     - the step is a runner step in the same workflow;
     - its descriptor digest equals the gate's `inputFingerprint`;
     - the approval is APPROVED or CONSUMED;
     - the flag is on.

     A DENY is never overridden, and a policy change already yields POLICY_STALE (a DENY).
   - **Consumption:** the approval becomes CONSUMED on first use.
   - **Resume key:** a step whose original key has an approved approval switches to `automation:<wf>:resume:<approvalId>`. The `earlier` receipt lookup in `commit()` must use the same key.
   - **Approvals table:** `agent_action_approvals` gets `step_key` and `step` columns in addition to the phase-06 columns.
   - **Workflow row:** add `approval_id`, `approval_generation` and a paused-time counter. The policy budget's `maxRunSeconds` defaults to 900, so time spent waiting must be subtracted, or most resumes fail with BUDGET_EXHAUSTED.
   - **Diff artifact:**
     - A pause after commit needs a new git port method, `diff-tree -p base commit`, because `git_diff` cannot diff against a base.
     - A pause before commit must delete `.cloud-harness-coding.diff` after the snapshot, or the commit would include it.
   - **TTL:** the minimum of the configured TTL, the policy approval TTL, and the remaining workspace lease after a best-effort `workspace_lease_renew` (capped at `hardExpiresAt`).
   - **Wiring:** `AutomationService` owns the approval service, the router reaches it as `automations.approvals`, and the sweeper runs in `pass()`.
   - **Migration:** a savepoint rebuild from the `sqlite_master` SQL, with count, integrity and index checks before release.
2. **Isolated review** of PR6, fix its findings, merge into `dev`.
3. **Final verification** on the integrated `dev`:
   - typecheck, lint, tests and build;
   - each D1–D6 check;
   - one final isolated review over the full #417 change set.
4. **Labels and cleanup:**
   - Move #417 to `done` once PR6 merges (`shipped` only after `main`).
   - Remove the worktrees: `ch-wt-pr6`, then `ch-417-plan` and branch `feat/417-plan`. `ch-417-plan` still holds an untracked superseded draft plan, `plans/261019-1728-full-cycle-coding-agents/`; check it before deleting.

## Decisions made on the owner's behalf

- **Policy gate is argv-only.** Shell strings, inline code, eval and source always require approval (`PLATFORM_COMMAND_UNANALYZABLE`). A container runtime, a privilege tool or docker.sock is DENY. Accepted residual: unknown programs admitted by the owner's command scope are not modelled; the executor is the containment.
- **The runner, not Pi, publishes the code.** It commits, pushes with refspec `<sha>:refs/heads/<branch>`, and opens the PR.
- **Pushes are verified.** The transfer clone is staged in isolation over the pack protocol and inspected under a clean git config (replace refs, grafts, `diff.relative`, `core.worktree` and alternates commands neutralised). The paths, parent, runner identity and exact message are gated, then the push goes from the same clone. Repeated staging failures stop as `COMMIT_UNVERIFIED`.
- **Residual: commit-to-HEAD-read window.** A substituted commit must still match the runner's parent, identity and message and pass the path gate. It is documented in `docs/security-model.md`.
- **Install advisor deviation.** A package that needs advisor clearance is refused rather than cleared.
- **Trace export is pull-only.** A push exporter is a follow-up.
- **The notification inbox has its own table.** The outbox writes nothing when there is no subscription. Mark-all is bounded by an insertion watermark.

## Follow-ups (open)

- #438: the gateway budget refusal is classified as `rate_limit` (structured `budget_exceeded` code).
- #464: the `git-transfer-helper-lease` suite fails on Windows and has no platform guard. Also, the `git-transfer-leak.test.ts` mount assertions fail on win32 because of backslash paths.
- Live GitHub/TypeSafe canary and real Jev: not run (out of scope).
- Trace push exporter to an external collector.
- `automationNotificationLink`: deep-link the coding PR URL and trace id into notifications (#459 and #463 are now both on `dev`).

## Working notes

- Use PowerShell for `gh`; Git Bash `gh` fails because of fnm.
- Merge with `gh pr merge N --merge --match-head-commit <sha>`. Merge `dev` into a PR branch; never rebase or force-push.
- Parallel sessions merge into `dev` too (for example, #468 and #471 landed while #459 merged). After each merge, check `dev` CI for semantic conflicts.
- The main checkout `D:/www/oss/cloud-harness-mcp` belongs to another session (`feat/408-dynamic-repositories`). Do not edit it.
