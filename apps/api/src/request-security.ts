import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ApiConfig } from '@cloud-harness/contracts';

type AuthenticatedRequest = Request & { auth?: AuthInfo };

type LimitWindow = { startedAt: number; requests: number; active: number; lastSeenAt: number };

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

function enforceLimit(window: LimitWindow, response: Response, next: NextFunction, maxRequests: number, maxActive: number): void {
  const now = Date.now();
  if (now - window.startedAt >= 60_000) {
    window.startedAt = now;
    window.requests = 0;
  }
  window.requests += 1;
  window.lastSeenAt = now;
  if (window.requests > maxRequests || window.active >= maxActive) {
    response.setHeader('Retry-After', '1');
    response.status(429).json({ error: 'rate_limited' });
    return;
  }
  window.active += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    window.active = Math.max(0, window.active - 1);
  };
  response.once('finish', release);
  response.once('close', release);
  next();
}

export function preAuthRequestLimits() {
  const window: LimitWindow = { startedAt: Date.now(), requests: 0, active: 0, lastSeenAt: Date.now() };

  return (_request: Request, response: Response, next: NextFunction): void => {
    enforceLimit(window, response, next, 1_000, 32);
  };
}

export function principalRequestLimits(maxPrincipals = 1_000) {
  const windows = new Map<string, LimitWindow>();

  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const key = request.auth?.clientId;
    if (!key) {
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    let window = windows.get(key);
    if (!window) {
      if (windows.size >= maxPrincipals) {
        const oldest = [...windows].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0];
        if (oldest) windows.delete(oldest[0]);
      }
      window = { startedAt: Date.now(), requests: 0, active: 0, lastSeenAt: Date.now() };
      windows.set(key, window);
    }
    enforceLimit(window, response, next, 120, 8);
  };
}

export const requestLimits = principalRequestLimits;
