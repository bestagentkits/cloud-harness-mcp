import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { principalFromAuthInfo } from './auth.js';
import type { DashboardRequest } from './dashboard-types.js';

type Session = { principalKey: string; tokenHash: Buffer; expiresAt: number; lastSeenAt: number };

const COOKIE = '__Host-ch-dashboard';
const bytes = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();

function cookieValue(request: DashboardRequest): string | undefined {
  const header = request.header('cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return undefined;
}

function principalKey(principal: RunnerPrincipalSelector): string {
  return createHash('sha256').update(JSON.stringify(principal)).digest('base64url');
}

export function createDashboardSessions(maxSessions = 1_000, now = () => Date.now()) {
  const sessions = new Map<string, Session>();

  function prune(): void {
    const current = now();
    for (const [id, session] of sessions) if (session.expiresAt <= current) sessions.delete(id);
    while (sessions.size >= maxSessions) {
      const oldest = [...sessions].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
  }

  function bootstrap(request: DashboardRequest, response: Response): void {
    const principal = principalFromAuthInfo(request.auth);
    if (!principal) { response.status(401).json({ error: 'session_ended' }); return; }
    prune();
    const id = bytes();
    const token = bytes();
    const currentTime = now();
    const assertionExpiry = (request.auth?.expiresAt ?? Math.floor(currentTime / 1_000) + 28_800) * 1_000;
    const effectiveExpiry = Math.min(assertionExpiry, currentTime + 28_800_000);
    sessions.set(id, {
      principalKey: principalKey(principal), tokenHash: digest(token),
      expiresAt: effectiveExpiry, lastSeenAt: currentTime
    });
    response.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    response.json({ csrfToken: token, expiresAt: new Date(effectiveExpiry).toISOString() });
  }

  function verify(request: DashboardRequest, response: Response, next: NextFunction): void {
    const principal = principalFromAuthInfo(request.auth);
    const sessionId = cookieValue(request);
    const token = request.header('x-csrf-token') ?? '';
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!principal || !session || session.expiresAt <= now() || session.principalKey !== principalKey(principal)) {
      response.status(401).json({ error: 'session_ended' });
      return;
    }
    const candidate = digest(token);
    if (candidate.length !== session.tokenHash.length || !timingSafeEqual(candidate, session.tokenHash)) {
      response.status(403).json({ error: 'csrf_failed' });
      return;
    }
    session.lastSeenAt = now();
    next();
  }

  return { bootstrap, verify, size: () => sessions.size };
}
