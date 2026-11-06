import { useQuery } from '@tanstack/react-query';
import { ActivityIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { AsyncStatus } from '@/components/feedback/async-status';
import { EmptyState } from '@/components/feedback/empty-state';
import { Section } from '@/components/data/section';
import { TruncationNotice } from '@/components/data/truncation-notice';
import { ActivityEventRow } from '@/features/activity/activity-event-row';
import { activityEvents } from '@/features/activity/activity-model';
import { bffPath, bffQuery } from '@/lib/bff-query';
import type { CockpitTabProps } from '../cockpit-tab-registry';

/**
 * The workspace's own activity: live agent rows plus retained audit rows recorded against it,
 * in the Activity Center's event grammar. Both sources are bounded projections, so an empty
 * list after truncation is never reported as "no activity".
 */
export default function ActivityTab({ workspaceId }: CockpitTabProps) {
  const read = useQuery(bffQuery<{ events?: unknown[] }>(`${bffPath('workspaces', workspaceId)}/activity`, {}));
  return (
    <Section
      title="Activity"
      description={<>Live runtime rows and retained audit rows recorded against this workspace. The cross-workspace view is the <Link to="/activity" className="underline">Activity Center</Link>.</>}
    >
      <AsyncStatus query={read} label="activity">
        {(body) => {
          const events = activityEvents(body);
          return (
            <div className="grid gap-3">
              <TruncationNotice truncated={body.truncated} what="activity" />
              {events.length ? (
                <ul className="rounded-lg border" aria-label="Workspace activity">
                  {events.map((event, index) => <ActivityEventRow key={`${String(event.at)}-${index}`} event={event} />)}
                </ul>
              ) : (
                <EmptyState icon={ActivityIcon} title={body.truncated ? 'No activity in this page of results' : 'No activity recorded for this workspace yet'} />
              )}
            </div>
          );
        }}
      </AsyncStatus>
    </Section>
  );
}
