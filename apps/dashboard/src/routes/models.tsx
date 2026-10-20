import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/models')({
  staticData: { pageId: 'models' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('models', match),
  component: () => <PagePlaceholder pageId="models" />
});
