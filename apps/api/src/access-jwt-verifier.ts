import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { ExternalPrincipal } from '@cloud-harness/contracts';

type JwtHeader = { alg?: unknown; kid?: unknown };
type JwtPayload = Record<string, unknown>;
type CachedKey = { key: KeyObject; freshUntil: number; staleUntil: number };
const SERVICE_SUBJECT_PREFIX = 'cf-service:';

export type AccessJwtVerifierOptions = {
  issuer: string;
  audience: string;
  jwksUrl: string;
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

export type VerifiedAccessIdentity = { principal: ExternalPrincipal; expiresAt: number };

export type AccessAssertionFailure =
  | 'missing_assertion'
  | 'malformed_assertion'
  | 'unsupported_algorithm'
  | 'invalid_signature'
  | 'unknown_key'
  | 'jwks_unavailable'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_token_type'
  | 'invalid_subject'
  | 'invalid_lifetime'
  | 'expired_assertion'
  | 'inactive_assertion';

export class AccessJwtVerificationError extends Error {
  readonly reason: AccessAssertionFailure;

  constructor(reason: AccessAssertionFailure) {
    super('Cloudflare Access assertion verification failed');
    this.name = 'AccessJwtVerificationError';
    this.reason = reason;
  }
}

function fail(reason: AccessAssertionFailure): never { throw new AccessJwtVerificationError(reason); }

function decodeJsonSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 32_768) fail('malformed_assertion');
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); } catch { return fail('malformed_assertion'); }
}

function optionalDisplayValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value !== value.trim()) return undefined;
  return value;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) fail('jwks_unavailable');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      fail('jwks_unavailable');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

export class CloudflareAccessJwtVerifier {
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
  private lastRefreshFailure: AccessAssertionFailure | undefined;

  constructor(private readonly options: AccessJwtVerifierOptions) {
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

  async verify(assertion: string): Promise<VerifiedAccessIdentity> {
    if (!assertion) fail('missing_assertion');
    const parts = assertion.split('.');
    if (parts.length !== 3) fail('malformed_assertion');
    const encodedHeader = parts[0]!;
    const encodedPayload = parts[1]!;
    const encodedSignature = parts[2]!;
    if (!encodedHeader || !encodedPayload || !encodedSignature || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) fail('malformed_assertion');
    const header = decodeJsonSegment(encodedHeader) as JwtHeader;
    if (!header || typeof header !== 'object' || header.alg !== 'RS256') fail('unsupported_algorithm');
    if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) fail('malformed_assertion');
    const kid = header.kid;
    const key = await this.keyFor(kid);
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (!verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), key, signature)) fail('invalid_signature');

    const payload = decodeJsonSegment(encodedPayload) as JwtPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('malformed_assertion');
    const nowSeconds = Math.floor(this.now() / 1_000);
    if (payload.iss !== this.options.issuer) fail('wrong_issuer');
    if (!this.hasAudience(payload.aud)) fail('wrong_audience');
    if (payload.type !== 'app') fail('wrong_token_type');
    const rawSubject = payload.sub;
    if (typeof rawSubject !== 'string') fail('invalid_subject');
    const serviceName = optionalDisplayValue(payload.common_name, 320);
    const isService = rawSubject === '';
    if (isService && !serviceName) fail('invalid_subject');
    if (!isService && (!rawSubject || rawSubject.length > 512 || rawSubject !== rawSubject.trim() || rawSubject.startsWith(SERVICE_SUBJECT_PREFIX))) fail('invalid_subject');
    const subject = isService
      ? `${SERVICE_SUBJECT_PREFIX}${Buffer.from(serviceName!).toString('base64url')}`
      : rawSubject;
    if (!Number.isInteger(payload.exp)) fail('invalid_lifetime');
    if (!isService && !Number.isInteger(payload.nbf)) fail('invalid_lifetime');
    if (payload.nbf !== undefined && !Number.isInteger(payload.nbf)) fail('invalid_lifetime');
    const expiresAt = payload.exp as number;
    if (nowSeconds >= expiresAt) fail('expired_assertion');
    if (payload.nbf !== undefined && nowSeconds < (payload.nbf as number)) fail('inactive_assertion');

    const email = optionalDisplayValue(payload.email, 320);
    const name = optionalDisplayValue(payload.name, 200);
    return {
      principal: {
        issuer: this.options.issuer,
        subject,
        ...(email ? { email } : {}),
        ...(name ? { name } : {})
      },
      expiresAt
    };
  }

  private hasAudience(value: unknown): boolean {
    return value === this.options.audience || (Array.isArray(value) && value.some((entry) => entry === this.options.audience));
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const now = this.now();
    const existing = this.keys.get(kid);
    if (existing && now <= existing.freshUntil) return existing.key;
    const missing = this.missingKids.get(kid);
    if (!existing && missing && now < missing) fail('unknown_key');

    let refreshFailure: AccessAssertionFailure | undefined;
    let refreshCompleted = false;
    if (now - this.lastRefreshAttempt >= this.refreshCooldownMs) {
      try { await this.refresh(); refreshCompleted = true; } catch (error) { refreshFailure = error instanceof AccessJwtVerificationError ? error.reason : undefined; /* bounded stale keys remain usable */ }
    } else if (this.refreshInFlight) {
      try { await this.refreshInFlight; refreshCompleted = true; } catch (error) { refreshFailure = error instanceof AccessJwtVerificationError ? error.reason : undefined; /* handled below */ }
    }
    if (refreshFailure) this.lastRefreshFailure = refreshFailure;
    else if (refreshCompleted) this.lastRefreshFailure = undefined;

    const checkedAt = this.now();
    const refreshed = this.keys.get(kid);
    if (refreshed && checkedAt <= refreshed.staleUntil) return refreshed.key;
    // Only a completed key document may mark a kid absent: caching an outage would keep rejecting
    // valid assertions after the endpoint recovers, so an outage retries on the next request past
    // the refresh cooldown and is labelled by the failure that is still in force.
    if (refreshCompleted) this.rememberMissing(kid, checkedAt + this.negativeCacheTtlMs);
    return fail(refreshFailure ?? this.lastRefreshFailure ?? 'unknown_key');
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.lastRefreshAttempt = this.now();
    const operation = this.fetchKeys();
    this.refreshInFlight = operation;
    try { await operation; } finally { this.refreshInFlight = undefined; }
  }

  private async fetchKeys(): Promise<void> {
    const response = await this.fetcher(this.options.jwksUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.fetchTimeoutMs)
    }).catch(() => fail('jwks_unavailable'));
    if (!response.ok) fail('jwks_unavailable');
    const body = await readBoundedBody(response, this.maxJwksBytes).catch((error: unknown) => {
      if (error instanceof AccessJwtVerificationError) throw error;
      fail('jwks_unavailable');
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
      const modulus = jwk.n;
      const exponent = jwk.e;
      if (typeof kid !== 'string' || !kid || kid.length > 200 || jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' || typeof modulus !== 'string' || typeof exponent !== 'string') fail('jwks_unavailable');
      if (next.has(kid)) fail('jwks_unavailable');
      try { next.set(kid, createPublicKey({ key: { kty: 'RSA', n: modulus, e: exponent }, format: 'jwk' })); } catch { fail('jwks_unavailable'); }
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
