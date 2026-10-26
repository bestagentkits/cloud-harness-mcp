# Phase 02 (PR2): ADR, policy contracts, policy store, GateDecision, Dashboard policy editor (#417)

Branch: `feat/417-agent-policies` from `origin/dev`. Target `dev`. Effort about 24h.
Wave W1, which can run in parallel with PR1. Merges second and rebases on PR1's hotspot lines.

## Context

- There is no execution policy today. Automations are hard-limited to read-only proxy ops
  (`AUTOMATION_DEFAULT_PROXY_OPERATIONS` in `packages/contracts/src/automations-api.ts`).
- Projects exist as metadata rows (`apps/runner/src/metadata-schema.ts:19`) and the page
  `/dashboard/projects`.
- The feature channel pattern is the internal router `/v1/internal/automations` (runner
  `apps/runner/src/app.ts:30`, `:97`) and Dashboard routes in
  `apps/api/src/dashboard-control-router.ts:252-267` through `automationsEndpoint` (:397).
- Dashboard writes are protected by Origin/Host plus a JSON content-type check
  (`apps/api/src/dashboard-security.ts`).

This PR delivers the policy model and the pure evaluator. Enforcement on real actions
is wired in PR4, so this PR does not touch `agent-manager.ts`.

## Data flow

```
Owner (Dashboard) -> /dashboard/api/agent-policies (CSRF checked)
  -> runner-client -> /v1/internal/agent-policies -> PolicyService
     -> PolicyStore: append immutable revision; CAS head (expectedRevision)
Simulation: ActionDescriptor + scope -> PolicyResolver(global head, project head)
     -> GateEvaluator (pure) -> GateDecision { decision, reasons[], matchedRules[], policyRevisionIds, advisor: {consulted:false} }
Execution (PR4): ActionBroker uses the same PolicyResolver + GateEvaluator
```

## Precedence (evaluated in order; first terminal result wins, then monotonic max)

1. Platform deny (invariant classes: credential access, Docker, network escalation, writes outside workspace)
2. Stale or revoked generation, or budget exhausted -> DENY
3. Global `hardDeny`
4. Repository, branch, path and command scope (deny on miss)
5. Global allowed action classes
6. Project narrowing (it can only remove classes, tighten paths and lower budgets)
7. Global `mandatoryApproval` -> REQUIRE_APPROVAL
8. Delegable defaults and project rules (ALLOW or REQUIRE_APPROVAL)
9. `ADVISOR_OR_APPROVAL`: discretionary. Without an advisor (PR3) it resolves to REQUIRE_APPROVAL.

A missing project policy means the global policy applies alone. A project policy that
references an unknown or deleted project is DENY with `PROJECT_POLICY_ORPHANED`. A
project can never loosen the global policy; the schema rejects such widening on save and
the evaluator also enforces it.

## Files to create

| File | Purpose |
|------|---------|
| `docs/adr/0006-policy-governed-coding-agents.md` | Ports (RuntimeAdapter, ExecutionBackend, ActionBroker, PolicyResolver/GateEvaluator, DecisionAdvisor, EventStore, NotificationAdapter), identity model, precedence, the orchestrator-owned publish decision, the advisor monotonicity rule, consequences |
| `packages/contracts/src/agent-policy-api.ts` | `ExecutionPolicy` v1 (global and project), `ActionClass` enum (read, edit, test, vcs_local, publish_branch, open_pr, network, package_install), `ActionDescriptor` v1, `GateDecision` v1, `PolicySimulation` request/result, revision DTOs, internal channel schemas |
| `packages/contracts/test/agent-policy-api.test.ts` | Bounds, rejection of widening project fields, enum stability |
| `apps/runner/src/agent-governance/ports.ts` | Port interfaces only |
| `apps/runner/src/agent-governance/policy-schema.ts` | `initializeAgentPolicySchema`: `agent_policy_revisions(revision_id PK, principal_id, scope CHECK(global,project), project_id NULL, version, document_json, digest, created_at, created_by, rollback_of NULL)` and `agent_policy_heads(principal_id, scope, project_id, revision_id, version, PRIMARY KEY(principal_id, scope, project_id))` |
| `apps/runner/src/agent-governance/policy-store.ts` | Immutable revisions; CAS head update; rollback creates a new revision |
| `apps/runner/src/agent-governance/gate-evaluator.ts` | Pure `evaluateGate(input) -> GateDecision`, plus `combineAdvisor(deterministic, advisorEffect)` |
| `apps/runner/src/agent-governance/policy-resolver.ts` | Loads heads for (principal, project) and returns a frozen snapshot with revision ids |
| `apps/runner/src/agent-governance/policy-service.ts` | CRUD, history, diff, simulate, rollback; owner scoping |
| `apps/runner/src/agent-governance/policy-router.ts` | `/v1/internal/agent-policies` routes |
| `apps/runner/test/gate-evaluator.test.ts` | D2 table-driven matrix plus property tests |
| `apps/runner/test/policy-store.test.ts` | Immutability, CAS conflict, rollback, idempotent schema, cross-principal isolation |
| `apps/runner/test/policy-service.test.ts` | Simulate equals evaluator output; orphaned project |
| `apps/api/dashboard/dashboard-policies.js` | Editor: form plus JSON view, simulation panel, diff, history, rollback |
| `apps/api/test/dashboard-policies-router.test.ts` | CSRF, owner scoping, CAS conflict -> 409 |
| `apps/api/test/dashboard-policies-ui.test.ts` | Render contract |
| `docs-site/dashboard/agent-policies.md` | User guide |

## Files to modify (append-only)

| File | Change |
|------|--------|
| `packages/contracts/src/index.ts` | Append the export |
| `packages/contracts/src/config.ts`, `apps/runner/src/config.ts`, `.env.example` | `AGENT_POLICIES_ENABLED` (default false) |
| `apps/runner/src/state-store.ts` | Call `initializeAgentPolicySchema` |
| `apps/runner/src/app.ts`, `apps/runner/src/index.ts` | Mount the router and construct the service |
| `apps/api/src/runner-client.ts` | Policy methods |
| `apps/api/src/dashboard-control-router.ts` | Policy routes, following the `automationsEndpoint` (:397) pattern |
| `apps/api/dashboard/dashboard-pages.js`, `apps/api/src/dashboard-assets.ts`, `apps/api/dashboard/dashboard.js`, `dashboard.css` | Register Settings > Agent policies and Projects > :id > Agent policies; delimited CSS block |
| `docs/security-model.md`, `docs/system-architecture.md`, `docs/configuration.md` | Policy authority, precedence, flag |

## Must not touch

`agent-manager.ts`, `workspace-service.ts`, `tool-schemas.ts`, `runner-api.ts`,
`automation-*.ts`, `event-outbox.ts`, the `apps/runner/src/decision-plane/` directory, and PR1-owned files.

## D2 test matrix (`gate-evaluator.test.ts`, 100% of rows required)

Rows: global only; project only (with the global default); both; missing project policy;
orphaned project; stale generation; revoked; budget exhausted; global hardDeny versus
project allow; global mandatoryApproval versus project allow; project attempts to widen
(rejected at save and ignored at eval); path outside scope; branch not `agent/*` for
`publish_branch`; command not in allowlist; `ADVISOR_OR_APPROVAL` without advisor resolves to
REQUIRE_APPROVAL.

Property test: for random policies and descriptors, adding a project policy never lowers
the decision, and `combineAdvisor` never yields ALLOW from REQUIRE_APPROVAL or DENY.
Inputs whose descriptor carries prompt-injected text in a free-form `reason` field must
not change the decision: the evaluator ignores free text.

## Tests (Windows-friendly)

```
npm run build -w @cloud-harness/contracts
npx vitest run packages/contracts/test/agent-policy-api.test.ts
npx vitest run apps/runner/test/gate-evaluator.test.ts apps/runner/test/policy-store.test.ts apps/runner/test/policy-service.test.ts
npx vitest run apps/api/test/dashboard-policies-router.test.ts apps/api/test/dashboard-policies-ui.test.ts apps/api/test/dashboard-pages.test.ts
npm run typecheck && npm run lint && npm run docs:reference && npm run docs:check
```

CI covers all of these in `npm run verify`. There is no Docker test in this PR.

## Feature flag

`AGENT_POLICIES_ENABLED=false`. When off, the routes return `FEATURE_DISABLED` and the
Dashboard hides the editor. PR4 refuses to enable coding unless this flag is on.

## Docs

ADR 0006, `docs/security-model.md`, `docs/configuration.md`,
`docs-site/dashboard/agent-policies.md` plus navigation, and generated environment references.
There is no skill change because there are no MCP tools.

## Risks

| Risk | L x I | Mitigation |
|------|-------|------------|
| Evaluator and simulation drift from execution | M x H | One pure function; PR4 adds a parity test that calls simulate and the broker on the same input |
| Policy JSON grows unbounded | L x M | Zod size caps; revision count cap per scope with history paging |
| Concurrent edits | M x M | CAS on `expectedRevision`, 409 in the UI with a reload diff |

## Rollback

Turn the flag off. Revert the code; the two tables become inert. No existing table changes.
