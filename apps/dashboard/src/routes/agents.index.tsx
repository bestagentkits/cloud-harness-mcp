import { createFileRoute } from '@tanstack/react-router';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { AGENT_ATTENTION, AGENT_STATUSES, type AgentAttention, agentListQuery, PROFILE_FILTER_MAX } from '@/features/agents/agent-model';
import { AgentsPage } from '@/features/agents/agents-page';
import { bffQuery } from '@/lib/bff-query';
import { compact, exact, flag, matching, oneOf, text } from '@/lib/search-params';

/** `needs-attention` / `clear` as the BFF filters them; an older boolean link means "needs attention". */
function attention(raw: Record<string, unknown>): AgentAttention | undefined {
  return oneOf(raw, 'attention', AGENT_ATTENTION) ?? (flag(raw, 'attention') ? 'needs-attention' : undefined);
}

function agentsSearch(raw: Record<string, unknown>) {
  return exact({
    status: oneOf(raw, 'status', AGENT_STATUSES),
    workspaceId: matching(raw, 'workspaceId', RESOURCE_ID_PATTERNS.workspaceId),
    profileId: text(raw, 'profileId', PROFILE_FILTER_MAX),
    parentAgentId: matching(raw, 'parentAgentId', RESOURCE_ID_PATTERNS.agentId),
    attention: attention(raw)
  });
}

export const Route = createFileRoute('/agents/')({
  staticData: { pageId: 'agents' },
  validateSearch: agentsSearch,
  // Preload warms the filtered list the page reads (`agentListQuery`), not the unfiltered fan-out.
  // The filters come from the target location rather than `loaderDeps`: deps would give every
  // filter change a new route match, and a new match shows the pending skeleton over the page.
  loader: ({ context, location, preload }) => {
    if (preload) void context.queryClient.prefetchQuery(bffQuery<{ agents?: unknown }>('/agents', agentListQuery(agentsSearch(location.search))));
  },
  component: AgentsRoute
});

function AgentsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AgentsPage search={search} onSearch={(next) => { void navigate({ search: compact(next), replace: true }); }} />;
}
