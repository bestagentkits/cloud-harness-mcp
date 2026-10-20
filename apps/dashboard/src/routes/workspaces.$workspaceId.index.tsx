import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { WorkspaceTabs } from '@/components/layouts/workspace-tabs';
import { warmPageRead } from '@/lib/page-read';

export const Route = createFileRoute('/workspaces/$workspaceId/')({
  staticData: { pageId: 'workspace' },
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.workspaceId.test(params.workspaceId)) throw notFound(); },
  loader: (match) => warmPageRead('workspace', match),
  component: WorkspaceSummary
});

function WorkspaceSummary() {
  const { workspaceId } = Route.useParams();
  return (
    <PagePlaceholder pageId="workspace">
      <WorkspaceTabs workspaceId={workspaceId} tab="summary" />
    </PagePlaceholder>
  );
}
