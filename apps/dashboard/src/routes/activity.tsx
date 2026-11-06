import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/features/activity/activity-page';
import { ACTIVITY_FILTER_IDS } from '@/features/activity/activity-model';
import { warmPageRead } from '@/lib/page-read';
import { exact, oneOf } from '@/lib/search-params';

/**
 * `filter` is the timeline category; the legacy `?filter=all` is the default view, so it is
 * dropped. `exact` keeps the key as undefined so a crafted raw value cannot survive.
 */
function activityFilter(raw: Record<string, unknown>) {
  const filter = oneOf(raw, 'filter', ACTIVITY_FILTER_IDS);
  return filter === 'all' ? undefined : filter;
}

export const Route = createFileRoute('/activity')({
  staticData: { pageId: 'activity' },
  validateSearch: (raw: Record<string, unknown>) => exact({ filter: activityFilter(raw) }),
  loader: (match) => warmPageRead('activity', match),
  component: ActivityRoute
});

function ActivityRoute() {
  return <ActivityPage search={Route.useSearch()} />;
}
