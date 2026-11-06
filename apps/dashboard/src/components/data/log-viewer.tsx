import { ArrowDownToLineIcon, ChevronsUpIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ActionButton, Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export type LogLine = { key: string; timestamp?: unknown; type?: string; content: string };

/**
 * A bounded, read-only log: lines render as text (React escapes them, nothing is parsed as
 * markup), the view keeps a fixed height and scrolls, "Load older" pages back through the
 * cursor, and "Follow" keeps the newest line in view while a poll appends. Log text never
 * leaves memory: it is not copied to storage or the URL.
 */
export function LogViewer({ lines, label, hasOlder, onLoadOlder, follow, onFollowChange, empty = 'No log lines yet.', className }: {
  lines: readonly LogLine[];
  label: string;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<unknown>;
  follow?: boolean;
  onFollowChange?: (follow: boolean) => void;
  empty?: string;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = lines.at(-1)?.key;
  useEffect(() => {
    const element = scroller.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [follow, last]);
  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {hasOlder && onLoadOlder
          ? <ActionButton size="sm" variant="outline" pendingLabel="Loading…" onAction={onLoadOlder}><ChevronsUpIcon aria-hidden="true" />Load older</ActionButton>
          : <span />}
        {onFollowChange ? (
          <Button size="sm" variant={follow ? 'secondary' : 'ghost'} aria-pressed={follow} onClick={() => onFollowChange(!follow)}>
            <ArrowDownToLineIcon aria-hidden="true" />Follow
          </Button>
        ) : null}
      </div>
      <div ref={scroller} role="log" aria-label={label} tabIndex={0} className="max-h-[28rem] min-h-24 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {lines.length === 0 ? <p className="p-2 font-sans text-sm text-muted-foreground">{empty}</p> : (
          <ol className="grid gap-1">
            {lines.map((line) => (
              <li key={line.key} className="grid gap-0.5 border-b border-border/50 pb-1 last:border-0">
                {line.timestamp !== undefined || line.type ? (
                  <span className="text-[0.7rem] text-muted-foreground">{line.timestamp !== undefined ? formatDateTime(line.timestamp) : null}{line.type ? ` · ${line.type}` : null}</span>
                ) : null}
                <span className="whitespace-pre-wrap break-words">{line.content}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
