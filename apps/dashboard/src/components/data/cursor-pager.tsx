import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Forward-only cursor pagination over a URL `cursor` param. "First page" clears it; the BFF
 * cursor is opaque, so there is no "previous" beyond Back in the browser history.
 */
export function CursorPager({ cursor, nextCursor, onCursor, label }: {
  cursor: string | undefined;
  nextCursor: string | undefined;
  onCursor: (next: string | undefined) => void;
  label: string;
}) {
  if (!cursor && !nextCursor) return null;
  return (
    <nav aria-label={`${label} pages`} className="flex items-center justify-end gap-2">
      <Button variant="outline" size="sm" disabled={!cursor} onClick={() => onCursor(undefined)}><ChevronLeftIcon aria-hidden="true" />First page</Button>
      <Button variant="outline" size="sm" disabled={!nextCursor} onClick={() => onCursor(nextCursor)}>Next page<ChevronRightIcon aria-hidden="true" /></Button>
    </nav>
  );
}
