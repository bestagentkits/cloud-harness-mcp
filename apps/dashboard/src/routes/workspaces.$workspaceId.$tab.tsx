import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS, WORKSPACE_TABS, type WorkspaceTab } from '@/app/page-registry';
import { PagePlaceholder } from '@/components/layouts/page-placeholder';
import { WorkspaceTabs } from '@/components/layouts/workspace-tabs';
import { warmPageRead } from '@/lib/page-read';
import { compact, flag, text } from '@/lib/search-params';

/** `summary` is the bare workspace URL; every other cockpit tab is a path segment. */
function isTab(value: string): value is Exclude<WorkspaceTab, 'summary'> {
  return value !== 'summary' && (WORKSPACE_TABS as readonly string[]).includes(value);
}

export const Route = createFileRoute('/workspaces/$workspaceId/$tab')({
  staticData: { pageId: 'workspace' },
  beforeLoad: ({ params }) => {
    if (!RESOURCE_ID_PATTERNS.workspaceId.test(params.workspaceId) || !isTab(params.tab)) throw notFound();
  },
  // Files: `path` (directory) and `file` (open file); Git: `staged` (show the staged diff).
  validateSearch: (raw: Record<string, unknown>) => compact({ path: text(raw, 'path', 1_024), file: text(raw, 'file', 1_024), staged: flag(raw, 'staged') }),
  loader: (match) => warmPageRead('workspace', match),
  component: WorkspaceTabPage
});

function WorkspaceTabPage() {
  const { workspaceId, tab } = Route.useParams();
  return (
    <PagePlaceholder pageId="workspace">
      <WorkspaceTabs workspaceId={workspaceId} tab={tab as WorkspaceTab} />
    </PagePlaceholder>
  );
}
