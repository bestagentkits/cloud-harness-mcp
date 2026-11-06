import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorState } from './error-state';
import { PageSkeleton } from './page-skeleton';

/**
 * Renders one read's state: a skeleton while it has never loaded, the error panel (with
 * Retry) when it failed without data, and the content otherwise. Cached data renders at
 * once while a background refetch runs, so returning to a page never flashes a skeleton.
 */
export function AsyncStatus<T>({ query, children, skeleton, label }: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  label: string;
}) {
  if (query.isPending) return <>{skeleton ?? <PageSkeleton label={`Loading ${label}`} />}</>;
  if (query.isError && query.data === undefined) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return (
    <div aria-busy={query.isFetching || undefined}>
      {query.isError ? <ErrorState className="mb-3" error={query.error} onRetry={() => query.refetch()} /> : null}
      {children(query.data as T)}
    </div>
  );
}
