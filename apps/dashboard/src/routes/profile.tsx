import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/profile')({
  staticData: { pageId: 'profile' },
  loader: (match) => warmPageRead('profile', match),
  component: () => <PagePlaceholder pageId="profile" />
});
