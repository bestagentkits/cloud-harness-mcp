import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A titled page region (`<section>` labelled by its heading). Detail pages compose these;
 * `actions` holds the region's own secondary controls, never the page's primary action.
 */
export function Section({ title, description, actions, children, className, id }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = `${id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-heading`;
  return (
    <section aria-labelledby={headingId} className={cn('grid gap-3 rounded-lg border bg-surface p-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 id={headingId} className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A headline number with its label and an optional hint line. */
export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warning' | 'danger' }) {
  return (
    <div className={cn('grid gap-1 rounded-lg border bg-surface p-4', tone === 'warning' && 'border-warning/50', tone === 'danger' && 'border-destructive/50')}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
