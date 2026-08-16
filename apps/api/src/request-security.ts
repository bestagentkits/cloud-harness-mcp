import type { NextFunction, Request, Response } from 'express';
import type { ApiConfig } from '@cloud-harness/contracts';

function hostnameFromHost(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']')).toLowerCase();
  return raw.split(':', 1)[0]!.toLowerCase();
}

export function requestSecurity(config: ApiConfig) {
  const hosts = new Set(config.publicHosts.map((host) => host.toLowerCase()));
  const origins = new Set(config.allowedOrigins.map((origin) => new URL(origin).origin));

  return (request: Request, response: Response, next: NextFunction): void => {
    const rawHost = request.header('host');
    if (!rawHost || !hosts.has(hostnameFromHost(rawHost))) {
      response.status(403).json({ error: 'forbidden_host' });
      return;
    }
    const rawOrigin = request.header('origin');
    if (rawOrigin) {
      let origin: string;
      try { origin = new URL(rawOrigin).origin; } catch { response.status(403).json({ error: 'forbidden_origin' }); return; }
      if (!origins.has(origin)) { response.status(403).json({ error: 'forbidden_origin' }); return; }
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Accel-Buffering', 'no');
    next();
  };
}

export function requestLimits() {
  let windowStarted = Date.now();
  let requests = 0;
  let active = 0;

  return (_request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    if (now - windowStarted >= 60_000) { windowStarted = now; requests = 0; }
    requests += 1;
    if (requests > 120 || active >= 8) {
      response.setHeader('Retry-After', '1');
      response.status(429).json({ error: 'rate_limited' });
      return;
    }
    active += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  };
}
