import { z } from 'zod';
import {
  MAX_MODEL_PRICE_TIERS, MAX_PRICE_TIER_MIN_PROMPT_TOKENS, ModelCatalogCapabilitiesSchema, ModelPriceTierSchema, getModelProvider,
  type ModelCatalogCapabilityState, type ModelPriceTier
} from '@cloud-harness/contracts';
import { assertProviderRequestUrl, type ProviderHttpClient } from '../model-provider-http.js';
import {
  CatalogSourceError, MAX_CATALOG_MODELS, MAX_MODEL_ID_LENGTH, assertCatalogResponse, boundedText,
  catalogErrorFromHttp, parseCatalogJson, positiveInt
} from './catalog-source.js';
import { usdPerTokenToMicrosPerMillion } from './pricing.js';

const nullableMicros = z.number().int().nonnegative().nullable();

/** One OpenRouter model reduced to the fields the catalog uses; also the persisted snapshot shape. */
export const OpenRouterModelSchema = z.object({
  id: z.string().min(1).max(MAX_MODEL_ID_LENGTH),
  name: z.string().max(300).nullable(),
  contextLength: z.number().int().positive().nullable(),
  maxCompletionTokens: z.number().int().positive().nullable(),
  prices: z.object({
    input: nullableMicros,
    output: nullableMicros,
    cacheRead: nullableMicros,
    cacheWrite: nullableMicros
  }).strict(),
  // Ascending, unique `min_prompt_tokens` overrides. The tier ordering rules are
  // applied per provider when a catalog price is built, because unknown cache
  // prices resolve differently per provider.
  tiers: z.array(ModelPriceTierSchema).max(MAX_MODEL_PRICE_TIERS),
  // An override this normaliser could not turn into a tier.
  hasConditionalPricing: z.boolean(),
  capabilities: ModelCatalogCapabilitiesSchema,
  expiresAt: z.number().int().nullable()
}).strict();
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

const RawModelSchema = z.object({
  id: z.string().min(1).max(MAX_MODEL_ID_LENGTH),
  name: z.unknown().optional(),
  context_length: z.unknown().optional(),
  architecture: z.object({ input_modalities: z.array(z.unknown()).optional() }).nullable().optional(),
  pricing: z.record(z.string(), z.unknown()).nullable().optional(),
  top_provider: z.object({ max_completion_tokens: z.unknown().optional() }).nullable().optional(),
  supported_parameters: z.array(z.unknown()).nullable().optional(),
  expiration_date: z.unknown().optional()
});

export const OPENROUTER_CATALOG_TIMEOUT_MS = 15_000;
export const OPENROUTER_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

function listed(values: readonly unknown[] | null | undefined, wanted: readonly string[]): ModelCatalogCapabilityState {
  // A model that publishes its parameter or modality list but omits the capability
  // does not support it on this route; a model without the list is unknown.
  if (!Array.isArray(values)) return 'unknown';
  return values.some((value) => typeof value === 'string' && wanted.includes(value)) ? 'reported' : 'unsupported';
}

// Price keys OpenRouter publishes. In an override, every other key is a condition.
const PRICE_KEYS = new Set([
  'prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write',
  'input_cache_write_1h', 'audio', 'input_audio_cache', 'image_output', 'audio_output'
]);
const MAX_OVERRIDES = 16;

/**
 * The higher of the default and the one-hour cache-write price. The agent runtime
 * can request long retention and usage does not say which write was billed, so
 * the higher price never understates cost.
 */
function cacheWritePrice(pricing: Record<string, unknown>): number | null {
  const fiveMinute = usdPerTokenToMicrosPerMillion(pricing.input_cache_write);
  const oneHour = usdPerTokenToMicrosPerMillion(pricing.input_cache_write_1h);
  if (fiveMinute === null) return oneHour;
  return oneHour === null ? fiveMinute : Math.max(fiveMinute, oneHour);
}

function overrideTier(override: unknown): ModelPriceTier | undefined {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return undefined;
  const entry = override as Record<string, unknown>;
  const conditions = Object.keys(entry).filter((key) => !PRICE_KEYS.has(key));
  if (conditions.length !== 1 || conditions[0] !== 'min_prompt_tokens') return undefined;
  const minPromptTokens = entry.min_prompt_tokens;
  if (typeof minPromptTokens !== 'number' || !Number.isSafeInteger(minPromptTokens) || minPromptTokens < 1 ||
    minPromptTokens > MAX_PRICE_TIER_MIN_PROMPT_TOKENS) return undefined;
  // A tier never inherits base prices: an omitted input or output price leaves the
  // tier unknown, and an omitted cache price stays unknown and resolves conservatively.
  const input = usdPerTokenToMicrosPerMillion(entry.prompt);
  const output = usdPerTokenToMicrosPerMillion(entry.completion);
  if (input === null || output === null) return undefined;
  return {
    minPromptTokens,
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    cacheReadMicrosPerMillionTokens: usdPerTokenToMicrosPerMillion(entry.input_cache_read),
    cacheWriteMicrosPerMillionTokens: cacheWritePrice(entry)
  };
}

/** Maps `overrides[]` to tiers; `skipped` reports any override that did not become a tier. */
function overrideTiers(overrides: unknown): { tiers: ModelPriceTier[]; skipped: boolean } {
  if (overrides === undefined || overrides === null) return { tiers: [], skipped: false };
  if (!Array.isArray(overrides)) return { tiers: [], skipped: true };
  let skipped = overrides.length > MAX_OVERRIDES;
  const candidates: ModelPriceTier[] = [];
  for (const override of overrides.slice(0, MAX_OVERRIDES)) {
    const tier = overrideTier(override);
    if (tier) candidates.push(tier);
    else skipped = true;
  }
  candidates.sort((left, right) => left.minPromptTokens - right.minPromptTokens);
  // Two prices for one threshold are ambiguous, so neither is used.
  const unique = candidates.filter((tier) => candidates.filter((other) => other.minPromptTokens === tier.minPromptTokens).length === 1);
  if (unique.length !== candidates.length) skipped = true;
  if (unique.length > MAX_MODEL_PRICE_TIERS) skipped = true;
  return { tiers: unique.slice(0, MAX_MODEL_PRICE_TIERS), skipped };
}

function expiry(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Normalizes the public `GET /api/v1/models` body; malformed models are skipped rather than failing the catalog. */
export function normalizeOpenRouterModels(payload: unknown): OpenRouterModel[] {
  const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new CatalogSourceError('invalid_response');
  const models: OpenRouterModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (models.length >= MAX_CATALOG_MODELS) break;
    const parsed = RawModelSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const raw = parsed.data;
    seen.add(raw.id);
    const pricing = raw.pricing ?? {};
    const { tiers, skipped } = overrideTiers(pricing.overrides);
    models.push({
      id: raw.id,
      name: boundedText(raw.name),
      contextLength: positiveInt(raw.context_length),
      maxCompletionTokens: positiveInt(raw.top_provider?.max_completion_tokens),
      prices: {
        input: usdPerTokenToMicrosPerMillion(pricing.prompt),
        output: usdPerTokenToMicrosPerMillion(pricing.completion),
        cacheRead: usdPerTokenToMicrosPerMillion(pricing.input_cache_read),
        cacheWrite: cacheWritePrice(pricing)
      },
      tiers,
      hasConditionalPricing: skipped,
      capabilities: {
        tools: listed(raw.supported_parameters, ['tools']),
        reasoning: listed(raw.supported_parameters, ['reasoning', 'include_reasoning']),
        vision: listed(raw.architecture?.input_modalities, ['image'])
      },
      expiresAt: expiry(raw.expiration_date)
    });
  }
  return models;
}

/** Fetches OpenRouter's public model list. No credential is sent: the endpoint is public. */
export async function fetchOpenRouterModels(http: ProviderHttpClient): Promise<OpenRouterModel[]> {
  const endpoint = getModelProvider('openrouter').modelsEndpoint;
  if (!endpoint) throw new CatalogSourceError('upstream_error');
  let response;
  try {
    const url = assertProviderRequestUrl('openrouter', endpoint.url);
    response = await http.request({
      url: url.toString(), method: 'GET', timeoutMs: OPENROUTER_CATALOG_TIMEOUT_MS, maxResponseBytes: OPENROUTER_CATALOG_MAX_BYTES
    });
  } catch (error) {
    throw catalogErrorFromHttp(error);
  }
  assertCatalogResponse(response);
  return normalizeOpenRouterModels(parseCatalogJson(response.body));
}
