# Phase 3: Catalog tiers, provenance resolution, repricing review

Depends on phase 2, which adds the revision provenance fields. This phase can run in parallel with phase 4: the two touch disjoint files.

Owner files:
- `packages/contracts/src/{model-catalog-schemas.ts, model-profile-schemas.ts}`
- `apps/runner/src/model-catalog/{openrouter-catalog.ts, model-catalog-service.ts, pricing-review.ts (new)}`
- `apps/runner/src/dashboard-control-service.ts`, limited to the `model_profile_list|create|update` cases
- tests: `apps/runner/test/{model-catalog-sources.test.ts, model-catalog-service.test.ts, model-pricing-review.test.ts (new), model-profile-state-repository.test.ts}`, `packages/contracts/test/` (schema cases)
- docs: `docs-site/dashboard/models.md`

MCP skill / `docs/mcp-api.md`: no change, because the catalog and profiles reach MCP only in #359.

## Current behaviour (verified)

- Catalog prices come only from OpenRouter metadata (`model-catalog-service.ts:140-159`). Provider listings carry no prices.
- `openrouter-catalog.ts:76-81` keeps only `input_cache_write`. It drops `input_cache_write_1h`, and it reduces `overrides[]` to a `hasConditionalPricing` boolean. The sample in `plans/261017-0429-353-provider-first-model-setup/openrouter-models-sample.json` shows `overrides:[{min_prompt_tokens:200000, prompt, completion, input_cache_read, input_cache_write, input_cache_write_1h}]`.
- `SourceCache.get` (`model-catalog-service.ts:72-88`) fetches when the cache is stale. No cache-only read exists.
- The `model_profile_list` case (`dashboard-control-service.ts:497`) returns `listProfiles` unchanged. The create and update cases (`:498-507`) pass the client input straight through.

## Requirements

1. **Catalog tiers.**
   - `ModelCatalogPriceSchema` gains optional `tiers`, reusing phase 2's `ModelPriceTierSchema`.
   - The OpenRouter normaliser maps every override whose only condition is `min_prompt_tokens` to a tier. An override with any other condition sets `hasConditionalPricing: true` and is skipped.
   - The cache-write price becomes max(`input_cache_write`, `input_cache_write_1h`). The pi runtime can request long retention, and usage does not say which write kind was billed.
2. **Cache-only lookup.** Add `peek(request)` to `SourceCache`. It returns the in-memory or persisted snapshot and never fetches.
   - `ModelCatalogService.cachedPrice(provider, revisionModel, sourceModelId)` resolves a `sourceModelId` directly against the OpenRouter snapshot. When there is no `sourceModelId`, it falls back to `VendorModelIndex.match` (legacy revisions). Listing profiles never makes a network call.
3. **Provenance at save.**
   - `AgentModelProfileInputSchema` and the update schema gain optional `catalogPriceRef: {sourceModelId}`; the wizard (#357) sends it.
   - The runner compares the submitted pricing (input, output, cache read/write, tiers) with the cached catalog price for that ref.
   - On an exact match, provenance is copied from the catalog with `isOverride=false`. Confidence is `exact` for the openrouter provider and `estimate` for direct vendors, matching `:140-159`.
   - Otherwise provenance is `{source:'user', sourceModelId, retrievedAt, isOverride:true}`.
   - Clients cannot assert provenance or confidence directly.
4. **Repricing review** (`pricing-review.ts`, pure). Compare the active revision with `cachedPrice` and return `pricingReview: {state: 'current'|'repriced'|'unknown', changes: [{field, pinned, catalog, percent}], catalogRetrievedAt, isOverride}`.
   - `repriced` when any of these differs by at least `REPRICING_WARNING_PERCENT = 10` percent: input, output, cache read, cache write, or a tier price. It is also `repriced` when the pinned price is 0 and the catalog price is positive, when the catalog has tiers that the revision lacks, or when the revision pins a cache price the catalog no longer publishes. Catalog conditional pricing that cannot be expressed as tiers never changes the state; it is reported separately as `catalogHasConditionalPricing` so the warning stays actionable.
   - `unknown` when the catalog has no entry or no snapshot.
   - The threshold constant lives in `model-catalog-schemas.ts`. It applies in both directions, because an increase leaves estimates and caps understated and a decrease leaves them overstated.
   - For an override, the review is informational. The UI shows "differs from catalog" instead of "repriced since saved".
   - `AgentModelProfileMetadataSchema` gains optional `pricingReview`. Only `model_profile_list` attaches it. Nothing persists it, so a refresh changes the warning but never the pinned prices or limits.
5. **Non-overwrite invariant.** No catalog code path writes revisions. Tests pin this.

## Tests

- `model-catalog-sources.test.ts`:
  - the sample model yields a tier at 200,000;
  - the cache-write price is the 1h price;
  - an unknown-condition override sets the flag and produces no tier.
- `model-catalog-service.test.ts`:
  - `peek` never calls the fetcher;
  - `cachedPrice` resolves by ref and by legacy model ID.
- `model-pricing-review.test.ts`:
  - 9.9% gives `current`; 10% gives `repriced` in both directions;
  - a zero pinned price;
  - missing tiers, a missing catalog, and the override label.
- `model-profile-state-repository.test.ts` (service level):
  - forcing a catalog refresh with changed prices leaves `listProfiles` pricing, provenance, and limits byte-identical, and flips `pricingReview` to `repriced`;
  - a matching `catalogPriceRef` saves `isOverride=false`; an edited price saves `isOverride=true`.

## Docs

- `docs-site/dashboard/models.md`: catalog tiers, how provenance is assigned at save, the repricing warning and its threshold, and that refresh never changes saved prices.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| Cold cache after a restart gives `unknown` reviews | M×L | `peek` loads the persisted last-good snapshot (`catalog-snapshot-store.ts`). |
| Legacy model IDs fail to match | M×L | The review reads `unknown`; matching stays strict as at `model-catalog-service.ts:174-179`. |
| Wizard (#357) does not yet send `catalogPriceRef` | H×L | Saves are recorded as user overrides until it does. That is safe, only less informative. |

## Rollback

Revert the PR. Nothing is persisted beyond what phase 2 stores.
