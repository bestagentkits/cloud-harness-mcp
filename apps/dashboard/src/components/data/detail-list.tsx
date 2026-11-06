import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type DetailItem = { label: string; value: ReactNode; mono?: boolean };

/** A definition list of label/value pairs, two columns on wide screens and one on phones. */
export function DetailList({ items, className }: { items: readonly DetailItem[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {items.map((item) => (
        <div key={item.label} className="grid min-w-0 gap-0.5">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn('min-w-0 break-words text-sm', item.mono && 'font-mono text-xs')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
