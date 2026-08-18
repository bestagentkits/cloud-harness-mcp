import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { RunnerPrincipalSelectorSchema, type ApiConfig, type RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { CloudflareAccessJwtVerifier, type AccessJwtVerifierOptions } from './access-jwt-verifier.js';

type ApiKeyAuthenticator = {
  authenticateApiKey(apiKey: string): Promise<
    { ok: true; data: { principal: RunnerPrincipalSelector; keyId: string } }
    | { ok: false; error: 'authentication_failed' }
  >;
};

type AuthenticatedRequest = Request & { auth?: AuthInfo };

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

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): RunnerPrincipalSelector | undefined {
  const parsed = RunnerPrincipalSelectorSchema.safeParse(authInfo?.extra?.principal);
  return parsed.success ? parsed.data : undefined;
}

type VerifierOverrides = Omit<Partial<AccessJwtVerifierOptions>, 'issuer' | 'audience' | 'jwksUrl'>;

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
        response.status(401).json({ error: 'authentication_failed' });
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
    } catch {
      response.status(401).json({ error: 'authentication_failed' });
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
        reject(response);
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
    } catch {
      reject(response);
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
        reject(response);
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
    } catch {
      reject(response);
    } finally {
      activeVerifications -= 1;
    }
  };
}
