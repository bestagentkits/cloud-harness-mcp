import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from './skeleton';

export type DataTableColumn<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
};

/**
 * A semantic table with a caption, a loading state of skeleton rows (so the layout does not
 * jump when data lands) and an empty state. Row height follows the density preference.
 */
export function DataTable<T>({
  columns, rows, rowKey, caption, loading = false, empty, skeletonRows = 5, className
}: {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string;
  caption: string;
  loading?: boolean;
  empty?: ReactNode;
  skeletonRows?: number;
  className?: string;
}) {
  const showSkeleton = loading && !rows?.length;
  // `relative` contains absolutely positioned cell content (`sr-only` labels) in the scroller,
  // so a wide table scrolls inside its frame instead of widening the page. The frame is a
  // named, focusable region so keyboard users can scroll it on a narrow screen.
  return (
    <div role="region" aria-label={caption} tabIndex={0} className={cn('relative overflow-x-auto rounded-lg border bg-surface outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}>
      <table className="w-full border-collapse text-sm" aria-busy={loading || undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {columns.map((column) => <th key={column.id} scope="col" className={cn('px-3 py-2 font-medium', column.className)}>{column.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {showSkeleton
            ? Array.from({ length: skeletonRows }, (_, index) => (
              <tr key={index} className="h-row border-b last:border-0">
                {columns.map((column) => <td key={column.id} className="px-3"><Skeleton className="h-4 w-3/4" /></td>)}
              </tr>
            ))
            : rows?.map((row) => (
              <tr key={rowKey(row)} className="h-row border-b last:border-0 hover:bg-accent/40">
                {columns.map((column) => <td key={column.id} className={cn('px-3 py-1.5', column.className)}>{column.cell(row)}</td>)}
              </tr>
            ))}
        </tbody>
      </table>
      {!showSkeleton && rows && rows.length === 0 ? <div className="border-t p-6">{empty ?? <p className="text-center text-sm text-muted-foreground">Nothing here yet.</p>}</div> : null}
    </div>
  );
}
