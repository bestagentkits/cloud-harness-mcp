import type { UseQueryResult } from '@tanstack/react-query';
import { ChevronsDownIcon } from 'lucide-react';
import { LogViewer, type LogLine } from '@/components/data/log-viewer';
import { Section } from '@/components/data/section';
import { ErrorState } from '@/components/feedback/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton } from '@/components/ui/button';
import type { AgentLogTail } from './agent-log-tail';

/**
 * The agent's retained log, bounded and redacted by the BFF (large events arrive truncated).
 * The runner's cursor reads forward from the oldest retained event, so the pager here is
 * "Load newer" (when the runner says more is waiting) rather than "Load older". Follow is
 * offered only while the agent can still write; it polls the tail and keeps the newest line
 * in view.
 */
export function AgentLogs({ logs, live, follow, onFollowChange }: {
  logs: UseQueryResult<AgentLogTail>;
  live: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}) {
  const tail = logs.data;
  const lines: LogLine[] = (tail?.events ?? []).map((event, index) => ({
    key: event.cursor ?? `index-${index}`,
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
    ...(event.type ? { type: event.type } : {}),
    content: event.content ?? ''
  }));
  return (
    <Section title="Logs" id="agent-logs" description="Bounded and redacted: large events are truncated before they reach this page.">
      {logs.isPending ? <div role="status"><Skeleton className="h-24 w-full" /><span className="sr-only">Loading logs</span></div> : null}
      {logs.isError && !tail ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : null}
      {tail ? (
        <div className="grid gap-2" aria-busy={logs.isFetching || undefined}>
          {tail.truncatedBefore || tail.trimmed ? (
            <p className="text-xs text-muted-foreground" data-testid="log-gap-notice">
              {tail.truncatedBefore ? 'Older events were dropped by the runner’s retention limit. ' : ''}
              {tail.trimmed ? 'This view keeps the newest 1,000 events.' : ''}
            </p>
          ) : null}
          <LogViewer
            lines={lines}
            label="Agent log"
            empty="No retained log events for this agent."
            follow={follow && live}
            {...(live ? { onFollowChange } : {})}
          />
          {logs.isError ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : null}
          {tail.hasMore ? (
            <div>
              <ActionButton size="sm" variant="outline" pendingLabel="Loading…" onAction={() => logs.refetch({ throwOnError: true })}>
                <ChevronsDownIcon aria-hidden="true" />Load newer events
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
