import { InfoIcon } from 'lucide-react';

/**
 * Shown when the BFF says a projection was truncated: the list is a bounded window, so the
 * page must not claim it is complete (or that "nothing" exists beyond it).
 */
export function TruncationNotice({ truncated, what }: { truncated: boolean | undefined; what: string }) {
  if (!truncated) return null;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="truncation-notice">
      <InfoIcon aria-hidden="true" className="size-3.5" />
      Showing the most recent {what} the server returned; older entries are not listed here.
    </p>
  );
}
