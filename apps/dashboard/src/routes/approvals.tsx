import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/approvals')({
  staticData: { pageId: 'approvals' },
  loader: (match) => warmPageRead('approvals', match),
  component: () => <PagePlaceholder pageId="approvals" />
});
