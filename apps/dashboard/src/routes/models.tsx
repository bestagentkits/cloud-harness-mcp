import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/models')({
  staticData: { pageId: 'models' },
  loader: (match) => warmPageRead('models', match),
  component: () => <PagePlaceholder pageId="models" />
});
