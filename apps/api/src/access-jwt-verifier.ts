import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { ExternalPrincipal } from '@cloud-harness/contracts';
import { JwksKeyCache } from './jwks-key-cache.js';

type JwtHeader = { alg?: unknown; kid?: unknown };
type JwtPayload = Record<string, unknown>;
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

function parseRsaKey(jwk: Record<string, unknown>): KeyObject {
  const modulus = jwk.n;
  const exponent = jwk.e;
  if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' || typeof modulus !== 'string' || typeof exponent !== 'string') fail('jwks_unavailable');
  try { return createPublicKey({ key: { kty: 'RSA', n: modulus, e: exponent }, format: 'jwk' }); } catch { return fail('jwks_unavailable'); }
}

export class CloudflareAccessJwtVerifier {
  private readonly now: () => number;
  private readonly keys: JwksKeyCache;

  constructor(private readonly options: AccessJwtVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.keys = new JwksKeyCache({
      ...options,
      parseKey: parseRsaKey,
      fail,
      reasonOf: (error) => error instanceof AccessJwtVerificationError && (error.reason === 'jwks_unavailable' || error.reason === 'unknown_key')
        ? error.reason : undefined
    });
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
    const key = await this.keys.keyFor(kid);
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
}
