import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessError, ModelCatalogSearchInputSchema, ModelCatalogSearchResultSchema, type ModelCatalogSearchInput } from '@cloud-harness/contracts';
import { CatalogSourceError } from '../src/model-catalog/catalog-source.js';
import {
  CATALOG_FAILURE_BACKOFF_MS, CATALOG_REFRESH_INTERVAL_MS, ModelCatalogService, OPENROUTER_CATALOG_TTL_MS, PROVIDER_CATALOG_TTL_MS,
  SourceCache, type SourceRequest
} from '../src/model-catalog/model-catalog-service.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import type { ProviderHttpClient, ProviderHttpRequest, ProviderHttpResponse } from '../src/model-provider-http.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/openrouter-models-sample.json', import.meta.url), 'utf8')) as { data: unknown[] };
const openRouterPayload = {
  data: [
    ...fixture.data,
    { id: 'openai/gpt-4o-mini:free', name: 'OpenAI: GPT-4o-mini (free)', pricing: { prompt: '0', completion: '0' } },
    { id: 'openai/o3', name: 'OpenAI: o3', supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000002', completion: '0.000008' } },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', pricing: { prompt: '0.00000125', completion: '0.00001' } }
  ]
};

const CLAUDE_LONG_PROMPT_TIER = {
  minPromptTokens: 200_000, inputMicrosPerMillionTokens: 6_000_000, outputMicrosPerMillionTokens: 22_500_000,
  cacheReadMicrosPerMillionTokens: 600_000, cacheWriteMicrosPerMillionTokens: 12_000_000
};

const json = (body: unknown, status = 200): ProviderHttpResponse => ({ status, headers: {}, body: JSON.stringify(body), truncated: false });

type Handler = (request: ProviderHttpRequest) => ProviderHttpResponse | Promise<ProviderHttpResponse>;

class FakeProviders implements ProviderHttpClient {
  calls: ProviderHttpRequest[] = [];
  openRouter: Handler = () => json(openRouterPayload);
  vendor: Handler = (request) => {
    const host = new URL(request.url).hostname;
    if (host === 'api.anthropic.com') return json({ data: [{ id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 200_000 }], has_more: false });
    if (host === 'api.deepseek.com') return json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
    return json({ data: [{ id: 'gpt-4o-mini' }, { id: 'o3' }, { id: 'text-embedding-3-small' }] });
  };

  async request(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.calls.push(request);
    return new URL(request.url).hostname === 'openrouter.ai' ? await this.openRouter(request) : await this.vendor(request);
  }

  count(host: string): number {
    return this.calls.filter((call) => new URL(call.url).hostname === host).length;
  }
}

describe('ModelCatalogService', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'model-catalog-'));
    const store = new StateStore(join(directory, 'state.sqlite'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    cleanups.push(() => store.close());
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const repo = new ModelProfileStateRepository(store.database, keyring);
    const p1 = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-1' });
    const p2 = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-2' });
    const http = new FakeProviders();
    const clock = { now: 1_800_000_000_000 };
    const service = (client: ProviderHttpClient = http) => new ModelCatalogService({ database: store.database, credentials: repo, http: client, now: () => clock.now });
    return { store, repo, p1, p2, http, clock, service };
  }

  const search = (overrides: Partial<ModelCatalogSearchInput> & Pick<ModelCatalogSearchInput, 'provider'>) =>
    ModelCatalogSearchInputSchema.parse(overrides);

  it('serves OpenRouter models with exact OpenRouter prices and no credential', async () => {
    const { p1, http, service } = setup();
    const result = await service().search(p1, search({ provider: 'openrouter', limit: 100 }));
    expect(ModelCatalogSearchResultSchema.parse(result)).toEqual(result);
    const claude = result.entries.find((entry) => entry.providerModelId === 'anthropic/claude-sonnet-4.5');
    expect(claude).toMatchObject({
      provider: 'openrouter', canonicalModelId: 'anthropic/claude-sonnet-4.5', contextWindow: 1_000_000, maxOutputTokens: 64_000,
      capabilities: { tools: 'reported', reasoning: 'reported', vision: 'reported' }, availability: 'public_catalog',
      pricing: {
        inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000,
        cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 6_000_000, hasConditionalPricing: false,
        tiers: [CLAUDE_LONG_PROMPT_TIER],
        provenance: { source: 'openrouter', sourceModelId: 'anthropic/claude-sonnet-4.5', confidence: 'exact' }
      }
    });
    expect(result.freshness).toMatchObject({ state: 'fresh', sources: [{ source: 'openrouter', state: 'fresh', error: null }] });
    expect(http.calls.every((call) => !call.headers || Object.keys(call.headers).length === 0)).toBe(true);
  });

  it('merges a credential listing with OpenRouter metadata without sending OpenRouter IDs to the vendor', async () => {
    const { repo, p1, http, service } = setup();
    const credential = repo.createCredential(p1, { label: 'Anthropic', provider: 'anthropic', authMode: 'x-api-key', apiKey: 'sk-ant-secret-value' });
    const result = await service().search(p1, search({ provider: 'anthropic', credentialId: credential.id }));
    expect(result.entries).toEqual([{
      provider: 'anthropic',
      providerModelId: 'claude-sonnet-4-5-20250929',
      canonicalModelId: 'anthropic/claude-sonnet-4.5',
      displayName: 'Claude Sonnet 4.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: 'reported', reasoning: 'reported', vision: 'reported' },
      pricing: {
        inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000,
        cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 6_000_000,
        provenance: { source: 'openrouter', sourceModelId: 'anthropic/claude-sonnet-4.5', retrievedAt: 1_800_000_000_000, confidence: 'estimate' },
        tiers: [CLAUDE_LONG_PROMPT_TIER],
        hasConditionalPricing: false
      },
      availability: 'listed_for_credential',
      expiresAt: null
    }]);
    const vendorCalls = http.calls.filter((call) => new URL(call.url).hostname === 'api.anthropic.com');
    expect(vendorCalls).toHaveLength(1);
    expect(vendorCalls[0]?.headers?.['x-api-key']).toBe('sk-ant-secret-value');
    expect(vendorCalls.some((call) => call.url.includes('anthropic%2F') || call.url.includes('anthropic/'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sk-ant-secret-value');
  });

  it('sends an Anthropic credential with the auth header it was stored with', async () => {
    const { repo, p1, http, service } = setup();
    const credential = repo.createCredential(p1, { label: 'Anthropic', provider: 'anthropic', authMode: 'bearer', apiKey: 'sk-ant-bearer-value' });
    const result = await service().search(p1, search({ provider: 'anthropic', credentialId: credential.id }));
    expect(result.entries.map((entry) => entry.availability)).toEqual(['listed_for_credential']);
    const vendorCalls = http.calls.filter((call) => new URL(call.url).hostname === 'api.anthropic.com');
    expect(vendorCalls.map((call) => call.headers)).toEqual([{ authorization: 'Bearer sk-ant-bearer-value', 'anthropic-version': '2023-06-01' }]);
  });

  it('keeps unmatched vendor models with unknown price and capability, and never guesses an absent capability', async () => {
    const { repo, p1, service } = setup();
    const credential = repo.createCredential(p1, { label: 'DeepSeek', provider: 'deepseek', apiKey: 'sk-deepseek-secret' });
    const result = await service().search(p1, search({ provider: 'deepseek', credentialId: credential.id }));
    const [chat, reasoner] = result.entries;
    expect(chat).toMatchObject({
      providerModelId: 'deepseek-chat', canonicalModelId: 'deepseek/deepseek-chat',
      // OpenRouter lists tools but not reasoning; for a direct vendor that is not proof of absence.
      capabilities: { tools: 'reported', reasoning: 'unknown', vision: 'unknown' },
      pricing: { inputMicrosPerMillionTokens: 320_000, provenance: { confidence: 'estimate' } }
    });
    expect(reasoner).toMatchObject({
      providerModelId: 'deepseek-reasoner', canonicalModelId: null, displayName: 'deepseek-reasoner',
      capabilities: { tools: 'unknown', reasoning: 'unknown', vision: 'unknown' },
      pricing: { inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null, provenance: { source: 'none', sourceModelId: null, confidence: 'unknown' } }
    });
  });

  it('falls back to public vendor entries without a credential, excluding OpenRouter-only variants', async () => {
    const { p1, http, service } = setup();
    const result = await service().search(p1, search({ provider: 'openai' }));
    expect(result.entries.map((entry) => entry.providerModelId)).toEqual(['gpt-4o-mini', 'o3']);
    expect(result.entries.every((entry) => entry.availability === 'public_catalog' && !entry.providerModelId.includes('/'))).toBe(true);
    expect(result.entries[0]?.canonicalModelId).toBe('openai/gpt-4o-mini');
    expect(http.count('api.openai.com')).toBe(0);
    expect(result.freshness.sources.map((source) => source.source)).toEqual(['openrouter']);
  });

  it('falls back to public entries and reports the category when the listing fails', async () => {
    const { repo, p1, http, service } = setup();
    http.vendor = () => json({ error: { message: 'bad key sk-openai-secret' } }, 401);
    const credential = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-secret' });
    const result = await service().search(p1, search({ provider: 'openai', credentialId: credential.id }));
    expect(result.entries.every((entry) => entry.availability === 'public_catalog')).toBe(true);
    expect(result.freshness).toMatchObject({
      state: 'stale',
      sources: [{ source: 'provider', state: 'unavailable', error: 'authentication' }, { source: 'openrouter', state: 'fresh' }]
    });
    expect(JSON.stringify(result)).not.toContain('sk-openai-secret');
  });

  it('returns an empty, unavailable catalog for a custom provider without any request', async () => {
    const { p1, http, service } = setup();
    const result = await service().search(p1, search({ provider: 'custom' }));
    expect(result).toEqual({ entries: [], nextCursor: null, freshness: { state: 'unavailable', fetchedAt: null, sources: [] } });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects another principal\'s credential and a credential for a different provider', async () => {
    const { repo, p1, p2, http, service } = setup();
    const credential = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-secret' });
    await expect(service().search(p2, search({ provider: 'openai', credentialId: credential.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service().search(p1, search({ provider: 'anthropic', credentialId: credential.id }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(http.calls).toHaveLength(0);
  });

  it('caches each source for its own TTL', async () => {
    const { repo, p1, http, clock, service } = setup();
    const credential = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-secret' });
    const catalog = service();
    const input = search({ provider: 'openai', credentialId: credential.id });
    await catalog.search(p1, input);
    await catalog.search(p1, input);
    expect([http.count('api.openai.com'), http.count('openrouter.ai')]).toEqual([1, 1]);
    clock.now += PROVIDER_CATALOG_TTL_MS;
    await catalog.search(p1, input);
    expect([http.count('api.openai.com'), http.count('openrouter.ai')]).toEqual([2, 1]);
    clock.now += OPENROUTER_CATALOG_TTL_MS;
    await catalog.search(p1, input);
    expect([http.count('api.openai.com'), http.count('openrouter.ai')]).toEqual([3, 2]);
  });

  it('serves the last-good snapshot as stale on failure and backs off before retrying', async () => {
    const { p1, http, clock, service } = setup();
    const catalog = service();
    const first = await catalog.search(p1, search({ provider: 'openrouter' }));
    clock.now += OPENROUTER_CATALOG_TTL_MS + 1;
    http.openRouter = () => json({}, 503);
    const stale = await catalog.search(p1, search({ provider: 'openrouter' }));
    expect(stale.entries).toEqual(first.entries);
    expect(stale.freshness).toMatchObject({ state: 'stale', fetchedAt: 1_800_000_000_000, sources: [{ state: 'stale', error: 'upstream_error' }] });
    await catalog.search(p1, search({ provider: 'openrouter' }));
    expect(http.count('openrouter.ai')).toBe(2);
    clock.now += CATALOG_FAILURE_BACKOFF_MS;
    await catalog.search(p1, search({ provider: 'openrouter' }));
    expect(http.count('openrouter.ai')).toBe(3);
  });

  it('reports unavailable when nothing was ever cached', async () => {
    const { p1, http, service } = setup();
    http.openRouter = () => json({}, 500);
    const result = await service().search(p1, search({ provider: 'openrouter' }));
    expect(result.entries).toEqual([]);
    expect(result.freshness).toEqual({ state: 'unavailable', fetchedAt: null, sources: [{ source: 'openrouter', state: 'unavailable', fetchedAt: null, error: 'upstream_error' }] });
  });

  it('persists last-good snapshots across a restart', async () => {
    const { repo, p1, http, clock, service } = setup();
    const credential = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-secret' });
    const input = search({ provider: 'openai', credentialId: credential.id });
    const first = await service().search(p1, input);
    expect(http.calls).toHaveLength(2);

    const restarted = await service().search(p1, input);
    expect(restarted).toEqual(first);
    expect(http.calls).toHaveLength(2);

    const failing: ProviderHttpClient = { request: async () => json({}, 502) };
    clock.now += OPENROUTER_CATALOG_TTL_MS + 1;
    const stale = await service(failing).search(p1, input);
    expect(stale.entries.map((entry) => entry.providerModelId)).toEqual(first.entries.map((entry) => entry.providerModelId));
    expect(stale.freshness.state).toBe('stale');
    expect(stale.freshness.sources.map((source) => [source.source, source.state])).toEqual([['provider', 'stale'], ['openrouter', 'stale']]);
  });

  it('shares one outbound request among concurrent searches', async () => {
    const { p1, http, service } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    http.openRouter = async () => { await gate; return json(openRouterPayload); };
    const catalog = service();
    const pending = Promise.all([1, 2, 3].map(() => catalog.search(p1, search({ provider: 'openrouter' }))));
    release();
    const results = await pending;
    expect(http.count('openrouter.ai')).toBe(1);
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  });

  it('never shares a credential listing across principals and refetches after rotation', async () => {
    const { store, repo, p1, p2, http, service } = setup();
    http.vendor = (request) => json({ data: [{ id: request.headers?.authorization === 'Bearer sk-one' ? 'model-for-one' : 'model-for-two' }] });
    const one = repo.createCredential(p1, { label: 'One', provider: 'openai', apiKey: 'sk-one' });
    const two = repo.createCredential(p2, { label: 'Two', provider: 'openai', apiKey: 'sk-two' });
    const catalog = service();
    const first = await catalog.search(p1, search({ provider: 'openai', credentialId: one.id }));
    const second = await catalog.search(p2, search({ provider: 'openai', credentialId: two.id }));
    expect(first.entries.map((entry) => entry.providerModelId)).toEqual(['model-for-one']);
    expect(second.entries.map((entry) => entry.providerModelId)).toEqual(['model-for-two']);
    const rows = store.database.prepare("SELECT principal_id, credential_id FROM model_catalog_snapshots WHERE source = 'provider' ORDER BY principal_id").all();
    expect(rows).toEqual(expect.arrayContaining([{ principal_id: p1, credential_id: one.id }, { principal_id: p2, credential_id: two.id }]));

    repo.rotateCredential(p1, one.id, { apiKey: 'sk-rotated', expectedGeneration: 1 });
    const rotated = await catalog.search(p1, search({ provider: 'openai', credentialId: one.id }));
    expect(rotated.entries.map((entry) => entry.providerModelId)).toEqual(['model-for-two']);
    expect(http.count('api.openai.com')).toBe(3);
  });

  it('removes a credential\'s snapshot when the credential is deleted', async () => {
    const { store, repo, p1, service } = setup();
    const credential = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-secret' });
    await service().search(p1, search({ provider: 'openai', credentialId: credential.id }));
    const count = () => (store.database.prepare('SELECT count(*) AS count FROM model_catalog_snapshots WHERE credential_id = ?').get(credential.id) as { count: number }).count;
    expect(count()).toBe(1);
    repo.deleteCredential(p1, credential.id, 1);
    expect(count()).toBe(0);
    expect((store.database.prepare("SELECT count(*) AS count FROM model_catalog_snapshots WHERE source = 'openrouter'").get() as { count: number }).count).toBe(1);
  });

  it('searches, filters, and paginates deterministically with an opaque cursor', async () => {
    const { p1, service } = setup();
    const catalog = service();
    const page1 = await catalog.search(p1, search({ provider: 'openrouter', limit: 2 }));
    expect(page1.entries.map((entry) => entry.providerModelId)).toEqual(['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat']);
    expect(page1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const page2 = await catalog.search(p1, search({ provider: 'openrouter', limit: 2, cursor: page1.nextCursor ?? undefined }));
    expect(page2.entries.map((entry) => entry.providerModelId)).toEqual(['google/gemini-2.5-pro', 'openai/gpt-4o-mini']);
    const page3 = await catalog.search(p1, search({ provider: 'openrouter', limit: 2, cursor: page2.nextCursor ?? undefined }));
    expect(page3.entries.map((entry) => entry.providerModelId)).toEqual(['openai/gpt-4o-mini:free', 'openai/o3']);
    expect(page3.nextCursor).toBeNull();

    const queried = await catalog.search(p1, search({ provider: 'openrouter', query: 'SONNET' }));
    expect(queried.entries.map((entry) => entry.providerModelId)).toEqual(['anthropic/claude-sonnet-4.5']);
    const reasoning = await catalog.search(p1, search({ provider: 'openrouter', capability: 'reasoning' }));
    expect(reasoning.entries.map((entry) => entry.providerModelId)).toEqual(['anthropic/claude-sonnet-4.5', 'openai/o3']);

    await expect(catalog.search(p1, search({ provider: 'openrouter', cursor: 'not-a-cursor' }))).rejects.toBeInstanceOf(HarnessError);
  });

  it('refreshes past the TTL but limits refreshes per principal and source', async () => {
    const { p1, p2, http, clock, service } = setup();
    const catalog = service();
    await catalog.search(p1, search({ provider: 'openrouter' }));
    const refreshed = await catalog.refresh(p1, { provider: 'openrouter' });
    expect(refreshed).toMatchObject({ entryCount: 6, freshness: { state: 'fresh' } });
    expect(http.count('openrouter.ai')).toBe(2);
    await expect(catalog.refresh(p1, { provider: 'openrouter' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // Another principal may refresh, but the shared public source is not forced again within the window.
    await expect(catalog.refresh(p2, { provider: 'openrouter' })).resolves.toMatchObject({ entryCount: 6 });
    expect(http.count('openrouter.ai')).toBe(2);
    clock.now += CATALOG_REFRESH_INTERVAL_MS;
    await catalog.refresh(p1, { provider: 'openrouter' });
    expect(http.count('openrouter.ai')).toBe(3);
  });

  it('forces each credential listing but not the shared OpenRouter source when credentials are cycled', async () => {
    const { repo, p1, http, service } = setup();
    const catalog = service();
    const credentials = ['One', 'Two', 'Three'].map((label) => repo.createCredential(p1, { label, provider: 'openai', apiKey: `sk-${label.toLowerCase()}` }));
    for (const credential of credentials) await catalog.search(p1, search({ provider: 'openai', credentialId: credential.id }));
    expect([http.count('api.openai.com'), http.count('openrouter.ai')]).toEqual([3, 1]);
    for (const credential of credentials) await catalog.refresh(p1, { provider: 'openai', credentialId: credential.id });
    expect([http.count('api.openai.com'), http.count('openrouter.ai')]).toEqual([6, 2]);
  });

  it('keeps catalog tiers only when a revision for the provider may save all of them', async () => {
    const { repo, p1, http, service } = setup();
    // An unpublished base cache-write price resolves to twice the input price where
    // cache writes are billed (OpenRouter) and to the input price elsewhere (OpenAI).
    const tiered = { id: 'openai/tiered', name: 'Tiered', pricing: {
      prompt: '0.000002', completion: '0.000004',
      overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000003', completion: '0.000004', input_cache_write: '0.0000035' }]
    } };
    const cheaper = { id: 'openai/cheaper', name: 'Cheaper', pricing: {
      prompt: '0.000002', completion: '0.000004',
      overrides: [
        { min_prompt_tokens: 100_000, prompt: '0.000001', completion: '0.000004' },
        { min_prompt_tokens: 300_000, prompt: '0.000003', completion: '0.000005' }
      ]
    } };
    http.openRouter = () => json({ data: [tiered, cheaper] });
    const viaOpenRouter = await service().search(p1, search({ provider: 'openrouter', limit: 100 }));
    expect(viaOpenRouter.entries.find((entry) => entry.providerModelId === 'openai/tiered')?.pricing).toMatchObject({ hasConditionalPricing: true });
    expect(viaOpenRouter.entries.find((entry) => entry.providerModelId === 'openai/tiered')?.pricing).not.toHaveProperty('tiers');

    const direct = await service().search(p1, search({ provider: 'openai', limit: 100 }));
    const tieredEntry = direct.entries.find((entry) => entry.providerModelId === 'tiered');
    expect(tieredEntry?.pricing).toMatchObject({
      hasConditionalPricing: false,
      tiers: [{ minPromptTokens: 100_000, inputMicrosPerMillionTokens: 3_000_000, cacheWriteMicrosPerMillionTokens: 3_500_000 }]
    });
    // A tier cheaper than the base drops every tier, never leaving a partial set.
    const cheaperEntry = direct.entries.find((entry) => entry.providerModelId === 'cheaper');
    expect(cheaperEntry?.pricing).toMatchObject({ hasConditionalPricing: true });
    expect(cheaperEntry?.pricing).not.toHaveProperty('tiers');

    const credential = repo.createCredential(p1, { label: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-secret' });
    for (const entry of [tieredEntry, cheaperEntry]) {
      const pricing = entry!.pricing;
      expect(() => repo.createProfile(p1, {
        profileId: `catalog-${entry!.providerModelId}`, displayName: 'Catalog tiers', credentialId: credential.id, model: entry!.providerModelId,
        apiMode: 'chat-completions',
        pricing: {
          inputMicrosPerMillionTokens: pricing.inputMicrosPerMillionTokens!, outputMicrosPerMillionTokens: pricing.outputMicrosPerMillionTokens!,
          cacheReadMicrosPerMillionTokens: pricing.cacheReadMicrosPerMillionTokens ?? null,
          cacheWriteMicrosPerMillionTokens: pricing.cacheWriteMicrosPerMillionTokens ?? null,
          ...(pricing.tiers ? { tiers: pricing.tiers } : {})
        },
        limits: { maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostMicros: 1_000_000 },
        maxProxyOperations: ['files_read']
      })).not.toThrow();
    }
  });

  it('reads a cached price without any network call, before and after the cache expires', async () => {
    const { p1, http, clock, service } = setup();
    const cold = service();
    expect(cold.cachedPrice('openrouter', 'anthropic/claude-sonnet-4.5')).toBeUndefined();
    expect(http.calls).toHaveLength(0);

    await cold.search(p1, search({ provider: 'openrouter' }));
    const calls = http.calls.length;
    clock.now += OPENROUTER_CATALOG_TTL_MS * 2;
    // A fresh service (a runner restart) peeks at the persisted last-good snapshot.
    const restarted = service();
    expect(restarted.cachedPrice('openrouter', 'anthropic/claude-sonnet-4.5')?.inputMicrosPerMillionTokens).toBe(3_000_000);
    expect(cold.cachedPrice('openrouter', 'anthropic/claude-sonnet-4.5')?.inputMicrosPerMillionTokens).toBe(3_000_000);
    expect(http.calls).toHaveLength(calls);
  });

  it('resolves a cached price only from the model a revision routes to', async () => {
    const { p1, service } = setup();
    const catalog = service();
    await catalog.search(p1, search({ provider: 'openrouter' }));
    const fetchedAt = 1_800_000_000_000;

    expect(catalog.cachedPrice('openrouter', 'anthropic/claude-sonnet-4.5')?.provenance)
      .toEqual({ source: 'openrouter', sourceModelId: 'anthropic/claude-sonnet-4.5', retrievedAt: fetchedAt, confidence: 'exact' });
    // A direct vendor's model matches as the search does, dated snapshot suffix included.
    expect(catalog.cachedPrice('anthropic', 'claude-sonnet-4-5-20250929')).toMatchObject({
      inputMicrosPerMillionTokens: 3_000_000, tiers: [CLAUDE_LONG_PROMPT_TIER],
      provenance: { sourceModelId: 'anthropic/claude-sonnet-4.5', confidence: 'estimate' }
    });
    // A vendor never matches another vendor's model or an OpenRouter-only variant.
    expect(catalog.cachedPrice('anthropic', 'gpt-4o-mini')).toBeUndefined();
    expect(catalog.cachedPrice('openai', 'gpt-4o-mini:free')).toBeUndefined();
    expect(catalog.cachedPrice('openrouter', 'vendor/missing')).toBeUndefined();
    expect(catalog.cachedPrice('custom', 'anything')).toBeUndefined();

    const lookup = catalog.cachedPrices();
    expect(lookup('openrouter', 'anthropic/claude-sonnet-4.5')).toEqual(catalog.cachedPrice('openrouter', 'anthropic/claude-sonnet-4.5'));
  });

  it('treats a persisted snapshot without tiers as absent', async () => {
    const { store, p1, service } = setup();
    await service().search(p1, search({ provider: 'openrouter' }));
    const row = store.database.prepare("SELECT entries_json FROM model_catalog_snapshots WHERE cache_key = 'openrouter:public'").get() as { entries_json: string };
    const legacy = (JSON.parse(row.entries_json) as Array<Record<string, unknown>>).map((model) => Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'tiers')));
    store.database.prepare("UPDATE model_catalog_snapshots SET entries_json = ? WHERE cache_key = 'openrouter:public'").run(JSON.stringify(legacy));
    expect(service().cachedPrice('openrouter', 'anthropic/claude-sonnet-4.5')).toBeUndefined();
  });
});

describe('SourceCache', () => {
  const clock = { now: 1_800_000_000_000 };
  const request = (overrides: Partial<SourceRequest<string>>): SourceRequest<string> => ({
    source: 'provider', key: 'p\u0000c\u00001', ttlMs: 1_000, force: false,
    load: () => undefined, fetch: async () => ['model'], save: () => undefined,
    ...overrides
  });

  it('peeks at the memory or persisted snapshot and never fetches', async () => {
    const cache = new SourceCache<string>(() => clock.now);
    let fetches = 0;
    const counting = (overrides: Partial<SourceRequest<string>>) => request({ fetch: async () => { fetches += 1; return ['fetched']; }, ...overrides });
    expect(cache.peek(counting({}))).toBeUndefined();
    expect(cache.peek(counting({ key: 'persisted', load: () => ({ entries: ['stored'], fetchedAt: 1 }) }))?.entries).toEqual(['stored']);
    await cache.get(counting({}));
    expect(fetches).toBe(1);
    clock.now += 10_000;
    expect(cache.peek(counting({}))?.entries).toEqual(['fetched']);
    expect(fetches).toBe(1);
  });

  it('reads a missing or rejected persisted snapshot once until a fetch succeeds', async () => {
    const cache = new SourceCache<string>(() => clock.now);
    let loads = 0;
    const counted = request({ key: 'rejected', load: () => { loads += 1; return undefined; } });
    for (let index = 0; index < 5; index += 1) expect(cache.peek(counted)).toBeUndefined();
    expect(loads).toBe(1);
    await cache.get(counted);
    expect(loads).toBe(1);
    expect(cache.peek(counted)?.entries).toEqual(['model']);
    // Evicting the key forgets the miss, so a later lookup reads the store again.
    cache.evict('rejected');
    cache.peek(counted);
    expect(loads).toBe(2);
  });

  it('retries after a fetch that fails synchronously instead of pinning the failure as in flight', async () => {
    const cache = new SourceCache<string>(() => clock.now);
    const failed = await cache.get(request({ fetch: () => { throw new CatalogSourceError('network'); } }));
    expect(failed.status).toMatchObject({ state: 'unavailable', error: 'network' });
    clock.now += CATALOG_FAILURE_BACKOFF_MS;
    const recovered = await cache.get(request({}));
    expect(recovered.status).toMatchObject({ state: 'fresh', error: null });
    expect(recovered.snapshot?.entries).toEqual(['model']);
  });

  it('evicts superseded versions of a listing and every entry under a removed prefix', async () => {
    const cache = new SourceCache<string>(() => clock.now);
    const family = 'p\u0000c\u0000';
    await cache.get(request({ key: `${family}1`, family }));
    await cache.get(request({ key: 'p\u0000other\u00001', family: 'p\u0000other\u0000' }));
    expect(cache.size).toBe(2);
    await cache.get(request({ key: `${family}2`, family }));
    expect(cache.size).toBe(2);
    cache.evict(family);
    expect(cache.size).toBe(1);
  });
});
