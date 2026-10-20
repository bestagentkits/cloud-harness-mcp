import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/approvals')({
  staticData: { pageId: 'approvals' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('approvals', match),
  component: () => <PagePlaceholder pageId="approvals" />
});
