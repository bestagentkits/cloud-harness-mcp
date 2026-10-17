import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessError, ModelCatalogSearchInputSchema, ModelCatalogSearchResultSchema, type ModelCatalogSearchInput } from '@cloud-harness/contracts';
import {
  CATALOG_FAILURE_BACKOFF_MS, CATALOG_REFRESH_INTERVAL_MS, ModelCatalogService, OPENROUTER_CATALOG_TTL_MS, PROVIDER_CATALOG_TTL_MS
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
        cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 3_750_000, hasConditionalPricing: true,
        provenance: { source: 'openrouter', sourceModelId: 'anthropic/claude-sonnet-4.5', confidence: 'exact' }
      }
    });
    expect(result.freshness).toMatchObject({ state: 'fresh', sources: [{ source: 'openrouter', state: 'fresh', error: null }] });
    expect(http.calls.every((call) => !call.headers || Object.keys(call.headers).length === 0)).toBe(true);
  });

  it('merges a credential listing with OpenRouter metadata without sending OpenRouter IDs to the vendor', async () => {
    const { repo, p1, http, service } = setup();
    const credential = repo.createCredential(p1, { label: 'Anthropic', provider: 'anthropic', apiKey: 'sk-ant-secret-value' });
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
        cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 3_750_000,
        provenance: { source: 'openrouter', sourceModelId: 'anthropic/claude-sonnet-4.5', retrievedAt: 1_800_000_000_000, confidence: 'estimate' },
        hasConditionalPricing: true
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
      pricing: { inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null, provenance: { source: 'provider', sourceModelId: null, confidence: 'unknown' } }
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
    await catalog.refresh(p2, { provider: 'openrouter' });
    expect(http.count('openrouter.ai')).toBe(3);
    clock.now += CATALOG_REFRESH_INTERVAL_MS;
    await catalog.refresh(p1, { provider: 'openrouter' });
    expect(http.count('openrouter.ai')).toBe(4);
  });
});
