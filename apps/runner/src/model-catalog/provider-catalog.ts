import { z } from 'zod';
import { getModelProvider, type ModelProviderKind, type ProviderAuthMode } from '@cloud-harness/contracts';
import { assertProviderRequestUrl, redactSecret, type ProviderHttpClient } from '../model-provider-http.js';
import {
  CatalogSourceError, MAX_CATALOG_MODELS, MAX_MODEL_ID_LENGTH, assertCatalogResponse, boundedText,
  catalogErrorFromHttp, parseCatalogJson, positiveInt
} from './catalog-source.js';

/** A model a provider's own models endpoint returned for a credential; also the persisted snapshot shape. */
export const ProviderListedModelSchema = z.object({
  id: z.string().min(1).max(MAX_MODEL_ID_LENGTH),
  displayName: z.string().max(300).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable()
}).strict();
export type ProviderListedModel = z.infer<typeof ProviderListedModelSchema>;

const RawListedModelSchema = z.object({
  id: z.string().min(1).max(MAX_MODEL_ID_LENGTH + 'models/'.length),
  display_name: z.unknown().optional(),
  // Anthropic
  max_input_tokens: z.unknown().optional(),
  max_tokens: z.unknown().optional(),
  // DeepSeek
  context_window: z.unknown().optional(),
  max_output_tokens: z.unknown().optional()
});

const PageSchema = z.object({
  data: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  last_id: z.string().max(MAX_MODEL_ID_LENGTH).nullable().optional()
});

export const PROVIDER_CATALOG_TIMEOUT_MS = 15_000;
// Both sources are fetched in parallel, so a search stays well inside the API's runner timeout.
export const PROVIDER_CATALOG_BUDGET_MS = 25_000;
export const PROVIDER_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_PAGE_LIMIT = 1_000;
const ANTHROPIC_MAX_PAGES = 5;

function normalizeModel(provider: ModelProviderKind, item: unknown): ProviderListedModel | undefined {
  const parsed = RawListedModelSchema.safeParse(item);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  // Gemini's OpenAI-compatible list names models `models/gemini-…`; chat requests take the bare ID.
  const id = provider === 'google' && raw.id.startsWith('models/') ? raw.id.slice('models/'.length) : raw.id;
  if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) return undefined;
  return {
    id,
    displayName: boundedText(raw.display_name),
    contextWindow: positiveInt(raw.max_input_tokens) ?? positiveInt(raw.context_window),
    maxOutputTokens: positiveInt(raw.max_tokens) ?? positiveInt(raw.max_output_tokens)
  };
}

export interface ProviderCatalogCredential {
  secret: string;
  // The auth header the operator chose for this credential; it decides how the key is sent.
  authMode: ProviderAuthMode;
}

export interface ProviderCatalogOptions {
  now?: () => number;
  // One budget for every page of the listing, so pagination cannot outlast the caller's timeout.
  budgetMs?: number;
}

function authHeaders(endpointAuth: 'bearer' | 'anthropic' | 'none', credential: ProviderCatalogCredential): Record<string, string> {
  if (endpointAuth === 'anthropic') {
    const key = credential.authMode === 'x-api-key'
      ? { 'x-api-key': credential.secret }
      : { authorization: `Bearer ${credential.secret}` };
    return { ...key, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return endpointAuth === 'bearer' ? { authorization: `Bearer ${credential.secret}` } : {};
}

/**
 * Lists the models a provider serves to a credential, through the provider's own
 * models endpoint. Runs only in the runner: the secret is sent to the registry
 * host and nowhere else, and no failure carries it or the provider's response text.
 */
export async function fetchProviderModels(
  http: ProviderHttpClient,
  provider: ModelProviderKind,
  credential: ProviderCatalogCredential,
  options: ProviderCatalogOptions = {}
): Promise<ProviderListedModel[]> {
  const definition = getModelProvider(provider);
  const endpoint = definition.modelsEndpoint;
  if (!endpoint || definition.catalogStrategy !== 'provider-models') throw new CatalogSourceError('upstream_error');
  const { secret } = credential;
  const headers = authHeaders(endpoint.auth, credential);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? PROVIDER_CATALOG_BUDGET_MS);
  // Gemini answers an unusable key with 400 INVALID_ARGUMENT rather than 401.
  const authenticationStatuses = provider === 'google' ? [400, 401, 403] : [401, 403];
  const paginated = endpoint.auth === 'anthropic';
  const models: ProviderListedModel[] = [];
  const seen = new Set<string>();
  let afterId: string | undefined;
  for (let page = 0; page < (paginated ? ANTHROPIC_MAX_PAGES : 1); page += 1) {
    const url = new URL(endpoint.url);
    if (paginated) {
      url.searchParams.set('limit', String(ANTHROPIC_PAGE_LIMIT));
      if (afterId) url.searchParams.set('after_id', afterId);
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new CatalogSourceError('timeout');
    let response;
    try {
      const target = assertProviderRequestUrl(provider, url.toString());
      response = await http.request({
        url: target.toString(), method: 'GET', headers, timeoutMs: Math.min(PROVIDER_CATALOG_TIMEOUT_MS, remaining), maxResponseBytes: PROVIDER_CATALOG_MAX_BYTES
      });
    } catch (error) {
      throw catalogErrorFromHttp(error);
    }
    assertCatalogResponse(response, authenticationStatuses);
    const body = PageSchema.safeParse(parseCatalogJson(redactSecret(response.body, secret)));
    if (!body.success) throw new CatalogSourceError('invalid_response');
    for (const item of body.data.data) {
      if (models.length >= MAX_CATALOG_MODELS) break;
      const model = normalizeModel(provider, item);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    if (!paginated || body.data.has_more !== true || !body.data.last_id || models.length >= MAX_CATALOG_MODELS) break;
    afterId = body.data.last_id;
  }
  return models;
}
