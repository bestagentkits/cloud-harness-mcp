import type { DatabaseSync } from 'node:sqlite';
import {
  HarnessError, findResolvedPriceTierIssues, getModelProvider,
  type ModelCatalogCapabilities, type ModelCatalogEntry, type ModelCatalogFreshness, type ModelCatalogPrice,
  type ModelCatalogPriceConfidence, type ModelCatalogRefreshInput, type ModelCatalogRefreshResult,
  type ModelCatalogSearchInput, type ModelCatalogSearchResult, type ModelCatalogSourceError,
  type ModelCatalogSourceKind, type ModelCatalogSourceStatus, type ModelPriceTier, type ModelProviderKind,
  type ProviderCredentialMetadata
} from '@cloud-harness/contracts';
import type { ProviderHttpClient } from '../model-provider-http.js';
import { CatalogSourceError } from './catalog-source.js';
import { CatalogSnapshotStore, type CatalogSnapshot } from './catalog-snapshot-store.js';
import { fetchOpenRouterModels, type OpenRouterModel } from './openrouter-catalog.js';
import { fetchProviderModels, type ProviderListedModel } from './provider-catalog.js';

/** The credential access the catalog needs; `ModelProfileStateRepository` provides it. */
export interface CatalogCredentialReader {
  getCredential(principalId: string, credentialId: string): ProviderCredentialMetadata | undefined;
  decryptCredentialSecret(principalId: string, credentialId: string): { activeVersion: number; secret: string };
}

export interface ModelCatalogServiceOptions {
  database: DatabaseSync;
  credentials: CatalogCredentialReader;
  http: ProviderHttpClient;
  now?: () => number;
}

// Public metadata is shared by every principal and changes slowly; a credential's
// listing is private to its principal and refreshed more often.
export const OPENROUTER_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const PROVIDER_CATALOG_TTL_MS = 60 * 60 * 1000;
// After a failed fetch, searches serve the last-good snapshot for this long instead of retrying each time.
export const CATALOG_FAILURE_BACKOFF_MS = 60 * 1000;
export const CATALOG_REFRESH_INTERVAL_MS = 30 * 1000;
const MAX_CURSOR_OFFSET = 100_000;

export interface SourceResult<T> {
  snapshot: CatalogSnapshot<T> | undefined;
  status: ModelCatalogSourceStatus;
}

export interface SourceRequest<T> {
  source: ModelCatalogSourceKind;
  key: string;
  // Keys sharing this prefix describe superseded versions of the same listing
  // (an older credential key version) and are evicted once this key is stored.
  family?: string;
  ttlMs: number;
  force: boolean;
  load: () => CatalogSnapshot<T> | undefined;
  fetch: () => Promise<T[]>;
  save: (snapshot: CatalogSnapshot<T>) => void;
}

/**
 * TTL cache over one catalog source with a persisted last-good snapshot, a failure
 * backoff, and single-flight fetches: concurrent searches for the same key share
 * one outbound request.
 */
export class SourceCache<T> {
  private readonly memory = new Map<string, CatalogSnapshot<T>>();
  private readonly failures = new Map<string, { error: ModelCatalogSourceError; at: number }>();
  private readonly inflight = new Map<string, Promise<SourceResult<T>>>();
  // Keys whose persisted snapshot was absent or no longer parsed. The row is not
  // read again until a fetch succeeds, so a large rejected snapshot is not re-parsed
  // on every lookup.
  private readonly missingLoads = new Set<string>();

  constructor(private readonly now: () => number) {}

  /** Number of keys holding a snapshot or a failure in memory. */
  get size(): number {
    return new Set([...this.memory.keys(), ...this.failures.keys()]).size;
  }

  async get(request: SourceRequest<T>): Promise<SourceResult<T>> {
    const snapshot = this.cached(request);
    const now = this.now();
    if (!request.force && snapshot && now - snapshot.fetchedAt < request.ttlMs) return this.result(request.source, snapshot, null);
    const failure = this.failures.get(request.key);
    if (!request.force && failure && now - failure.at < CATALOG_FAILURE_BACKOFF_MS) {
      return this.result(request.source, snapshot, failure.error);
    }
    const pending = this.inflight.get(request.key) ?? this.start(request);
    return await pending;
  }

  /** The in-memory or persisted last-good snapshot, whatever its age. Never fetches. */
  peek(request: Pick<SourceRequest<T>, 'key' | 'load'>): CatalogSnapshot<T> | undefined {
    return this.cached(request);
  }

  /** Drops every in-memory entry whose key starts with `prefix`. */
  evict(prefix: string, keep?: string): void {
    for (const map of [this.memory, this.failures]) {
      for (const key of map.keys()) if (key.startsWith(prefix) && key !== keep) map.delete(key);
    }
    for (const key of this.missingLoads) if (key.startsWith(prefix) && key !== keep) this.missingLoads.delete(key);
  }

  private cached(request: Pick<SourceRequest<T>, 'key' | 'load'>): CatalogSnapshot<T> | undefined {
    let snapshot = this.memory.get(request.key);
    if (!snapshot && !this.missingLoads.has(request.key)) {
      snapshot = request.load();
      if (snapshot) this.memory.set(request.key, snapshot);
      else this.missingLoads.add(request.key);
    }
    return snapshot;
  }

  private start(request: SourceRequest<T>): Promise<SourceResult<T>> {
    // The fetch runs on a later microtask, so the promise is registered before any
    // of its work starts, and cleanup removes only this promise. A fetch that fails
    // synchronously therefore cannot leave a settled failure pinned as in flight.
    const pending = Promise.resolve().then(() => this.run(request));
    this.inflight.set(request.key, pending);
    const release = () => {
      if (this.inflight.get(request.key) === pending) this.inflight.delete(request.key);
    };
    pending.then(release, release);
    return pending;
  }

  private async run(request: SourceRequest<T>): Promise<SourceResult<T>> {
    try {
      const snapshot: CatalogSnapshot<T> = { entries: await request.fetch(), fetchedAt: this.now() };
      this.memory.set(request.key, snapshot);
      this.failures.delete(request.key);
      this.missingLoads.delete(request.key);
      if (request.family) this.evict(request.family, request.key);
      try {
        request.save(snapshot);
      } catch {
        // The snapshot stays served from memory; a persistence failure (such as the
        // credential being deleted mid-fetch) only costs the restart fallback.
      }
      return this.result(request.source, snapshot, null);
    } catch (error) {
      const category = error instanceof CatalogSourceError ? error.category : 'network';
      this.failures.set(request.key, { error: category, at: this.now() });
      return this.result(request.source, this.memory.get(request.key), category);
    }
  }

  private result(source: ModelCatalogSourceKind, snapshot: CatalogSnapshot<T> | undefined, error: ModelCatalogSourceError | null): SourceResult<T> {
    const state = snapshot ? (error ? 'stale' : 'fresh') : 'unavailable';
    return { snapshot, status: { source, state, fetchedAt: snapshot?.fetchedAt ?? null, error } };
  }
}

const unknownCapabilities: ModelCatalogCapabilities = { tools: 'unknown', reasoning: 'unknown', vision: 'unknown' };

/**
 * The model's tiers when a saved revision for `provider` may carry all of them:
 * ascending, and no resolved price below the level beneath it. If any tier breaks
 * those rules, no tier is used and the price is reported as conditional: a partial
 * set would misprice the prompts between the tiers kept. A client that saves
 * catalog tiers unchanged therefore never sends pricing the runner or the gateway
 * refuses.
 */
function acceptedTiers(model: OpenRouterModel, provider: ModelProviderKind): { tiers: ModelPriceTier[]; dropped: boolean } {
  const { input, output, cacheRead, cacheWrite } = model.prices;
  if (input === null || output === null) return { tiers: [], dropped: model.tiers.length > 0 };
  const base = {
    inputMicrosPerMillionTokens: input, outputMicrosPerMillionTokens: output,
    cacheReadMicrosPerMillionTokens: cacheRead, cacheWriteMicrosPerMillionTokens: cacheWrite
  };
  const tiers: ModelPriceTier[] = model.tiers;
  const ascending = tiers.every((tier, index) => index === 0 || tier.minPromptTokens > tiers[index - 1]!.minPromptTokens);
  if (ascending && findResolvedPriceTierIssues({ ...base, tiers }, provider).length === 0) return { tiers, dropped: false };
  return { tiers: [], dropped: tiers.length > 0 };
}

function price(
  model: OpenRouterModel | undefined,
  provider: ModelProviderKind,
  confidence: ModelCatalogPriceConfidence,
  retrievedAt: number | null
): ModelCatalogPrice {
  if (!model) {
    return {
      inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null,
      cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: null,
      provenance: { source: 'none', sourceModelId: null, retrievedAt: null, confidence: 'unknown' },
      hasConditionalPricing: false
    };
  }
  const known = model.prices.input !== null || model.prices.output !== null;
  const { tiers, dropped } = acceptedTiers(model, provider);
  return {
    inputMicrosPerMillionTokens: model.prices.input,
    outputMicrosPerMillionTokens: model.prices.output,
    cacheReadMicrosPerMillionTokens: model.prices.cacheRead,
    cacheWriteMicrosPerMillionTokens: model.prices.cacheWrite,
    provenance: { source: 'openrouter', sourceModelId: model.id, retrievedAt, confidence: known ? confidence : 'unknown' },
    ...(tiers.length > 0 ? { tiers } : {}),
    hasConditionalPricing: model.hasConditionalPricing || dropped
  };
}

// OpenRouter's parameter list describes OpenRouter's route, so for a direct vendor
// it can confirm a capability but cannot prove its absence.
function vendorCapabilities(model: OpenRouterModel | undefined): ModelCatalogCapabilities {
  if (!model) return unknownCapabilities;
  const confirm = (state: ModelCatalogCapabilities['tools']) => (state === 'reported' ? 'reported' : 'unknown');
  return { tools: confirm(model.capabilities.tools), reasoning: confirm(model.capabilities.reasoning), vision: confirm(model.capabilities.vision) };
}

/** `4.5` and `4-5` name the same version; nothing else is rewritten. */
function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/(?<=\d)\.(?=\d)/gu, '-');
}

/**
 * Finds OpenRouter metadata for a direct vendor's model ID: exact
 * `${vendor}/${id}`, then the version-separator normalization, then the same
 * with an Anthropic-style `-YYYYMMDD` snapshot suffix removed. An ambiguous
 * normalized match is no match, so metadata is never attached by guesswork.
 */
export class VendorModelIndex {
  private readonly exact = new Map<string, OpenRouterModel>();
  private readonly normalized = new Map<string, OpenRouterModel | null>();
  readonly models: OpenRouterModel[];

  constructor(vendor: string, models: readonly OpenRouterModel[]) {
    const prefix = `${vendor}/`;
    // Variant routes (`:free`, `:thinking`) are OpenRouter constructs that no vendor serves.
    this.models = models.filter((model) => model.id.startsWith(prefix) && model.id.length > prefix.length && !model.id.includes(':'));
    for (const model of this.models) {
      const bare = model.id.slice(prefix.length);
      this.exact.set(bare, model);
      const key = normalizeModelId(bare);
      this.normalized.set(key, this.normalized.has(key) ? null : model);
    }
  }

  match(providerModelId: string): OpenRouterModel | undefined {
    const exact = this.exact.get(providerModelId);
    if (exact) return exact;
    const normalized = normalizeModelId(providerModelId);
    const direct = this.normalized.get(normalized);
    if (direct !== undefined) return direct ?? undefined;
    const undated = normalized.replace(/-\d{8}$/u, '');
    return undated === normalized ? undefined : this.normalized.get(undated) ?? undefined;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(`catalog:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^catalog:(\d{1,6})$/u.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset > MAX_CURSOR_OFFSET) throw new HarnessError('INVALID_INPUT', 'invalid model catalog cursor', 400, false);
  return offset;
}

function compareEntries(left: ModelCatalogEntry, right: ModelCatalogEntry): number {
  const a = left.providerModelId.toLowerCase();
  const b = right.providerModelId.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left.providerModelId < right.providerModelId ? -1 : left.providerModelId > right.providerModelId ? 1 : 0;
}

function overallFreshness(sources: ModelCatalogSourceStatus[], hasCatalog: boolean): ModelCatalogFreshness {
  const contributing = sources.filter((source) => source.state !== 'unavailable');
  const fetched = contributing.map((source) => source.fetchedAt).filter((value): value is number => value !== null);
  const state = !hasCatalog || contributing.length === 0
    ? 'unavailable'
    : sources.every((source) => source.state === 'fresh') ? 'fresh' : 'stale';
  return { state, fetchedAt: fetched.length > 0 ? Math.min(...fetched) : null, sources };
}

/**
 * The model catalog: a provider's own listing for the selected credential (the
 * availability evidence) merged with OpenRouter's public metadata (names, limits,
 * capabilities, prices). Provider model IDs come only from the provider listing;
 * OpenRouter's `vendor/model` IDs are kept as `canonicalModelId` and never sent
 * to a direct vendor.
 */
export class ModelCatalogService {
  private readonly store: CatalogSnapshotStore;
  private readonly now: () => number;
  private readonly openRouterCache: SourceCache<OpenRouterModel>;
  private readonly providerCache: SourceCache<ProviderListedModel>;
  private readonly lastRefresh = new Map<string, number>();
  // OpenRouter is one source shared by every principal and credential, so its
  // forced fetches are limited on their own: cycling credentials (each with its
  // own refresh window) cannot force it more than once per interval.
  private lastOpenRouterForce: number | undefined;
  // Lookups built once per snapshot, so listing many profiles stays linear.
  private readonly modelsById = new WeakMap<CatalogSnapshot<OpenRouterModel>, Map<string, OpenRouterModel>>();
  private readonly vendorIndexes = new WeakMap<CatalogSnapshot<OpenRouterModel>, Map<string, VendorModelIndex>>();

  constructor(private readonly options: ModelCatalogServiceOptions) {
    this.store = new CatalogSnapshotStore(options.database);
    this.now = options.now ?? Date.now;
    this.openRouterCache = new SourceCache(this.now);
    this.providerCache = new SourceCache(this.now);
  }

  async search(principalId: string, input: ModelCatalogSearchInput): Promise<ModelCatalogSearchResult> {
    const credential = this.credentialFor(principalId, input.provider, input.credentialId);
    const offset = decodeCursor(input.cursor);
    const { entries, freshness } = await this.build(principalId, input.provider, credential, { provider: false, openRouter: false });
    const query = input.query?.toLowerCase();
    const matching = entries.filter((entry) =>
      (!input.capability || entry.capabilities[input.capability] === 'reported') &&
      (!query || entry.providerModelId.toLowerCase().includes(query) || entry.displayName.toLowerCase().includes(query) ||
        (entry.canonicalModelId?.toLowerCase().includes(query) ?? false))
    ).sort(compareEntries);
    const page = matching.slice(offset, offset + input.limit);
    const next = offset + page.length;
    return { entries: page, nextCursor: next < matching.length && page.length > 0 ? encodeCursor(next) : null, freshness };
  }

  /** Bypasses the TTL; limited per principal, provider, and credential so a client cannot hammer a provider. */
  async refresh(principalId: string, input: ModelCatalogRefreshInput): Promise<ModelCatalogRefreshResult> {
    const credential = this.credentialFor(principalId, input.provider, input.credentialId);
    const key = `${principalId}\u0000${input.provider}\u0000${input.credentialId ?? ''}`;
    const now = this.now();
    const last = this.lastRefresh.get(key);
    if (last !== undefined && now - last < CATALOG_REFRESH_INTERVAL_MS) {
      const seconds = Math.ceil((CATALOG_REFRESH_INTERVAL_MS - (now - last)) / 1000);
      throw new HarnessError('LIMIT_EXCEEDED', `The model catalog was refreshed recently. Try again in ${seconds} seconds.`, 429, true);
    }
    for (const [entry, at] of this.lastRefresh) if (now - at >= CATALOG_REFRESH_INTERVAL_MS) this.lastRefresh.delete(entry);
    this.lastRefresh.set(key, now);
    const forceOpenRouter = this.lastOpenRouterForce === undefined || now - this.lastOpenRouterForce >= CATALOG_REFRESH_INTERVAL_MS;
    if (forceOpenRouter) this.lastOpenRouterForce = now;
    const { entries, freshness } = await this.build(principalId, input.provider, credential, { provider: true, openRouter: forceOpenRouter });
    return { entryCount: entries.length, freshness };
  }

  /**
   * The cached catalog price of the model a revision routes to, from the last-good
   * OpenRouter snapshot in memory or in the state database. Never makes a network
   * call. An OpenRouter revision's model is the OpenRouter ID itself (confidence
   * `exact`); a direct vendor's model is matched as the catalog search matches it
   * (confidence `estimate`). A client's catalog reference never selects the price.
   */
  cachedPrice(provider: ModelProviderKind, model: string): ModelCatalogPrice | undefined {
    return this.cachedPrices()(provider, model);
  }

  /** A lookup over one peek at the snapshot, for pricing many revisions at once. */
  cachedPrices(): (provider: ModelProviderKind, model: string) => ModelCatalogPrice | undefined {
    const snapshot = this.openRouterCache.peek(this.openRouterRequest(false));
    return (provider, model) => {
      const definition = getModelProvider(provider);
      if (!snapshot || definition.catalogStrategy === 'none') return undefined;
      if (definition.catalogStrategy === 'openrouter') {
        let byId = this.modelsById.get(snapshot);
        if (!byId) {
          byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
          this.modelsById.set(snapshot, byId);
        }
        const metadata = byId.get(model);
        return metadata ? price(metadata, provider, 'exact', snapshot.fetchedAt) : undefined;
      }
      const vendor = definition.openRouterVendor ?? provider;
      let indexes = this.vendorIndexes.get(snapshot);
      if (!indexes) {
        indexes = new Map();
        this.vendorIndexes.set(snapshot, indexes);
      }
      let index = indexes.get(vendor);
      if (!index) {
        index = new VendorModelIndex(vendor, snapshot.entries);
        indexes.set(vendor, index);
      }
      const metadata = index.match(model);
      return metadata ? price(metadata, provider, 'estimate', snapshot.fetchedAt) : undefined;
    };
  }

  private credentialFor(principalId: string, provider: ModelProviderKind, credentialId: string | undefined): ProviderCredentialMetadata | undefined {
    if (credentialId === undefined) return undefined;
    const credential = this.options.credentials.getCredential(principalId, credentialId);
    if (!credential) {
      // A deleted credential's cached listings are dropped from memory; its persisted
      // snapshots are removed by the foreign-key cascade.
      this.providerCache.evict(`${principalId}\u0000${credentialId}\u0000`);
      throw new HarnessError('NOT_FOUND', 'model provider credential was not found', 404, false);
    }
    if (credential.provider !== provider) {
      throw new HarnessError('INVALID_INPUT', `the credential belongs to ${credential.provider}, not ${provider}`, 400, false);
    }
    return credential;
  }

  private async build(
    principalId: string,
    provider: ModelProviderKind,
    credential: ProviderCredentialMetadata | undefined,
    force: { provider: boolean; openRouter: boolean }
  ): Promise<{ entries: ModelCatalogEntry[]; freshness: ModelCatalogFreshness }> {
    const definition = getModelProvider(provider);
    if (definition.catalogStrategy === 'none') return { entries: [], freshness: overallFreshness([], false) };
    const listingRequest = definition.catalogStrategy === 'provider-models' && credential
      ? this.providerListing(principalId, provider, credential, force.provider)
      : Promise.resolve(undefined);
    const [openRouter, listing] = await Promise.all([this.openRouter(force.openRouter), listingRequest]);
    const openRouterModels = openRouter.snapshot?.entries ?? [];
    const openRouterFetchedAt = openRouter.snapshot?.fetchedAt ?? null;
    const sources = listing ? [listing.status, openRouter.status] : [openRouter.status];

    if (definition.catalogStrategy === 'openrouter') {
      const entries = openRouterModels.map((model): ModelCatalogEntry => ({
        provider,
        providerModelId: model.id,
        canonicalModelId: model.id,
        displayName: model.name ?? model.id,
        contextWindow: model.contextLength,
        maxOutputTokens: model.maxCompletionTokens,
        capabilities: model.capabilities,
        pricing: price(model, provider, 'exact', openRouterFetchedAt),
        availability: 'public_catalog',
        expiresAt: model.expiresAt
      }));
      return { entries, freshness: overallFreshness(sources, true) };
    }

    const index = new VendorModelIndex(definition.openRouterVendor ?? provider, openRouterModels);
    const listed = listing?.snapshot?.entries;
    const entries = listed
      ? listed.map((model): ModelCatalogEntry => {
        const metadata = index.match(model.id);
        return {
          provider,
          providerModelId: model.id,
          canonicalModelId: metadata?.id ?? null,
          displayName: model.displayName ?? metadata?.name ?? model.id,
          contextWindow: model.contextWindow ?? metadata?.contextLength ?? null,
          maxOutputTokens: model.maxOutputTokens ?? metadata?.maxCompletionTokens ?? null,
          capabilities: vendorCapabilities(metadata),
          pricing: price(metadata, provider, 'estimate', openRouterFetchedAt),
          availability: 'listed_for_credential',
          expiresAt: metadata?.expiresAt ?? null
        };
      })
      // Without a listing, OpenRouter's public entries for the vendor stand in. Their
      // provider IDs are OpenRouter's naming with the vendor prefix removed, and
      // `public_catalog` tells the caller to verify them before relying on them.
      : index.models.map((model): ModelCatalogEntry => ({
        provider,
        providerModelId: model.id.slice((definition.openRouterVendor ?? provider).length + 1),
        canonicalModelId: model.id,
        displayName: model.name ?? model.id,
        contextWindow: model.contextLength,
        maxOutputTokens: model.maxCompletionTokens,
        capabilities: vendorCapabilities(model),
        pricing: price(model, provider, 'estimate', openRouterFetchedAt),
        availability: 'public_catalog',
        expiresAt: model.expiresAt
      }));
    return { entries, freshness: overallFreshness(sources, true) };
  }

  private async openRouter(force: boolean): Promise<SourceResult<OpenRouterModel>> {
    return await this.openRouterCache.get(this.openRouterRequest(force));
  }

  private openRouterRequest(force: boolean): SourceRequest<OpenRouterModel> {
    return {
      source: 'openrouter',
      key: 'openrouter',
      ttlMs: OPENROUTER_CATALOG_TTL_MS,
      force,
      load: () => this.store.loadOpenRouter(),
      fetch: () => fetchOpenRouterModels(this.options.http),
      save: (snapshot) => this.store.saveOpenRouter(snapshot)
    };
  }

  /** Keyed by principal, credential, and active version, so a rotated key or another principal never reuses a listing. */
  private async providerListing(
    principalId: string,
    provider: ModelProviderKind,
    credential: ProviderCredentialMetadata,
    force: boolean
  ): Promise<SourceResult<ProviderListedModel>> {
    const version = credential.activeVersion;
    const unavailable = (): SourceResult<ProviderListedModel> => ({
      snapshot: undefined,
      status: { source: 'provider', state: 'unavailable', fetchedAt: null, error: 'credential_unavailable' }
    });
    if (credential.status !== 'ACTIVE') return unavailable();
    const family = `${principalId}\u0000${credential.id}\u0000`;
    return await this.providerCache.get({
      source: 'provider',
      key: `${family}${version}`,
      family,
      ttlMs: PROVIDER_CATALOG_TTL_MS,
      force,
      load: () => this.store.loadProvider(principalId, credential.id, version),
      fetch: async () => {
        let secret: string;
        try {
          const decrypted = this.options.credentials.decryptCredentialSecret(principalId, credential.id);
          if (decrypted.activeVersion !== version) throw new CatalogSourceError('credential_unavailable');
          secret = decrypted.secret;
        } catch {
          throw new CatalogSourceError('credential_unavailable');
        }
        return await fetchProviderModels(this.options.http, provider, { secret, authMode: credential.authMode }, { now: this.now });
      },
      save: (snapshot) => this.store.saveProvider(principalId, credential.id, version, provider, snapshot)
    });
  }
}
