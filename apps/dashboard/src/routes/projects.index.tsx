import { createFileRoute } from '@tanstack/react-router';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/projects/')({
  staticData: { pageId: 'projects' },
  loader: (match) => warmPageRead('projects', match),
  component: () => <PagePlaceholder pageId="projects" />
});
