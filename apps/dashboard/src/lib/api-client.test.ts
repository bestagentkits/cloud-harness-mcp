import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  ConflictError,
  createApiClient,
  ForbiddenError,
  NetworkError,
  RateLimitedError,
  ServerError,
  UnauthorizedError
} from './api-client';

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    // jsdom's DOMException is not an Error subclass, so test for Response instead.
    if (next instanceof Response) return next;
    throw next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const header = (call: Call | undefined, name: string) => (call?.init.headers as Record<string, string> | undefined)?.[name];

describe('createApiClient', () => {
  it('reads with same-origin credentials and no CSRF header', async () => {
    const { impl, calls } = fakeFetch(json(200, { data: { ok: true } }));
    const client = createApiClient(impl);
    await expect(client.get('/profile', { query: { a: 1, skip: undefined } })).resolves.toEqual({ data: { ok: true } });
    expect(calls[0]?.url).toBe('/dashboard/api/v1/profile?a=1');
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect(header(calls[0], 'x-csrf-token')).toBeUndefined();
    expect(header(calls[0], 'content-type')).toBeUndefined();
  });

  it('bootstraps the session once and sends the CSRF token on mutations', async () => {
    const { impl, calls } = fakeFetch(json(200, { csrfToken: 'token-1' }), json(200, { ok: 1 }), json(200, { ok: 2 }));
    const client = createApiClient(impl);
    await Promise.all([
      client.request('/a', { method: 'POST', body: { x: 1 } }),
      client.request('/b', { method: 'DELETE' })
    ]);
    expect(calls.map((call) => call.url)).toEqual(['/dashboard/api/v1/session', '/dashboard/api/v1/a', '/dashboard/api/v1/b']);
    expect(header(calls[1], 'x-csrf-token')).toBe('token-1');
    expect(header(calls[1], 'content-type')).toBe('application/json');
    expect(calls[1]?.init.body).toBe('{"x":1}');
    expect(header(calls[2], 'x-csrf-token')).toBe('token-1');
  });

  it('drops the CSRF token after a 401 so the next mutation re-bootstraps', async () => {
    const { impl, calls } = fakeFetch(
      json(200, { csrfToken: 't1' }),
      json(401, { error: 'session_ended', message: 'Session ended.' }),
      json(200, { csrfToken: 't2' }),
      json(204, undefined)
    );
    const client = createApiClient(impl);
    await expect(client.request('/x', { method: 'POST' })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(client.request('/x', { method: 'POST' })).resolves.toBeUndefined();
    expect(header(calls[3], 'x-csrf-token')).toBe('t2');
  });

  it.each([
    [401, UnauthorizedError],
    [403, ForbiddenError],
    [409, ConflictError],
    [429, RateLimitedError],
    [500, ServerError],
    [503, ServerError],
    [404, ApiError]
  ])('maps HTTP %i to a typed error', async (status, type) => {
    const { impl } = fakeFetch(json(status, { error: 'code_x', message: 'Readable.' }));
    const error = await createApiClient(impl).get('/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ status, code: 'code_x', message: 'Readable.' });
  });

  it('reads Retry-After on 429 and falls back to a generic message for non-JSON bodies', async () => {
    const { impl } = fakeFetch(new Response('busy', { status: 429, headers: { 'retry-after': '7' } }));
    const error = await createApiClient(impl).get('/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(7);
    expect((error as RateLimitedError).message).not.toBe('busy');
  });

  it('wraps transport failures but rethrows aborts unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const { impl } = fakeFetch(new TypeError('Failed to fetch'), abort);
    const client = createApiClient(impl);
    await expect(client.get('/x')).rejects.toBeInstanceOf(NetworkError);
    await expect(client.get('/x')).rejects.toBe(abort);
  });

  it('passes the AbortSignal through', async () => {
    const { impl, calls } = fakeFetch(json(200, {}));
    const controller = new AbortController();
    await createApiClient(impl).get('/x', { signal: controller.signal });
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it('rejects relative paths and a session response without a token', async () => {
    const { impl } = fakeFetch(json(200, {}));
    const client = createApiClient(impl);
    await expect(client.get('profile')).rejects.toBeInstanceOf(TypeError);
    await expect(client.request('/x', { method: 'POST' })).rejects.toMatchObject({ code: 'invalid_session' });
  });
});
