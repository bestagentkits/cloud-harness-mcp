import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/secrets')({
  staticData: { pageId: 'secrets' },
  loader: (match) => warmPageRead('secrets', match),
  component: () => <PagePlaceholder pageId="secrets" />
});
