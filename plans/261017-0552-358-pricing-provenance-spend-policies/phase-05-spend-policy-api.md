# Phase 5: Spend policy and summary API

Depends on:
- phase 3, because both edit `dashboard-control-service.ts`;
- phase 4, which provides the ledger, the policy repository, and the schemas;
- #370, because both edit `internal-runner-api.ts` and `dashboard-response.ts`.

Nothing runs in parallel with it.

Owner files:
- `packages/contracts/src/internal-runner-api.ts`
- `apps/runner/src/dashboard-control-service.ts` (new `model_spend_*` cases only)
- `apps/api/src/{dashboard-control-router.ts, dashboard-response.ts}`
- tests: `packages/contracts/test/` (operation schemas), `apps/runner/test/dashboard-control-service*.test.ts` or a new `model-spend-api.test.ts`, `test/integration/dynamic-model-profiles.test.ts` (one HTTP round trip)
- docs: `docs-site/dashboard/models.md`, `docs/system-architecture.md` (only if its route list names operations)

MCP skill / `docs/mcp-api.md`: no change here. MCP parity for budget usage is #359; open question 4.

## Current state (verified)

- Model operations are listed in `internal-runner-api.ts:194-198` and get schemas at `:309-328`. They are registered as metadata requests at `:615-619`.
- The API passes runner refusals through for the model operations listed at `dashboard-response.ts:672-674`. Its operation list is at `:232-235`.
- Routes: `dashboard-control-router.ts:57,120-136`. Runner handlers: `dashboard-control-service.ts:481-560`. Mutations go through `mutation()` (`:1673`).

## Requirements

1. **Operations** (additive, next to the existing model operations):
   - `model_spend_summary`: `{}` in, `ModelSpendSummarySchema` out;
   - `model_spend_policy_list`;
   - `model_spend_policy_set`: `{profileId?, period, limitMicros, warnPercent?, expectedGeneration?}`, an upsert keyed by scope and period, where a generation conflict gives `CONFLICT`;
   - `model_spend_policy_delete`: `{policyId, expectedGeneration}`.
2. **Summary shape** (every amount is an estimate). For the current UTC day and month, per principal and per profile with a policy or recorded spend:
   - `estimatedSettledMicros`, `estimatedReservedMicros` (open rows at their cap), and `estimatedUnreconciledMicros`;
   - the policy, with `thresholdState` (`ok|warning|exceeded`);
   - `isEstimate: true`, and a `windowStartsAt` and `windowEndsAt` in ISO UTC.

   A profile id whose profile was deleted is still listed, so the user can delete its policy.
3. **Validation.**
   - `limitMicros` is an integer from 1 to 1e12. `warnPercent` is 1 to 100, default 80. There are at most 64 policies per principal.
   - `profileId` must name one of the principal's profiles when the policy is created; otherwise `NOT_FOUND`, with the API wording "Model profile not found.".
4. **Audit.** Policy set and delete are recorded through the same `mutation()` path as profile changes. The audit entry contains ids, the period, and the limit.
5. **Routes:**
   - `GET /api/v1/model-spend`: summary and policies;
   - `PUT /api/v1/model-spend/policies`: set;
   - `DELETE /api/v1/model-spend/policies/:id`: delete, with `generation` in the body as in the `integration-credentials` delete at `:55`.
6. **Pass-through.** `model_spend_policy_set` and `model_spend_policy_delete` join the pass-through list, so the runner's plain refusal text reaches the dashboard. That text never contains credentials.

## Tests

- Contracts: the operation schemas accept and reject the boundary values above.
- Runner:
  - a set, update, and delete cycle with generation conflicts;
  - a summary that splits settled, reserved, and unreconciled amounts;
  - the threshold states at 79%, 80%, and 100%;
  - principal isolation: principal B never sees or changes principal A's policies or spend;
  - a policy set through the API makes the next spawn over the limit fail. This is an end-to-end check with phase 4.
- Integration: one HTTP round trip through the API to a stub runner, checking the route and response envelope.

## Docs

- `docs-site/dashboard/models.md`, a new "Spend policies" section:
  - scopes and periods;
  - UTC windows: a run counts in the day it started;
  - the run's cap is reserved until the run settles;
  - unreconciled entries;
  - every figure is an estimate.
- No `docs/configuration.md` change: there are no new environment keys.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| A merge conflict with #370 in the operation lists | H×L | Start after #370 merges. The edits only append. |
| Users read the summary as billing | M×M | Every field is `estimated*`, there is an `isEstimate` flag, and the docs say so. |

## Rollback

Revert the PR. Policies already stored keep being enforced by phase 4 code. To lift enforcement during an incident, delete the policy before reverting.
