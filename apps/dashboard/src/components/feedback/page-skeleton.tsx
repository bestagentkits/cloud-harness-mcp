import { Skeleton } from '@/components/ui/skeleton';

/** The route pending component and the first-load state of a page body. */
export function PageSkeleton({ label = 'Loading page' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} data-testid="page-skeleton" className="grid gap-3">
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  );
}
