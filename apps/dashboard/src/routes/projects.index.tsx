import { createFileRoute } from '@tanstack/react-router';
import { ProjectsPage } from '@/features/projects/projects-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/projects/')({
  staticData: { pageId: 'projects' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('projects', match),
  component: ProjectsPage
});
