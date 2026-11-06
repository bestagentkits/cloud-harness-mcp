import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { ProjectDetailPage } from '@/features/projects/project-detail-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/projects/$projectId')({
  staticData: { pageId: 'project' },
  validateSearch: noSearch,
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.projectId.test(params.projectId)) throw notFound(); },
  loader: (match) => warmPageRead('project', match),
  component: ProjectRoute
});

function ProjectRoute() {
  const { projectId } = Route.useParams();
  // Keyed by id so open dialogs and conflict notices never carry over to another project.
  return <ProjectDetailPage key={projectId} projectId={projectId} />;
}
