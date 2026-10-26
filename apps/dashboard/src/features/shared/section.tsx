import { type ReactNode, useId } from 'react';
import { cn } from '@/lib/utils';

/** A titled page section (`<section aria-labelledby>`) with optional actions beside the heading. */
export function Section({ title, description, actions, children, className, testId }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('grid gap-3', className)} data-testid={testId}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 id={id} className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
