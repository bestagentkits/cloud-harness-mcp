import { describe, expect, it } from 'vitest';
import {
  MetadataRunnerOperationSchema,
  MetadataRunnerRequestSchema,
  ModelCatalogEntrySchema,
  ModelCatalogPriceSchema,
  ModelCatalogRefreshInputSchema,
  ModelCatalogSearchInputSchema,
  ModelCatalogSearchResultSchema,
  REPRICING_WARNING_PERCENT
} from '../src/index.js';

const unknownPrice = {
  inputMicrosPerMillionTokens: null,
  outputMicrosPerMillionTokens: null,
  provenance: { source: 'none', sourceModelId: null, retrievedAt: null, confidence: 'unknown' },
  hasConditionalPricing: false
} as const;

const entry = {
  provider: 'anthropic',
  providerModelId: 'claude-sonnet-4-5-20250929',
  canonicalModelId: 'anthropic/claude-sonnet-4.5',
  displayName: 'Claude Sonnet 4.5',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  capabilities: { tools: 'reported', reasoning: 'reported', vision: 'unknown' },
  pricing: {
    inputMicrosPerMillionTokens: 3_000_000,
    outputMicrosPerMillionTokens: 15_000_000,
    cacheReadMicrosPerMillionTokens: 300_000,
    cacheWriteMicrosPerMillionTokens: null,
    provenance: { source: 'openrouter', sourceModelId: 'anthropic/claude-sonnet-4.5', retrievedAt: 1_800_000_000_000, confidence: 'estimate' },
    hasConditionalPricing: true
  },
  availability: 'listed_for_credential',
  expiresAt: null
} as const;

describe('model catalog contracts', () => {
  it('keeps an unknown price distinct from a free one', () => {
    expect(ModelCatalogPriceSchema.parse(unknownPrice).inputMicrosPerMillionTokens).toBeNull();
    expect(ModelCatalogPriceSchema.parse({ ...unknownPrice, inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }).inputMicrosPerMillionTokens).toBe(0);
    expect(() => ModelCatalogPriceSchema.parse({ ...unknownPrice, inputMicrosPerMillionTokens: undefined })).toThrow();
    expect(() => ModelCatalogPriceSchema.parse({ ...unknownPrice, inputMicrosPerMillionTokens: 1.5 })).toThrow();
    expect(() => ModelCatalogPriceSchema.parse({ ...unknownPrice, outputMicrosPerMillionTokens: -1 })).toThrow();
    expect(() => ModelCatalogPriceSchema.parse({ ...unknownPrice, provenance: { ...unknownPrice.provenance, confidence: 'guess' } })).toThrow();
  });

  it('carries optional long-prompt tiers under the tier rules', () => {
    const tier = { minPromptTokens: 200_000, inputMicrosPerMillionTokens: 6_000_000, outputMicrosPerMillionTokens: 22_500_000, cacheReadMicrosPerMillionTokens: null };
    expect(ModelCatalogPriceSchema.parse({ ...entry.pricing, tiers: [tier] }).tiers).toEqual([tier]);
    expect(ModelCatalogPriceSchema.parse(entry.pricing)).not.toHaveProperty('tiers');
    expect(ModelCatalogPriceSchema.safeParse({ ...entry.pricing, tiers: [{ ...tier, minPromptTokens: 10_000_001 }] }).success).toBe(false);
    expect(ModelCatalogPriceSchema.safeParse({ ...entry.pricing, tiers: [tier, tier, tier, tier, tier] }).success).toBe(false);
    expect(ModelCatalogPriceSchema.safeParse({ ...entry.pricing, tiers: [{ ...tier, outputMicrosPerMillionTokens: null }] }).success).toBe(false);
    expect(REPRICING_WARNING_PERCENT).toBe(10);
  });

  it('accepts a complete entry and rejects unknown fields and states', () => {
    expect(ModelCatalogEntrySchema.parse(entry)).toEqual(entry);
    expect(() => ModelCatalogEntrySchema.parse({ ...entry, secret: 'x' })).toThrow();
    expect(() => ModelCatalogEntrySchema.parse({ ...entry, availability: 'maybe' })).toThrow();
    expect(() => ModelCatalogEntrySchema.parse({ ...entry, capabilities: { ...entry.capabilities, tools: 'yes' } })).toThrow();
    expect(() => ModelCatalogEntrySchema.parse({ ...entry, providerModelId: '' })).toThrow();
  });

  it('bounds search input and applies the default page size', () => {
    expect(ModelCatalogSearchInputSchema.parse({ provider: 'openai' })).toEqual({ provider: 'openai', limit: 25 });
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'openai', limit: 0 })).toThrow();
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'openai', limit: 101 })).toThrow();
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'openai', query: 'x'.repeat(201) })).toThrow();
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'openai', cursor: 'x'.repeat(257) })).toThrow();
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'openai', capability: 'audio' })).toThrow();
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'openai', credentialId: 'not-a-credential' })).toThrow();
    expect(() => ModelCatalogSearchInputSchema.parse({ provider: 'unknown' })).toThrow();
    expect(() => ModelCatalogRefreshInputSchema.parse({ provider: 'openai', query: 'x' })).toThrow();
  });

  it('describes freshness per source with error categories only', () => {
    const result = {
      entries: [entry],
      nextCursor: null,
      freshness: {
        state: 'stale', fetchedAt: 1,
        sources: [
          { source: 'provider', state: 'unavailable', fetchedAt: null, error: 'authentication' },
          { source: 'openrouter', state: 'fresh', fetchedAt: 1, error: null }
        ]
      }
    };
    expect(ModelCatalogSearchResultSchema.parse(result)).toEqual(result);
    const freeText = { ...result, freshness: { ...result.freshness, sources: [{ source: 'provider', state: 'stale', fetchedAt: 1, error: 'invalid key sk-123' }] } };
    expect(() => ModelCatalogSearchResultSchema.parse(freeText)).toThrow();
  });

  it('registers the catalog operations as metadata runner requests', () => {
    expect(MetadataRunnerOperationSchema.options).toEqual(expect.arrayContaining(['model_catalog_search', 'model_catalog_refresh']));
    const principal = { kind: 'owner', ownerId: 'owner' };
    expect(MetadataRunnerRequestSchema.parse({ version: 2, principal, operation: 'model_catalog_search', input: { provider: 'openrouter', query: 'claude' } }))
      .toMatchObject({ input: { provider: 'openrouter', query: 'claude', limit: 25 } });
    expect(() => MetadataRunnerRequestSchema.parse({ version: 2, principal, operation: 'model_catalog_refresh', input: {} })).toThrow();
  });
});
