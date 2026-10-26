import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient } from '@/lib/api-client';
import { createWidgetFetch, fitPageContext, parametersFor, parseArgs, WIDGET_SESSION_STORAGE_KEY, widgetSchema } from './widget-host-setup';

describe('widget host setup', () => {
  it('reduces zod schemas to the widget keyword subset', () => {
    const schema = z.object({ page: z.enum(['a', 'b']), query: z.string().max(10).optional(), count: z.number().int().min(1) }).strict();
    const parameters = parametersFor(schema);
    expect(parameters).toEqual({
      type: 'object',
      properties: { page: { type: 'string', enum: ['a', 'b'] }, query: { type: 'string', maxLength: 10 }, count: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      required: ['page', 'count'],
      additionalProperties: false
    });
    expect(widgetSchema({ $schema: 'x', type: 'object', anyOf: [], properties: { a: { format: 'uri', type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
  });

  it('parses strictly and names the failing field without echoing input', () => {
    const schema = z.object({ name: z.string().min(1) }).strict();
    expect(parseArgs(schema, { name: 'ok' })).toEqual({ name: 'ok' });
    expect(() => parseArgs(schema, { name: '' })).toThrow(/^Invalid arguments: name/);
    expect(() => parseArgs(schema, { name: 'x', token: 'sk-live-abc' })).not.toThrow(/sk-live-abc/);
  });

  it('refuses prototype-polluting keys at any depth, whatever the schema allows', () => {
    const loose = z.object({ name: z.string(), nested: z.object({}).passthrough().optional() }).passthrough();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => parseArgs(loose, JSON.parse(`{"name":"x","${key}":{"polluted":true}}`))).toThrow('reserved key');
      expect(() => parseArgs(loose, JSON.parse(`{"name":"x","nested":{"${key}":{}}}`))).toThrow('reserved key');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('scrubs the widget session token from storage after a session response', async () => {
    vi.useFakeTimers();
    const base = vi.fn(async () => new Response('{"token":"visitor"}'));
    const widgetFetch = createWidgetFetch(base as unknown as typeof fetch);
    // As the widget does: parse the body, then save the session in the same microtask chain.
    const response = await widgetFetch('/dashboard/api/v1/dewee/session', { method: 'POST' });
    localStorage.setItem(WIDGET_SESSION_STORAGE_KEY, JSON.stringify(await response.json()));
    expect((base.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'same-origin' });
    await vi.runAllTimersAsync();
    expect(localStorage.getItem(WIDGET_SESSION_STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  describe('after the API restarts and forgets the dashboard session', () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    /** The BFF: `/session` mints numbered tokens, writes need the current one. */
    function harness(options: { refuseBootstrap?: boolean; alwaysEnded?: boolean } = {}) {
      let issued = 0;
      let current = '';
      const writes: string[] = [];
      const server = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/dashboard/api/v1/session')) {
          if (options.refuseBootstrap && issued > 0) return json(401, { error: 'session_ended' });
          current = `token-${++issued}`;
          return json(200, { csrfToken: current });
        }
        const token = new Headers(init?.headers).get('x-csrf-token') ?? '';
        writes.push(token);
        if (options.alwaysEnded || token !== current) return json(401, { error: 'session_ended' });
        return json(200, { ok: true });
      });
      const client = createApiClient(server as unknown as typeof fetch);
      const onSessionEnded = vi.fn();
      const widgetFetch = createWidgetFetch(server as unknown as typeof fetch, { csrfHeaders: client.csrfHeaders, clearSession: client.clearSession, onSessionEnded });
      const send = async () => widgetFetch('/dashboard/api/v1/dewee/chat', { method: 'POST', headers: await client.csrfHeaders(), body: '{"message":"hi"}' });
      const restart = () => { current = 'forgotten'; };
      const bootstraps = () => server.mock.calls.filter(([input]) => String(input).endsWith('/session')).length;
      return { send, restart, writes, bootstraps, onSessionEnded, server };
    }

    it('bootstraps once and retries the write once with the fresh CSRF token', async () => {
      const bff = harness();
      expect((await bff.send()).status).toBe(200);
      bff.restart();
      const response = await bff.send();
      expect(response.status).toBe(200);
      expect(bff.writes).toEqual(['token-1', 'token-1', 'token-2']);
      expect(bff.bootstraps()).toBe(2);
      expect((bff.server.mock.calls.at(-1) as unknown[])[1]).toMatchObject({ body: '{"message":"hi"}', credentials: 'same-origin' });
      expect(bff.onSessionEnded).not.toHaveBeenCalled();
      // The fresh token is kept for the widget's next request.
      expect((await bff.send()).status).toBe(200);
      expect(bff.bootstraps()).toBe(2);
    });

    it('does not retry a second session_ended answer and ends the session', async () => {
      const bff = harness({ alwaysEnded: true });
      const response = await bff.send();
      expect(response.status).toBe(401);
      expect(bff.writes).toEqual(['token-1', 'token-2']);
      expect(bff.bootstraps()).toBe(2);
      expect(bff.onSessionEnded).toHaveBeenCalledTimes(1);
    });

    it('hands back the 401 when the bootstrap is refused because Access ended', async () => {
      const bff = harness({ refuseBootstrap: true });
      expect((await bff.send()).status).toBe(200);
      bff.restart();
      const response = await bff.send();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'session_ended' });
      expect(bff.writes).toEqual(['token-1', 'token-1']);
      expect(bff.bootstraps()).toBe(2);
      expect(bff.onSessionEnded).toHaveBeenCalledTimes(1);
    });

    it('leaves reads and other 401 answers to the widget', async () => {
      const base = vi.fn(async () => json(401, { error: 'session_ended' }));
      const session = { csrfHeaders: vi.fn(async () => ({ 'x-csrf-token': 't' })), clearSession: vi.fn(), onSessionEnded: vi.fn() };
      const widgetFetch = createWidgetFetch(base as unknown as typeof fetch, session);
      expect((await widgetFetch('/dashboard/api/v1/dewee/history', { method: 'GET' })).status).toBe(401);
      base.mockImplementationOnce(async () => json(401, { error: { code: 'unauthorized' } }));
      expect((await widgetFetch('/dashboard/api/v1/dewee/chat', { method: 'POST' })).status).toBe(401);
      expect(base).toHaveBeenCalledTimes(2);
      expect(session.csrfHeaders).not.toHaveBeenCalled();
    });
  });

  it('trims page context to the 4 KB cap by dropping items first', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ id: `item_${index}`, name: 'x'.repeat(100) }));
    const fitted = fitPageContext({ route: '/x', items });
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(4096);
    expect(fitted).toMatchObject({ route: '/x', itemsTruncated: true });
    expect((fitted.items as unknown[]).length).toBeLessThan(50);
  });
});
