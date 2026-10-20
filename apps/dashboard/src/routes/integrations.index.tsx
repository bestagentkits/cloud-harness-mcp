import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/integrations/')({
  staticData: { pageId: 'integrations' },
  loader: (match) => warmPageRead('integrations', match),
  component: () => <PagePlaceholder pageId="integrations" />
});
