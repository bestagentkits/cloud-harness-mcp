import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/secrets')({
  staticData: { pageId: 'secrets' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('secrets', match),
  component: () => <PagePlaceholder pageId="secrets" />
});
