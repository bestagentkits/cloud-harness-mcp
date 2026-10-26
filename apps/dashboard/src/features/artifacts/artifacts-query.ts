import { keepPreviousData } from '@tanstack/react-query';
import { bffQuery } from '@/lib/bff-query';
import { ARTIFACTS_PAGE_SIZE } from './artifacts-model';

/**
 * One artifacts page read. Without a cursor its key equals the registry read
 * (`/artifacts` with `limit: 50`), so the route loader's warm prefetch is reused; the
 * current page stays on screen while the next one loads.
 */
export function artifactsPageQuery(cursor: string | undefined) {
  return { ...bffQuery<unknown>('/artifacts', { limit: ARTIFACTS_PAGE_SIZE, cursor }), placeholderData: keepPreviousData };
}
