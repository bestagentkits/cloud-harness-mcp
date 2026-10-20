import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

// Text stays the foreground colour (contrast holds in both themes and high contrast); the
// tone colours the border, tint and dot only.
const TONES: Record<BadgeTone, { pill: string; dot: string }> = {
  neutral: { pill: 'border-border bg-muted', dot: 'bg-muted-foreground' },
  success: { pill: 'border-success/50 bg-success/10', dot: 'bg-success' },
  warning: { pill: 'border-warning/60 bg-warning/15', dot: 'bg-warning' },
  danger: { pill: 'border-destructive/50 bg-destructive/10', dot: 'bg-destructive' },
  info: { pill: 'border-info/50 bg-info/10', dot: 'bg-info' }
};

/** A status pill. The text is the status; colour only reinforces it. */
export function StatusBadge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span data-tone={tone} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground', TONES[tone].pill, className)}>
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', TONES[tone].dot)} />
      {children}
    </span>
  );
}
