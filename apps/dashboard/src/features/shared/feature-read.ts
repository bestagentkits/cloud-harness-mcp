import { useQuery } from '@tanstack/react-query';
import type { PageId } from '@/app/page-registry';
import { pageReadQuery } from '@/lib/page-read';

/**
 * A page's primary read, typed and unwrapped from the BFF `{ data }` envelope. It shares
 * the query key with the route loader's warm-up, so hover preload and the page use one
 * cache entry. The cache is in memory only; the BFF projections hold no secret values.
 */
export function usePageData<T>(pageId: PageId, params: Record<string, string> = {}) {
  return useQuery({ ...pageReadQuery(pageId, params), select: (body: unknown) => (body as { data: T }).data });
}
