import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/packages')({
  staticData: { pageId: 'packages' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('packages', match),
  component: () => <PagePlaceholder pageId="packages" />
});
