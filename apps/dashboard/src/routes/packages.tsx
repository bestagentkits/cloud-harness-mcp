import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/packages')({
  staticData: { pageId: 'packages' },
  loader: (match) => warmPageRead('packages', match),
  component: () => <PagePlaceholder pageId="packages" />
});
