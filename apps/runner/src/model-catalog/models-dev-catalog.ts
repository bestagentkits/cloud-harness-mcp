import { z } from 'zod';
import { MAX_MODEL_PRICE_TIERS, MAX_PRICE_TIER_MIN_PROMPT_TOKENS, type ModelPriceTier, type ModelProviderKind } from '@cloud-harness/contracts';
import { assertPublicMetadataUrl, type ProviderHttpClient } from '../model-provider-http.js';
import {
  CatalogSourceError, MAX_CATALOG_MODELS, MAX_MODEL_ID_LENGTH, assertCatalogResponse, boundedText,
  catalogErrorFromHttp, parseCatalogJson, positiveInt
} from './catalog-source.js';
import type { OpenRouterModel } from './openrouter-catalog.js';
import { usdPerMillionTokensToMicrosPerMillion } from './pricing.js';

// models.dev is the public model registry OpenCode's own client reads prices
// from. It is the price source for providers whose API publishes no prices and
// that OpenRouter does not list: the key is the models.dev provider ID.
const MODELS_DEV_PROVIDERS: Partial<Record<ModelProviderKind, string>> = {
  'opencode-go': 'opencode-go'
};

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';
export const MODELS_DEV_CATALOG_TIMEOUT_MS = 15_000;
export const MODELS_DEV_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

/** The models.dev provider ID that prices `provider`, or undefined when models.dev is not its price source. */
export function modelsDevProviderFor(provider: ModelProviderKind): string | undefined {
  return MODELS_DEV_PROVIDERS[provider];
}

const RawTierSchema = z.object({
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  cache_read: z.unknown().optional(),
  cache_write: z.unknown().optional(),
  tier: z.object({ type: z.unknown(), size: z.unknown() })
});

const RawModelSchema = z.object({
  id: z.string().min(1).max(MAX_MODEL_ID_LENGTH),
  name: z.unknown().optional(),
  tool_call: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  modalities: z.object({ input: z.array(z.unknown()).optional() }).nullable().optional(),
  limit: z.object({ context: z.unknown().optional(), output: z.unknown().optional() }).nullable().optional(),
  cost: z.record(z.string(), z.unknown()).nullable().optional()
});

// Cost keys the normaliser prices. `context_over_200k` repeats a context tier
// that `tiers` describes; any other key is a price under a condition the
// catalog cannot express, such as audio input.
const PRICED_COST_KEYS = new Set(['input', 'output', 'cache_read', 'cache_write', 'tiers', 'context_over_200k']);

function reported(value: unknown): 'reported' | 'unknown' {
  // A model the registry marks without a capability is left unknown: the catalog
  // confirms capabilities from metadata but never rules one out.
  return value === true ? 'reported' : 'unknown';
}

/**
 * Maps `cost.tiers` to tiers, all or nothing, as the OpenRouter normaliser maps
 * its overrides: a tier other than a prompt-context threshold, a missing price,
 * or thresholds that are not strictly ascending drop every tier and mark the
 * price conditional. A tier's threshold is the context size it starts above.
 */
function costTiers(cost: Record<string, unknown>): { tiers: ModelPriceTier[]; skipped: boolean } {
  const raw = cost.tiers;
  if (raw === undefined || raw === null) return { tiers: [], skipped: cost.context_over_200k !== undefined };
  if (!Array.isArray(raw) || raw.length > MAX_MODEL_PRICE_TIERS) return { tiers: [], skipped: true };
  const tiers: ModelPriceTier[] = [];
  for (const item of raw) {
    const parsed = RawTierSchema.safeParse(item);
    if (!parsed.success || parsed.data.tier.type !== 'context') return { tiers: [], skipped: true };
    const minPromptTokens = parsed.data.tier.size;
    const input = usdPerMillionTokensToMicrosPerMillion(parsed.data.input);
    const output = usdPerMillionTokensToMicrosPerMillion(parsed.data.output);
    if (typeof minPromptTokens !== 'number' || !Number.isSafeInteger(minPromptTokens) || minPromptTokens < 1 ||
      minPromptTokens > MAX_PRICE_TIER_MIN_PROMPT_TOKENS || input === null || output === null ||
      (tiers.length > 0 && minPromptTokens <= tiers[tiers.length - 1]!.minPromptTokens)) {
      return { tiers: [], skipped: true };
    }
    tiers.push({
      minPromptTokens,
      inputMicrosPerMillionTokens: input,
      outputMicrosPerMillionTokens: output,
      cacheReadMicrosPerMillionTokens: usdPerMillionTokensToMicrosPerMillion(parsed.data.cache_read),
      cacheWriteMicrosPerMillionTokens: usdPerMillionTokensToMicrosPerMillion(parsed.data.cache_write)
    });
  }
  return { tiers, skipped: false };
}

/**
 * Normalizes one provider of the models.dev `api.json` body to the catalog's
 * metadata shape. IDs carry the models.dev provider prefix (`opencode-go/glm-5.2`)
 * so the vendor index matches them as it matches OpenRouter IDs. Malformed models
 * are skipped rather than failing the catalog; a missing provider fails it.
 */
export function normalizeModelsDevModels(payload: unknown, modelsDevProvider: string): OpenRouterModel[] {
  const entry = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[modelsDevProvider] : undefined;
  const rawModels = entry && typeof entry === 'object' ? (entry as { models?: unknown }).models : undefined;
  if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) throw new CatalogSourceError('invalid_response');
  const models: OpenRouterModel[] = [];
  const seen = new Set<string>();
  for (const item of Object.values(rawModels)) {
    if (models.length >= MAX_CATALOG_MODELS) break;
    const parsed = RawModelSchema.safeParse(item);
    if (!parsed.success) continue;
    const raw = parsed.data;
    const id = `${modelsDevProvider}/${raw.id}`;
    if (id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const cost = raw.cost ?? {};
    const { tiers, skipped } = costTiers(cost);
    const modalities = raw.modalities?.input;
    models.push({
      id,
      name: boundedText(raw.name),
      contextLength: positiveInt(raw.limit?.context),
      maxCompletionTokens: positiveInt(raw.limit?.output),
      prices: {
        input: usdPerMillionTokensToMicrosPerMillion(cost.input),
        output: usdPerMillionTokensToMicrosPerMillion(cost.output),
        cacheRead: usdPerMillionTokensToMicrosPerMillion(cost.cache_read),
        cacheWrite: usdPerMillionTokensToMicrosPerMillion(cost.cache_write)
      },
      tiers,
      hasConditionalPricing: skipped || Object.keys(cost).some((key) => !PRICED_COST_KEYS.has(key)),
      capabilities: {
        tools: reported(raw.tool_call),
        reasoning: reported(raw.reasoning),
        vision: reported(Array.isArray(modalities) && modalities.includes('image'))
      },
      expiresAt: null
    });
  }
  return models;
}

/** Fetches models.dev's public registry. No credential is sent: the file is public. */
export async function fetchModelsDevModels(http: ProviderHttpClient, modelsDevProvider: string): Promise<OpenRouterModel[]> {
  let response;
  try {
    const url = assertPublicMetadataUrl(MODELS_DEV_CATALOG_URL);
    response = await http.request({
      url: url.toString(), method: 'GET', timeoutMs: MODELS_DEV_CATALOG_TIMEOUT_MS, maxResponseBytes: MODELS_DEV_CATALOG_MAX_BYTES
    });
  } catch (error) {
    throw catalogErrorFromHttp(error);
  }
  assertCatalogResponse(response);
  return normalizeModelsDevModels(parseCatalogJson(response.body), modelsDevProvider);
}
