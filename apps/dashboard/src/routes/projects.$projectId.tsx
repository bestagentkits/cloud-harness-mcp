import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/projects/$projectId')({
  staticData: { pageId: 'project' },
  validateSearch: noSearch,
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.projectId.test(params.projectId)) throw notFound(); },
  loader: (match) => warmPageRead('project', match),
  component: () => <PagePlaceholder pageId="project" />
});
