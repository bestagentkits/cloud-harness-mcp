import type { UseQueryResult } from '@tanstack/react-query';
import { ServerOffIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorState } from '@/components/feedback/error-state';
import { PageSkeleton } from '@/components/feedback/page-skeleton';
import { ActionButton } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * A section's live status line: what the last action did, in words, announced politely.
 * The text is fixed copy or the server's sanitised message, never a submitted value.
 */
export function StatusLine({ message, testId }: { message: string; testId: string }) {
  return <p role="status" aria-live="polite" data-testid={testId} className="min-h-5 text-sm text-muted-foreground">{message}</p>;
}

/** A warning callout; the icon and the bold lead in its copy carry the meaning, not the colour alone. */
export function Callout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm', className)}>
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">{children}</div>
    </div>
  );
}

/** 503 is how the BFF says the runner behind a read is unavailable; its message is sanitised server copy. */
export function isUnavailable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 503;
}

export function UnavailableState({ error, what, onRetry }: { error: ApiError; what: string; onRetry: () => Promise<unknown> }) {
  return (
    <div role="alert" data-error-kind="unavailable" className="grid justify-items-start gap-2 rounded-lg border border-warning/50 bg-surface p-4">
      <p className="flex items-center gap-2 text-sm font-medium"><ServerOffIcon className="size-4" aria-hidden="true" />{what} are unavailable</p>
      <p className="text-sm text-muted-foreground">{error.message || 'The runner did not answer.'} The runner may be restarting or unreachable.</p>
      <ActionButton size="sm" variant="outline" pendingLabel="Retrying…" onAction={onRetry}>Retry</ActionButton>
    </div>
  );
}

/**
 * One section's read: a skeleton on first load, an inline error (runner unavailable or the
 * failure class) with Retry, and otherwise the content with `aria-busy` while it refetches.
 * A section failing never hides the rest of the page.
 */
export function SectionRead<T>({ query, what, children }: { query: UseQueryResult<T>; what: string; children: (data: T) => ReactNode }) {
  const retry = () => query.refetch();
  if (query.isPending) return <PageSkeleton label={`Loading ${what.toLowerCase()}`} />;
  if (query.isError && query.data === undefined) {
    return isUnavailable(query.error) ? <UnavailableState error={query.error} what={what} onRetry={retry} /> : <ErrorState error={query.error} onRetry={retry} />;
  }
  return (
    <div aria-busy={query.isFetching || undefined} className="grid gap-3">
      {query.isError ? <ErrorState error={query.error} onRetry={retry} /> : null}
      {children(query.data as T)}
    </div>
  );
}
