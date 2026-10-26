import type { NextFunction, Request, Response } from 'express';
import type { ApiConfig } from '@cloud-harness/contracts';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostnameFromHost(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']')).toLowerCase();
  return raw.split(':', 1)[0]!.toLowerCase();
}

/** Policy for every Dashboard response, including the legacy shell and the BFF. */
export const DASHBOARD_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/**
 * Policy for the React shell document only. It differs from the Dashboard policy in two
 * directives: `font-src 'self'` for the self-hosted Geist files, and a per-response
 * style nonce for the `<style>` element Radix's scroll lock injects at runtime. Scripts
 * stay `'self'` with no nonce, so injected markup can never execute.
 */
export function reactShellContentSecurityPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(nonce)) throw new Error('invalid CSP nonce');
  return `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}

export function dashboardSecurity(config: ApiConfig) {
  const hosts = new Set(config.publicHosts.map((host) => host.toLowerCase()));
  const origins = new Set(config.allowedOrigins.map((origin) => new URL(origin).origin));
  return (request: Request, response: Response, next: NextFunction): void => {
    const host = request.header('host')?.toLowerCase();
    if (!host || !hosts.has(hostnameFromHost(host))) { response.status(403).json({ error: 'forbidden_host' }); return; }
    const rawOrigin = request.header('origin');
    if (rawOrigin) {
      try {
        const origin = new URL(rawOrigin);
        if (origin.host.toLowerCase() !== host || !origins.has(origin.origin)) {
          response.status(403).json({ error: 'forbidden_origin' }); return;
        }
      } catch { response.status(403).json({ error: 'forbidden_origin' }); return; }
    } else if (mutationMethods.has(request.method)) {
      response.status(403).json({ error: 'origin_required' }); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', DASHBOARD_CONTENT_SECURITY_POLICY);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  };
}

export function requireJson(request: Request, response: Response, next: NextFunction): void {
  if (mutationMethods.has(request.method) && !request.is('application/json')) {
    response.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  next();
}

/** The one dashboard route that takes a binary body; it is exempt from the router-wide JSON rule. */
export const SKILL_ARCHIVE_PATH = '/api/v1/skill-archives';
/** Media types a browser or CLI legitimately labels a zip with. */
export const SKILL_ARCHIVE_MEDIA_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

export function requireArchiveMediaType(request: Request, response: Response, next: NextFunction): void {
  if (!request.is(SKILL_ARCHIVE_MEDIA_TYPES)) {
    response.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  next();
}
