# Phase 03 (PR3): Jev `execution-risk` advisor (#417 B, #333)

Branch: `feat/417-jev-execution-risk` from `dev` after PR2 merges. Target `dev`.
Effort about 12h. Wave W2, which can run in parallel with PR4 and PR5 (file sets are disjoint).

## Context

- `DECISION_PURPOSES` already lists `execution-risk`, but
  `IMPLEMENTED_DECISION_PURPOSES = ['failure-classification','mcp-routing']`
  (`packages/contracts/src/decision-plane.ts:27`).
- Config caps the array: `decisionPlanePurposes: z.array(ImplementedDecisionPurposeSchema).max(2)`
  (`packages/contracts/src/config.ts:262`). `typesafeEgress` is the instance-wide egress switch.
- `DecisionPlane.evaluate` (`apps/runner/src/decision-plane/decision-plane.ts`) never
  throws. It returns typed fallbacks and has a 1500 ms timeout, a rate limit and `redact()`.
  `createRunnerDecisionPlane` (`apps/runner/src/decision-plane/runner-decision-plane.ts:31`)
  wires `JevDecisionProvider` with the TypeSafe credential and audits `decision.evaluated`.
  `FailureIntelligence` is the in-repo integration precedent.

## Data flow

```
GateEvaluator -> ADVISOR_OR_APPROVAL (discretionary only)
  -> ExecutionRiskAdvisor.assess(summary)
       summary = { actionClass, repoAllowlisted, pathsTouchedCount, diffLines, testsPassed,
                   commandDigest, hasNetwork, packageChanges } (bounded, redacted, no free text)
       -> DecisionPlane.evaluate(purpose='execution-risk', questions:
            risk_score 0..1, uncertain_side_effects bool, human_required bool)
  -> advisorEffect: escalate | no_change  (+ decisionId, risk, confidence, fallbackReason)
  -> combineAdvisor(deterministic=REQUIRE_APPROVAL default for discretionary, effect)
```

Mapping: by default `ADVISOR_OR_APPROVAL` starts at the policy's `discretionaryDefault`
(ALLOW or REQUIRE_APPROVAL, owner-chosen). The advisor result only escalates ALLOW to
REQUIRE_APPROVAL, when `risk >= threshold`, `human_required` or `uncertain_side_effects` is true, or on any fallback.
Every fallback is conservative and escalates. With the advisor off and `discretionaryDefault=ALLOW`, the
action is allowed with no egress.

## Files to create

| File | Purpose |
|------|---------|
| `apps/runner/src/decision-plane/execution-risk-advisor.ts` | Builds the summary, calls `DecisionPlane.evaluate`, returns a typed `AdvisorEffect` |
| `apps/runner/test/support/fake-jev-provider.ts` | Scripted `DecisionProvider` with answers, latency, 429/500, invalid payload and a call counter. Reused by PR6. |
| `apps/runner/test/execution-risk-advisor.test.ts` | Fallback matrix |
| `apps/runner/test/gate-evaluator-advisor.test.ts` | Monotonic combination with the real evaluator from PR2 |
| `test/fixtures/decision-plane/execution-risk.json` | Fixture answers |

## Files to modify

| File | Change |
|------|--------|
| `packages/contracts/src/decision-plane.ts` | Add `execution-risk` to `IMPLEMENTED_DECISION_PURPOSES` (:27) plus its answer schema |
| `packages/contracts/src/config.ts` | `.max(2)` becomes `.max(3)` at :262 |
| `packages/contracts/test/decision-plane*.test.ts` (existing) | Accept the new purpose; reject unknown ones |
| `packages/contracts/src/agent-policy-api.ts` (PR2-owned, merged) | Add `advisor: { enabled: false, riskThreshold: 0.5, minConfidence: 0.7 }` and `discretionaryDefault` to the policy, plus `advisor` on `GateDecision` |
| `apps/runner/src/agent-governance/policy-service.ts` | Simulation reports `advisor.consulted`, `decisionId`, `risk`, `confidence`, `fallbackReason` |
| `apps/runner/src/agent-governance/gate-evaluator.ts` | Accept an optional precomputed `AdvisorEffect`; it stays pure |
| `apps/runner/src/index.ts` | Construct the advisor from the existing runner decision plane (one wiring line) |
| `apps/api/dashboard/dashboard-policies.js` | Advisor toggle and threshold; simulation shows "Jev consulted: yes/no (reason)" |
| `docs/configuration.md`, `docs/security-model.md`, `docs-site/dashboard/agent-policies.md`, ADR 0006 implementation notes | Advisor semantics: never authorizes, escalate only |

## Must not touch

`agent-manager.ts`, `automation-*.ts`, `workspace-service.ts`, `event-outbox.ts`,
`runner-api.ts`, `tool-schemas.ts`, and every file PR4 or PR5 creates.

## Fallback matrix (zero false ALLOW)

| Condition | Expected |
|-----------|----------|
| Advisor disabled in the policy | `consulted:false`; provider call count 0 |
| Purpose not in `DECISION_PLANE_PURPOSES` or `typesafeEgress` off | `consulted:false, fallbackReason: disabled`; 0 calls |
| Credential unconfigured | `fallbackReason: unconfigured`, escalate |
| Timeout (> 1500 ms) | `timeout`, escalate |
| 429 / rate limited | `rate_limited`, escalate |
| Invalid answer schema | `invalid_answer`, escalate |
| Confidence < minConfidence | `low_confidence`, escalate |
| Redaction failure | `redaction_failed`, escalate, 0 calls |
| Risk below threshold, confident, no flags | `no_change` (ALLOW stays ALLOW) |
| Any answer with deterministic DENY or REQUIRE_APPROVAL | unchanged (never downgraded); the advisor is not called for non-discretionary results |

Injection test: summary fields are typed. The test asserts that a prompt-injected string in
an issue body never reaches the provider payload (spy on the fake provider input).

## Tests (Windows-friendly)

```
npm run build -w @cloud-harness/contracts
npx vitest run packages/contracts/test/decision-plane.test.ts
npx vitest run apps/runner/test/execution-risk-advisor.test.ts apps/runner/test/gate-evaluator-advisor.test.ts apps/runner/test/gate-evaluator.test.ts
npx vitest run apps/runner/test/decision-plane
npx vitest run apps/api/test/dashboard-policies-ui.test.ts
npm run typecheck && npm run lint && npm run docs:reference && npm run docs:check
```

Confirm the exact existing decision-plane test file names with
`git ls-files packages/contracts/test apps/runner/test | grep decision` before running.
CI covers all of these in `npm run verify`. No real Jev call is made anywhere.

## Feature flag

Off unless the operator adds `execution-risk` to `DECISION_PLANE_PURPOSES`, enables
`typesafeEgress`, and enables the advisor in a policy. All three are required.

## Risks

| Risk | L x I | Mitigation |
|------|-------|------------|
| Advisor used as an allow source | L x H | Type-level `AdvisorEffect` lacks allow; property test from PR2 extended |
| Latency on the action path | M x M | 1500 ms cap; consulted only for discretionary actions; rate-limit fallback escalates |
| Data egress | L x H | Typed bounded summary, `redact()`, zero calls when off (asserted) |

## Rollback

Remove `execution-risk` from `DECISION_PLANE_PURPOSES`. A code revert restores `.max(2)`.
Configs that list three purposes then fail validation at startup, so remove the purpose
before reverting (documented in `docs/configuration.md`).
