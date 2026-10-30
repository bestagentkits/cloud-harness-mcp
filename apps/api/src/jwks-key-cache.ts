import type { KeyObject } from 'node:crypto';

type CachedKey = { key: KeyObject; freshUntil: number; staleUntil: number };

export type JwksFailure = 'jwks_unavailable' | 'unknown_key';

export type JwksKeyCacheOptions = {
  jwksUrl: string;
  /** Returns the verification key for one JWK, or throws through `fail` when the entry is unacceptable. */
  parseKey: (jwk: Record<string, unknown>) => KeyObject;
  /** Throws the verifier's own error type, so callers keep their failure vocabulary. */
  fail: (reason: JwksFailure) => never;
  /** Recovers the reason from an error `fail` threw, or undefined for anything else. */
  reasonOf: (error: unknown) => JwksFailure | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
  cacheTtlMs?: number;
  maxStaleMs?: number;
  refreshCooldownMs?: number;
  negativeCacheTtlMs?: number;
  maxKeys?: number;
  maxNegativeKeys?: number;
  maxJwksBytes?: number;
};

/**
 * A bounded JWKS key cache: fixed URL, no redirects, a timeout and a body cap on every fetch,
 * bounded stale reuse during an outage, a refresh cooldown, and a negative cache that only a
 * completed key document can populate.
 */
export class JwksKeyCache {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly refreshCooldownMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly maxKeys: number;
  private readonly maxNegativeKeys: number;
  private readonly maxJwksBytes: number;
  private readonly keys = new Map<string, CachedKey>();
  private readonly missingKids = new Map<string, number>();
  private refreshInFlight: Promise<void> | undefined;
  private lastRefreshAttempt = Number.NEGATIVE_INFINITY;
  private lastRefreshFailure: JwksFailure | undefined;

  constructor(private readonly options: JwksKeyCacheOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 3_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.maxStaleMs = options.maxStaleMs ?? 900_000;
    this.refreshCooldownMs = options.refreshCooldownMs ?? 1_000;
    this.negativeCacheTtlMs = options.negativeCacheTtlMs ?? 30_000;
    this.maxKeys = options.maxKeys ?? 32;
    this.maxNegativeKeys = options.maxNegativeKeys ?? 64;
    this.maxJwksBytes = options.maxJwksBytes ?? 65_536;
  }

  async keyFor(kid: string): Promise<KeyObject> {
    const now = this.now();
    const existing = this.keys.get(kid);
    if (existing && now <= existing.freshUntil) return existing.key;
    const missing = this.missingKids.get(kid);
    if (!existing && missing && now < missing) this.options.fail('unknown_key');

    let refreshFailure: JwksFailure | undefined;
    let refreshCompleted = false;
    if (now - this.lastRefreshAttempt >= this.refreshCooldownMs) {
      try { await this.refresh(); refreshCompleted = true; } catch (error) { refreshFailure = this.options.reasonOf(error); /* bounded stale keys remain usable */ }
    } else if (this.refreshInFlight) {
      try { await this.refreshInFlight; refreshCompleted = true; } catch (error) { refreshFailure = this.options.reasonOf(error); /* handled below */ }
    }
    if (refreshFailure) this.lastRefreshFailure = refreshFailure;
    else if (refreshCompleted) this.lastRefreshFailure = undefined;

    const checkedAt = this.now();
    const refreshed = this.keys.get(kid);
    if (refreshed && checkedAt <= refreshed.staleUntil) return refreshed.key;
    // Only a completed key document may mark a kid absent: caching an outage would keep rejecting
    // valid tokens after the endpoint recovers, so an outage retries on the next request past
    // the refresh cooldown and is labelled by the failure that is still in force.
    if (refreshCompleted) this.rememberMissing(kid, checkedAt + this.negativeCacheTtlMs);
    return this.options.fail(refreshFailure ?? this.lastRefreshFailure ?? 'unknown_key');
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.lastRefreshAttempt = this.now();
    const operation = this.fetchKeys();
    this.refreshInFlight = operation;
    try { await operation; } finally { this.refreshInFlight = undefined; }
  }

  private async readBoundedBody(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxJwksBytes) this.options.fail('jwks_unavailable');
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > this.maxJwksBytes) {
        await reader.cancel();
        this.options.fail('jwks_unavailable');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  }

  private async fetchKeys(): Promise<void> {
    const fail: (reason: JwksFailure) => never = this.options.fail;
    const response = await this.fetcher(this.options.jwksUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.fetchTimeoutMs)
    }).catch(() => fail('jwks_unavailable'));
    if (!response.ok) fail('jwks_unavailable');
    const body = await this.readBoundedBody(response).catch((error: unknown) => {
      if (this.options.reasonOf(error)) throw error;
      return fail('jwks_unavailable');
    });
    let document: unknown;
    try { document = JSON.parse(body); } catch { fail('jwks_unavailable'); }
    if (!document || typeof document !== 'object' || !Array.isArray((document as { keys?: unknown }).keys)) fail('jwks_unavailable');
    const jwks = (document as { keys: unknown[] }).keys;
    if (jwks.length < 1 || jwks.length > this.maxKeys) fail('jwks_unavailable');
    const fetchedAt = this.now();
    const next = new Map<string, KeyObject>();
    for (const candidate of jwks) {
      if (!candidate || typeof candidate !== 'object') fail('jwks_unavailable');
      const jwk = candidate as Record<string, unknown>;
      const kid = jwk.kid;
      if (typeof kid !== 'string' || !kid || kid.length > 200) fail('jwks_unavailable');
      if (next.has(kid)) fail('jwks_unavailable');
      next.set(kid, this.options.parseKey(jwk));
    }
    for (const [kid, key] of next) {
      this.keys.set(kid, { key, freshUntil: fetchedAt + this.cacheTtlMs, staleUntil: fetchedAt + this.maxStaleMs });
      this.missingKids.delete(kid);
    }
    for (const [kid, cached] of this.keys) if (cached.staleUntil < fetchedAt) this.keys.delete(kid);
    while (this.keys.size > this.maxKeys) this.keys.delete(this.keys.keys().next().value as string);
  }

  private rememberMissing(kid: string, until: number): void {
    this.missingKids.delete(kid);
    this.missingKids.set(kid, until);
    while (this.missingKids.size > this.maxNegativeKeys) this.missingKids.delete(this.missingKids.keys().next().value as string);
  }
}
