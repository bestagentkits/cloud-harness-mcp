import {
  DEFAULT_USER_PRICE_PROVENANCE, REPRICING_WARNING_PERCENT,
  type AgentModelPriceProvenance, type AgentModelPricing, type AgentModelProfileRevision, type ModelCatalogPrice,
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
 * Provenance for prices a client submitted with a catalog reference. `catalog` is
 * the runner's own cached price for that reference, undefined when it has none.
 * Only pricing equal to it in every price and tier is recorded as the catalog's;
 * any other pricing is the operator's override, noting the catalog model it
 * started from. The client's claim alone never sets provenance or confidence.
 */
export function savedPriceProvenance(submitted: AgentModelPricing, catalog: ModelCatalogPrice | undefined): AgentModelPriceProvenance {
  if (!catalog || catalog.provenance.source === 'none') return { ...DEFAULT_USER_PRICE_PROVENANCE };
  const offered = catalogPricing(catalog);
  if (offered && canonicalPricing(offered) === canonicalPricing(submitted)) {
    return { ...catalog.provenance, isOverride: false };
  }
  return {
    source: 'user',
    sourceModelId: catalog.provenance.sourceModelId,
    retrievedAt: catalog.provenance.retrievedAt,
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
 * Price changes between two levels. A cache price is compared only when both
 * sides state it: an unstated pinned cache price is charged at a conservative
 * default, not at a stale value.
 */
function levelChanges(pinned: PriceLevel, catalog: PriceLevel, minPromptTokens: number | null): ModelPricingReviewChange[] {
  const changes: ModelPricingReviewChange[] = [];
  for (const [field, key] of PRICE_FIELDS) {
    const left = pinned[key];
    const right = catalog[key];
    if (typeof left !== 'number' || typeof right !== 'number') continue;
    const change = priceChange(field, minPromptTokens, left, right);
    if (change) changes.push(change);
  }
  return changes;
}

/**
 * Compares a revision's pinned prices with the cached catalog price. `repriced`
 * when a price differs by at least REPRICING_WARNING_PERCENT in either direction,
 * a pinned zero now has a catalog price, a tier exists on only one side, or the
 * catalog has conditional pricing no revision can express. `unknown` when there is
 * no cached catalog price. The result is never stored.
 */
export function reviewPricing(
  revision: Pick<AgentModelProfileRevision, 'pricing' | 'priceProvenance'>,
  catalog: ModelCatalogPrice | undefined
): ModelPricingReview {
  const isOverride = revision.priceProvenance.isOverride;
  const catalogRetrievedAt = catalog?.provenance.retrievedAt ?? null;
  const offered = catalog ? catalogPricing(catalog) : undefined;
  if (!catalog || !offered) return { state: 'unknown', changes: [], catalogRetrievedAt, isOverride };

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
  if (catalog.hasConditionalPricing) changes.push({ field: 'conditionalPricing', minPromptTokens: null, pinned: null, catalog: null, percent: null });
  return { state: changes.length > 0 ? 'repriced' : 'current', changes, catalogRetrievedAt, isOverride };
}
