import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { RunnerPrincipalSelectorSchema, type ApiConfig, type RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { AccessJwtVerificationError, CloudflareAccessJwtVerifier, type AccessJwtVerifierOptions } from './access-jwt-verifier.js';
import { renderAccessDiagnostic, type AccessDiagnosticReason } from './access-diagnostic.js';
import { AGENTKIT_WORKSPACE_SCOPE, AgentkitJwtVerifier, AgentkitTokenError, type AgentkitJwtVerifierOptions } from './agentkit-jwt-verifier.js';
import { apiLogger } from './logging.js';

type ApiKeyAuthenticator = {
  authenticateApiKey(apiKey: string): Promise<
    { ok: true; data: { principal: RunnerPrincipalSelector; keyId: string } }
    | { ok: false; error: 'authentication_failed' }
  >;
};

export type AuthenticatedRequest = Request & { auth?: AuthInfo };

function equal(actual: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const scopes = ['workspace:read', 'workspace:write', 'workspace:execute'];

function isApiKeyGatewaySubject(config: ApiConfig, subject: string): boolean {
  return subject === config.apiKeyGatewayServiceSubject;
}

function reject(response: Response): void {
  response.setHeader('WWW-Authenticate', 'Bearer realm="cloud-harness-mcp"');
  response.status(401).json({ error: 'authentication_failed' });
}

function verificationReason(error: unknown): AccessDiagnosticReason {
  return error instanceof AccessJwtVerificationError ? error.reason : 'unexpected_verification_error';
}

// Bound the logged path: a rejected request is unauthenticated input, and an oversized path
// must not let a scanner roll the container's log ring and evict its own forensic trail.
const MAX_LOGGED_PATH = 256;

function logAssertionRejection(request: AuthenticatedRequest, reason: AccessDiagnosticReason): void {
  apiLogger.warn(
    {
      reason,
      method: request.method,
      path: (request.originalUrl ?? '').split('?')[0]?.slice(0, MAX_LOGGED_PATH),
      host: request.header('host') ?? null
    },
    'access assertion rejected'
  );
}

// An entry only counts as an HTML request when text/html is acceptable (q > 0); explicit
// exclusions such as "application/json,text/html;q=0" stay JSON.
function acceptsHtml(accept: string): boolean {
  return accept.split(',').some((entry) => {
    const [type, ...parameters] = entry.split(';').map((part) => part.trim().toLowerCase());
    if (type !== 'text/html') return false;
    const quality = parameters.find((parameter) => parameter.startsWith('q='));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

// Only a browser document navigation gets the diagnostic page; dashboard XHR/fetch calls and
// the MCP surfaces always keep the compact JSON body.
function wantsDiagnosticPage(request: AuthenticatedRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const destination = request.header('sec-fetch-dest');
  if (destination && destination !== 'document') return false;
  return acceptsHtml(request.header('accept') ?? '');
}

function rejectAssertion(request: AuthenticatedRequest, response: Response, reason: AccessDiagnosticReason): void {
  logAssertionRejection(request, reason);
  reject(response);
}

function rejectDashboardAssertion(request: AuthenticatedRequest, response: Response, reason: AccessDiagnosticReason): void {
  logAssertionRejection(request, reason);
  if (!wantsDiagnosticPage(request)) {
    response.status(401).json({ error: 'authentication_failed' });
    return;
  }
  response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.status(401).type('html').send(renderAccessDiagnostic(reason));
}

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): RunnerPrincipalSelector | undefined {
  const parsed = RunnerPrincipalSelectorSchema.safeParse(authInfo?.extra?.principal);
  return parsed.success ? parsed.data : undefined;
}

export type VerifierOverrides = Omit<Partial<AccessJwtVerifierOptions>, 'issuer' | 'audience' | 'jwksUrl'>;

function accessVerifier(config: ApiConfig, verifierOptions: VerifierOverrides): CloudflareAccessJwtVerifier | undefined {
  return config.authMode === 'cloudflare-access'
    ? new CloudflareAccessJwtVerifier({
        issuer: config.accessIssuer!,
        audience: config.accessAudience!,
        jwksUrl: config.accessJwksUrl!,
        ...verifierOptions
      })
    : undefined;
}

export function accessAssertionAuth(config: ApiConfig, verifierOptions: VerifierOverrides = {}) {
  const verifier = accessVerifier(config, verifierOptions);
  let activeVerifications = 0;
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> => {
    if (!verifier) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (activeVerifications >= 32) {
      response.status(429).json({ error: 'too_many_requests' });
      return;
    }
    activeVerifications += 1;
    try {
      const identity = await verifier.verify(request.header('cf-access-jwt-assertion') ?? '');
      if (isApiKeyGatewaySubject(config, identity.principal.subject)) {
        rejectDashboardAssertion(request, response, 'assertion_identity_not_accepted');
        return;
      }
      const principal: RunnerPrincipalSelector = { kind: 'external', ...identity.principal };
      request.auth = {
        token: 'cloudflare-access',
        clientId: identity.principal.subject,
        scopes,
        expiresAt: identity.expiresAt,
        extra: { principal, externalPrincipal: identity.principal }
      };
      next();
    } catch (error) {
      rejectDashboardAssertion(request, response, verificationReason(error));
    } finally {
      activeVerifications -= 1;
    }
  };
}

export function bearerAuth(config: ApiConfig, verifierOptions: VerifierOverrides = {}) {
  const verifier = accessVerifier(config, verifierOptions);
  let activeVerifications = 0;
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!verifier) {
      if (!token || !equal(token, config.bearerToken)) {
        reject(response);
        return;
      }
      const principal: RunnerPrincipalSelector = { kind: 'owner', ownerId: config.ownerId };
      request.auth = { token, clientId: config.ownerId, scopes, extra: { principal } };
      next();
      return;
    }
    if (token.startsWith('chm_key_')) {
      reject(response);
      return;
    }

    if (activeVerifications >= 32) {
      response.status(429).json({ error: 'too_many_requests' });
      return;
    }
    activeVerifications += 1;
    try {
      const assertion = request.header('cf-access-jwt-assertion') ?? '';
      const identity = await verifier.verify(assertion);
      if (isApiKeyGatewaySubject(config, identity.principal.subject)) {
        rejectAssertion(request, response, 'assertion_identity_not_accepted');
        return;
      }
      const principal: RunnerPrincipalSelector = { kind: 'external', ...identity.principal };
      request.auth = {
        token: token || 'cloudflare-access',
        clientId: identity.principal.subject,
        scopes,
        expiresAt: identity.expiresAt,
        extra: { principal, externalPrincipal: identity.principal }
      };
      next();
    } catch (error) {
      rejectAssertion(request, response, verificationReason(error));
    } finally {
      activeVerifications -= 1;
    }
  };
}

export type AgentkitVerifierOverrides = Omit<Partial<AgentkitJwtVerifierOptions>, 'issuer' | 'resource'>;

/** The hostname that carries the agentkit.best lane, or undefined when the lane is off. */
export function agentkitResourceHost(config: ApiConfig): string | undefined {
  return config.agentkitAuthEnabled && config.agentkitAuthResource
    ? new URL(config.agentkitAuthResource).hostname.toLowerCase()
    : undefined;
}

export function isAgentkitRequest(config: ApiConfig, request: Request): boolean {
  const host = agentkitResourceHost(config);
  const rawHost = request.header('host');
  if (!host || !rawHost) return false;
  return (rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':', 1)[0]!).toLowerCase() === host;
}

function protectedResourceMetadataUrl(config: ApiConfig): string {
  const resource = new URL(config.agentkitAuthResource!);
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

function rejectAgentkit(config: ApiConfig, response: Response, status: 401 | 403, error: 'invalid_token' | 'insufficient_scope' | 'access_denied'): void {
  const challenge = [`Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`];
  if (error !== 'access_denied') challenge.push(`error="${error}"`);
  if (error === 'insufficient_scope') challenge.push(`scope="${AGENTKIT_WORKSPACE_SCOPE}"`);
  response.setHeader('WWW-Authenticate', challenge.join(', '));
  response.status(status).json({ error: status === 401 ? 'authentication_failed' : error });
}

/**
 * RFC 9728 protected resource metadata for the agentkit.best lane. MCP clients read it to find
 * agentkit.best as the authorization server and the scope to request.
 */
export function agentkitProtectedResourceMetadata(config: ApiConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!isAgentkitRequest(config, request)) {
      next();
      return;
    }
    response.json({
      resource: config.agentkitAuthResource,
      authorization_servers: [config.agentkitAuthIssuer],
      scopes_supported: [AGENTKIT_WORKSPACE_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Cloud Harness'
    });
  };
}

/**
 * The agentkit.best sign-in lane. A verified token whose subject the operator did not list is
 * refused: agentkit.best lets any account sign in, and this instance stays single-owner.
 */
export function agentkitBearerAuth(config: ApiConfig, verifierOptions: AgentkitVerifierOverrides = {}) {
  const verifier = config.agentkitAuthEnabled && config.agentkitAuthResource
    ? new AgentkitJwtVerifier({ issuer: config.agentkitAuthIssuer, resource: config.agentkitAuthResource, ...verifierOptions })
    : undefined;
  const subjects = new Set(config.agentkitAuthSubjects);
  let activeVerifications = 0;
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> => {
    if (!verifier) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const authorization = request.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token) {
      rejectAgentkit(config, response, 401, 'invalid_token');
      return;
    }
    if (activeVerifications >= 32) {
      response.status(429).json({ error: 'too_many_requests' });
      return;
    }
    activeVerifications += 1;
    try {
      const verified = await verifier.verify(token);
      if (!subjects.has(verified.subject)) {
        apiLogger.warn({ reason: 'subject_not_allowed' }, 'agentkit.best token rejected');
        rejectAgentkit(config, response, 403, 'access_denied');
        return;
      }
      const externalPrincipal = { issuer: config.agentkitAuthIssuer, subject: verified.subject };
      const principal: RunnerPrincipalSelector = { kind: 'external', ...externalPrincipal };
      request.auth = {
        token: 'agentkit-best',
        clientId: `agentkit:${verified.subject}`,
        scopes,
        expiresAt: verified.expiresAt,
        extra: { principal, externalPrincipal }
      };
      next();
    } catch (error) {
      const reason = error instanceof AgentkitTokenError ? error.reason : 'unexpected_verification_error';
      apiLogger.warn({ reason }, 'agentkit.best token rejected');
      if (reason === 'insufficient_scope') rejectAgentkit(config, response, 403, 'insufficient_scope');
      else rejectAgentkit(config, response, 401, 'invalid_token');
    } finally {
      activeVerifications -= 1;
    }
  };
}

export function apiKeyGatewayAuth(
  config: ApiConfig,
  runner: ApiKeyAuthenticator,
  verifierOptions: VerifierOverrides = {}
) {
  const verifier = config.authMode === 'cloudflare-access' && config.apiKeyAuthEnabled
    ? new CloudflareAccessJwtVerifier({
        issuer: config.accessIssuer!,
        audience: config.apiKeyGatewayAccessAudience!,
        jwksUrl: config.accessJwksUrl!,
        ...verifierOptions
      })
    : undefined;
  let activeVerifications = 0;
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> => {
    if (!verifier) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (activeVerifications >= 32) {
      response.status(429).json({ error: 'too_many_requests' });
      return;
    }
    activeVerifications += 1;
    try {
      const identity = await verifier.verify(request.header('cf-access-jwt-assertion') ?? '');
      if (!isApiKeyGatewaySubject(config, identity.principal.subject)) {
        rejectAssertion(request, response, 'assertion_identity_not_accepted');
        return;
      }
      const authorization = request.header('authorization') ?? '';
      const apiKey = authorization.startsWith('Bearer ') && authorization.length <= 103
        ? authorization.slice(7) : '';
      const authenticated = await runner.authenticateApiKey(apiKey);
      if (!authenticated.ok || authenticated.data.principal.kind !== 'external') {
        reject(response);
        return;
      }
      const principal = authenticated.data.principal;
      request.auth = {
        token: 'managed-api-key',
        clientId: `api-key:${authenticated.data.keyId}`,
        scopes,
        extra: { principal, apiKeyId: authenticated.data.keyId }
      };
      next();
    } catch (error) {
      rejectAssertion(request, response, verificationReason(error));
    } finally {
      activeVerifications -= 1;
    }
  };
}
