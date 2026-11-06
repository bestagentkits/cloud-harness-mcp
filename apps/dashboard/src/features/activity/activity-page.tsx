import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ActivityIcon, ScrollTextIcon, SearchXIcon } from 'lucide-react';
import { Section } from '@/components/data/section';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { pageReadQuery } from '@/lib/page-read';
import { cn } from '@/lib/utils';
import { ActivityEventRow } from './activity-event-row';
import { ACTIVITY_EVENT_CAP, ACTIVITY_FILTERS, type ActivityFilter, activityEvents, countByCategory, filterEvents } from './activity-model';
import { ApprovalsSummary } from './approvals-summary';

export type ActivitySearch = { filter?: Exclude<ActivityFilter, 'all'> | undefined };

/**
 * The Activity Center: one server-composed timeline (`GET /activity`) filtered by category
 * in the URL (`?filter=`), plus the read-only approvals summary. Filtering never refetches;
 * the page has no poller, like the classic page, and refreshes on focus and return.
 */
export function ActivityPage({ search }: { search: ActivitySearch }) {
  const read = useQuery(pageReadQuery('activity', {}));
  const filter: ActivityFilter = search.filter ?? 'all';
  return (
    <div className="grid gap-(--stack-gap)">
      <ApprovalsSummary />
      <p className="rounded-lg border bg-surface p-3 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Operational activity.</strong>{' '}
        Live runtime rows disappear with their workspace; retained audit rows are kept and redacted. Each row says which it is.
      </p>
      <AsyncStatus query={read} label="activity">
        {(body) => {
          const events = activityEvents(body);
          const counts = countByCategory(events);
          const visible = filterEvents(events, filter);
          return (
            <Section
              title="Events"
              description={filter === 'all' ? `${events.length} recent events` : `${visible.length} of ${events.length} recent events`}
              actions={<Button asChild variant="outline" size="sm"><Link to="/audit"><ScrollTextIcon aria-hidden="true" />Full audit history</Link></Button>}
            >
              <nav aria-label="Activity filters" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
                {ACTIVITY_FILTERS.map((entry) => (
                  <Link
                    key={entry.id}
                    to="/activity"
                    search={entry.id === 'all' ? {} : { filter: entry.id }}
                    replace
                    activeOptions={{ exact: true, includeSearch: true }}
                    // The validated filter decides, so `?filter=all` or a dropped value still marks All.
                    aria-current={entry.id === filter ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors duration-(--motion-fast) outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      'aria-[current=page]:border-foreground/40 aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground'
                    )}
                  >
                    {entry.label}
                    {entry.id === 'all' ? null : <span className="tabular-nums text-muted-foreground">({counts[entry.id]})</span>}
                  </Link>
                ))}
              </nav>
              <TruncationNotice truncated={events.length >= ACTIVITY_EVENT_CAP} what="events" />
              {visible.length === 0
                ? (events.length === 0
                  ? <EmptyState icon={ActivityIcon} title="No activity yet" description="Agent runs and retained audit events appear here as they happen." />
                  : (
                    <EmptyState
                      icon={SearchXIcon}
                      title="No events in this view yet"
                      description="Nothing in the recent timeline matches this category."
                      action={<Button asChild variant="outline" size="sm"><Link to="/activity" search={{}} replace>Show all events</Link></Button>}
                    />
                  ))
                : (
                  <ul aria-label={`${ACTIVITY_FILTERS.find((entry) => entry.id === filter)?.label ?? 'All'} events`} className="overflow-hidden rounded-md border animate-in fade-in-0 motion-reduce:animate-none">
                    {visible.map((event, index) => <ActivityEventRow key={`${index}-${String(event.at ?? '')}`} event={event} />)}
                  </ul>
                )}
            </Section>
          );
        }}
      </AsyncStatus>
    </div>
  );
}
