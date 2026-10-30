import { keepPreviousData } from '@tanstack/react-query';
import { bffQuery } from '@/lib/bff-query';
import { AUDIT_PAGE_SIZE } from './audit-model';

/**
 * One audit page read. Without a cursor its key equals the registry read
 * (`pageReadQuery('audit', {})`, `/audit` with `limit: 50`), so the route loader's warm
 * prefetch is reused instead of fetching the first page twice. While a next page loads the
 * current page stays on screen (marked busy), so paging never flashes a skeleton.
 */
export function auditPageQuery(cursor: string | undefined) {
  return { ...bffQuery<unknown>('/audit', { limit: AUDIT_PAGE_SIZE, cursor }), placeholderData: keepPreviousData };
}
