import { cn } from '@/lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<StatusTone, string> = {
  success: 'border-success/40 text-success',
  warning: 'border-warning/50 text-warning',
  danger: 'border-destructive/50 text-destructive',
  info: 'border-info/40 text-info',
  neutral: 'border-border text-muted-foreground'
};

const BY_STATUS: Record<string, StatusTone> = {
  READY: 'success', RUNNING: 'info', ACTIVE: 'success', SUCCEEDED: 'success', COMPLETED: 'success', CONNECTED: 'success', OK: 'success', ENABLED: 'success', SUCCESS: 'success', RECORDED: 'neutral',
  CREATING: 'info', SPAWNING: 'info', PENDING: 'info', QUEUED: 'info', STARTING: 'info', CANCELLING: 'warning', CLOSING: 'warning', IMPORTING: 'info',
  EXPIRING: 'warning', WAITING: 'warning', ATTENTION: 'warning', DEGRADED: 'warning', STALE: 'warning', ARCHIVED: 'neutral', DISABLED: 'neutral',
  FAILED: 'danger', ERROR: 'danger', EXPIRED: 'danger', CANCELLED: 'neutral', CLOSED: 'neutral', TIMED_OUT: 'danger', LIMIT_EXCEEDED: 'danger', REJECTED: 'danger'
};

/** The tone a status string maps to; unknown statuses are neutral. */
export function statusTone(status: unknown): StatusTone {
  return BY_STATUS[String(status ?? '').toUpperCase()] ?? 'neutral';
}

/**
 * A status pill. Tone is a colour plus a dot, and the text is always the status itself, so
 * the state never depends on colour alone.
 */
export function StatusBadge({ status, tone, className }: { status: unknown; tone?: StatusTone; className?: string }) {
  const label = typeof status === 'string' && status ? status.replaceAll('_', ' ').toLowerCase() : 'unknown';
  const resolved = tone ?? statusTone(status);
  return (
    <span data-status={typeof status === 'string' ? status : undefined} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize', TONES[resolved], className)}>
      <span aria-hidden="true" className={cn('size-1.5 rounded-full bg-current', resolved === 'info' && 'animate-pulse motion-reduce:animate-none')} />
      {label}
    </span>
  );
}
