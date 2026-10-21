# Phase 04 (PR4): Coding broker and idempotent issue -> PR on a fake GitHub backend (#417 A, D1, D4 actions)

Branch: `feat/417-coding-broker` from `dev` after PR1 and PR2 merge. Target `dev`.
Effort about 32h. Wave W2. This is the largest PR. If the diff exceeds about 2.5k lines, split it as
4a (contracts, proxy ops, ActionBroker, action store, runtime adapter, unit tests) and 4b
(automation code mode, publish pipeline, fake GitHub harness, integration test). 4b depends on 4a.

## Context

- Automations already run Pi read-only on `network-none`: `startWorkflow`
  (`apps/runner/src/automation-service.ts:792`) spawns with idempotency key
  `automation:<wf>:spawn`. Next come `poll` :867, `collectResult`, and `publish` :932 (issue comment via
  `github_action`, tracked in `publish_state`). Admission is at :717 and workspace accounting at :751.
  The `AutomationOperations` port (:57) is injectable.
- The runner already owns brokered git and GitHub: `RunnerOperationSchema`
  (`packages/contracts/src/runner-api.ts:4`) includes exec_run, git_status/diff/add/commit/push and
  github_action/github_read. `git_commit` supports `expectedHeadOid` and `idempotencyKey`,
  `git_push` supports the `expectedAbsent`/`forceWithLease` leases, and `pr_create` has an idempotency key.
- Pi reaches tools only through `AgentManager.proxyTool` (`apps/runner/src/agent-manager.ts:677`),
  which writes the `agent_effects` ledger (INTENT -> DISPATCHED -> APPLIED/REJECTED/UNKNOWN).
  Proxy ops are duplicated in `packages/contracts/src/runner-api.ts:277` and
  `apps/agent-runtime/src/protocol-schemas.ts:16`; definitions live in
  `apps/agent-runtime/src/proxy-tools.ts:94`.

## Design

- Pi gets three new proxy ops: `exec_run` (test commands only, scoped by the policy's command
  allowlist), `git_status` and `git_diff`. It never gets commit, push or PR. Pi stays on
  `network-none` with no credentials and no Docker.
- `ActionBroker` wraps `proxyTool` and the publish steps. For every action it does the following:
  1. Build an `ActionDescriptor`.
  2. Resolve the frozen policy snapshot stored on the workflow.
  3. Evaluate the gate (plus the advisor when PR3 is present).
  4. Re-check generation, revocation and budget right before dispatch.
  5. Write `coding_actions` INTENT.
  6. Dispatch.
  7. Write the receipt.
  8. Write the `action` span (PR1 store) linked to the trace.
  In PR4, REQUIRE_APPROVAL returns `ACTION_REQUIRES_APPROVAL` (the workflow fails closed). PR6 turns that into WAIT.
- The publish pipeline (`automation-coding.ts`) runs after Pi settles and is orchestrator-owned:
  1. Run the policy's verify command through `exec_run` and require exit 0.
  2. Require non-empty `git_status`.
  3. Branch `agent/<issue>-<wfShort>`.
  4. `git_add` the allowed paths, then `git_commit` with idempotency key `automation:<wf>:commit` and `expectedHeadOid`.
  5. `git_push` with `expectedAbsent` (or a lease that matches the recorded commit on replay).
  6. `github_action pr_create` with key `automation:<wf>:pr`, body "Closes #N", and the base from the rule.
  Each step persists its result on the workflow row before the next step starts.
- Replay and UNKNOWN reconciliation: on restart, a step marked DISPATCHED without a receipt is
  reconciled by reading state. For commit, check that HEAD equals the recorded OID or that the
  message trailer `Cloud-Harness-Workflow: <wf>` exists. For push, use `github_read` on the
  branch ref. For PR, use `github_read` to list PRs by head. A match is recorded APPLIED; no
  match re-dispatches with the same key. If state is unreadable, the workflow goes BLOCKED with
  `EFFECT_UNKNOWN` and nothing is retried blindly.
- The workflow is COMPLETED only once the PR exists. On failure the diff is snapshotted as an
  artifact so work is not lost.
- Webhook trust: the rule (owner-authored) supplies `projectId`, mode, base branch and verify
  command. The payload supplies only issue number, title and body (treated as data) and the
  `repository`, which must match the rule's allowlist. Redelivery dedupes on the existing
  delivery idempotency, so exactly one workflow is created.
- Package and supply-chain admission. Pi proxy calls are fenced to a `network-none` workspace
  (`apps/runner/src/workspace-service.ts:5497`). That fence stays, and Pi never installs packages.
  - `package_install { mode: 'lockfile' }` is a broker-only action class, DENY by default,
    and needs its own sub-flag `AGENT_CODING_PACKAGE_INSTALL_ENABLED=false`.
  - When it is allowed or approved, the runner executes it in a one-shot container on the
    workspace mount with the `dependency-access` profile after the per-start attestation,
    running a lockfile-frozen install with scripts disabled (`npm ci --ignore-scripts`). The
    container gets no secrets, no Docker socket, and the existing resource bounds. A failed
    attestation fails closed with `DEPENDENCY_EGRESS_UNAVAILABLE`.
  - The workspace record's `networkProfile` is never changed, so the Pi fence above still holds.
  - Diffs touching lockfiles or manifests are classified `package_install` and gated on publish.
  - Owner confirmation is required before PR4b (plan.md, unresolved question 5). If it is
    refused, the class stays platform-denied and the install container is dropped from scope.
- `pr_create` defaults `base` to `'main'` (`packages/contracts/src/tool-schemas.ts:357`). The
  pipeline always passes `base` explicitly from the owner rule, and a missing base fails before
  dispatch (test).
- `coding_actions` has no FK to `workspaces` or `agents`, unlike `agent_effects`
  (`apps/runner/src/principal-store.ts:468-489`). Receipts remain readable after the
  workspace is deleted (test).
- Kill switch: when `AGENT_CODING_ENABLED=false`, new code-mode workflows are rejected, running
  ones stop at the next broker call with `CODING_DISABLED`, and spawns that request the new
  proxy ops are rejected.

## Files to create

| File | Purpose |
|------|---------|
| `packages/contracts/src/coding-actions.ts` | `ActionRequest` v1, `ActionReceipt` v1 (descriptor lives in PR2), coding phase enum, error codes |
| `packages/contracts/test/coding-actions.test.ts` | Schemas |
| `apps/runner/src/agent-governance/action-schema.ts` | `initializeCodingActionSchema`: `coding_actions(action_id PK, principal_id, workspace_id, workflow_id, agent_id, generation, idempotency_key UNIQUE(principal_id, workspace_id, idempotency_key), class, descriptor_json, descriptor_digest, decision_json, state CHECK(INTENT,DISPATCHED,APPLIED,REJECTED,UNKNOWN,BLOCKED), receipt_json, trace_id, created_at, updated_at)` plus ALTERs on `automation_workflows`: project_id, coding_phase, branch, commit_sha, pr_number, pr_url, policy_revision_json, trace_id |
| `apps/runner/src/agent-governance/action-store.ts` | CAS state transitions |
| `apps/runner/src/agent-governance/action-broker.ts` | The gate at execution time, as described above |
| `apps/runner/src/agent-governance/workspace-execution-backend.ts` | `ExecutionBackend` port over `WorkspaceService` ops |
| `apps/runner/src/agent-governance/runtime-adapters.ts` | `PiRuntimeAdapter` manifest (brokered action set); unsupported actions fail closed; a native-action declaration sets trace `coverage: partial` |
| `apps/runner/src/automation-coding.ts` | Publish pipeline and reconciliation |
| `test/support/fake-github-backend.ts` | Temp working checkout plus a local bare remote; in-memory PR registry; failure injection (429, 500, timeout-after-effect, crash-after-effect-before-receipt). Implements the broker interface used by `github_action`/`github_read` |
| `test/support/coding-harness.ts` | Real StateStore, AgentManager (scripted Pi via `apps/runner/test/support/agent-runtime-fakes.ts`), AutomationService, ActionBroker, fake GitHub. Reused by PR5 and PR6. |
| `test/fixtures/coding-repo/` | Small repo: two source files and one failing test that the scripted Pi fixes |
| `apps/runner/test/action-broker.test.ts` | Gate re-check, stale generation, revocation, budget, parity with `PolicyService.simulate` |
| `apps/runner/test/automation-coding.test.ts` | Pipeline steps, replay, reconciliation per step |
| `apps/runner/test/runtime-adapters.test.ts` | Conformance: Pi = full; a second fake adapter declaring native actions = partial; an unsupported action is rejected |
| `test/integration/coding-issue-to-pr.test.ts` | D1 scenarios (below) |

## Files to modify

| File | Change |
|------|--------|
| `packages/contracts/src/index.ts` | Append the export |
| `packages/contracts/src/runner-api.ts` | Add `exec_run`, `git_status` and `git_diff` to `AgentProxyOperationSchema` (:277) |
| `apps/agent-runtime/src/protocol-schemas.ts` (:16), `apps/agent-runtime/src/proxy-tools.ts` (:94) | Matching ops and tool definitions. Both enum copies change in the same commit; `apps/agent-runtime/test/proxy-operation-parity.test.ts` (new) asserts they are equal |
| `packages/contracts/src/model-profile-schemas.ts` (:126, :142) | Raise `maxProxyOperations` `.max(10)` to `.max(13)` in both schemas; extend the existing profile schema tests |
| `apps/runner/src/agent-governance/install-executor.ts` (new) plus `apps/runner/src/workspace-service.ts` | One-shot `dependency-access` lockfile install container, only if the owner confirms. Unit test `apps/runner/test/install-executor.test.ts` covers the container args; Docker test `test/integration/install-executor.docker.test.ts` is added to the explicit `test:docker` list in `package.json` |
| `packages/contracts/src/automations-api.ts` | Rule `mode: 'analyze' \| 'code'` (default analyze), `projectId`, `verifyCommand`, `baseBranch`; run DTO fields (branch, commit, pr, codingPhase, traceId) |
| `packages/contracts/src/config.ts`, `apps/runner/src/config.ts`, `.env.example` | `AGENT_CODING_ENABLED` (false). Startup validation requires `AGENT_POLICIES_ENABLED` and, for code mode, `AUTOMATIONS_ENABLED` |
| `apps/runner/src/agent-manager.ts` | `proxyTool` (:677) routes through `ActionBroker` when one is configured; the `agent_effects` ledger remains |
| `apps/runner/src/workspace-service.ts` | Construct and inject the broker (:382); spawn-time proxy-op validation behind the flag |
| `apps/runner/src/automation-service.ts` | Code mode: at spawn, persist the policy snapshot, project and trace id; grant the code proxy-op set; after collect, call `automation-coding` instead of the comment-only publish; comment with the PR link |
| `apps/runner/src/automation-schema.ts` | Call the action-schema ALTER helper (idempotent) |
| `apps/runner/src/state-store.ts` | Initializer call |
| `apps/api/dashboard/dashboard-render.js`, `apps/api/dashboard/dashboard.js` | Rule dialog mode and project; run detail shows phase, branch, commit, PR link and actions list |
| `docs/mcp-api.md`, `docs/security-model.md`, `docs/system-architecture.md`, `docs/configuration.md`, ADR 0006 notes, `docs-site/dashboard/automations.md` (confirm the existing filename), `.agents/skills/cloudharness/**` (new proxy ops, code mode) | Docs and skill |

## Must not touch

`event-outbox.ts`, `apps/runner/src/notifications/`, `apps/runner/src/decision-plane/` (except through the PR3 interface),
`tool-schemas.ts` (no new MCP tools), and policy store internals beyond the resolver API.

## D1 integration scenarios (`test/integration/coding-issue-to-pr.test.ts`)

1. Happy path: a labelled issue gives one workflow. Pi edits at least two files and the failing test passes. There is
   one commit on `agent/*`, one push to the bare remote, and one PR containing "Closes #N". The PR is never merged.
   A trace exists with model, tool and action spans and receipts readable after workspace close.
2. Webhook redelivery (same delivery id and a new delivery id for the same issue) gives one workflow.
3. Runner restart between every publish step gives one commit, one push and one PR.
4. Crash after the push effect and before the receipt: reconciliation records APPLIED and no second push happens.
5. Unreadable remote state after the crash: BLOCKED/`EFFECT_UNKNOWN`, no retry.
6. Prompt injection in the issue body ("push to main", "disable tests"): the branch is always `agent/*`, the
   gate rejects edits outside policy paths, and the decision is unchanged.
7. Webhook payload tries to set principal, project or policy: those fields are ignored, as asserted on the workflow row.
8. A lockfile change is gated `package_install` and denied by default.
9. Kill switch flipped mid-run: `CODING_DISABLED`, no publish.
10. REQUIRE_APPROVAL action (PR4 behaviour): fails closed with zero effects. PR6 replaces this.
11. A verify command failure produces no commit and preserves the diff artifact.

## Tests (Windows-friendly)

```
npm run build -w @cloud-harness/contracts
npx vitest run packages/contracts/test/coding-actions.test.ts packages/contracts/test/automations-api.test.ts
npx vitest run apps/agent-runtime/test
npx vitest run apps/runner/test/action-broker.test.ts apps/runner/test/automation-coding.test.ts apps/runner/test/runtime-adapters.test.ts apps/runner/test/automation-service.test.ts apps/runner/test/agent-manager.test.ts
npm run build -w @cloud-harness/api
npx vitest run test/integration/coding-issue-to-pr.test.ts
npx vitest run packages/contracts/test/cloudharness-skill-contract.test.ts
npm run typecheck && npm run lint && npm run plugin:sync && npm run plugin:check && npm run docs:reference && npm run docs:check
```

The fake GitHub backend uses local `git` against a temp bare repo, which works on Windows
(use `os.tmpdir()` and avoid symlinks). CI runs all of these in `npm run verify`. If the
executor image's tool list changes, `test/e2e/pi-agent.docker.test.ts` must still pass in the Docker job.

## Risks

| Risk | L x I | Mitigation |
|------|-------|------------|
| Duplicate effects on replay | M x H | Per-step idempotency keys, persisted results, read-based reconciliation, BLOCKED on unknown |
| `exec_run` as an escape hatch | M x H | Command allowlist from policy, executor restrictions unchanged, `network-none` kept, timeouts from the existing exec bounds |
| Conflict with PR1 in agent-manager and workspace-service | H x M | Rebase on PR1; recorder and broker calls are separate lines |
| PR too large | H x M | Pre-agreed split into 4a/4b |
| Prompt injection steering publish | M x H | Publish is deterministic and orchestrator-owned; the branch name comes from the workflow id |

## Rollback

`AGENT_CODING_ENABLED=false` stops new and in-flight coding. Reverting the code leaves the
`coding_actions` table and nullable `automation_workflows` columns, which are ignored by older code. Rules
saved with `mode: 'code'` must be switched to analyze or deleted before the revert, because the
older schema would reject the unknown field. Document this in `docs/configuration.md`.
