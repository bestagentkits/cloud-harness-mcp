import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { JwksKeyCache, type JwksKeyCacheOptions } from './jwks-key-cache.js';

export const AGENTKIT_WORKSPACE_SCOPE = 'cloud-harness:workspace';

export type AgentkitTokenFailure =
  | 'missing_token'
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'wrong_token_type'
  | 'invalid_signature'
  | 'unknown_key'
  | 'jwks_unavailable'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'invalid_subject'
  | 'invalid_lifetime'
  | 'expired_token'
  | 'inactive_token'
  | 'insufficient_scope';

export class AgentkitTokenError extends Error {
  readonly reason: AgentkitTokenFailure;

  constructor(reason: AgentkitTokenFailure) {
    super('agentkit.best access token verification failed');
    this.name = 'AgentkitTokenError';
    this.reason = reason;
  }
}

export type AgentkitJwtVerifierOptions = Omit<JwksKeyCacheOptions, 'jwksUrl' | 'parseKey' | 'fail' | 'reasonOf'> & {
  issuer: string;
  resource: string;
  /** Upper bound on `exp - iat`. agentkit.best registers 60-second tokens for this resource. */
  maxLifetimeSeconds?: number;
  /** Tolerated clock skew for `iat` and `nbf`. */
  clockSkewSeconds?: number;
};

export type VerifiedAgentkitToken = {
  subject: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
};

function fail(reason: AgentkitTokenFailure): never { throw new AgentkitTokenError(reason); }

function decodeJsonSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 16_384) fail('malformed_token');
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); } catch { return fail('malformed_token'); }
}

function parseEcKey(jwk: Record<string, unknown>): KeyObject {
  const { x, y } = jwk;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') fail('jwks_unavailable');
  if (jwk.alg !== undefined && jwk.alg !== 'ES256') fail('jwks_unavailable');
  if (jwk.use !== undefined && jwk.use !== 'sig') fail('jwks_unavailable');
  if ('d' in jwk) fail('jwks_unavailable');
  try { return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' }); } catch { return fail('jwks_unavailable'); }
}

/**
 * Verifies agentkit.best OAuth access tokens locally: ES256 `at+jwt` signed by a key from the
 * issuer's JWKS, exact issuer and audience, a short bounded lifetime, and the workspace scope.
 * No introspection: a revoked grant cannot refresh, so its last token expires within a minute.
 */
export class AgentkitJwtVerifier {
  private readonly now: () => number;
  private readonly keys: JwksKeyCache;
  private readonly maxLifetimeSeconds: number;
  private readonly clockSkewSeconds: number;

  constructor(private readonly options: AgentkitJwtVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.maxLifetimeSeconds = options.maxLifetimeSeconds ?? 120;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 30;
    this.keys = new JwksKeyCache({
      ...options,
      jwksUrl: new URL('/.well-known/jwks.json', options.issuer).href,
      parseKey: parseEcKey,
      fail,
      reasonOf: (error) => error instanceof AgentkitTokenError && (error.reason === 'jwks_unavailable' || error.reason === 'unknown_key')
        ? error.reason : undefined
    });
  }

  async verify(token: string): Promise<VerifiedAgentkitToken> {
    if (!token) fail('missing_token');
    if (token.length > 8_192) fail('malformed_token');
    const parts = token.split('.');
    if (parts.length !== 3) fail('malformed_token');
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    if (!encodedHeader || !encodedPayload || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) fail('malformed_token');
    const header = decodeJsonSegment(encodedHeader) as Record<string, unknown> | null;
    if (!header || typeof header !== 'object' || Array.isArray(header)) fail('malformed_token');
    if (header.alg !== 'ES256') fail('unsupported_algorithm');
    const type = typeof header.typ === 'string' ? header.typ.toLowerCase() : '';
    if (type !== 'at+jwt' && type !== 'application/at+jwt') fail('wrong_token_type');
    if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) fail('malformed_token');
    const key = await this.keys.keyFor(header.kid);
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (signature.length !== 64) fail('invalid_signature');
    const signed = verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!signed) fail('invalid_signature');

    const payload = decodeJsonSegment(encodedPayload) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('malformed_token');
    if (payload.iss !== this.options.issuer) fail('wrong_issuer');
    const audience = payload.aud;
    const audienceMatches = audience === this.options.resource
      || (Array.isArray(audience) && audience.length === 1 && audience[0] === this.options.resource);
    if (!audienceMatches) fail('wrong_audience');
    const subject = payload.sub;
    if (typeof subject !== 'string' || !subject || subject.length > 512 || subject !== subject.trim()) fail('invalid_subject');

    const nowSeconds = Math.floor(this.now() / 1_000);
    const { exp, iat, nbf } = payload;
    if (!Number.isInteger(exp) || !Number.isInteger(iat)) fail('invalid_lifetime');
    if (nbf !== undefined && !Number.isInteger(nbf)) fail('invalid_lifetime');
    const expiresAt = exp as number;
    const issuedAt = iat as number;
    if (expiresAt <= issuedAt || expiresAt - issuedAt > this.maxLifetimeSeconds) fail('invalid_lifetime');
    if (nowSeconds >= expiresAt) fail('expired_token');
    if (issuedAt > nowSeconds + this.clockSkewSeconds) fail('inactive_token');
    if (nbf !== undefined && (nbf as number) > nowSeconds + this.clockSkewSeconds) fail('inactive_token');

    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    if (!scopes.includes(AGENTKIT_WORKSPACE_SCOPE)) fail('insufficient_scope');
    const clientId = typeof payload.client_id === 'string' && payload.client_id.length <= 512 ? payload.client_id : '';
    return { subject, clientId, scopes, expiresAt };
  }
}
