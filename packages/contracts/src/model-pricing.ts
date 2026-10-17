import { z } from 'zod';
import { getModelProvider } from './model-provider-registry.js';
import type { ModelProviderKind } from './model-profile-schemas.js';

// Price primitives shared by the model catalog and saved profile revisions. This
// module imports no runtime schema from either, so both can build on it without
// an import cycle.

// A price is integer micro-USD per one million tokens.
export const PriceMicrosPerMillionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// `none`: no source published a price for the model, so the price fields are null.
export const ModelCatalogPriceSourceSchema = z.enum(['provider', 'openrouter', 'user', 'none']);
export type ModelCatalogPriceSource = z.infer<typeof ModelCatalogPriceSourceSchema>;

// `exact` is the price the selected route bills, `estimate` is a price observed on
// another route (OpenRouter metadata applied to a direct vendor), `unknown` means
// no price evidence exists.
export const ModelCatalogPriceConfidenceSchema = z.enum(['exact', 'estimate', 'unknown']);
export type ModelCatalogPriceConfidence = z.infer<typeof ModelCatalogPriceConfidenceSchema>;

export const ModelCatalogPriceProvenanceSchema = z.object({
  source: ModelCatalogPriceSourceSchema,
  sourceModelId: z.string().max(300).nullable(),
  retrievedAt: z.number().int().nonnegative().nullable(),
  confidence: ModelCatalogPriceConfidenceSchema
}).strict();
export type ModelCatalogPriceProvenance = z.infer<typeof ModelCatalogPriceProvenanceSchema>;

// Where a saved revision's prices came from. `isOverride` is true when the
// operator typed or changed the prices rather than taking a catalog price as is.
// Revisions saved before provenance existed read as user overrides of unknown
// confidence, which is truthful: those prices were entered by hand.
export const AgentModelPriceProvenanceSchema = ModelCatalogPriceProvenanceSchema.extend({
  isOverride: z.boolean()
}).strict();
export type AgentModelPriceProvenance = z.infer<typeof AgentModelPriceProvenanceSchema>;

export const DEFAULT_USER_PRICE_PROVENANCE: AgentModelPriceProvenance = Object.freeze({
  source: 'user',
  sourceModelId: null,
  retrievedAt: null,
  confidence: 'unknown',
  isOverride: true
});

// A cache price that is null or absent is unknown, never free; it resolves to a
// conservative concrete price in resolveEffectivePricing.
const OptionalCachePriceSchema = PriceMicrosPerMillionSchema.nullable().optional();

// Prices that apply once a request's prompt reaches `minPromptTokens`. The base
// prices cover prompts below the first tier.
export const ModelPriceTierSchema = z.object({
  minPromptTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  inputMicrosPerMillionTokens: PriceMicrosPerMillionSchema,
  outputMicrosPerMillionTokens: PriceMicrosPerMillionSchema,
  cacheReadMicrosPerMillionTokens: OptionalCachePriceSchema,
  cacheWriteMicrosPerMillionTokens: OptionalCachePriceSchema
}).strict();
export type ModelPriceTier = z.infer<typeof ModelPriceTierSchema>;

export const MAX_MODEL_PRICE_TIERS = 4;

const PRICE_KEYS = [
  'inputMicrosPerMillionTokens',
  'outputMicrosPerMillionTokens',
  'cacheReadMicrosPerMillionTokens',
  'cacheWriteMicrosPerMillionTokens'
] as const;

type PriceLevel = Partial<Record<(typeof PRICE_KEYS)[number], number | null | undefined>>;

/**
 * Reports a tier whose threshold does not rise above the previous one, or whose
 * price is lower than the same price one level below (the base prices for the
 * first tier). Cache prices are compared only where both levels state them,
 * because an unknown price has no value to compare.
 */
export function addPriceTierIssues(
  base: PriceLevel,
  tiers: readonly ModelPriceTier[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = ['tiers']
): void {
  let below: PriceLevel = base;
  let previousThreshold = 0;
  tiers.forEach((tier, index) => {
    if (tier.minPromptTokens <= previousThreshold) {
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'minPromptTokens'],
        message: 'price tiers must have strictly ascending minPromptTokens'
      });
    }
    for (const key of PRICE_KEYS) {
      const lower = below[key];
      const upper = tier[key];
      if (typeof lower === 'number' && typeof upper === 'number' && upper < lower) {
        context.addIssue({
          code: 'custom',
          path: [...path, index, key],
          message: `a price tier must not charge less than the level below it (${key})`
        });
      }
    }
    previousThreshold = tier.minPromptTokens;
    below = tier;
  });
}

export const ModelPriceTiersSchema = z.array(ModelPriceTierSchema).min(1).max(MAX_MODEL_PRICE_TIERS);

export interface EffectivePriceLevel {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  cacheReadMicrosPerMillionTokens: number;
  cacheWriteMicrosPerMillionTokens: number;
}

export interface EffectivePriceTier extends EffectivePriceLevel {
  minPromptTokens: number;
}

export interface EffectiveModelPricing extends EffectivePriceLevel {
  tiers?: EffectivePriceTier[];
}

/** Base or tier prices as stored on a revision, before unknown cache prices are resolved. */
export interface PinnedModelPricing extends PriceLevel {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  tiers?: readonly ModelPriceTier[] | undefined;
}

function resolveLevel(level: PriceLevel & { inputMicrosPerMillionTokens: number; outputMicrosPerMillionTokens: number }, billsCacheWrites: boolean): EffectivePriceLevel {
  const input = level.inputMicrosPerMillionTokens;
  const cacheRead = level.cacheReadMicrosPerMillionTokens;
  const cacheWrite = level.cacheWriteMicrosPerMillionTokens;
  return {
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: level.outputMicrosPerMillionTokens,
    // An unknown cached read is charged as uncached input.
    cacheReadMicrosPerMillionTokens: typeof cacheRead === 'number' ? cacheRead : input,
    // Providers that bill cache writes charge a premium over input; 2x covers the
    // published write premiums. The clamp keeps the result a safe integer.
    cacheWriteMicrosPerMillionTokens: typeof cacheWrite === 'number'
      ? cacheWrite
      : billsCacheWrites ? Math.min(Number.MAX_SAFE_INTEGER, input * 2) : input
  };
}

/**
 * The concrete prices the gateway charges and the agent reports for a revision.
 * Unknown prices are never free: an unknown cache read costs the input price, and
 * an unknown cache write costs twice the input price for providers that bill
 * cache writes, otherwise the input price. Each tier resolves the same way from
 * its own input price. This is the only place these defaults live.
 */
export function resolveEffectivePricing(pricing: PinnedModelPricing, provider: ModelProviderKind): EffectiveModelPricing {
  const { billsCacheWrites } = getModelProvider(provider);
  const effective: EffectiveModelPricing = resolveLevel(pricing, billsCacheWrites);
  if (pricing.tiers && pricing.tiers.length > 0) {
    effective.tiers = pricing.tiers.map((tier) => ({
      minPromptTokens: tier.minPromptTokens,
      ...resolveLevel(tier, billsCacheWrites)
    }));
  }
  return effective;
}
