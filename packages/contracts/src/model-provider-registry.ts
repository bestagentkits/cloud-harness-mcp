import { HarnessError } from './mcp-results.js';
import type { AgentModelApiMode, ModelProviderKind, ProviderAuthMode } from './model-profile-schemas.js';

// How the catalog learns which models a provider serves. `provider-models`
// calls the provider's own models endpoint with the operator's credential,
// `openrouter` uses OpenRouter's public metadata, `none` leaves the operator to
// enter a model ID.
export type ModelCatalogStrategy = 'provider-models' | 'openrouter' | 'none';

export interface ModelProviderModelsEndpoint {
  url: string;
  // `bearer` sends `Authorization: Bearer`, `anthropic` sends `x-api-key` and
  // `anthropic-version` as Anthropic's native models endpoint requires.
  auth: 'bearer' | 'anthropic' | 'none';
}

export interface ModelProviderDefinition {
  id: ModelProviderKind;
  displayName: string;
  description: string;
  docsUrl: string | null;
  apiKeyUrl: string | null;
  authModes: readonly ProviderAuthMode[];
  defaultAuthMode: ProviderAuthMode;
  // Full upstream URL per supported API mode. A mode that is absent is not
  // offered by the provider's OpenAI-compatible surface and is rejected.
  endpoints: Partial<Record<AgentModelApiMode, string>>;
  modelsEndpoint: ModelProviderModelsEndpoint | null;
  catalogStrategy: ModelCatalogStrategy;
  // Vendor prefix OpenRouter uses for this provider's models (`openai/gpt-…`).
  // Provider model IDs never carry it; the catalog strips it when mapping.
  openRouterVendor: string | null;
  requiresCustomUpstream: boolean;
  // Whether the provider's route can bill a cache write above the input price.
  // An unknown cache-write price defaults to twice the input price when true and
  // to the input price when false (resolveEffectivePricing in model-pricing.ts).
  billsCacheWrites: boolean;
}

const definitions: readonly ModelProviderDefinition[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    description: 'GPT and o-series models through the OpenAI API.',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    authModes: ['bearer'],
    defaultAuthMode: 'bearer',
    endpoints: {
      'chat-completions': 'https://api.openai.com/v1/chat/completions',
      responses: 'https://api.openai.com/v1/responses'
    },
    modelsEndpoint: { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
    catalogStrategy: 'provider-models',
    openRouterVendor: 'openai',
    requiresCustomUpstream: false,
    // OpenAI caches automatically and charges no cache-write premium.
    billsCacheWrites: false
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    description: 'Claude models through Anthropic\'s OpenAI SDK compatibility endpoint.',
    docsUrl: 'https://docs.anthropic.com/en/api/openai-sdk',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    authModes: ['bearer', 'x-api-key'],
    defaultAuthMode: 'bearer',
    endpoints: {
      'chat-completions': 'https://api.anthropic.com/v1/chat/completions'
    },
    modelsEndpoint: { url: 'https://api.anthropic.com/v1/models', auth: 'anthropic' },
    catalogStrategy: 'provider-models',
    openRouterVendor: 'anthropic',
    requiresCustomUpstream: false,
    // The OpenAI SDK compatibility endpoint does not support prompt caching.
    billsCacheWrites: false
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    description: 'Hundreds of models from many vendors behind one OpenRouter key.',
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
    apiKeyUrl: 'https://openrouter.ai/settings/keys',
    authModes: ['bearer'],
    defaultAuthMode: 'bearer',
    endpoints: {
      'chat-completions': 'https://openrouter.ai/api/v1/chat/completions',
      responses: 'https://openrouter.ai/api/v1/responses'
    },
    modelsEndpoint: { url: 'https://openrouter.ai/api/v1/models', auth: 'none' },
    catalogStrategy: 'openrouter',
    openRouterVendor: null,
    requiresCustomUpstream: false,
    // OpenRouter routes to vendors that charge for cache writes.
    billsCacheWrites: true
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    description: 'Gemini models through the Gemini API\'s OpenAI-compatible endpoint.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    authModes: ['bearer'],
    defaultAuthMode: 'bearer',
    endpoints: {
      'chat-completions': 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    },
    modelsEndpoint: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', auth: 'bearer' },
    catalogStrategy: 'provider-models',
    openRouterVendor: 'google',
    requiresCustomUpstream: false,
    // Gemini implicit caching charges no write premium.
    billsCacheWrites: false
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models through the DeepSeek API.',
    docsUrl: 'https://api-docs.deepseek.com/',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    authModes: ['bearer'],
    defaultAuthMode: 'bearer',
    endpoints: {
      'chat-completions': 'https://api.deepseek.com/chat/completions'
    },
    modelsEndpoint: { url: 'https://api.deepseek.com/models', auth: 'bearer' },
    catalogStrategy: 'provider-models',
    openRouterVendor: 'deepseek',
    requiresCustomUpstream: false,
    // DeepSeek context caching charges no write premium.
    billsCacheWrites: false
  },
  {
    id: 'custom',
    displayName: 'Custom (OpenAI-compatible)',
    description: 'Any HTTPS endpoint that speaks the OpenAI Chat Completions or Responses protocol.',
    docsUrl: null,
    apiKeyUrl: null,
    authModes: ['bearer', 'x-api-key'],
    defaultAuthMode: 'bearer',
    endpoints: {},
    modelsEndpoint: null,
    catalogStrategy: 'none',
    openRouterVendor: null,
    requiresCustomUpstream: true,
    // An unknown upstream may bill cache writes, so assume it does.
    billsCacheWrites: true
  }
];

const byId = new Map<ModelProviderKind, ModelProviderDefinition>(definitions.map((definition) => [definition.id, definition]));

export function listModelProviders(): readonly ModelProviderDefinition[] {
  return definitions;
}

export function getModelProvider(provider: ModelProviderKind): ModelProviderDefinition {
  const definition = byId.get(provider);
  if (!definition) throw new HarnessError('INVALID_INPUT', `unsupported provider ${provider}`);
  return definition;
}

export function providerSupportsApiMode(provider: ModelProviderKind, apiMode: AgentModelApiMode): boolean {
  const definition = getModelProvider(provider);
  return definition.requiresCustomUpstream || definition.endpoints[apiMode] !== undefined;
}

export function resolveProviderUpstreamUrl(provider: ModelProviderKind, apiMode: AgentModelApiMode, customUrl?: string): string {
  const definition = getModelProvider(provider);
  if (definition.requiresCustomUpstream) {
    if (!customUrl) throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl is required for custom provider');
    let parsed: URL;
    try {
      parsed = new URL(customUrl);
    } catch {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl must be an absolute HTTPS URL');
    }
    if (parsed.protocol !== 'https:' || (parsed.port !== '' && parsed.port !== '443')) {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl must use HTTPS on default port 443');
    }
    // Same one-fixed-path rules as env-configured gateway profiles: userinfo would be a second
    // credential channel outside the encrypted store, and the URL parser drops an empty "?"/"#".
    if (/[\0-\x20\x7f]/u.test(customUrl)) {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl must not contain whitespace or control characters');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || customUrl.includes('?') || customUrl.includes('#')) {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl must not contain credentials, a query string, or a fragment');
    }
    if (/%(?:2e|2f|5c)|\\/iu.test(customUrl) || parsed.pathname === '/' || parsed.pathname.endsWith('/')) {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl must name one fixed request path without encoded separators');
    }
    return customUrl;
  }
  const endpoint = definition.endpoints[apiMode];
  if (endpoint === undefined) {
    const supported = Object.keys(definition.endpoints).join(', ');
    throw new HarnessError('INVALID_INPUT', `${definition.displayName} does not support the ${apiMode} API mode; supported: ${supported}`);
  }
  return endpoint;
}

export function assertProviderAuthMode(provider: ModelProviderKind, authMode: ProviderAuthMode): void {
  const definition = getModelProvider(provider);
  if (!definition.authModes.includes(authMode)) {
    throw new HarnessError('INVALID_INPUT', `${definition.displayName} does not accept the ${authMode} auth mode; supported: ${definition.authModes.join(', ')}`);
  }
}
