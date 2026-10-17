import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_PRICE_PROVENANCE, ModelPricingReviewSchema, REPRICING_WARNING_PERCENT,
  type AgentModelPriceProvenance, type AgentModelPricing, type ModelCatalogPrice
} from '@cloud-harness/contracts';
import { reviewPricing, savedPriceProvenance } from '../src/model-catalog/pricing-review.js';

const RETRIEVED_AT = 1_800_000_000_000;
const TIER = {
  minPromptTokens: 200_000, inputMicrosPerMillionTokens: 6_000_000, outputMicrosPerMillionTokens: 22_500_000,
  cacheReadMicrosPerMillionTokens: 600_000, cacheWriteMicrosPerMillionTokens: 12_000_000
};

function catalog(overrides: Partial<ModelCatalogPrice> = {}): ModelCatalogPrice {
  return {
    inputMicrosPerMillionTokens: 1_000_000,
    outputMicrosPerMillionTokens: 4_000_000,
    cacheReadMicrosPerMillionTokens: 100_000,
    cacheWriteMicrosPerMillionTokens: 2_000_000,
    provenance: { source: 'openrouter', sourceModelId: 'vendor/model', retrievedAt: RETRIEVED_AT, confidence: 'exact' },
    hasConditionalPricing: false,
    ...overrides
  };
}

const CATALOG_PROVENANCE: AgentModelPriceProvenance = {
  source: 'openrouter', sourceModelId: 'vendor/model', retrievedAt: RETRIEVED_AT, confidence: 'exact', isOverride: false
};

function revision(pricing: Partial<AgentModelPricing> = {}, priceProvenance: AgentModelPriceProvenance = CATALOG_PROVENANCE) {
  return {
    pricing: {
      inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000,
      cacheReadMicrosPerMillionTokens: 100_000, cacheWriteMicrosPerMillionTokens: 2_000_000,
      ...pricing
    },
    priceProvenance
  };
}

describe('saved price provenance', () => {
  const submitted: AgentModelPricing = {
    inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000,
    cacheReadMicrosPerMillionTokens: 100_000, cacheWriteMicrosPerMillionTokens: 2_000_000, tiers: [TIER]
  };

  it('copies the catalog provenance when every price and tier matches', () => {
    expect(savedPriceProvenance(submitted, catalog({ tiers: [TIER] }))).toEqual(CATALOG_PROVENANCE);
    const estimate = catalog({ provenance: { ...catalog().provenance, confidence: 'estimate' } });
    expect(savedPriceProvenance({ ...submitted, tiers: [] }, estimate)).toEqual({ ...CATALOG_PROVENANCE, confidence: 'estimate' });
  });

  it('treats an absent and an unknown cache price as the same price', () => {
    const unknownCache = catalog({ cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: null });
    expect(savedPriceProvenance({ inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 }, unknownCache)).toEqual(CATALOG_PROVENANCE);
  });

  it('records any edited price, cache price, or tier as an override that names its catalog model', () => {
    const override: AgentModelPriceProvenance = {
      source: 'user', sourceModelId: 'vendor/model', retrievedAt: RETRIEVED_AT, confidence: 'unknown', isOverride: true
    };
    const withTiers = catalog({ tiers: [TIER] });
    expect(savedPriceProvenance({ ...submitted, inputMicrosPerMillionTokens: 1_000_001 }, withTiers)).toEqual(override);
    expect(savedPriceProvenance({ ...submitted, cacheWriteMicrosPerMillionTokens: null }, withTiers)).toEqual(override);
    expect(savedPriceProvenance({ ...submitted, tiers: [] }, withTiers)).toEqual(override);
    expect(savedPriceProvenance({ ...submitted, tiers: [{ ...TIER, minPromptTokens: 128_000 }] }, withTiers)).toEqual(override);
  });

  it('never trusts a reference the runner cannot resolve to a priced entry', () => {
    expect(savedPriceProvenance(submitted, undefined)).toEqual(DEFAULT_USER_PRICE_PROVENANCE);
    const unpriced = catalog({
      inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null,
      provenance: { source: 'openrouter', sourceModelId: 'vendor/model', retrievedAt: RETRIEVED_AT, confidence: 'unknown' }
    });
    expect(savedPriceProvenance(submitted, unpriced)).toMatchObject({ source: 'user', confidence: 'unknown', isOverride: true });
    const none = catalog({ provenance: { source: 'none', sourceModelId: null, retrievedAt: null, confidence: 'unknown' } });
    expect(savedPriceProvenance(submitted, none)).toEqual(DEFAULT_USER_PRICE_PROVENANCE);
  });
});

describe('repricing review', () => {
  it('uses a ten percent threshold', () => {
    expect(REPRICING_WARNING_PERCENT).toBe(10);
  });

  it('reads current below the threshold and repriced at it, in both directions', () => {
    expect(reviewPricing(revision(), catalog({ inputMicrosPerMillionTokens: 1_099_000 }))).toEqual({
      state: 'current', changes: [], catalogRetrievedAt: RETRIEVED_AT, isOverride: false
    });
    expect(reviewPricing(revision(), catalog({ inputMicrosPerMillionTokens: 901_000 })).state).toBe('current');
    const increase = reviewPricing(revision(), catalog({ inputMicrosPerMillionTokens: 1_100_000 }));
    expect(increase).toEqual({
      state: 'repriced',
      changes: [{ field: 'input', minPromptTokens: null, pinned: 1_000_000, catalog: 1_100_000, percent: 10 }],
      catalogRetrievedAt: RETRIEVED_AT,
      isOverride: false
    });
    expect(ModelPricingReviewSchema.parse(increase)).toEqual(increase);
    expect(reviewPricing(revision(), catalog({ outputMicrosPerMillionTokens: 3_600_000 })).changes)
      .toEqual([{ field: 'output', minPromptTokens: null, pinned: 4_000_000, catalog: 3_600_000, percent: -10 }]);
  });

  it('compares stated cache prices and ignores a cache price only one side states', () => {
    expect(reviewPricing(revision(), catalog({ cacheReadMicrosPerMillionTokens: 150_000, cacheWriteMicrosPerMillionTokens: 1_000_000 })).changes).toEqual([
      { field: 'cacheRead', minPromptTokens: null, pinned: 100_000, catalog: 150_000, percent: 50 },
      { field: 'cacheWrite', minPromptTokens: null, pinned: 2_000_000, catalog: 1_000_000, percent: -50 }
    ]);
    const unstated = revision({ cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: undefined });
    expect(reviewPricing(unstated, catalog({ cacheReadMicrosPerMillionTokens: 900_000 })).state).toBe('current');
    expect(reviewPricing(revision(), catalog({ cacheWriteMicrosPerMillionTokens: null })).state).toBe('current');
  });

  it('flags a pinned zero price once the catalog charges for it', () => {
    const free = revision({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
    expect(reviewPricing(free, catalog({ inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 0 })).changes)
      .toEqual([{ field: 'input', minPromptTokens: null, pinned: 0, catalog: 1, percent: null }]);
  });

  it('flags catalog tiers the revision lacks, tiers the catalog dropped, and changed tier prices', () => {
    expect(reviewPricing(revision(), catalog({ tiers: [TIER] })).changes)
      .toEqual([{ field: 'tier', minPromptTokens: 200_000, pinned: null, catalog: 6_000_000, percent: null }]);
    expect(reviewPricing(revision({ tiers: [TIER] }), catalog()).changes)
      .toEqual([{ field: 'tier', minPromptTokens: 200_000, pinned: 6_000_000, catalog: null, percent: null }]);
    expect(reviewPricing(revision({ tiers: [TIER] }), catalog({ tiers: [TIER] })).state).toBe('current');
    expect(reviewPricing(revision({ tiers: [TIER] }), catalog({ tiers: [{ ...TIER, outputMicrosPerMillionTokens: 30_000_000 }] })).changes)
      .toEqual([{ field: 'output', minPromptTokens: 200_000, pinned: 22_500_000, catalog: 30_000_000, percent: 33.3 }]);
  });

  it('flags conditional pricing no revision can express', () => {
    expect(reviewPricing(revision(), catalog({ hasConditionalPricing: true })).changes)
      .toEqual([{ field: 'conditionalPricing', minPromptTokens: null, pinned: null, catalog: null, percent: null }]);
  });

  it('reads unknown without a cached catalog price', () => {
    expect(reviewPricing(revision(), undefined)).toEqual({ state: 'unknown', changes: [], catalogRetrievedAt: null, isOverride: false });
    const unpriced = catalog({ inputMicrosPerMillionTokens: null });
    expect(reviewPricing(revision(), unpriced)).toEqual({ state: 'unknown', changes: [], catalogRetrievedAt: RETRIEVED_AT, isOverride: false });
  });

  it('labels an override so the difference reads as informational', () => {
    const override = revision({}, { ...DEFAULT_USER_PRICE_PROVENANCE });
    expect(reviewPricing(override, catalog({ inputMicrosPerMillionTokens: 2_000_000 }))).toMatchObject({ state: 'repriced', isOverride: true });
    expect(reviewPricing(override, catalog())).toMatchObject({ state: 'current', isOverride: true });
  });

  it('compares the largest prices exactly', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(reviewPricing(revision({ inputMicrosPerMillionTokens: max }), catalog({ inputMicrosPerMillionTokens: max - 1 })).state).toBe('current');
  });
});
