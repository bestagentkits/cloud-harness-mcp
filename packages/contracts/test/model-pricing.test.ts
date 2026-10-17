import { describe, expect, it } from 'vitest';
import {
  AgentModelPriceProvenanceSchema,
  AgentModelPricingSchema,
  AgentModelProfileRevisionSchema,
  AgentModelProfileSchema,
  DEFAULT_USER_PRICE_PROVENANCE,
  MAX_MODEL_PRICE_TIERS,
  MAX_PRICE_TIER_MIN_PROMPT_TOKENS,
  ModelCatalogPriceProvenanceSchema,
  ModelProviderKindSchema,
  findResolvedPriceTierIssues,
  getModelProvider,
  resolveEffectivePricing,
  type ModelProviderKind,
  type PinnedModelPricing
} from '../src/index.js';

const base = { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 4_000 };

const GATEWAY_PRICE_FIELDS = [
  'inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'cacheReadMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens'
] as const;

/**
 * Mirrors the model gateway's `parsePricing` (apps/model-gateway/src/config.ts) as
 * the control snapshot calls it: prices are non-negative safe integers, absent
 * cache prices mean the input price of the same level, at most four tiers, integer
 * thresholds from 1 to 10,000,000 that strictly ascend, and no resolved tier price
 * below the same price one level down. Throws the first violation.
 */
function gatewayParsePricing(value: unknown): void {
  const record = (candidate: unknown, label: string): Record<string, unknown> => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`${label} must be an object`);
    return candidate as Record<string, unknown>;
  };
  const integer = (candidate: unknown, label: string, min: number, max: number): number => {
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) throw new Error(`${label} out of range`);
    return candidate;
  };
  const price = (candidate: unknown, label: string) => integer(candidate, label, 0, Number.MAX_SAFE_INTEGER);
  const optionalPrice = (candidate: unknown, label: string) => candidate === undefined || candidate === null ? undefined : price(candidate, label);
  const pricing = record(value, 'pricing');
  const input = pricing.inputMicrosPerMillionTokens === undefined ? 0 : price(pricing.inputMicrosPerMillionTokens, 'input');
  const output = pricing.outputMicrosPerMillionTokens === undefined ? 0 : price(pricing.outputMicrosPerMillionTokens, 'output');
  let below: Record<string, number> = {
    minPromptTokens: 0,
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    cacheReadMicrosPerMillionTokens: optionalPrice(pricing.cacheReadMicrosPerMillionTokens, 'cacheRead') ?? input,
    cacheWriteMicrosPerMillionTokens: optionalPrice(pricing.cacheWriteMicrosPerMillionTokens, 'cacheWrite') ?? input
  };
  if (pricing.tiers === undefined || pricing.tiers === null) return;
  if (!Array.isArray(pricing.tiers) || pricing.tiers.length > 4) throw new Error('tiers must be an array of at most 4 tiers');
  pricing.tiers.forEach((candidate, index) => {
    const raw = record(candidate, `tiers[${index}]`);
    const tierInput = price(raw.inputMicrosPerMillionTokens, `tiers[${index}].input`);
    const tier: Record<string, number> = {
      minPromptTokens: integer(raw.minPromptTokens, `tiers[${index}].minPromptTokens`, 1, 10_000_000),
      inputMicrosPerMillionTokens: tierInput,
      outputMicrosPerMillionTokens: price(raw.outputMicrosPerMillionTokens, `tiers[${index}].output`),
      cacheReadMicrosPerMillionTokens: optionalPrice(raw.cacheReadMicrosPerMillionTokens, `tiers[${index}].cacheRead`) ?? tierInput,
      cacheWriteMicrosPerMillionTokens: optionalPrice(raw.cacheWriteMicrosPerMillionTokens, `tiers[${index}].cacheWrite`) ?? tierInput
    };
    if (tier.minPromptTokens! <= below.minPromptTokens!) throw new Error(`tiers[${index}].minPromptTokens must be strictly ascending`);
    for (const field of GATEWAY_PRICE_FIELDS) {
      if (tier[field]! < below[field]!) throw new Error(`tiers[${index}].${field} must not be lower than the tier below`);
    }
    below = tier;
  });
}

/** A deterministic PRNG (mulberry32), so a failing case reproduces from its seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Pricing that passes AgentModelPricingSchema, with cache prices stated, null, or absent at random. */
function randomSchemaValidPricing(random: () => number): PinnedModelPricing {
  const amount = (min: number) => min + Math.floor(random() * 5_000_000);
  const cache = (min: number): number | null | undefined => {
    const pick = random();
    if (pick < 0.3) return undefined;
    if (pick < 0.4) return null;
    // Small stated prices land below the resolved defaults of the level beneath.
    return pick < 0.55 ? min + Math.floor(random() * 3_000) : amount(min);
  };
  const level = (below?: Record<string, number | null | undefined>) => {
    const floor = (key: string) => typeof below?.[key] === 'number' ? below[key] as number : 0;
    const cacheRead = cache(floor('cacheReadMicrosPerMillionTokens'));
    const cacheWrite = cache(floor('cacheWriteMicrosPerMillionTokens'));
    return {
      inputMicrosPerMillionTokens: amount(floor('inputMicrosPerMillionTokens')),
      outputMicrosPerMillionTokens: amount(floor('outputMicrosPerMillionTokens')),
      ...(cacheRead === undefined ? {} : { cacheReadMicrosPerMillionTokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteMicrosPerMillionTokens: cacheWrite })
    };
  };
  const pricing: PinnedModelPricing = level();
  const tierCount = Math.floor(random() * (MAX_MODEL_PRICE_TIERS + 1));
  const tiers = [];
  let below: Record<string, number | null | undefined> = pricing;
  let threshold = 0;
  for (let index = 0; index < tierCount; index += 1) {
    threshold += 1 + Math.floor(random() * 2_000_000);
    const tier = { minPromptTokens: threshold, ...level(below) };
    tiers.push(tier);
    below = tier;
  }
  if (tiers.length > 0) pricing.tiers = tiers;
  return pricing;
}

describe('resolveEffectivePricing', () => {
  it('declares which providers bill cache writes', () => {
    const expected: Record<ModelProviderKind, boolean> = {
      openai: false, anthropic: false, google: false, deepseek: false, openrouter: true, custom: true
    };
    for (const provider of ModelProviderKindSchema.options) {
      expect(getModelProvider(provider).billsCacheWrites, provider).toBe(expected[provider]);
    }
  });

  it('defaults unknown cache prices per provider and never to zero', () => {
    for (const provider of ModelProviderKindSchema.options) {
      for (const unknown of [{}, { cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: null }]) {
        const effective = resolveEffectivePricing({ ...base, ...unknown }, provider);
        expect(effective.cacheReadMicrosPerMillionTokens, provider).toBe(1_000);
        expect(effective.cacheWriteMicrosPerMillionTokens, provider).toBe(getModelProvider(provider).billsCacheWrites ? 2_000 : 1_000);
        expect(effective.inputMicrosPerMillionTokens).toBe(1_000);
        expect(effective.outputMicrosPerMillionTokens).toBe(4_000);
        expect(effective.tiers).toBeUndefined();
      }
    }
  });

  it('keeps explicit cache prices, including an explicit zero', () => {
    const effective = resolveEffectivePricing({ ...base, cacheReadMicrosPerMillionTokens: 0, cacheWriteMicrosPerMillionTokens: 1_250 }, 'openrouter');
    expect(effective.cacheReadMicrosPerMillionTokens).toBe(0);
    expect(effective.cacheWriteMicrosPerMillionTokens).toBe(1_250);
  });

  it('resolves each tier from its own input price', () => {
    const effective = resolveEffectivePricing({
      ...base,
      cacheReadMicrosPerMillionTokens: 250,
      tiers: [
        { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 },
        { minPromptTokens: 500_000, inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 9_000, cacheReadMicrosPerMillionTokens: 2_400, cacheWriteMicrosPerMillionTokens: null }
      ]
    }, 'custom');
    expect(effective.cacheReadMicrosPerMillionTokens).toBe(250);
    expect(effective.cacheWriteMicrosPerMillionTokens).toBe(2_000);
    expect(effective.tiers).toEqual([
      { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000, cacheReadMicrosPerMillionTokens: 2_000, cacheWriteMicrosPerMillionTokens: 4_000 },
      { minPromptTokens: 500_000, inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 9_000, cacheReadMicrosPerMillionTokens: 2_400, cacheWriteMicrosPerMillionTokens: 6_000 }
    ]);
    expect(resolveEffectivePricing({ ...base, tiers: [] }, 'openai').tiers).toBeUndefined();
  });

  it('raises tier cache prices that would resolve below the level beneath them', () => {
    // A Gemini-style tier with a cheaper explicit read than the base's unstated read
    // (which resolves to the base input price).
    const gemini = resolveEffectivePricing({
      inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000,
      tiers: [{ minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_500_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 625_000 }]
    }, 'google');
    expect(gemini.tiers?.[0]?.cacheReadMicrosPerMillionTokens).toBe(1_250_000);
    // OpenRouter doubles the base's unstated write above the tier's stated write.
    const openrouter = resolveEffectivePricing({
      inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000,
      tiers: [{ minPromptTokens: 200_000, inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 20_000_000, cacheWriteMicrosPerMillionTokens: 5_000_000 }]
    }, 'openrouter');
    expect(openrouter.cacheWriteMicrosPerMillionTokens).toBe(6_000_000);
    expect(openrouter.tiers?.[0]?.cacheWriteMicrosPerMillionTokens).toBe(6_000_000);
    // A stated base write above the tier input, with the tier write unstated.
    const statedBaseWrite = resolveEffectivePricing({
      inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheWriteMicrosPerMillionTokens: 3_750_000,
      tiers: [{ minPromptTokens: 200_000, inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 }]
    }, 'anthropic');
    expect(statedBaseWrite.tiers?.[0]?.cacheWriteMicrosPerMillionTokens).toBe(3_750_000);
    for (const effective of [gemini, openrouter, statedBaseWrite]) expect(() => gatewayParsePricing(effective)).not.toThrow();
  });

  it('resolves schema-valid pricing to prices the gateway accepts, for every provider', () => {
    const random = seededRandom(0x5eed_358);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const pricing = AgentModelPricingSchema.parse(randomSchemaValidPricing(random));
      for (const basis of [...ModelProviderKindSchema.options, { billsCacheWrites: false }] as const) {
        const effective = resolveEffectivePricing(pricing, basis);
        expect(() => gatewayParsePricing(effective), `iteration ${iteration}, ${JSON.stringify(basis)}: ${JSON.stringify(pricing)}`).not.toThrow();
        if (findResolvedPriceTierIssues(pricing, basis).length === 0) {
          // Pricing the runner accepts is never raised: every tier keeps its own resolution.
          const billsWrites = typeof basis === 'string' ? getModelProvider(basis).billsCacheWrites : basis.billsCacheWrites;
          (pricing.tiers ?? []).forEach((tier, index) => {
            expect(effective.tiers?.[index]).toEqual({
              minPromptTokens: tier.minPromptTokens,
              inputMicrosPerMillionTokens: tier.inputMicrosPerMillionTokens,
              outputMicrosPerMillionTokens: tier.outputMicrosPerMillionTokens,
              cacheReadMicrosPerMillionTokens: tier.cacheReadMicrosPerMillionTokens ?? tier.inputMicrosPerMillionTokens,
              cacheWriteMicrosPerMillionTokens: tier.cacheWriteMicrosPerMillionTokens
                ?? (billsWrites ? tier.inputMicrosPerMillionTokens * 2 : tier.inputMicrosPerMillionTokens)
            });
          });
        }
      }
    }
  });

  it('resolves each provider\'s defaults to prices the gateway accepts', () => {
    const tiers = [
      { minPromptTokens: 128_000, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 },
      { minPromptTokens: MAX_PRICE_TIER_MIN_PROMPT_TOKENS, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 }
    ];
    for (const provider of ModelProviderKindSchema.options) {
      for (const pricing of [base, { ...base, tiers }, { ...base, cacheReadMicrosPerMillionTokens: 100, tiers }]) {
        expect(() => gatewayParsePricing(resolveEffectivePricing(pricing, provider)), provider).not.toThrow();
        expect(findResolvedPriceTierIssues(pricing, provider), provider).toEqual([]);
      }
    }
  });

  it('resolves a static profile\'s unknown cache prices to the input price, as the gateway does', () => {
    expect(resolveEffectivePricing(base, { billsCacheWrites: false })).toEqual({ ...base, cacheReadMicrosPerMillionTokens: 1_000, cacheWriteMicrosPerMillionTokens: 1_000 });
  });

  it('keeps the doubled write default a safe integer', () => {
    const effective = resolveEffectivePricing({ inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER, outputMicrosPerMillionTokens: 0 }, 'custom');
    expect(effective.cacheWriteMicrosPerMillionTokens).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('AgentModelPricingSchema', () => {
  it('accepts the legacy two-price shape unchanged', () => {
    expect(AgentModelPricingSchema.parse(base)).toEqual(base);
  });

  it('accepts unknown cache prices as null and rejects negative or unsafe prices', () => {
    expect(AgentModelPricingSchema.parse({ ...base, cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: 5 }))
      .toEqual({ ...base, cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: 5 });
    expect(() => AgentModelPricingSchema.parse({ ...base, cacheReadMicrosPerMillionTokens: -1 })).toThrow();
    expect(() => AgentModelPricingSchema.parse({ ...base, cacheWriteMicrosPerMillionTokens: 1.5 })).toThrow();
    expect(() => AgentModelPricingSchema.parse({ ...base, inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => AgentModelPricingSchema.parse({ ...base, inputMicrosPerMillionTokens: null })).toThrow();
  });

  it('accepts up to the maximum number of ascending, non-decreasing tiers', () => {
    const tiers = Array.from({ length: MAX_MODEL_PRICE_TIERS }, (_, index) => ({
      minPromptTokens: (index + 1) * 100_000,
      inputMicrosPerMillionTokens: 1_000 * (index + 1),
      outputMicrosPerMillionTokens: 4_000 * (index + 1)
    }));
    expect(AgentModelPricingSchema.parse({ ...base, tiers }).tiers).toHaveLength(MAX_MODEL_PRICE_TIERS);
    expect(() => AgentModelPricingSchema.parse({ ...base, tiers: [...tiers, { ...tiers[3]!, minPromptTokens: 900_000 }] })).toThrow();
    expect(AgentModelPricingSchema.parse({ ...base, tiers: [] })).toEqual({ ...base, tiers: [] });
  });

  it('caps tier thresholds at the gateway maximum', () => {
    const tier = { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 };
    expect(AgentModelPricingSchema.safeParse({ ...base, tiers: [{ ...tier, minPromptTokens: 10_000_000 }] }).success).toBe(true);
    const over = AgentModelPricingSchema.safeParse({ ...base, tiers: [{ ...tier, minPromptTokens: 10_000_001 }] });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path).toEqual(['tiers', 0, 'minPromptTokens']);
  });

  it('rejects tiers whose thresholds do not strictly ascend', () => {
    const tier = { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 };
    const equal = AgentModelPricingSchema.safeParse({ ...base, tiers: [{ ...tier, minPromptTokens: 100 }, { ...tier, minPromptTokens: 100 }] });
    expect(equal.success).toBe(false);
    expect(equal.error?.issues[0]?.path).toEqual(['tiers', 1, 'minPromptTokens']);
    expect(AgentModelPricingSchema.safeParse({ ...base, tiers: [{ ...tier, minPromptTokens: 200 }, { ...tier, minPromptTokens: 100 }] }).success).toBe(false);
    expect(AgentModelPricingSchema.safeParse({ ...base, tiers: [{ ...tier, minPromptTokens: 0 }] }).success).toBe(false);
  });

  it('rejects a tier that charges less than the level below it', () => {
    const cheaperThanBase = AgentModelPricingSchema.safeParse({
      ...base, tiers: [{ minPromptTokens: 100, inputMicrosPerMillionTokens: 999, outputMicrosPerMillionTokens: 4_000 }]
    });
    expect(cheaperThanBase.error?.issues[0]?.path).toEqual(['tiers', 0, 'inputMicrosPerMillionTokens']);
    const cheaperThanPrevious = AgentModelPricingSchema.safeParse({
      ...base,
      tiers: [
        { minPromptTokens: 100, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 },
        { minPromptTokens: 200, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 7_999 }
      ]
    });
    expect(cheaperThanPrevious.error?.issues[0]?.path).toEqual(['tiers', 1, 'outputMicrosPerMillionTokens']);
    const cheaperCache = AgentModelPricingSchema.safeParse({
      ...base,
      cacheReadMicrosPerMillionTokens: 300,
      tiers: [{ minPromptTokens: 100, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000, cacheReadMicrosPerMillionTokens: 299 }]
    });
    expect(cheaperCache.error?.issues[0]?.path).toEqual(['tiers', 0, 'cacheReadMicrosPerMillionTokens']);
  });

  it('leaves unstated cache prices to the provider-aware resolved check', () => {
    const pricing = {
      ...base,
      cacheReadMicrosPerMillionTokens: null,
      tiers: [{ minPromptTokens: 100, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000, cacheReadMicrosPerMillionTokens: 10 }]
    };
    // The schema cannot resolve an unstated price without the provider, so it accepts this shape...
    expect(AgentModelPricingSchema.safeParse(pricing).success).toBe(true);
    // ...and the resolved check refuses it: the base read resolves to its input price, 1,000.
    expect(findResolvedPriceTierIssues(pricing, 'openai')).toEqual([
      'tiers[0].cacheReadMicrosPerMillionTokens is 10, below 1000 one level down; state a price of at least 1000'
    ]);
  });

  it('reports each tier price that resolves below the level beneath it', () => {
    const tier = { minPromptTokens: 100, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000 };
    // An unstated tier write doubles to 4,000 on OpenRouter but stays 2,000 on OpenAI.
    const statedBaseWrite = { ...base, cacheWriteMicrosPerMillionTokens: 3_000, tiers: [tier] };
    expect(findResolvedPriceTierIssues(statedBaseWrite, 'openrouter')).toEqual([]);
    expect(findResolvedPriceTierIssues(statedBaseWrite, 'openai')).toEqual([
      'tiers[0].cacheWriteMicrosPerMillionTokens resolves to 2000, below 3000 one level down; state a price of at least 3000'
    ]);
    // A stated tier write below the base's doubled default on OpenRouter.
    expect(findResolvedPriceTierIssues({ ...base, tiers: [{ ...tier, cacheWriteMicrosPerMillionTokens: 1_500 }] }, 'openrouter')).toEqual([
      'tiers[0].cacheWriteMicrosPerMillionTokens is 1500, below 2000 one level down; state a price of at least 2000'
    ]);
  });
});

describe('price provenance', () => {
  it('extends catalog provenance with isOverride and defaults to a user override of unknown confidence', () => {
    const catalog = { source: 'openrouter', sourceModelId: 'openai/gpt-5', retrievedAt: 1, confidence: 'estimate' } as const;
    expect(ModelCatalogPriceProvenanceSchema.parse(catalog)).toEqual(catalog);
    expect(AgentModelPriceProvenanceSchema.parse({ ...catalog, isOverride: false })).toEqual({ ...catalog, isOverride: false });
    expect(() => AgentModelPriceProvenanceSchema.parse(catalog)).toThrow();
    expect(() => AgentModelPriceProvenanceSchema.parse({ ...catalog, isOverride: false, extra: 1 })).toThrow();
    expect(AgentModelPriceProvenanceSchema.parse(DEFAULT_USER_PRICE_PROVENANCE)).toEqual({
      source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true
    });
  });

  it('requires provenance on every revision', () => {
    const revision = {
      id: 'rev_12345678901234567890',
      profileId: 'coding-fast',
      principalId: 'p_user_1',
      credentialId: 'cred_12345678901234567890',
      model: 'gpt-5',
      apiMode: 'chat-completions',
      downstreamPath: '/v1/chat/completions',
      upstreamUrl: 'https://api.openai.com/v1/chat/completions',
      pricing: base,
      limits: { maxInputTokens: 1, maxOutputTokens: 1, maxCostMicros: 1 },
      maxProxyOperations: ['files_read'],
      digest: 'sha256:x',
      createdAt: 1
    };
    expect(() => AgentModelProfileRevisionSchema.parse(revision)).toThrow();
    expect(AgentModelProfileRevisionSchema.parse({ ...revision, priceProvenance: DEFAULT_USER_PRICE_PROVENANCE }).priceProvenance.isOverride).toBe(true);
  });
});

describe('static agent model profiles', () => {
  it('accept optional cache prices', () => {
    const profile = {
      id: 'static-1', displayName: 'Static', provider: 'openai', model: 'gpt-5',
      inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000,
      maxInputTokens: 1_000, maxOutputTokens: 100, maxCostMicros: 1_000, maxProxyOperations: ['files_read']
    };
    expect(AgentModelProfileSchema.parse(profile).cacheReadMicrosPerMillionTokens).toBeUndefined();
    const priced = AgentModelProfileSchema.parse({ ...profile, cacheReadMicrosPerMillionTokens: 100, cacheWriteMicrosPerMillionTokens: 1_250 });
    expect(priced.cacheReadMicrosPerMillionTokens).toBe(100);
    expect(priced.cacheWriteMicrosPerMillionTokens).toBe(1_250);
    expect(() => AgentModelProfileSchema.parse({ ...profile, cacheWriteMicrosPerMillionTokens: -1 })).toThrow();
  });
});
