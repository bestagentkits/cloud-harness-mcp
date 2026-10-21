import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS, WORKSPACE_TABS, type WorkspaceTab } from '@/app/page-registry';
import { validateCockpitSearch } from '@/features/workspace-cockpit/cockpit-tab-registry';
import { WorkspaceCockpit } from '@/features/workspace-cockpit/workspace-cockpit';
import { warmPageRead } from '@/lib/page-read';
import { compact } from '@/lib/search-params';

/** `summary` is the bare workspace URL; every other cockpit tab is a path segment. */
function isTab(value: string): value is Exclude<WorkspaceTab, 'summary'> {
  return value !== 'summary' && (WORKSPACE_TABS as readonly string[]).includes(value);
}

export const Route = createFileRoute('/workspaces/$workspaceId/$tab')({
  staticData: { pageId: 'workspace' },
  beforeLoad: ({ params }) => {
    if (!RESOURCE_ID_PATTERNS.workspaceId.test(params.workspaceId) || !isTab(params.tab)) throw notFound();
  },
  // Each tab declares its own params in the cockpit tab registry; this merges them.
  validateSearch: validateCockpitSearch,
  loader: (match) => warmPageRead('workspace', match),
  component: WorkspaceTabPage
});

function WorkspaceTabPage() {
  const { workspaceId, tab } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkspaceCockpit
      workspaceId={workspaceId}
      tab={tab as WorkspaceTab}
      search={search}
      onSearch={(next) => void navigate({ search: compact(next), replace: true })}
    />
  );
}
