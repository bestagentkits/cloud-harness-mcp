import { createFileRoute, notFound } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { AgentDetailPage } from '@/features/agents/agent-detail-page';
import { agentDetailQuery } from '@/features/agents/agent-queries';
import { exact, matching } from '@/lib/search-params';

/**
 * `workspaceId` scopes the agent lookup, as the classic page's `?workspaceId=` did: the
 * runner resolves an unscoped lookup to the principal's single active workspace, so links
 * from the agent list carry it.
 */
export const Route = createFileRoute('/agents/$agentId')({
  staticData: { pageId: 'agent' },
  validateSearch: (raw: Record<string, unknown>) => exact({ workspaceId: matching(raw, 'workspaceId', RESOURCE_ID_PATTERNS.workspaceId) }),
  beforeLoad: ({ params }) => { if (!RESOURCE_ID_PATTERNS.agentId.test(params.agentId)) throw notFound(); },
  loaderDeps: ({ search }) => ({ workspaceId: search.workspaceId }),
  // Warm the same detail read the page renders (the registry read when unscoped) on preload.
  loader: ({ context, params, deps, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(agentDetailQuery(params.agentId, deps.workspaceId));
  },
  component: AgentRoute
});

function AgentRoute() {
  const { agentId } = Route.useParams();
  const { workspaceId } = Route.useSearch();
  return <AgentDetailPage key={`${agentId}:${workspaceId ?? ''}`} agentId={agentId} workspaceId={workspaceId} />;
}
