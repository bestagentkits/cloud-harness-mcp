import { queryOptions, type QueryKey } from '@tanstack/react-query';
import { apiClient } from './api-client';

/** The BFF result envelope (`apps/api/src/dashboard-response.ts` `sendRunnerResponse`). */
export type BffEnvelope<T> = { data: T; truncated?: boolean; cursor?: string };

export type BffQueryParams = Record<string, string | number | boolean | undefined>;

/**
 * The query key of one BFF read. It matches `pageReadQuery`, so a page's registry read and
 * a component reading the same path share one cache entry (and one request) instead of two.
 * Undefined params are dropped so `{}` and `{ q: undefined }` are the same key.
 */
export function bffKey(path: string, query: BffQueryParams = {}): QueryKey {
  const clean = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''));
  return ['bff', path, clean] as const;
}

/**
 * Query options for a BFF GET. The Query `signal` reaches `fetch`, so a read whose last
 * observer unmounts is aborted, and the in-memory cache is the only place the answer lives.
 */
export function bffQuery<T>(path: string, query: BffQueryParams = {}) {
  const key = bffKey(path, query);
  const params = key[2] as Record<string, string | number | boolean>;
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => apiClient.get<BffEnvelope<T>>(path, { query: params, signal })
  });
}

/** `/workspaces/ws_1/agents` from segments, each one URI-encoded. */
export function bffPath(...segments: string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/**
 * A `refetchInterval` that polls at `interval` until `done(data)` says the watched state is
 * terminal. Only the owner component of a live view passes it; other readers of the same key
 * observe the cache without a timer of their own.
 */
export function pollUntil<T>(interval: number, done: (data: T | undefined) => boolean) {
  return (query: { state: { data: T | undefined } }) => (done(query.state.data) ? false : interval);
}
