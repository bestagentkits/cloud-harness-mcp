import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/api-keys')({
  staticData: { pageId: 'api-keys' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('api-keys', match),
  component: () => <PagePlaceholder pageId="api-keys" />
});
