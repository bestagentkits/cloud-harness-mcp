import { Router, type Request, type Response } from 'express';
import { isOidc, type ApiConfig } from '@cloud-harness/contracts';
import { preAuthRequestLimits, requestSecurity } from './request-security.js';

const WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';

/**
 * RFC 9728 section 3.1: the well-known segment sits between the host and any path of the resource,
 * so `https://host` publishes at `/.well-known/oauth-protected-resource` and `https://host/x` at
 * `/.well-known/oauth-protected-resource/x`.
 */
export function protectedResourceMetadataPath(resource: string): string {
  const { pathname } = new URL(resource);
  return pathname === '/' ? WELL_KNOWN_PATH : `${WELL_KNOWN_PATH}${pathname}`;
}

/** The absolute metadata URL a 401 challenge names in `resource_metadata`. */
export function protectedResourceMetadataUrl(resource: string): string {
  return new URL(protectedResourceMetadataPath(resource), resource).href;
}

/** RFC 6750 challenge for this resource; `parameters` are already-quoted `name="value"` pairs. */
export function bearerChallenge(resource: string, ...parameters: string[]): string {
  return `Bearer ${[...parameters, `resource_metadata="${protectedResourceMetadataUrl(resource)}"`].join(', ')}`;
}

type OidcResourceConfig = Pick<ApiConfig, 'oidcIssuer' | 'oidcAudience' | 'oidcRequiredScope'>;

/** The RFC 9728 document: this instance is the resource and the OIDC issuer its only authorization server. */
export function protectedResourceMetadata(config: OidcResourceConfig): Record<string, unknown> {
  return {
    resource: config.oidcAudience,
    authorization_servers: [config.oidcIssuer],
    scopes_supported: [config.oidcRequiredScope],
    bearer_methods_supported: ['header']
  };
}

/**
 * Serves the protected resource metadata in `oidc` mode only; the other modes have no OAuth
 * authorization server for a client to discover, so they mount nothing.
 */
export function createProtectedResourceMetadataRouter(config: ApiConfig): Router | undefined {
  if (!isOidc(config.authMode) || !config.oidcAudience || !config.oidcIssuer) return undefined;
  const document = JSON.stringify(protectedResourceMetadata(config));
  const router = Router();
  router.get(protectedResourceMetadataPath(config.oidcAudience), requestSecurity(config), preAuthRequestLimits(), (_request: Request, response: Response) => {
    response.type('application/json').send(document);
  });
  return router;
}
