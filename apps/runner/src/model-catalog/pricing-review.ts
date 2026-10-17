import {
  DEFAULT_USER_PRICE_PROVENANCE, REPRICING_WARNING_PERCENT,
  type AgentModelPriceProvenance, type AgentModelPricing, type AgentModelProfileRevision, type ModelCatalogPrice, type ModelCatalogPriceRef,
  type ModelPricingReview, type ModelPricingReviewChange, type PinnedModelPricing
} from '@cloud-harness/contracts';

// Pure comparisons between saved revision prices and a cached catalog price. No
// function here reads or writes state: the catalog only ever informs a save or a
// review, and never changes a pinned price.

type PriceField = 'input' | 'output' | 'cacheRead' | 'cacheWrite';
type PriceKey = 'inputMicrosPerMillionTokens' | 'outputMicrosPerMillionTokens' | 'cacheReadMicrosPerMillionTokens' | 'cacheWriteMicrosPerMillionTokens';
type PriceLevel = Partial<Record<PriceKey, number | null | undefined>>;

const PRICE_FIELDS: ReadonlyArray<readonly [PriceField, PriceKey]> = [
  ['input', 'inputMicrosPerMillionTokens'],
  ['output', 'outputMicrosPerMillionTokens'],
  ['cacheRead', 'cacheReadMicrosPerMillionTokens'],
  ['cacheWrite', 'cacheWriteMicrosPerMillionTokens']
];

/** The catalog price as revision pricing, or undefined when its input or output price is unknown. */
function catalogPricing(catalog: ModelCatalogPrice): PinnedModelPricing | undefined {
  const input = catalog.inputMicrosPerMillionTokens;
  const output = catalog.outputMicrosPerMillionTokens;
  if (input === null || output === null) return undefined;
  return {
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    cacheReadMicrosPerMillionTokens: catalog.cacheReadMicrosPerMillionTokens ?? null,
    cacheWriteMicrosPerMillionTokens: catalog.cacheWriteMicrosPerMillionTokens ?? null,
    tiers: catalog.tiers ?? []
  };
}

/** One comparable form: an absent and a null cache price are both unknown, and no tiers is flat pricing. */
function canonicalPricing(pricing: PinnedModelPricing): string {
  const level = (value: PriceLevel) => [
    value.inputMicrosPerMillionTokens, value.outputMicrosPerMillionTokens,
    value.cacheReadMicrosPerMillionTokens ?? null, value.cacheWriteMicrosPerMillionTokens ?? null
  ];
  return JSON.stringify([level(pricing), (pricing.tiers ?? []).map((tier) => [tier.minPromptTokens, ...level(tier)])]);
}

/**
 * Provenance for prices a client submitted with a catalog reference. `routed` is
 * the runner's own cached catalog price for the model the revision routes to,
 * undefined when it has none. The prices are the catalog's only when the
 * reference names that very catalog model and the pricing equals it in every
 * price and tier. Pricing that differs is the operator's override, noting the
 * routed catalog model; a reference to any other model is ignored. The client's
 * claim alone never sets provenance or confidence.
 */
export function savedPriceProvenance(
  submitted: AgentModelPricing,
  ref: ModelCatalogPriceRef,
  routed: ModelCatalogPrice | undefined
): AgentModelPriceProvenance {
  if (!routed || routed.provenance.source === 'none' || routed.provenance.sourceModelId !== ref.sourceModelId) {
    return { ...DEFAULT_USER_PRICE_PROVENANCE };
  }
  const offered = catalogPricing(routed);
  if (offered && canonicalPricing(offered) === canonicalPricing(submitted)) {
    return { ...routed.provenance, isOverride: false };
  }
  return {
    source: 'user',
    sourceModelId: routed.provenance.sourceModelId,
    retrievedAt: routed.provenance.retrievedAt,
    confidence: 'unknown',
    isOverride: true
  };
}

/** A price change worth flagging, or undefined when the difference is under the threshold. */
function priceChange(field: PriceField, minPromptTokens: number | null, pinned: number, catalog: number): ModelPricingReviewChange | undefined {
  if (pinned === catalog) return undefined;
  if (pinned === 0) return { field, minPromptTokens, pinned, catalog, percent: null };
  // Integer comparison, so a difference of exactly the threshold is never lost to rounding.
  const difference = BigInt(Math.abs(catalog - pinned));
  if (difference * 100n < BigInt(REPRICING_WARNING_PERCENT) * BigInt(pinned)) return undefined;
  return { field, minPromptTokens, pinned, catalog, percent: Math.round(((catalog - pinned) / pinned) * 1000) / 10 };
}

/**
 * Price changes between two levels. An unstated pinned cache price is charged at
 * a conservative default, so it is not compared. A stated one is compared with the
 * catalog's, and a catalog that no longer publishes it counts as a change.
 */
function levelChanges(pinned: PriceLevel, catalog: PriceLevel, minPromptTokens: number | null): ModelPricingReviewChange[] {
  const changes: ModelPricingReviewChange[] = [];
  for (const [field, key] of PRICE_FIELDS) {
    const left = pinned[key];
    const right = catalog[key];
    if (typeof left !== 'number') continue;
    if (typeof right !== 'number') {
      changes.push({ field, minPromptTokens, pinned: left, catalog: null, percent: null });
      continue;
    }
    const change = priceChange(field, minPromptTokens, left, right);
    if (change) changes.push(change);
  }
  return changes;
}

/**
 * Compares a revision's pinned prices with the cached catalog price of the model
 * it routes to. `repriced` when a price differs by at least
 * REPRICING_WARNING_PERCENT in either direction, a pinned zero now has a catalog
 * price, a pinned cache price is no longer published, or a tier exists on only one
 * side.
 * `unknown` when there is no cached catalog price. Catalog conditional pricing no
 * revision can express is reported apart from the state, which an edit must always
 * be able to clear. The result is never stored.
 */
export function reviewPricing(
  revision: Pick<AgentModelProfileRevision, 'pricing' | 'priceProvenance'>,
  catalog: ModelCatalogPrice | undefined
): ModelPricingReview {
  const isOverride = revision.priceProvenance.isOverride;
  const catalogRetrievedAt = catalog?.provenance.retrievedAt ?? null;
  const catalogHasConditionalPricing = catalog?.hasConditionalPricing ?? false;
  const offered = catalog ? catalogPricing(catalog) : undefined;
  if (!catalog || !offered) return { state: 'unknown', changes: [], catalogRetrievedAt, isOverride, catalogHasConditionalPricing };

  const changes = levelChanges(revision.pricing, offered, null);
  const pinnedTiers = new Map((revision.pricing.tiers ?? []).map((tier) => [tier.minPromptTokens, tier]));
  const catalogTiers = new Map((offered.tiers ?? []).map((tier) => [tier.minPromptTokens, tier]));
  for (const [threshold, tier] of catalogTiers) {
    const pinned = pinnedTiers.get(threshold);
    if (pinned) changes.push(...levelChanges(pinned, tier, threshold));
    else changes.push({ field: 'tier', minPromptTokens: threshold, pinned: null, catalog: tier.inputMicrosPerMillionTokens, percent: null });
  }
  for (const [threshold, tier] of pinnedTiers) {
    if (!catalogTiers.has(threshold)) {
      changes.push({ field: 'tier', minPromptTokens: threshold, pinned: tier.inputMicrosPerMillionTokens, catalog: null, percent: null });
    }
  }
  return { state: changes.length > 0 ? 'repriced' : 'current', changes, catalogRetrievedAt, isOverride, catalogHasConditionalPricing };
}
