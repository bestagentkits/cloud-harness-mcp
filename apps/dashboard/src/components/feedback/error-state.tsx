import { TriangleAlertIcon } from 'lucide-react';
import { ConflictError, ForbiddenError, NetworkError, RateLimitedError, ServerError, UnauthorizedError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ActionButton } from '@/components/ui/button';

export type ErrorKind = 'session' | 'forbidden' | 'conflict' | 'rate-limited' | 'server' | 'network' | 'unknown';

/**
 * Operator-facing copy per failure class. Messages are fixed strings: the server's own
 * message is already sanitised, but the page never echoes raw bodies or ids either.
 */
export function describeError(error: unknown): { kind: ErrorKind; title: string; message: string; retryable: boolean } {
  if (error instanceof UnauthorizedError) return { kind: 'session', title: 'Your session ended', message: 'Reload the page to sign in again.', retryable: false };
  if (error instanceof ForbiddenError) return { kind: 'forbidden', title: 'Not allowed', message: 'Your signed-in identity cannot open this. Ask the instance owner if you need access.', retryable: false };
  if (error instanceof ConflictError) return { kind: 'conflict', title: 'This changed elsewhere', message: 'Someone else updated it. Retry to load the latest version.', retryable: true };
  if (error instanceof RateLimitedError) {
    const wait = error.retryAfterSeconds ? ` Try again in ${Math.ceil(error.retryAfterSeconds)} seconds.` : ' Wait a moment before retrying.';
    return { kind: 'rate-limited', title: 'Too many requests', message: `The server is limiting requests.${wait}`, retryable: true };
  }
  if (error instanceof ServerError) return { kind: 'server', title: 'The server could not answer', message: 'The API or runner failed. Retry, and check service health if it keeps failing.', retryable: true };
  if (error instanceof NetworkError) return { kind: 'network', title: 'Connection lost', message: 'The Dashboard could not reach the server. Check your connection and retry.', retryable: true };
  return { kind: 'unknown', title: 'Something went wrong', message: 'The request could not be completed.', retryable: true };
}

/** Inline error panel for a failed read, with a Retry that stays pending until the refetch settles. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => Promise<unknown>; className?: string }) {
  const described = describeError(error);
  return (
    <div role="alert" data-error-kind={described.kind} className={cn('grid justify-items-start gap-2 rounded-lg border border-destructive/40 bg-surface p-4', className)}>
      <p className="flex items-center gap-2 text-sm font-medium"><TriangleAlertIcon className="size-4 text-destructive" aria-hidden="true" />{described.title}</p>
      <p className="text-sm text-muted-foreground">{described.message}</p>
      {described.kind === 'session'
        ? <ActionButton size="sm" variant="outline" onAction={async () => { window.location.reload(); }}>Reload</ActionButton>
        : onRetry && described.retryable
          ? <ActionButton size="sm" variant="outline" pendingLabel="Retrying…" onAction={onRetry}>Retry</ActionButton>
          : null}
    </div>
  );
}
