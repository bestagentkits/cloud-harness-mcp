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

  it('re-bootstraps once and resends a mutation the session verifier rejected', async () => {
    const onSessionEnded = vi.fn();
    const { impl, calls } = fakeFetch(
      json(200, { csrfToken: 't1' }),
      json(401, { error: 'session_ended' }),
      json(200, { csrfToken: 't2' }),
      json(204, undefined)
    );
    const client = createApiClient(impl, { onSessionEnded });
    await expect(client.request('/x', { method: 'POST', body: { a: 1 } })).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual(['/dashboard/api/v1/session', '/dashboard/api/v1/x', '/dashboard/api/v1/session', '/dashboard/api/v1/x']);
    expect(header(calls[1], 'x-csrf-token')).toBe('t1');
    expect(header(calls[3], 'x-csrf-token')).toBe('t2');
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('retries a session_ended mutation only once, then reports the ended session', async () => {
    const onSessionEnded = vi.fn();
    const { impl, calls } = fakeFetch(
      json(200, { csrfToken: 't1' }),
      json(401, { error: 'session_ended' }),
      json(200, { csrfToken: 't2' }),
      json(401, { error: 'session_ended' }),
      json(200, { csrfToken: 't3' }),
      json(204, undefined)
    );
    const client = createApiClient(impl, { onSessionEnded });
    await expect(client.request('/x', { method: 'POST' })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(4);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    // The token was dropped, so the next mutation bootstraps a fresh session.
    await expect(client.request('/x', { method: 'POST' })).resolves.toBeUndefined();
    expect(header(calls[5], 'x-csrf-token')).toBe('t3');
  });

  it('never resends a mutation whose 401 is not a session verifier rejection', async () => {
    const onSessionEnded = vi.fn();
    const { impl, calls } = fakeFetch(json(200, { csrfToken: 't1' }), json(401, { error: 'access_denied' }));
    const client = createApiClient(impl, { onSessionEnded });
    await expect(client.request('/x', { method: 'DELETE' })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(2);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('reports a read 401 without retrying it', async () => {
    const onSessionEnded = vi.fn();
    const { impl, calls } = fakeFetch(json(401, { error: 'session_ended' }));
    const client = createApiClient(impl, { onSessionEnded });
    await expect(client.get('/profile')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(1);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('reports an ended session when the bootstrap itself is refused', async () => {
    const onSessionEnded = vi.fn();
    const { impl } = fakeFetch(json(401, { error: 'session_ended' }));
    const client = createApiClient(impl, { onSessionEnded });
    await expect(client.request('/x', { method: 'PUT' })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('never logs tokens, bodies or errors to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const { impl } = fakeFetch(
      json(200, { csrfToken: 'csrf-secret-fixture' }),
      json(403, { error: 'csrf_failed' }),
      json(500, { error: 'boom' }),
      new TypeError('offline')
    );
    const client = createApiClient(impl);
    await expect(client.request('/x', { method: 'POST', body: { apiKey: 'sk-fixture' } })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(client.get('/y')).rejects.toBeInstanceOf(ServerError);
    await expect(client.get('/z')).rejects.toBeInstanceOf(NetworkError);
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
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

  it('keeps a fresh token when a stale request answers 401 after a rotation', async () => {
    const calls: Call[] = [];
    let releaseFirst!: (response: Response) => void;
    const queue: Array<() => Promise<Response>> = [
      async () => json(200, { csrfToken: 'token-one' }),
      () => new Promise<Response>((resolve) => { releaseFirst = resolve; }),
      async () => json(401, { error: 'session_ended' }),
      async () => json(200, { csrfToken: 'token-two' }),
      async () => json(200, { ok: 2 }),
      async () => json(200, { ok: 3 })
    ];
    const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const next = queue.shift();
      if (!next) throw new Error('unexpected request');
      return next();
    }) as unknown as typeof fetch;
    const client = createApiClient(impl);
    await client.bootstrapSession();
    const stale = client.request('/a', { method: 'POST', body: {} });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await expect(client.request('/b', { method: 'POST', body: {} })).resolves.toEqual({ ok: 2 });
    expect(header(calls[4], 'x-csrf-token')).toBe('token-two');
    // The first request, sent with the old token, now fails with a non-verifier 401.
    releaseFirst(json(401, { error: 'unauthorized' }));
    await expect(stale).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(client.request('/c', { method: 'POST', body: {} })).resolves.toEqual({ ok: 3 });
    // No third bootstrap: the stale 401 did not discard token-two.
    expect(calls.filter((call) => call.url.endsWith('/session'))).toHaveLength(2);
    expect(header(calls[5], 'x-csrf-token')).toBe('token-two');
  });

  it('does not let one caller abort the bootstrap the others share', async () => {
    const calls: Call[] = [];
    let releaseSession!: () => void;
    const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/session')) {
        expect(init.signal).toBeUndefined();
        await new Promise<void>((resolve) => { releaseSession = resolve; });
        return json(200, { csrfToken: 'shared-token' });
      }
      return json(200, { ok: true });
    }) as unknown as typeof fetch;
    const client = createApiClient(impl);
    const controller = new AbortController();
    const abandoned = client.request('/a', { method: 'POST', body: {}, signal: controller.signal });
    const kept = client.request('/b', { method: 'POST', body: {} });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    releaseSession();
    await expect(kept).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual(['/dashboard/api/v1/session', '/dashboard/api/v1/b']);
    expect(header(calls[1], 'x-csrf-token')).toBe('shared-token');
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
