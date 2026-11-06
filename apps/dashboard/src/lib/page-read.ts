import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { type PageId, pageById, resolveReadPath } from '@/app/page-registry';
import { apiClient } from './api-client';

/**
 * The query for a page's primary BFF read. The key is the resolved path plus query, so a
 * late answer is fenced to the page (and resource) that asked for it, and the Query
 * `signal` reaches `fetch`, so leaving the page aborts the request.
 */
export function pageReadQuery(pageId: PageId, params: Record<string, string>) {
  const read = pageById(pageId).read;
  const path = read ? resolveReadPath(read, params) : '';
  const query = read?.query ?? {};
  return queryOptions({
    queryKey: ['bff', path, query] as const,
    queryFn: ({ signal }) => apiClient.get<unknown>(path, { query, signal }),
    enabled: Boolean(read)
  });
}

/**
 * Route loader: on hover/focus preload, warm the page's read alongside its route chunk.
 * It never awaits, so an actual navigation commits page B's shell at once and the body
 * renders the cache or a skeleton.
 */
export function warmPageRead(pageId: PageId, { context, params, preload }: { context: { queryClient: QueryClient }; params: object; preload: boolean }): void {
  if (preload && pageById(pageId).read) void context.queryClient.prefetchQuery(pageReadQuery(pageId, params as Record<string, string>));
}

/** A short, non-sensitive summary of a BFF response for placeholder bodies: a record count. */
export function summarizeRead(body: unknown): { count: number | undefined } {
  const data = body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
  if (Array.isArray(data)) return { count: data.length };
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) if (Array.isArray(value)) return { count: value.length };
  }
  return { count: undefined };
}
