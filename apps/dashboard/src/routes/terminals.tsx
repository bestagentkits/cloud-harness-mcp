import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/terminals')({
  staticData: { pageId: 'terminals' },
  loader: (match) => warmPageRead('terminals', match),
  component: () => <PagePlaceholder pageId="terminals" />
});
