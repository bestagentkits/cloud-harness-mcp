import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/api-keys')({
  staticData: { pageId: 'api-keys' },
  loader: (match) => warmPageRead('api-keys', match),
  component: () => <PagePlaceholder pageId="api-keys" />
});
