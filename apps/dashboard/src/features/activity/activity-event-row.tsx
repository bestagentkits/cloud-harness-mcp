import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { StatusBadge } from '@/components/data/status-badge';
import { EMPTY, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type ActivityEvent, activityLink, fieldText } from './activity-model';

/**
 * One timeline row. Every value renders as text. The "Retained audit" / "Live runtime" label
 * is a word, not a colour, so a running task never reads as a durable history entry. The
 * Open link exists only when the projection's href maps to a known in-app route.
 */
export function ActivityEventRow({ event }: { event: ActivityEvent }) {
  const link = activityLink(event.href);
  const when = formatDateTime(event.at);
  const durable = event.durable === true;
  const summary = fieldText(event.summary, fieldText(event.category, 'Event'));
  return (
    <li className="grid gap-1.5 border-b px-4 py-3 last:border-b-0" data-testid="activity-event" data-durable={durable ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {when === EMPTY
          ? <span className="font-mono text-xs text-muted-foreground">Time not reported</span>
          : <time dateTime={String(event.at)} className="font-mono text-xs text-muted-foreground">{when}</time>}
        <StatusBadge status={fieldText(event.status, 'unknown')} />
      </div>
      <p className="min-w-0 break-words text-sm font-medium">{summary}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="capitalize">{fieldText(event.category, 'uncategorised')}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 break-all font-mono">{fieldText(event.actor, 'Not reported')}</span>
        <span
          data-testid="activity-durability"
          className={cn('rounded-full border px-2 py-0.5 font-medium', durable ? 'border-success/40 text-success' : 'border-border text-muted-foreground')}
        >
          {durable ? 'Retained audit' : 'Live runtime'}
        </span>
        {link
          ? (
            <Link {...link} className="ml-auto inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline focus-visible:underline">
              Open<span className="sr-only"> {summary}</span><ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          )
          : null}
      </div>
    </li>
  );
}
