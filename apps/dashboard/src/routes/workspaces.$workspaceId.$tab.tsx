import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS, WORKSPACE_TABS, type WorkspaceTab } from '@/app/page-registry';
import type { CockpitSearch } from '@/features/workspace-cockpit/cockpit-tab-registry';
import { RUNTIME_ID_PATTERN } from '@/features/workspace-cockpit/runtime-model';
import { WorkspaceCockpit } from '@/features/workspace-cockpit/workspace-cockpit';
import { warmPageRead } from '@/lib/page-read';
import { compact, exact, flag, matching, text } from '@/lib/search-params';

/** `summary` is the bare workspace URL; every other cockpit tab is a path segment. */
function isTab(value: string): value is Exclude<WorkspaceTab, 'summary'> {
  return value !== 'summary' && (WORKSPACE_TABS as readonly string[]).includes(value);
}

export const Route = createFileRoute('/workspaces/$workspaceId/$tab')({
  staticData: { pageId: 'workspace' },
  beforeLoad: ({ params }) => {
    if (!RESOURCE_ID_PATTERNS.workspaceId.test(params.workspaceId) || !isTab(params.tab)) throw notFound();
  },
  // Files: `path` (directory) and `file` (open file); Git: `staged` (show the staged diff);
  // Runtime: `task` (the task whose output is open).
  validateSearch: (raw: Record<string, unknown>) => exact({
    path: text(raw, 'path', 1_024),
    file: text(raw, 'file', 1_024),
    staged: flag(raw, 'staged'),
    task: matching(raw, 'task', RUNTIME_ID_PATTERN)
  }),
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
      search={search as CockpitSearch}
      onSearch={(next) => void navigate({ search: compact(next), replace: true })}
    />
  );
}
