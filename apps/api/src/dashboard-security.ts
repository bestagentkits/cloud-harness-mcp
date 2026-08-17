import type { NextFunction, Request, Response } from 'express';
import type { ApiConfig } from '@cloud-harness/contracts';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostnameFromHost(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']')).toLowerCase();
  return raw.split(':', 1)[0]!.toLowerCase();
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
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
