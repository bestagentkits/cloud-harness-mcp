import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A page note or warning. Warnings are announced (`role="status"`), notes are plain text. */
export function Callout({ tone = 'note', title, children, className, testId }: { tone?: 'note' | 'warning'; title?: ReactNode; children?: ReactNode; className?: string; testId?: string }) {
  const Icon = tone === 'warning' ? TriangleAlertIcon : InfoIcon;
  return (
    <div
      role={tone === 'warning' ? 'status' : undefined}
      data-testid={testId}
      className={cn('flex gap-3 rounded-lg border p-3 text-sm', tone === 'warning' ? 'border-warning/60 bg-warning/10' : 'bg-surface', className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'warning' ? 'text-warning' : 'text-muted-foreground')} aria-hidden="true" />
      <div className="grid min-w-0 gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}
