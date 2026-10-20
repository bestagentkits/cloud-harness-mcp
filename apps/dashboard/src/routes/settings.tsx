import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/settings')({
  staticData: { pageId: 'settings' },
  loader: (match) => warmPageRead('settings', match),
  component: () => <PagePlaceholder pageId="settings" />
});
