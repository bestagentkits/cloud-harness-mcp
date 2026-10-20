import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/profile')({
  staticData: { pageId: 'profile' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('profile', match),
  component: () => <PagePlaceholder pageId="profile" />
});
