import { describe, expect, it } from 'vitest';
import {
  AgentModelPriceProvenanceSchema,
  AgentModelPricingSchema,
  AgentModelProfileRevisionSchema,
  AgentModelProfileSchema,
  DEFAULT_USER_PRICE_PROVENANCE,
  MAX_MODEL_PRICE_TIERS,
  ModelCatalogPriceProvenanceSchema,
  ModelProviderKindSchema,
  getModelProvider,
  resolveEffectivePricing,
  type ModelProviderKind
} from '../src/index.js';

const base = { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 4_000 };

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
        { minPromptTokens: 500_000, inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 9_000, cacheReadMicrosPerMillionTokens: 600, cacheWriteMicrosPerMillionTokens: null }
      ]
    }, 'custom');
    expect(effective.cacheReadMicrosPerMillionTokens).toBe(250);
    expect(effective.cacheWriteMicrosPerMillionTokens).toBe(2_000);
    expect(effective.tiers).toEqual([
      { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000, cacheReadMicrosPerMillionTokens: 2_000, cacheWriteMicrosPerMillionTokens: 4_000 },
      { minPromptTokens: 500_000, inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 9_000, cacheReadMicrosPerMillionTokens: 600, cacheWriteMicrosPerMillionTokens: 6_000 }
    ]);
    expect(resolveEffectivePricing({ ...base, tiers: [] }, 'openai').tiers).toBeUndefined();
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
    expect(() => AgentModelPricingSchema.parse({ ...base, tiers: [] })).toThrow();
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

  it('compares cache prices only where both levels state them', () => {
    expect(AgentModelPricingSchema.safeParse({
      ...base,
      cacheReadMicrosPerMillionTokens: null,
      tiers: [{ minPromptTokens: 100, inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 8_000, cacheReadMicrosPerMillionTokens: 10 }]
    }).success).toBe(true);
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
