import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModelProviderKind } from '@cloud-harness/contracts';
import { CatalogSourceError } from '../src/model-catalog/catalog-source.js';
import { fetchOpenRouterModels, normalizeOpenRouterModels } from '../src/model-catalog/openrouter-catalog.js';
import { PROVIDER_CATALOG_BUDGET_MS, fetchProviderModels, type ProviderCatalogCredential } from '../src/model-catalog/provider-catalog.js';
import { ProviderHttpError, type ProviderHttpClient, type ProviderHttpRequest, type ProviderHttpResponse } from '../src/model-provider-http.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/openrouter-models-sample.json', import.meta.url), 'utf8')) as unknown;
const SECRET = 'sk-test-catalog-secret-0123456789';
const BEARER: ProviderCatalogCredential = { secret: SECRET, authMode: 'bearer' };
const X_API_KEY: ProviderCatalogCredential = { secret: SECRET, authMode: 'x-api-key' };

function fakeHttp(handler: (request: ProviderHttpRequest) => ProviderHttpResponse | Promise<ProviderHttpResponse>) {
  const calls: ProviderHttpRequest[] = [];
  const client: ProviderHttpClient = {
    request: async (request) => {
      calls.push(request);
      return await handler(request);
    }
  };
  return { client, calls };
}

const json = (body: unknown, status = 200): ProviderHttpResponse => ({ status, headers: {}, body: JSON.stringify(body), truncated: false });

async function categoryOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogSourceError);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    return (error as CatalogSourceError).category;
  }
  throw new Error('expected a catalog failure');
}

describe('OpenRouter catalog normalization', () => {
  it('normalizes the sample payload with exact prices, limits, capabilities, and long-prompt tiers', () => {
    const models = normalizeOpenRouterModels(fixture);
    expect(models.map((model) => model.id)).toEqual(['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat', 'openai/gpt-4o-mini']);
    const [claude, deepseek, mini] = models;
    expect(claude).toEqual({
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      contextLength: 1_000_000,
      maxCompletionTokens: 64_000,
      // The one-hour cache write is the higher write price, so it is the one kept.
      prices: { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 6_000_000 },
      tiers: [{
        minPromptTokens: 200_000, inputMicrosPerMillionTokens: 6_000_000, outputMicrosPerMillionTokens: 22_500_000,
        cacheReadMicrosPerMillionTokens: 600_000, cacheWriteMicrosPerMillionTokens: 12_000_000
      }],
      hasConditionalPricing: false,
      capabilities: { tools: 'reported', reasoning: 'reported', vision: 'reported' },
      expiresAt: null
    });
    expect(deepseek?.capabilities).toEqual({ tools: 'reported', reasoning: 'unsupported', vision: 'unsupported' });
    expect(deepseek?.prices).toEqual({ input: 320_000, output: 890_000, cacheRead: null, cacheWrite: null });
    expect(deepseek?.hasConditionalPricing).toBe(false);
    expect(deepseek?.tiers).toEqual([]);
    expect(mini?.prices).toEqual({ input: 150_000, output: 600_000, cacheRead: 75_000, cacheWrite: null });
  });

  it('keeps the default cache-write price when the one-hour price is lower or unknown', () => {
    const [lower, unknown, onlyHour] = normalizeOpenRouterModels({
      data: [
        { id: 'vendor/lower', pricing: { prompt: '0.000001', completion: '0.000002', input_cache_write: '0.000003', input_cache_write_1h: '0.000002' } },
        { id: 'vendor/unknown', pricing: { prompt: '0.000001', completion: '0.000002', input_cache_write: '0.000003', input_cache_write_1h: '-1' } },
        { id: 'vendor/only-hour', pricing: { prompt: '0.000001', completion: '0.000002', input_cache_write_1h: '0.000004' } }
      ]
    });
    expect(lower?.prices.cacheWrite).toBe(3_000_000);
    expect(unknown?.prices.cacheWrite).toBe(3_000_000);
    expect(onlyHour?.prices.cacheWrite).toBe(4_000_000);
  });

  it('turns min_prompt_tokens overrides into tiers, all or nothing, and flags every other override', () => {
    const tier = (min: unknown, extra: Record<string, unknown> = {}) => ({ min_prompt_tokens: min, prompt: '0.000004', completion: '0.000008', ...extra });
    const models = normalizeOpenRouterModels({
      data: [
        { id: 'vendor/condition', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [{ ...tier(200_000), max_output_tokens: 10 }] } },
        { id: 'vendor/time', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [{ hour_of_day: 3, prompt: '0.000001', completion: '0.000002' }] } },
        { id: 'vendor/sorted', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [tier(500_000, { prompt: '0.000005' }), tier(100_000, { web_search: '0.01' })] } },
        {
          id: 'vendor/invalid',
          pricing: {
            prompt: '0.000002', completion: '0.000004',
            overrides: [tier(0), tier(10_000_001), tier(1.5), tier('200000'), { min_prompt_tokens: 300_000, prompt: '0.000004' }, 'not an override', tier(64_000)]
          }
        },
        { id: 'vendor/duplicate', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [tier(200_000), tier(200_000, { prompt: '0.000009' }), tier(400_000)] } },
        { id: 'vendor/many', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [1, 2, 3, 4, 5].map((step) => tier(step * 100_000)) } },
        { id: 'vendor/unsorted-four', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [4, 2, 3, 1].map((step) => tier(step * 100_000)) } },
        { id: 'vendor/one-bad', pricing: { prompt: '0.000002', completion: '0.000004', overrides: [tier(100_000), { ...tier(300_000), hour_of_day: 3 }] } },
        { id: 'vendor/not-a-list', pricing: { prompt: '0.000002', completion: '0.000004', overrides: { min_prompt_tokens: 1 } } }
      ]
    });
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get('vendor/condition')).toMatchObject({ tiers: [], hasConditionalPricing: true });
    expect(byId.get('vendor/time')).toMatchObject({ tiers: [], hasConditionalPricing: true });
    // Unpublished tier cache prices stay unknown rather than inheriting the base price.
    expect(byId.get('vendor/sorted')).toMatchObject({
      hasConditionalPricing: false,
      tiers: [
        { minPromptTokens: 100_000, inputMicrosPerMillionTokens: 4_000_000, cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: null },
        { minPromptTokens: 500_000, inputMicrosPerMillionTokens: 5_000_000 }
      ]
    });
    // One override that cannot become a tier drops every tier: a partial set would misprice the gaps.
    expect(byId.get('vendor/invalid')).toMatchObject({ tiers: [], hasConditionalPricing: true });
    expect(byId.get('vendor/duplicate')).toMatchObject({ tiers: [], hasConditionalPricing: true });
    expect(byId.get('vendor/many')).toMatchObject({ tiers: [], hasConditionalPricing: true });
    expect(byId.get('vendor/one-bad')).toMatchObject({ tiers: [], hasConditionalPricing: true });
    expect(byId.get('vendor/unsorted-four')?.tiers.map((entry) => entry.minPromptTokens)).toEqual([100_000, 200_000, 300_000, 400_000]);
    expect(byId.get('vendor/unsorted-four')?.hasConditionalPricing).toBe(false);
    expect(byId.get('vendor/not-a-list')).toMatchObject({ tiers: [], hasConditionalPricing: true });
  });

  it('treats missing evidence as unknown and skips malformed models', () => {
    const models = normalizeOpenRouterModels({
      data: [
        { id: 'vendor/bare' },
        { id: 'vendor/variable', pricing: { prompt: '-1', completion: '0' }, expiration_date: '2026-12-31' },
        { name: 'no id' },
        'not an object',
        { id: 'vendor/bare' }
      ]
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      name: null, contextLength: null, maxCompletionTokens: null,
      prices: { input: null, output: null, cacheRead: null, cacheWrite: null },
      capabilities: { tools: 'unknown', reasoning: 'unknown', vision: 'unknown' }
    });
    expect(models[1]?.prices).toMatchObject({ input: null, output: 0 });
    expect(models[1]?.expiresAt).toBe(Date.parse('2026-12-31'));
    expect(() => normalizeOpenRouterModels({ models: [] })).toThrow(CatalogSourceError);
  });

  it('fetches the public endpoint without credentials and within bounds', async () => {
    const { client, calls } = fakeHttp(() => json(fixture));
    const models = await fetchOpenRouterModels(client);
    expect(models).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
    expect(calls[0]?.headers ?? {}).toEqual({});
    expect(calls[0]?.maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(calls[0]?.timeoutMs).toBe(15_000);
  });

  it('classifies upstream failures', async () => {
    expect(await categoryOf(fetchOpenRouterModels(fakeHttp(() => json({}, 503)).client))).toBe('upstream_error');
    expect(await categoryOf(fetchOpenRouterModels(fakeHttp(() => json({}, 429)).client))).toBe('rate_limited');
    expect(await categoryOf(fetchOpenRouterModels(fakeHttp(() => ({ status: 200, headers: {}, body: '{"data":[', truncated: true })).client))).toBe('invalid_response');
    expect(await categoryOf(fetchOpenRouterModels(fakeHttp(() => ({ status: 200, headers: {}, body: 'not json', truncated: false })).client))).toBe('invalid_response');
    expect(await categoryOf(fetchOpenRouterModels(fakeHttp(() => { throw new ProviderHttpError('timeout', 'slow'); }).client))).toBe('timeout');
  });
});

describe('provider model listing', () => {
  it.each<[ModelProviderKind, string]>([
    ['openai', 'https://api.openai.com/v1/models'],
    ['deepseek', 'https://api.deepseek.com/models'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/openai/models']
  ])('sends a bearer credential to the %s registry models endpoint', async (provider, url) => {
    const { client, calls } = fakeHttp(() => json({ data: [{ id: 'model-a' }] }));
    await fetchProviderModels(client, provider, BEARER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(url);
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
    expect(calls[0]?.method).toBe('GET');
  });

  it('sends the OpenCode Go session header with a fresh id on each listing, and no such header elsewhere', async () => {
    const { client, calls } = fakeHttp(() => json({ data: [{ id: 'kimi-k2.5' }] }));
    expect(await fetchProviderModels(client, 'opencode-go', BEARER)).toEqual([
      { id: 'kimi-k2.5', displayName: null, contextWindow: null, maxOutputTokens: null }
    ]);
    await fetchProviderModels(client, 'opencode-go', BEARER);
    await fetchProviderModels(client, 'openai', BEARER);
    expect(calls.map((call) => call.url)).toEqual([
      'https://opencode.ai/inference/go/v1/models', 'https://opencode.ai/inference/go/v1/models', 'https://api.openai.com/v1/models'
    ]);
    const [first, second] = calls.map((call) => call.headers?.['x-opencode-session']);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}`, 'x-opencode-session': first });
    expect(calls[2]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
  });

  it('strips the Gemini models/ prefix so the chat endpoint receives a bare ID', async () => {
    const { client } = fakeHttp(() => json({ object: 'list', data: [{ id: 'models/gemini-2.5-pro', object: 'model' }, { id: 'gemini-2.5-flash' }] }));
    const models = await fetchProviderModels(client, 'google', BEARER);
    expect(models.map((model) => model.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
  });

  it('reads DeepSeek context and output limits', async () => {
    const { client } = fakeHttp(() => json({ data: [{ id: 'deepseek-chat', context_window: 131_072, max_output_tokens: 8_192 }] }));
    expect(await fetchProviderModels(client, 'deepseek', BEARER)).toEqual([
      { id: 'deepseek-chat', displayName: null, contextWindow: 131_072, maxOutputTokens: 8_192 }
    ]);
  });

  it('uses Anthropic native headers and follows after_id pagination', async () => {
    const { client, calls } = fakeHttp((request) => {
      const after = new URL(request.url).searchParams.get('after_id');
      if (!after) {
        return json({
          data: [{ id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 200_000, max_tokens: 64_000 }],
          has_more: true, last_id: 'claude-sonnet-4-5-20250929'
        });
      }
      return json({ data: [{ id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' }], has_more: false, last_id: 'claude-haiku-4-5-20251001' });
    });
    const models = await fetchProviderModels(client, 'anthropic', X_API_KEY);
    expect(models).toEqual([
      { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 64_000 },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', contextWindow: null, maxOutputTokens: null }
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers).toEqual({ 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[1]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-4-5-20250929');
  });

  it('sends an Anthropic bearer credential as an Authorization header', async () => {
    const { client, calls } = fakeHttp(() => json({ data: [{ id: 'claude-haiku-4-5-20251001' }], has_more: false }));
    await fetchProviderModels(client, 'anthropic', { secret: SECRET, authMode: 'bearer' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}`, 'anthropic-version': '2023-06-01' });
  });

  it('shares one deadline across every page and stops with a timeout once it is spent', async () => {
    let clock = 0;
    let page = 0;
    const { client, calls } = fakeHttp(() => {
      clock += 10_000;
      page += 1;
      return json({ data: [{ id: `claude-${page}` }], has_more: true, last_id: `claude-${page}` });
    });
    expect(PROVIDER_CATALOG_BUDGET_MS).toBe(25_000);
    expect(await categoryOf(fetchProviderModels(client, 'anthropic', X_API_KEY, { now: () => clock }))).toBe('timeout');
    expect(calls.map((call) => call.timeoutMs)).toEqual([15_000, 15_000, 5_000]);
  });

  it('stops Anthropic pagination after a bounded number of pages', async () => {
    let page = 0;
    const { client, calls } = fakeHttp(() => {
      page += 1;
      return json({ data: [{ id: `claude-${page}` }], has_more: true, last_id: `claude-${page}` });
    });
    const models = await fetchProviderModels(client, 'anthropic', X_API_KEY);
    expect(calls).toHaveLength(5);
    expect(models).toHaveLength(5);
  });

  it('refuses providers without a credential-backed models endpoint', async () => {
    const { client, calls } = fakeHttp(() => json({ data: [] }));
    expect(await categoryOf(fetchProviderModels(client, 'custom', BEARER))).toBe('upstream_error');
    expect(await categoryOf(fetchProviderModels(client, 'openrouter', BEARER))).toBe('upstream_error');
    expect(calls).toHaveLength(0);
  });

  it('never carries the credential or provider text in a failure', async () => {
    const echo = (status: number) => fakeHttp(() => json({ error: { message: `invalid key ${SECRET}` } }, status)).client;
    expect(await categoryOf(fetchProviderModels(echo(401), 'openai', BEARER))).toBe('authentication');
    expect(await categoryOf(fetchProviderModels(echo(403), 'anthropic', X_API_KEY))).toBe('authentication');
    expect(await categoryOf(fetchProviderModels(echo(400), 'google', BEARER))).toBe('authentication');
    expect(await categoryOf(fetchProviderModels(echo(400), 'openai', BEARER))).toBe('upstream_error');
    expect(await categoryOf(fetchProviderModels(echo(429), 'deepseek', BEARER))).toBe('rate_limited');
    expect(await categoryOf(fetchProviderModels(echo(200), 'openai', BEARER))).toBe('invalid_response');
    const throwing = fakeHttp(() => { throw new Error(`socket closed for ${SECRET}`); }).client;
    expect(await categoryOf(fetchProviderModels(throwing, 'openai', BEARER))).toBe('network');
  });

  it('redacts a credential the provider reflects into model metadata', async () => {
    const { client } = fakeHttp(() => json({ data: [{ id: 'model-a', display_name: `Echo ${SECRET}` }] }));
    const [model] = await fetchProviderModels(client, 'openai', BEARER);
    expect(model?.displayName).toBe('Echo [redacted]');
  });
});
