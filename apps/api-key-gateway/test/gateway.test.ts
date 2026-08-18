import { describe, expect, it, vi } from 'vitest';
import {
  createGatewayHandler,
  type GatewayEnv,
  type UpstreamFetch
} from '../src/gateway.js';

const ENV: GatewayEnv = {
  CF_ACCESS_CLIENT_ID: '[redacted-client-id]',
  CF_ACCESS_CLIENT_SECRET: '[redacted-client-secret]',
  API_KEY_RATE_LIMITER: { limit: async () => ({ success: true }) }
};

function request(
  path = '/mcp',
  init: RequestInit & { duplex?: 'half' } = {}
): Request {
  return new Request(`https://api.harness.zuey.me${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer [redacted-api-key]' },
    ...init
  } as RequestInit);
}

function handlerReturning(response = new Response('{}', {
  headers: { 'content-type': 'application/json' }
})) {
  const upstreamFetch = vi.fn<UpstreamFetch>().mockResolvedValue(response);
  return { handler: createGatewayHandler(upstreamFetch), upstreamFetch };
}

describe('API-key gateway boundary', () => {
  it.each(['/mcp/', '/dashboard', '/mcp?target=other'])('rejects non-exact route %s', async (path) => {
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request(path), ENV);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(['HEAD', 'OPTIONS', 'PATCH', 'PUT'])('rejects method %s', async (method) => {
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request('/mcp', { method }), ENV);
    expect(response.status).toBe(405);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(['DELETE', 'GET', 'POST'])('allows Streamable HTTP method %s', async (method) => {
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request('/mcp', { method }), ENV);
    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it('uses one fixed HTTPS origin URL and manual redirects', async () => {
    const { handler, upstreamFetch } = handlerReturning();
    await handler(new Request('https://attacker.invalid/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer [redacted-api-key]',
        host: 'other.invalid',
        'x-forwarded-host': 'other.invalid'
      }
    }), ENV);

    expect(upstreamFetch).toHaveBeenCalledWith(
      'https://harness.zuey.me/mcp-api-key',
      expect.objectContaining({ redirect: 'manual', cache: 'no-store' })
    );
  });

  it('reconstructs request headers and strips mixed-case duplicate forbidden headers', async () => {
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer [redacted-api-key]',
      'content-type': 'application/json',
      'last-event-id': 'event-1',
      'mcp-protocol-version': '2025-11-25',
      'mcp-session-id': 'session-1',
      cookie: 'sensitive=discarded',
      forwarded: 'for=192.0.2.1',
      host: 'spoofed.invalid',
      'x-real-ip': '192.0.2.2',
      'x-forwarded-for': '192.0.2.3',
      connection: 'keep-alive',
      'cache-control': 'public, max-age=3600',
      'cf-access-jwt-assertion': 'caller-assertion',
      'cf-access-client-id': 'caller-id',
      'cf-access-client-secret': 'caller-secret',
      'cf-connecting-ip': '192.0.2.4'
    });
    headers.append('CF-Access-JWT-Assertion', 'duplicate-caller-assertion');
    headers.append('X-Forwarded-For', '192.0.2.5');
    const { handler, upstreamFetch } = handlerReturning();

    await handler(request('/mcp', { headers }), ENV);

    const init = upstreamFetch.mock.calls[0]?.[1];
    const outgoing = new Headers(init?.headers);
    expect(Object.fromEntries(outgoing)).toEqual({
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer [redacted-api-key]',
      'cache-control': 'no-store',
      'cf-access-client-id': ENV.CF_ACCESS_CLIENT_ID,
      'cf-access-client-secret': ENV.CF_ACCESS_CLIENT_SECRET,
      'content-type': 'application/json',
      'last-event-id': 'event-1',
      'mcp-protocol-version': '2025-11-25',
      'mcp-session-id': 'session-1'
    });
  });

  it.each([
    undefined,
    '',
    'Basic [redacted]',
    'Bearer first, Bearer second',
    `Bearer ${'x'.repeat(600)}`
  ])('rejects missing or ambiguous authorization %s', async (authorization) => {
    const headers = new Headers();
    if (authorization !== undefined) headers.set('authorization', authorization);
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request('/mcp', { headers }), ENV);
    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate singleton protocol headers', async () => {
    const headers = new Headers({ authorization: 'Bearer [redacted-api-key]' });
    headers.append('MCP-Session-Id', 'first');
    headers.append('mcp-session-id', 'second');
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request('/mcp', { headers }), ENV);
    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('fails closed when Worker secrets are missing without reflecting their values', async () => {
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request(), {
      CF_ACCESS_CLIENT_ID: '',
      CF_ACCESS_CLIENT_SECRET: '[redacted]',
      API_KEY_RATE_LIMITER: ENV.API_KEY_RATE_LIMITER
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"gateway_unavailable"}');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects at the edge when the aggregate gateway limit is exhausted', async () => {
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request(), {
      ...ENV,
      API_KEY_RATE_LIMITER: { limit: async () => ({ success: false }) }
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.text()).toBe('{"error":"rate_limited"}');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the edge limiter binding is unavailable', async () => {
    const { handler, upstreamFetch } = handlerReturning();
    const response = await handler(request(), {
      ...ENV,
      API_KEY_RATE_LIMITER: { limit: async () => { throw new Error('[redacted]'); } }
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"gateway_unavailable"}');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('passes the POST body stream through without reading or replacing it', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[redacted-body]'));
        controller.close();
      }
    });
    const { handler, upstreamFetch } = handlerReturning();
    const incoming = request('/mcp', {
      method: 'POST',
      body,
      duplex: 'half'
    });

    await handler(incoming, ENV);

    expect(upstreamFetch.mock.calls[0]?.[1]?.body).toBe(incoming.body);
  });

  it('streams the response body and exposes only safe headers', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\\n\\n'));
        controller.close();
      }
    });
    const upstream = new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'mcp-session-id': 'session-1',
        'set-cookie': 'discarded=true',
        location: 'https://discarded.invalid',
        'transfer-encoding': 'chunked',
        'x-internal-debug': 'discarded'
      }
    });
    const { handler } = handlerReturning(upstream);

    const response = await handler(request(), ENV);

    expect(response.body).toBe(body);
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'no-store',
      'content-type': 'text/event-stream',
      'mcp-session-id': 'session-1'
    });
  });

  it('rejects upstream redirects instead of following or reflecting them', async () => {
    const { handler } = handlerReturning(new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.invalid' }
    }));
    const response = await handler(request(), ENV);
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toBe('{"error":"bad_gateway"}');
  });

  it('returns a bounded generic error when upstream fetch fails', async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>().mockRejectedValue(new Error('[redacted-error]'));
    const handler = createGatewayHandler(upstreamFetch);
    const response = await handler(request(), ENV);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":"bad_gateway"}');
  });
});
