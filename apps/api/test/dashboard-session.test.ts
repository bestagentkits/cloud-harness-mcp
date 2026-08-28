import { describe, expect, it, vi } from 'vitest';
import { createDashboardSessions } from '../src/dashboard-session.js';
import type { DashboardRequest } from '../src/dashboard-types.js';
import type { Response } from 'express';

function createMockResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let jsonBody: Record<string, unknown> | undefined;
  const res = {
    setHeader: vi.fn((key: string, val: string) => { headers[key.toLowerCase()] = val; }),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((body: Record<string, unknown>) => { jsonBody = body; return res; }),
    get headers() { return headers; },
    get statusCode() { return statusCode; },
    get jsonBody() { return jsonBody; }
  };
  return res as unknown as Response & { headers: Record<string, string>; statusCode: number; jsonBody: Record<string, unknown> };
}

describe('createDashboardSessions', () => {
  const principal = { kind: 'external' as const, issuer: 'https://team.cloudflareaccess.com', subject: 'user-1' };
  const baseTime = 1_800_000_000_000;

  it('caps session expiry at 8 hours when assertion duration is longer', () => {
    let clock = baseTime;
    const manager = createDashboardSessions(100, () => clock);
    // 24 hours assertion
    const request = {
      auth: {
        token: 'token',
        clientId: 'client-1',
        scopes: [],
        expiresAt: Math.floor(baseTime / 1_000) + 86_400,
        extra: { principal }
      }
    } as unknown as DashboardRequest;
    const response = createMockResponse();

    manager.bootstrap(request, response);
    expect(response.statusCode).toBe(200);
    const expectedExpiry = baseTime + 28_800_000;
    expect(response.jsonBody.expiresAt).toBe(new Date(expectedExpiry).toISOString());
    const cookie = response.headers['set-cookie'];
    expect(cookie).toContain('__Host-ch-dashboard=');

    const sessionId = cookie.split(';')[0].split('=')[1];
    const csrfToken = response.jsonBody.csrfToken as string;

    // Verify right before 8 hours
    clock = expectedExpiry - 1_000;
    const next = vi.fn();
    const verifyReq = {
      auth: request.auth,
      header: (name: string) => {
        if (name.toLowerCase() === 'cookie') return `__Host-ch-dashboard=${sessionId}`;
        if (name.toLowerCase() === 'x-csrf-token') return csrfToken;
        return undefined;
      }
    } as unknown as DashboardRequest;
    const verifyRes = createMockResponse();
    manager.verify(verifyReq, verifyRes, next);
    expect(next).toHaveBeenCalledOnce();

    // Verify after 8 hours fails
    clock = expectedExpiry + 1_000;
    const failRes = createMockResponse();
    const failNext = vi.fn();
    manager.verify(verifyReq, failRes, failNext);
    expect(failNext).not.toHaveBeenCalled();
    expect(failRes.statusCode).toBe(401);
  });

  it('honors shorter assertion expiry when assertion duration is under 8 hours', () => {
    const clock = baseTime;
    const manager = createDashboardSessions(100, () => clock);
    // 2 hours assertion
    const request = {
      auth: {
        token: 'token',
        clientId: 'client-1',
        scopes: [],
        expiresAt: Math.floor(baseTime / 1_000) + 7_200,
        extra: { principal }
      }
    } as unknown as DashboardRequest;
    const response = createMockResponse();

    manager.bootstrap(request, response);
    expect(response.statusCode).toBe(200);
    const expectedExpiry = baseTime + 7_200_000;
    expect(response.jsonBody.expiresAt).toBe(new Date(expectedExpiry).toISOString());
  });

  it('rejects wrong principal, missing cookie, or invalid CSRF token', () => {
    const clock = baseTime;
    const manager = createDashboardSessions(100, () => clock);
    const request = {
      auth: {
        token: 'token',
        clientId: 'client-1',
        scopes: [],
        expiresAt: Math.floor(baseTime / 1_000) + 7_200,
        extra: { principal }
      }
    } as unknown as DashboardRequest;
    const response = createMockResponse();
    manager.bootstrap(request, response);

    const cookie = response.headers['set-cookie'];
    const sessionId = cookie.split(';')[0].split('=')[1];
    const csrfToken = response.jsonBody.csrfToken as string;

    // Wrong principal
    const wrongPrincipalReq = {
      auth: {
        ...request.auth,
        extra: { principal: { ...principal, subject: 'attacker' } }
      },
      header: (name: string) => {
        if (name.toLowerCase() === 'cookie') return `__Host-ch-dashboard=${sessionId}`;
        if (name.toLowerCase() === 'x-csrf-token') return csrfToken;
        return undefined;
      }
    } as unknown as DashboardRequest;
    const wrongRes = createMockResponse();
    const wrongNext = vi.fn();
    manager.verify(wrongPrincipalReq, wrongRes, wrongNext);
    expect(wrongNext).not.toHaveBeenCalled();
    expect(wrongRes.statusCode).toBe(401);

    // Invalid CSRF token
    const invalidCsrfReq = {
      auth: request.auth,
      header: (name: string) => {
        if (name.toLowerCase() === 'cookie') return `__Host-ch-dashboard=${sessionId}`;
        if (name.toLowerCase() === 'x-csrf-token') return 'invalid-token';
        return undefined;
      }
    } as unknown as DashboardRequest;
    const invalidCsrfRes = createMockResponse();
    const invalidCsrfNext = vi.fn();
    manager.verify(invalidCsrfReq, invalidCsrfRes, invalidCsrfNext);
    expect(invalidCsrfNext).not.toHaveBeenCalled();
    expect(invalidCsrfRes.statusCode).toBe(403);
  });
});
