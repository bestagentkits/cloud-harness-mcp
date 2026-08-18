const UPSTREAM_URL = 'https://harness.zuey.me/mcp-api-key';

const REQUEST_HEADER_POLICIES = new Map<string, { limit: number; single?: true }>([
  ['accept', { limit: 512 }],
  ['authorization', { limit: 512, single: true }],
  ['content-type', { limit: 256, single: true }],
  ['last-event-id', { limit: 256 }],
  ['mcp-protocol-version', { limit: 64, single: true }],
  ['mcp-session-id', { limit: 256, single: true }]
]);

const RESPONSE_HEADERS = new Set([
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'retry-after',
  'www-authenticate'
]);

const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'POST']);
export interface GatewayEnv {
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  API_KEY_RATE_LIMITER: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

export type UpstreamFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function hasValidSecrets(env: GatewayEnv): boolean {
  return [env.CF_ACCESS_CLIENT_ID, env.CF_ACCESS_CLIENT_SECRET].every((value) =>
    typeof value === 'string'
      && value.length > 0
      && value.length <= 2_048
      && !/[\r\n]/u.test(value)
  );
}

function buildUpstreamHeaders(request: Request, env: GatewayEnv): Headers | null {
  const headers = new Headers();

  for (const [name, policy] of REQUEST_HEADER_POLICIES) {
    const value = request.headers.get(name);
    if (value === null) continue;
    if (value.length === 0 || value.length > policy.limit || /[\r\n]/u.test(value)) return null;
    if (policy.single && value.includes(',')) return null;
    headers.set(name, value);
  }

  const authorization = headers.get('authorization');
  if (authorization === null || !/^Bearer [^\s,]+$/u.test(authorization)) return null;

  headers.set('cache-control', 'no-store');
  headers.set('cf-access-client-id', env.CF_ACCESS_CLIENT_ID);
  headers.set('cf-access-client-secret', env.CF_ACCESS_CLIENT_SECRET);
  return headers;
}

function buildClientHeaders(upstream: Response): Headers {
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export function createGatewayHandler(upstreamFetch: UpstreamFetch): (
  request: Request,
  env: GatewayEnv
) => Promise<Response> {
  return async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp' || url.search !== '') {
      return errorResponse(404, 'not_found');
    }
    if (!ALLOWED_METHODS.has(request.method)) {
      return errorResponse(405, 'method_not_allowed');
    }
    try {
      const limited = await env.API_KEY_RATE_LIMITER.limit({ key: 'mcp-api-key-gateway' });
      if (!limited.success) {
        const response = errorResponse(429, 'rate_limited');
        response.headers.set('retry-after', '60');
        return response;
      }
    } catch {
      return errorResponse(503, 'gateway_unavailable');
    }
    if (!hasValidSecrets(env)) {
      return errorResponse(503, 'gateway_unavailable');
    }

    const headers = buildUpstreamHeaders(request, env);
    if (headers === null) return errorResponse(400, 'invalid_request');

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'manual',
      cache: 'no-store'
    };
    if (request.method === 'POST') init.body = request.body;

    let upstream: Response;
    try {
      upstream = await upstreamFetch(UPSTREAM_URL, init);
    } catch {
      return errorResponse(502, 'bad_gateway');
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(502, 'bad_gateway');
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildClientHeaders(upstream)
    });
  };
}
