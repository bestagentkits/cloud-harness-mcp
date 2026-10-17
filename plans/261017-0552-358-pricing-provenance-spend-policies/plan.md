---
title: "Pricing provenance, cache-aware accounting, and aggregate spend policies (#358)"
description: "Pin price provenance on revisions, charge cached/reasoning tokens conservatively in the gateway, and enforce durable per-principal and per-profile spend policies."
status: pending
priority: P1
effort: 34h
branch: claude/determined-gates-3zyr4g
tags: [model-gateway, pricing, budgets, runner-state, umbrella-353]
created: 2026-10-17
---

# Pricing provenance and spend policies (#358, phase 5 of #353)

Base: `origin/dev` at 5d37e33 (phases 1-3 merged). Each phase is one PR to `dev`.

## Outcome

Every saved revision records where its prices came from and keeps them when the
catalog changes. The gateway charges cached, cache-write, reasoning, and tiered
usage, and never charges less than the provider bills. A durable runner ledger
enforces daily/monthly per-principal and per-profile spend limits. Per-run caps
stay as they are, and every aggregate figure is labelled an estimate.

## Decisions (evidence in phase files)

1. **Ledger location.** The ledger is SQLite in the runner (`model_spend_ledger`, `model_spend_policies`), created additively. No usage path from the gateway to the runner exists today. The gateway runs with `noOpBudgetHooks` (`apps/model-gateway/src/index.ts:5`), and `revoke` returns only `{revoked}` (`control.ts:82`). **A lease is the reservation:** spawn reserves the run's `maxCostMicros` cap in the ledger inside the `reserveSpawn` transaction. The gateway enforces that cap in RAM, so checking the policy needs no per-request round trip. When the runner revokes a lease, the gateway returns its settlement. A lease lost to a gateway restart is settled at the full cap and marked `unreconciled`.
2. **Token fields.** The per-provider field table is in phase 1. Unknown cache-read prices default to the input price. Unknown cache-write prices default to 2x the input price for providers that bill writes. Input is reserved at max(input, cache-write) for the tier that applies to the estimated tokens.
3. **Revision schema.** No version bump. Nullable or defaulted columns are added additively and idempotently, following `state-store.ts:459-479`. Existing rows backfill to `source='user'`, `confidence='unknown'`, `isOverride=true`.
4. **Repricing warning.** A warning fires when any pinned price differs by 10% or more from the cached catalog price, or when the catalog has conditional tiers the revision lacks. It is computed only when the profile list is read. It appears as `pricingReview` on profile metadata and as a badge in the dashboard.

## Phases

| # | Phase | Effort | Depends on | Parallel with |
| --- | --- | --- | --- | --- |
| 1 | [Gateway cache-aware accounting and reservation review](phase-01-gateway-cache-aware-accounting.md) | 6h | — | 2 |
| 2 | [Revision pricing and provenance persistence](phase-02-revision-pricing-provenance.md) | 6h | #370 merged | 1 |
| 3 | [Catalog tiers, provenance resolution, repricing review](phase-03-catalog-tiers-repricing-review.md) | 5h | 2 | 4 |
| 4 | [Durable spend ledger and spawn-time enforcement](phase-04-spend-ledger-enforcement.md) | 8h | 1, 2 | 3 |
| 5 | [Spend policy and summary API](phase-05-spend-policy-api.md) | 4h | 3, 4, #370 | — |
| 6 | [Dashboard pricing and spend UI](phase-06-dashboard-pricing-spend-ui.md) | 5h | 5, #357 merged | — |

The parallel pairs touch disjoint files, including docs; each phase file lists
what it owns. Phase 1 changes only `apps/model-gateway/` and is
compatible in both directions: the current runner ignores additive control
fields, and absent pricing fields keep today's semantics.

## Acceptance criteria (issue #358)

- Revisions expose `priceProvenance` {source, sourceModelId, retrievedAt, confidence, isOverride}; catalog refresh and pricing-less edits never change pinned prices or limits (phases 2-3).
- Gateway charges cached, cache-write, reasoning, and tiered usage; cost >= provider-reported cost; refund never exceeds the reservation (phase 1).
- Byte-to-token reservation never under-reserves; the rationale is documented (phase 1).
- Spend policies are enforced against the durable ledger, across concurrent spawns and gateway/runner restarts, with threshold states; per-run caps are unchanged (phases 4-5).
- UI and API label aggregates as estimates (phases 5-6).
- Regression tests cover cached, missing-usage, streaming, concurrent, and tiered cases (phases 1, 4).

## Validation

Run the focused suites named in each phase, then `npm run verify`. Phases that touch tool docs or the skill also run `npm run plugin:sync` and the skill contract test.

## Open questions (recommended defaults are used in the phases)

1. A lease lost to a gateway restart is settled at the full run cap and flagged `unreconciled`. Default: keep this, because it is the only bound that never under-charges.
2. When a spawn's cap exceeds the policy headroom, the spawn is refused rather than having its cap clamped. Default: refuse, which keeps per-run caps unchanged.
3. The repricing threshold is 10% in either direction. Overrides show the difference as information only.
4. Threshold warnings go to the API, the dashboard, and the runner log only, with no MCP event or `agent_spawn` field. Default: leave MCP surfacing to #359.
5. Connection-verification probes stay out of the ledger: they are tiny and rate-limited, and they never go through the gateway.

## Rollback

Revert each PR independently. No phase changes the schema version. The added columns and tables are ignored by older code. Phase 2 and its docs record one rollback caveat: an older runner bills tiered revisions at the base tier.
