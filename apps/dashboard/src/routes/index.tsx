import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '@/features/overview/overview-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

// The Overview takes no deep-link params (the classic page reads a fixed 24h metrics window).
export const Route = createFileRoute('/')({
  staticData: { pageId: 'overview' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('overview', match),
  component: OverviewPage
});
