/**
 * Fetch wrapper for the Dashboard BFF at `/dashboard/api/v1`.
 *
 * The session and CSRF semantics match the legacy client (`apps/api/dashboard/dashboard-api.js`)
 * and the server owner (`apps/api/src/dashboard-session.ts`):
 * - `GET /session` sets the HTTP-only session cookie and returns a CSRF token, which is
 *   kept in memory only (never in storage) and sent as `x-csrf-token` on mutations;
 * - a mutation without a token bootstraps the session first;
 * - a 401 forgets the token so the next mutation bootstraps again;
 * - requests are same-origin with `credentials: 'same-origin'`.
 *
 * Errors are typed by status so callers and the query client can branch without parsing
 * messages. Server messages are already sanitised by the BFF; anything unparseable gets a
 * generic message.
 */

export const API_BASE_PATH = '/dashboard/api/v1';
const GENERIC_MESSAGE = 'The request could not be completed.';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRequestOptions = {
  method?: HttpMethod;
  /** JSON-serialised as the request body. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
/** 401: the Access assertion or dashboard session ended; the operator must reload or sign in. */
export class UnauthorizedError extends ApiError { override name = 'UnauthorizedError'; }
/** 403: forbidden host/origin, failed CSRF, or a principal-scoped denial. */
export class ForbiddenError extends ApiError { override name = 'ForbiddenError'; }
/** 409: a generation fence or lifecycle conflict; refetch before retrying. */
export class ConflictError extends ApiError { override name = 'ConflictError'; }
/** 429: rate limited; `retryAfterSeconds` comes from `Retry-After` when present. */
export class RateLimitedError extends ApiError {
  override name = 'RateLimitedError';
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, message: string, code: string | undefined, retryAfterSeconds: number | undefined) {
    super(status, message, code);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
/** 5xx: the API or runner failed; safe reads may be retried. */
export class ServerError extends ApiError { override name = 'ServerError'; }
/** The request never produced an HTTP response (offline, DNS, connection reset). */
export class NetworkError extends Error {
  override name = 'NetworkError';
  constructor(cause: unknown) {
    super('The Dashboard could not reach the server.', { cause });
  }
}

const MUTATIONS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function toError(response: Response): Promise<ApiError> {
  let body: { message?: unknown; error?: unknown } = {};
  try { body = await response.json() as typeof body; } catch { /* sanitised fallback */ }
  const message = typeof body.message === 'string' && body.message ? body.message : GENERIC_MESSAGE;
  const code = typeof body.error === 'string' ? body.error : undefined;
  const { status } = response;
  if (status === 401) return new UnauthorizedError(status, message, code);
  if (status === 403) return new ForbiddenError(status, message, code);
  if (status === 409) return new ConflictError(status, message, code);
  if (status === 429) return new RateLimitedError(status, message, code, retryAfter(response));
  if (status >= 500) return new ServerError(status, message, code);
  return new ApiError(status, message, code);
}

/** Matches by name: the abort reason may come from another realm (iframe, test DOM). */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function buildPath(path: string, query: ApiRequestOptions['query']): string {
  if (!path.startsWith('/')) throw new TypeError('API paths must start with "/".');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) search.set(key, String(value));
  const encoded = search.toString();
  return `${API_BASE_PATH}${path}${encoded ? `?${encoded}` : ''}`;
}

export type ApiClient = {
  request: <T>(path: string, options?: ApiRequestOptions) => Promise<T>;
  get: <T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>) => Promise<T>;
  bootstrapSession: (signal?: AbortSignal) => Promise<void>;
  /** Drops the in-memory CSRF token, e.g. after sign-out. */
  clearSession: () => void;
};

export function createApiClient(fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): ApiClient {
  let csrfToken: string | undefined;
  let pendingSession: Promise<void> | undefined;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, credentials: 'same-origin' });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new NetworkError(error);
    }
  }

  function bootstrapSession(signal?: AbortSignal): Promise<void> {
    // Concurrent mutations share one bootstrap instead of minting several sessions.
    pendingSession ??= (async () => {
      const response = await send(`${API_BASE_PATH}/session`, { method: 'GET', ...(signal ? { signal } : {}) });
      if (!response.ok) throw await toError(response);
      const body = await response.json() as { csrfToken?: unknown };
      if (typeof body.csrfToken !== 'string' || !body.csrfToken) throw new ApiError(response.status, GENERIC_MESSAGE, 'invalid_session');
      csrfToken = body.csrfToken;
    })().finally(() => { pendingSession = undefined; });
    return pendingSession;
  }

  async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const mutation = MUTATIONS.has(method);
    const url = buildPath(path, options.query);
    if (mutation && !csrfToken) await bootstrapSession(options.signal);
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (mutation) {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrfToken ?? '';
    }
    const response = await send(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (!response.ok) {
      if (response.status === 401) csrfToken = undefined;
      throw await toError(response);
    }
    if (response.status === 204 || method === 'HEAD') return undefined as T;
    return await response.json() as T;
  }

  return {
    request,
    get: (path, options = {}) => request(path, { ...options, method: 'GET' }),
    bootstrapSession,
    clearSession: () => { csrfToken = undefined; }
  };
}

export const apiClient = createApiClient();
