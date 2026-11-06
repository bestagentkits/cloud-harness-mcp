import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPage } from '@/features/api-keys/api-keys-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/api-keys')({
  staticData: { pageId: 'api-keys' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('api-keys', match),
  component: ApiKeysPage
});
