# Phase 2: Revision pricing and provenance persistence

Start after #370 merges, because both PRs edit `model-profile-state-repository.ts`. This phase can run in parallel with phase 1.

Owner files:
- `packages/contracts/src/{model-profile-schemas.ts, model-pricing.ts (new), model-provider-registry.ts, config.ts, index.ts}`
- `apps/runner/src/model-profile-state-repository.ts`
- `apps/runner/src/agent-manager.ts`, limited to `profile()` and `startRecord()`
- tests: `packages/contracts/test/model-pricing.test.ts` (new), `apps/runner/test/{model-profile-state-repository.test.ts, model-profile-pricing-columns.test.ts (new), agent-manager.test.ts}`, `test/integration/dynamic-model-profiles.test.ts`
- docs: `docs-site/dashboard/models.md`, `docs/operations.md`, `docs/configuration.md` (only if static-profile keys are listed there)

MCP skill / `docs/mcp-api.md`: no change, because profiles are not on MCP until #359.

## Current behaviour (verified)

- Revision pricing is `{input, output}` only (`model-profile-schemas.ts:78-82`). The `agent_model_profile_revisions` table (`principal-store.ts:654-672`) has no provenance columns.
- `updateProfile` carries input and output forward when an edit omits pricing (`model-profile-state-repository.ts:629-632`). Any new field must be carried the same way.
- `getExportSnapshot` sends `{input, output}` to the gateway (`:863-866`). The gateway defaults missing prices to 0 (`apps/model-gateway/src/control.ts:137-138`).
- The agent start record hard-codes `cacheRead: 0, cacheWrite: 0` (`agent-manager.ts:967-972`), so the agent's self-reported cost under-counts cached usage.
- Revisions are immutable rows. Catalog code never writes to them; `model-catalog/*` has no reference to the revisions table.

## Schema decision: no version bump

Add the columns idempotently, guarded by `PRAGMA table_info`, inside a new `initializeModelProfilePricingColumns(database)`. Call it from the repository constructor next to `initializeModelVerificationSchema` (`:109`). Precedents: `state-store.ts:459-479` and `github-installation-sqlite-store.ts:82-87`.

Columns:
- `cache_read_micros_per_million INTEGER NULL`
- `cache_write_micros_per_million INTEGER NULL`
- `price_tiers_json TEXT NULL`
- `price_source TEXT NOT NULL DEFAULT 'user' CHECK(... IN ('provider','openrouter','user','none'))`
- `price_source_model_id TEXT NULL`
- `price_retrieved_at INTEGER NULL`
- `price_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(... IN ('exact','estimate','unknown'))`
- `price_is_override INTEGER NOT NULL DEFAULT 1 CHECK(... IN (0,1))`

Why no bump:
- Every column is nullable or has a default, so existing rows backfill as user-entered overrides with unknown confidence. That is truthful: those prices were typed by hand.
- Older code reads columns by name and inserts with explicit column lists (`:458-480`). A rollback therefore keeps working and its new rows get the defaults.
- A bump would also force head-version edits in 10 downgrade helpers (`principal-store.ts:1178-1584`) and 28 `toBe(14)` assertions across 11 test files, and it would add no safety.

Rollback caveat, documented in `docs/operations.md`: an older runner ignores tiers and cache prices. Cache usage is then billed at the input price, which over-charges. Long prompts on tiered revisions are billed at the base tier, which under-charges. Tiers exist only on revisions saved after the upgrade.

## Requirements

1. **Contracts.**
   - `AgentModelPricingSchema` gains optional nullable `cacheReadMicrosPerMillionTokens` and `cacheWriteMicrosPerMillionTokens`, plus optional `tiers`.
   - `ModelPriceTierSchema` has at most 4 entries. `minPromptTokens` must be strictly ascending, and each price must be >= the price below it. A null price means unknown, never free; this matches `model-catalog-schemas.ts:5-7`.
   - `AgentModelPriceProvenanceSchema` is `ModelCatalogPriceProvenanceSchema` extended with `isOverride: boolean`.
   - `AgentModelProfileRevisionSchema` gains a required `priceProvenance`.
   - Optional `cacheRead`/`cacheWrite` keys are added to the static `AgentModelProfileSchema` (`config.ts:47-62`).
2. **Registry.** `ModelProviderDefinition` gains `billsCacheWrites: boolean`:
   - `openai`, `google`, and `deepseek` are false, because their pricing has no write charge;
   - `anthropic` is false, because its compatibility endpoint does not support caching;
   - `openrouter` and `custom` are true.
3. **Effective pricing** (`model-pricing.ts`, pure). `resolveEffectivePricing(pricing, provider)` produces concrete prices:
   - an unknown read price becomes the input price;
   - an unknown write price becomes 2x input when `billsCacheWrites` is true, otherwise the input price;
   - the same rules apply inside each tier.

   One function serves both the snapshot and the agent start record. There is no second copy of these defaults.
4. **Repository.**
   - `createProfile` and `updateProfile` accept an internal `priceProvenance` argument. It comes from the service layer, never from the client schema, and phase 3 wires it. When it is absent, provenance is `{source:'user', sourceModelId:null, retrievedAt:null, confidence:'unknown', isOverride:true}`.
   - An edit without `pricing` copies pricing, tiers, and provenance from the current revision verbatim. An edit with `pricing` sets `isOverride=true` unless the service supplies a catalog provenance.
   - The digest includes cache prices and tiers only when they are present, so legacy-shaped digests stay stable.
   - `listProfiles` returns the new fields. `getExportSnapshot` sends the effective prices.
5. **Agent start record.** `profile()` (`agent-manager.ts:893-912`) maps the effective cache prices, and `startRecord` passes them instead of `0`.

## Tests

- `model-pricing.test.ts`: the default matrix per provider, tier validation, null never becoming free.
- `model-profile-pricing-columns.test.ts`:
  - fresh database and legacy v14 database, both with `initialize...` run twice;
  - legacy rows read back as user overrides;
  - an old-style explicit-column INSERT still succeeds;
  - `downgradeStateSchemaToV13` still works with the columns present.
- `model-profile-state-repository.test.ts`:
  - provenance round-trips;
  - an edit without pricing keeps prices, tiers, provenance, and limits;
  - an edit with pricing marks an override;
  - the export snapshot sends effective prices.
- `agent-manager.test.ts`: the start record carries cache prices.
- `dynamic-model-profiles.test.ts`: a snapshot with cache and tier prices applies against the gateway (once phase 1 has merged, this asserts the costs).

## Docs

- `docs-site/dashboard/models.md`: revision price provenance, overrides, cache prices, tiers, and how unknown prices are defaulted.
- `docs/operations.md`: a new subsection, "Revision pricing columns rollback", with the caveat above.

## Risks

| Risk | L×I | Mitigation |
| --- | --- | --- |
| A merge conflict with #370 in the repository | H×L | Start after #370 merges. |
| Strict schemas reject older clients | L×M | All new input fields are optional. The output schema change is additive. |
| The 2x default over-reserves on custom upstreams | M×L | Refunded on reconcile. Operators can enter the real price. |

## Rollback

Revert the PR. The columns stay, and older code ignores them (see the caveat above).
