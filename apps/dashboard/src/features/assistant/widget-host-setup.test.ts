import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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

  it('trims page context to the 4 KB cap by dropping items first', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ id: `item_${index}`, name: 'x'.repeat(100) }));
    const fitted = fitPageContext({ route: '/x', items });
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(4096);
    expect(fitted).toMatchObject({ route: '/x', itemsTruncated: true });
    expect((fitted.items as unknown[]).length).toBeLessThan(50);
  });
});
