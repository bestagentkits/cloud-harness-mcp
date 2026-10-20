import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/terminals')({
  staticData: { pageId: 'terminals' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('terminals', match),
  component: () => <PagePlaceholder pageId="terminals" />
});
