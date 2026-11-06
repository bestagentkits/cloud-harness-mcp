import { useQuery } from '@tanstack/react-query';
import { ScrollTextIcon } from 'lucide-react';
import { CursorPager } from '@/components/data/cursor-pager';
import { Section } from '@/components/data/section';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { EMPTY, formatDateTime } from '@/lib/format';
import { fieldText } from '@/features/activity/activity-model';
import { type AuditEvent, auditDetailsText, auditPage, hasAuditDetails } from './audit-model';
import { auditPageQuery } from './audit-query';

export type AuditSearch = { cursor?: string | undefined };

function AuditEventItem({ event }: { event: AuditEvent }) {
  const when = formatDateTime(event.createdAt);
  return (
    <li className="grid gap-2 border-b px-4 py-3 last:border-b-0" data-testid="audit-event">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-semibold">{fieldText(event.action, 'Audit event')}</h3>
        {when === EMPTY
          ? <span className="font-mono text-xs text-muted-foreground">Time not reported</span>
          : <time dateTime={String(event.createdAt)} className="font-mono text-xs text-muted-foreground">{when}</time>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-xs text-muted-foreground">Subject</dt>
        <dd className="min-w-0 break-words">{fieldText(event.subjectType, 'Not reported')} <span className="break-all font-mono text-xs">{fieldText(event.subjectId, '')}</span></dd>
        <dt className="text-xs text-muted-foreground">Generation</dt>
        <dd className="tabular-nums">{fieldText(event.subjectGeneration, EMPTY)}</dd>
      </dl>
      {hasAuditDetails(event.details)
        ? (
          <details className="group rounded-md border bg-muted/40">
            <summary className="cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">Redacted details</summary>
            <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap break-all">{auditDetailsText(event.details)}</pre>
          </details>
        )
        : <p className="text-xs text-muted-foreground">No details recorded.</p>}
    </li>
  );
}

/**
 * Retained, redacted control-plane history (`GET /audit?limit=50`), paged forward with the
 * opaque BFF cursor kept in the URL (`?cursor=`), so a page is shareable and Back returns to
 * the previous one. No poller: it is history, refreshed on focus and return.
 */
export function AuditPage({ search, onCursor }: { search: AuditSearch; onCursor: (cursor: string | undefined) => void }) {
  const read = useQuery(auditPageQuery(search.cursor));
  return (
    <div className="grid gap-(--stack-gap)">
      <p className="rounded-lg border bg-surface p-3 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Retained redacted audit history.</strong>{' '}
        Events exclude secret values, provider credentials, and workspace command output.
      </p>
      <AsyncStatus query={read} label="audit events">
        {(body) => {
          const { events, nextCursor } = auditPage(body);
          return (
            <Section title="Audit events" description={search.cursor ? `${events.length} events on this page` : `${events.length} most recent events`}>
              {events.length === 0
                ? (search.cursor
                  ? <EmptyState icon={ScrollTextIcon} title="No more audit events" description="This page is past the end of the retained history." action={<Button variant="outline" size="sm" onClick={() => onCursor(undefined)}>First page</Button>} />
                  : <EmptyState icon={ScrollTextIcon} title="No retained audit events" description="Control-plane changes such as opening workspaces, approvals, and key changes are recorded here." />)
                : (
                  <ul aria-label="Audit events" className="overflow-hidden rounded-md border animate-in fade-in-0 motion-reduce:animate-none">
                    {events.map((event, index) => <AuditEventItem key={event.id ?? `${index}-${String(event.createdAt ?? '')}`} event={event} />)}
                  </ul>
                )}
              <CursorPager cursor={search.cursor} nextCursor={nextCursor} onCursor={onCursor} label="Audit" />
            </Section>
          );
        }}
      </AsyncStatus>
    </div>
  );
}
