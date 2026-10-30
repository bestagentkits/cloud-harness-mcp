import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * Determinate when the work reports progress (`value` 0-100); indeterminate only when the
 * duration is genuinely unknown (`value` undefined). Never fake a percentage.
 */
export function Progress({ value, label, className }: { value?: number | undefined; label: string; className?: string }) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : null;
  return (
    <ProgressPrimitive.Root
      aria-label={label}
      value={clamped}
      max={100}
      data-indeterminate={determinate ? undefined : ''}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full bg-primary transition-[width] duration-(--motion-base)',
          determinate ? '' : 'progress-indeterminate w-1/3'
        )}
        // React writes this through the CSSOM, which the strict style CSP allows.
        {...(clamped === null ? {} : { style: { width: `${clamped}%` } })}
      />
    </ProgressPrimitive.Root>
  );
}
