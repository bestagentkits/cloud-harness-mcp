import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { principalRequestLimits } from '../src/request-security.js';

type FakeResponse = EventEmitter & {
  headers: Record<string, string>;
  statusCode?: number;
  body?: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
};

function fakeResponse(): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  response.status = (code) => { response.statusCode = code; return response; };
  response.json = (body) => { response.body = body; return response; };
  return response;
}

const request = { auth: { clientId: 'client-a' } } as unknown as Request;

function call(limit: ReturnType<typeof principalRequestLimits>): { response: FakeResponse; passed: boolean } {
  const response = fakeResponse();
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  limit(request, response as unknown as Response, next);
  return { response, passed };
}

describe('principal request limits', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('tells a client that spent its per-minute budget to wait for the window reset, not one second', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const limit = principalRequestLimits();
    for (let index = 0; index < 120; index += 1) {
      const { response, passed } = call(limit);
      expect(passed).toBe(true);
      response.emit('finish');
    }
    clock.mockReturnValue(1_000_000 + 15_250);
    const { response, passed } = call(limit);
    expect(passed).toBe(false);
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('45');
    expect(response.body).toEqual({ error: 'rate_limited', scope: 'requests_per_minute', retryable: true, retryAfterMs: 44_750 });

    clock.mockReturnValue(1_000_000 + 59_900);
    const nearReset = call(limit).response;
    expect(nearReset.headers['retry-after']).toBe('1');
    expect(nearReset.body).toMatchObject({ retryAfterMs: 1_000 });

    clock.mockReturnValue(1_000_000 + 60_000);
    expect(call(limit).passed).toBe(true);
  });

  it('reports a short retry for the concurrency cap, which frees as soon as a request finishes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const limit = principalRequestLimits();
    const inFlight = Array.from({ length: 8 }, () => call(limit));
    expect(inFlight.every((entry) => entry.passed)).toBe(true);
    const { response, passed } = call(limit);
    expect(passed).toBe(false);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).toEqual({ error: 'rate_limited', scope: 'concurrent_requests', retryable: true, retryAfterMs: 1_000 });

    inFlight[0]!.response.emit('finish');
    expect(call(limit).passed).toBe(true);
  });

  it('does not charge refused concurrency retries against the per-minute budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000);
    const limit = principalRequestLimits();
    const inFlight = Array.from({ length: 8 }, () => call(limit));
    for (let index = 0; index < 200; index += 1) {
      expect(call(limit).response.body).toMatchObject({ scope: 'concurrent_requests' });
    }
    for (const entry of inFlight) entry.response.emit('finish');
    for (let index = 0; index < 112; index += 1) {
      const { response, passed } = call(limit);
      expect(passed).toBe(true);
      response.emit('finish');
    }
    expect(call(limit).response.body).toMatchObject({ scope: 'requests_per_minute' });
  });
});
